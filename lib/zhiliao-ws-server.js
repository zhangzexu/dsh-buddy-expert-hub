/**
 * 智聊 WebSocket 服务端（插件内嵌，零依赖）
 *
 * 聊天工具主动连 ws://127.0.0.1:<port>/ws，首帧 auth，之后双向 JSON 帧。
 * 协议见 docs/zhiliao-ws-protocol.md。
 *
 * 本模块只做「长连接 + 鉴权 + 权限 + 协议编解码」，agent 执行仍复用插件现有的
 * handleZhiliaInbound（通过 onInbound 回调注入）。回投也复用插件现有的
 * replyBaseUrl 机制：插件 POST /internal/reply 到本服务，本服务转成 message.out 帧。
 */
import http from 'node:http'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_FRAME = 64 * 1024 * 1024
const MAX_TEXT = 4 * 1024 * 1024
const HEARTBEAT_MS = 180000   /* 3 分钟没收到任何帧才判超时 */
const WS_PING_MS = 30000      /* 空闲 30 秒主动 ping，标准客户端自动回 pong 保活 */
const ROUTE_DEDUPE_MS = 24 * 60 * 60 * 1000

/* ------------------------------------------------------------------ WS 帧 */

/** 解析 buffer 里的 WebSocket 帧，返回 {frames, rest}；分片帧在这里拼回 */
function parseFrames(buffer) {
  const frames = []
  let buf = buffer
  let fragment = null

  while (buf.length >= 2) {
    const b0 = buf[0]
    const b1 = buf[1]
    const fin = (b0 & 0x80) !== 0
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let offset = 2

    if (len === 126) {
      if (buf.length < offset + 2) break
      len = buf.readUInt16BE(offset)
      offset += 2
    } else if (len === 127) {
      if (buf.length < offset + 8) break
      const high = buf.readUInt32BE(offset)
      const low = buf.readUInt32BE(offset + 4)
      len = high * 0x100000000 + low
      offset += 8
    }
    if (len > MAX_FRAME) throw new Error('frame-too-large')
    if (buf.length < offset + (masked ? 4 : 0) + len) break

    let payload
    if (masked) {
      const mask = buf.subarray(offset, offset + 4)
      payload = Buffer.allocUnsafe(len)
      for (let i = 0; i < len; i += 1) payload[i] = buf[offset + 4 + i] ^ mask[i % 4]
      offset += 4
    } else {
      payload = buf.subarray(offset, offset + len)
    }
    offset += len
    buf = buf.subarray(offset)

    if (opcode === 0x8) { frames.push({ type: 'close', code: payload.length >= 2 ? payload.readUInt16BE(0) : 1000 }); continue }
    if (opcode === 0x9) { frames.push({ type: 'ping', payload }); continue }
    if (opcode === 0xa) { frames.push({ type: 'pong', payload }); continue }
    if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
      if (fragment === null) fragment = []
      fragment.push(payload)
      if (fin) {
        const text = Buffer.concat(fragment).toString('utf8')
        fragment = null
        frames.push({ type: 'text', text })
      }
      continue
    }
    /* 其它控制帧忽略 */
  }
  return { frames, rest: buf }
}

function encodeFrame(text, opcode = 0x1) {
  const payload = Buffer.isBuffer(text) ? text : Buffer.from(String(text), 'utf8')
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.allocUnsafe(2)
    header[0] = 0x80 | opcode
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.allocUnsafe(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeUInt32BE(0, 2)
    header.writeUInt32BE(len, 6)
  }
  return Buffer.concat([header, payload])
}

/* ------------------------------------------------------------------ 工具 */

const now = () => Date.now()

function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

function matchChat(pattern, chatKey) {
  if (pattern === '*') return true
  if (!pattern.includes('*')) return pattern === chatKey
  const re = new RegExp('^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$')
  return re.test(chatKey)
}

function normalizeChatKey(raw) {
  const value = String(raw || '').trim()
  return /^(direct|group):[^\s:]+(:[^\s:]+)?$/.test(value) ? value : ''
}

function safeName(raw, index) {
  const base = path.basename(String(raw || '').replace(/\\/g, '/'))
  const cleaned = base.replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim()
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? 'file-' + String(index) : cleaned.slice(0, 120)
}

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.json': 'application/json', '.csv': 'text/csv', '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}
function mimeOf(name, fallback) {
  return MIME_BY_EXT[path.extname(String(name)).toLowerCase()] || fallback || 'application/octet-stream'
}

function withinDir(dir, target) {
  const rel = path.relative(dir, target)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * 管理接口鉴权：配置了 adminToken 就严格校验；
 * 没配置（ADMIN_TOKEN 空）时只放行本机回环 —— 否则 /push 永远 403，脚本和 AI 都发不出去。
 * @param {any} req http 请求
 * @returns {boolean} 是否放行
 */
function adminOk(req, adminToken) {
  const expected = String(adminToken || '')
  if (expected !== '') return safeEqual(expected, String(req.headers['x-admin-token'] || ''))
  const ra = String((req && req.socket && req.socket.remoteAddress) || '')
  return ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1'
}

function readBodyBuffer(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('body-too-large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error('body-too-large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

/* ------------------------------------------------------------------ 服务 */

/**
 * @param {Object} options
 * @param {number} options.port 监听端口
 * @param {string} options.host 监听地址
 * @param {string} options.configPath 客户端权限配置文件（JSON）
 * @param {string} options.baseDir 插件数据目录（附件/状态）
 * @param {string} options.adminToken 本地 /push 的令牌
 * @param {string[]} options.mediaRoots 额外允许出站 MEDIA 读取的目录
 * @param {(payload:Object)=>Promise<Object>} options.onInbound 复用插件的入站 handler
 * @param {(msg:Object)=>void} [options.onEvent] 审计回调
 */
export function startZhiliaoWsServer(options) {
  const PORT = Number(options.port || 18779)
  const HOST = String(options.host || '127.0.0.1')
  const CONFIG_PATH = path.resolve(options.configPath || '')
  const BASE_DIR = path.resolve(options.baseDir || '')
  const ADMIN_TOKEN = String(options.adminToken || '')
  const ATT_DIR = path.join(BASE_DIR, 'zhiliao', 'work', 'inbox')
  const FILE_DIR = path.join(BASE_DIR, 'zhiliao', 'files')
  /* 二进制附件：保留 7 天，每 7 天清一次（按 mtime） */
  const retainDays = Math.min(365, Math.max(1, Math.trunc(Number(options.fileRetainDays) || 7)))
  const FILE_TTL_MS = retainDays * 24 * 60 * 60 * 1000
  /** chatKey → 接收人 id：/push 时按它决定附件用 URL 还是 base64 */
  const chatOwners = new Map()
  /* AI 最终回复里的 MEDIA: 路径允许范围：智聊工作目录 + 用户桌面/下载/文档 + 临时目录 */
  const homeRoots = ['Desktop', 'Downloads', 'Documents', '桌面', '下载', '文档']
    .map((name) => path.join(os.homedir(), name))
  const MEDIA_ROOTS = [
    ATT_DIR, path.dirname(ATT_DIR), os.tmpdir(), ...homeRoots,
    ...(Array.isArray(options.mediaRoots) ? options.mediaRoots.map((p) => path.resolve(p)) : []),
  ]
  const MAX_FILE = 10 * 1024 * 1024
  const MAX_FILES = 5
  const MAX_OUT = 10 * 1024 * 1024

  fs.mkdirSync(ATT_DIR, { recursive: true })

  /* clients 配置：热加载（每次连接时重读），改完不用重启 */
  function loadClients() {
    /* 优先用插件设置页配置：每次鉴权/权限校验都动态读，改 clientId/token/群@ 不用重启服务 */
    const dynamic = typeof options.getClients === 'function' ? options.getClients() : options.clients
    if (Array.isArray(dynamic) && dynamic.length > 0) {
      const map = new Map()
      for (const c of dynamic) {
        if (!c || typeof c.id !== 'string' || c.id.trim() === '') continue
        const id = c.id.trim()
        map.set(id, {
          id,
          secret: String(c.secret || ''),
          capabilities: Array.isArray(c.capabilities) ? c.capabilities.map(String) : ['message.in', 'message.out'],
          users: { allow: asList(c.users && c.users.allow), deny: asList(c.users && c.users.deny) },
          chats: { allow: asList(c.chats && c.chats.allow), deny: asList(c.chats && c.chats.deny) },
          /* 默认不强制 @：群消息未 @ 时交给 AI 按上下文判断（requireMention=true 才强制） */
          group: { requireMention: c.group !== undefined && c.group !== null && c.group.requireMention === true },
          maxTextLength: num(c.maxTextLength, 4000, 1, 200000),
        })
      }
      return map
    }
    try {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
      const map = new Map()
      for (const c of Array.isArray(cfg.clients) ? cfg.clients : []) {
        if (!c || typeof c.id !== 'string' || c.id === '') continue
        map.set(c.id, {
          id: c.id,
          secret: String(c.secret || ''),
          capabilities: Array.isArray(c.capabilities) ? c.capabilities.map(String) : ['message.in', 'message.out'],
          users: { allow: asList(c.users && c.users.allow), deny: asList(c.users && c.users.deny) },
          chats: { allow: asList(c.chats && c.chats.allow), deny: asList(c.chats && c.chats.deny) },
          /* 默认不强制 @：群消息未 @ 时交给 AI 按上下文判断（requireMention=true 才强制） */
          group: { requireMention: c.group !== undefined && c.group !== null && c.group.requireMention === true },
          maxTextLength: num(c.maxTextLength, 4000, 1, 200000),
        })
      }
      return map
    } catch {
      return new Map()
    }
  }
  const asList = (v) => Array.isArray(v) ? v.map(String).filter((s) => s !== '') : []
  const num = (v, d, min, max) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : d
  }
  const AUDIT_FILE = path.join(BASE_DIR, 'zhiliao', 'ws-audit.jsonl')
  const AUDIT_MAX = 200
  const audit = (entry) => {
    const full = { ts: now(), ...entry }
    try {
      fs.appendFileSync(AUDIT_FILE, JSON.stringify(full) + '\n')
      /* 超出上限只留尾部 */
      try {
        const st = fs.statSync(AUDIT_FILE)
        if (st.size > 64 * 1024) {
          const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter((s) => s !== '')
          fs.writeFileSync(AUDIT_FILE, lines.slice(-AUDIT_MAX).join('\n') + '\n')
        }
      } catch { /* 裁剪失败不影响写入 */ }
    } catch { /* 只读目录：静默降级 */ }
    if (typeof options.onEvent === 'function') options.onEvent(full)
  }

  /** 活跃的已鉴权连接：Set<Client> */
  const clients = new Set()
  /** 连接记录（断开后保留，手动删除才移除）：connectionId → record */
  const connections = new Map()
  /** 鉴权失败计数（只用于面板提示，不落盘） */
  let authFailures = 0
  let lastAuthError = ''
  /** messageId → { clientId, chatKey, replyTo }：回投时定路由 */
  const routes = new Map()
  /** 人设：clientId\u0000chatKey → {name,prompt,version,injected}（旧接口，兼容保留） */
  const personas = new Map()
  /** 用户级人设：senderId → {name,prompt,version,injected,skills:[{name,path}]} */
  const userPersonas = new Map()
  /** 按用户(senderId)的规则：群 @ 等，覆盖客户端默认值 */
  const userRules = new Map()
  /** 会话级规则（chatKey → {requireConfirm, requireConfirmSet}），优先于用户默认 */
  const chatRules = new Map()
  const STATE_FILE = path.join(BASE_DIR, 'zhiliao-ws-state.json')

  function loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
      for (const [k, v] of Object.entries(raw.routes || {})) {
        if (v && now() - Number(v.ts || 0) < ROUTE_DEDUPE_MS) routes.set(k, v)
      }
      for (const [k, v] of Object.entries(raw.personas || {})) {
        if (v && typeof v.prompt === 'string') personas.set(k, v)
      }
      for (const [k, v] of Object.entries(raw.connections || {})) {
        /* 跳过历史脏数据（未鉴权的空记录），只恢复真实客户端记录 */
        if (v && typeof v.clientId === 'string' && v.clientId !== '') {
          connections.set(k, { ...v, connected: false })
        }
      }
      for (const [k, v] of Object.entries(raw.userRules || {})) {
        if (v && typeof v.requireMention === 'boolean') userRules.set(k, v)
        if (v && (v.fileMode === 'binary' || v.fileMode === 'base64')) userRules.set(k, Object.assign({}, userRules.get(k) || {}, { fileMode: v.fileMode }))
      }
      for (const [k, v] of Object.entries(raw.userPersonas || {})) {
        if (v && typeof v.prompt === 'string') userPersonas.set(k, v)
      }
      for (const [k, v] of Object.entries(raw.chatRules || {})) {
        if (v && typeof v.requireConfirm === 'boolean') chatRules.set(k, v)
      }
    } catch { /* 首次 */ }
  }
  let stateTimer = null
  function persist() {
    if (stateTimer !== null) return
    stateTimer = setTimeout(() => {
      stateTimer = null
      try {
        const r = {}
        for (const [k, v] of routes) r[k] = v
        const p = {}
        for (const [k, v] of personas) p[k] = v
        const conns = {}
        for (const [k, v] of connections) conns[k] = v
        const rules = {}
        for (const [k, v] of userRules) rules[k] = v
        const ups = {}
        for (const [k, v] of userPersonas) ups[k] = v
        const cr = {}
        for (const [k, v] of chatRules) cr[k] = v
        fs.writeFileSync(STATE_FILE, JSON.stringify({ routes: r, personas: p, connections: conns, userRules: rules, userPersonas: ups, chatRules: cr }), 'utf8')
      } catch (error) {
        audit({ event: 'state-error', error: String((error && error.message) || error) })
      }
    }, 250)
    if (stateTimer.unref) stateTimer.unref()
  }
  loadState()

  /* -------------------------------------------------------------- 客户端 */

  function send(client, obj) {
    /* net.Socket 没有 readyState（那是浏览器 WebSocket 的属性），用 destroyed/writable 判断 */
    if (!client.socket || client.socket.destroyed || !client.socket.writable) return false
    try {
      client.socket.write(encodeFrame(JSON.stringify(obj)))
      return true
    } catch {
      return false
    }
  }

  function error(client, requestId, code, message) {
    send(client, { type: 'error', requestId: String(requestId || ''), code, message: String(message || '') })
  }

  function has(client, cap) {
    return client.auth !== null && client.auth.capabilities.includes(cap)
  }

  function checkPermission(client, msg) {
    /* 每次重新读配置：设置页改群 @ / 白名单后，已连接的客户端立即生效，不用重连 */
    const cfg = client.auth ? (loadClients().get(client.auth.clientId) || client.auth.cfg) : null
    if (!cfg) return 'adapter-disabled'
    if (cfg.users.deny.length > 0 && cfg.users.deny.includes(msg.senderId)) return 'user-denied'
    if (cfg.users.allow.length > 0 && !cfg.users.allow.includes(msg.senderId)) return 'user-not-allowed'
    if (cfg.chats.deny.some((p) => matchChat(p, msg.chatKey))) return 'chat-denied'
    if (cfg.chats.allow.length > 0 && !cfg.chats.allow.some((p) => matchChat(p, msg.chatKey))) return 'chat-not-allowed'
    /* 群 @ 规则按接收用户(receiverId)；只有显式勾了「群聊必须 @」才强制，否则交给 AI 判断 */
    if (msg.chatKey.startsWith('group:') && msg.atBot !== true) {
      const ownerId = String(msg.receiverId || msg.senderId || '')
      const rule = userRules.get(ownerId)
      if (rule !== undefined && rule.requireMention === true) return 'group-needs-mention'
  }
    if (String(msg.text || '').length > cfg.maxTextLength) return 'text-too-long'
    return ''
  }

  /* -------------------------------------------------------------- 附件 */

  function saveAttachments(clientId, messageId, list) {
    if (clientId === null || clientId === '') return []
    if (!Array.isArray(list) || list.length === 0) return []
    if (list.length > MAX_FILES) throw new Error('too-many-attachments')
    const dir = path.join(ATT_DIR, safeName(clientId, 0), safeName(String(messageId).replace(/[:\\/]/g, '_'), 0))
    fs.mkdirSync(dir, { recursive: true })
    const out = []
    list.forEach((item, i) => {
      if (!item || typeof item.data !== 'string' || item.data === '') return
      const name = safeName(item.name, i)
      const buf = Buffer.from(item.data, 'base64')
      if (buf.length === 0) return
      if (buf.length > MAX_FILE) throw new Error('attachment-too-large:' + name)
      const target = path.join(dir, name)
      fs.writeFileSync(target, buf)
      out.push({ path: target, name, mime: String(item.mime || mimeOf(name)), bytes: buf.length })
    })
    return out
  }

  function withAttachmentText(text, saved) {
    if (saved.length === 0) return String(text || '')
    const lines = saved.map((s) => '- ' + s.path + '（' + s.mime + '，' + String(s.bytes) + ' 字节）')
    return (String(text || '').trim() === '' ? '' : text + '\n\n')
      + '[用户发来 ' + String(saved.length) + ' 个附件，可用文件工具直接读取]\n' + lines.join('\n')
  }

  /**
   * 从回复文本里提取 MEDIA: <路径> 并剥掉标记行。
   * AI 常把路径和后续正文写在同一行（如 "MEDIA: C:/x.sql在，收下"），
   * 因此先试整行匹配，再对行内 MEDIA: 做「最长存在文件」回退匹配。
   */
  function mediaFile(raw) {
    let target
    try { target = path.resolve(raw) } catch { return null }
    if (!MEDIA_ROOTS.some((root) => withinDir(root, target))) return null
    try {
      const st = fs.statSync(target)
      if (!st.isFile() || st.size > MAX_OUT) return null
      return { target, st }
    } catch { return null }
  }

  function extractMedia(text) {
    const files = []
    const kept = []
    let keptBeforeMedia = []
    let mediaSeen = false
    for (const line of String(text || '').split('\n')) {
      /* MEDIA: <路径>，路径后可能紧跟正文：统一从长到短找真实存在的文件 */
      const inline = /MEDIA:\s*(\S+)/.exec(line)
      if (inline === null) { kept.push(line); continue }
      const tail = inline[1]
      let hit = null
      let usedLen = 0
      for (let n = Math.min(tail.length, 600); n > 0; n -= 1) {
        const probe = tail.slice(0, n)
        const found = mediaFile(probe)
        if (found !== null) { hit = found; usedLen = n; break }
      }
      if (hit === null) { kept.push(line); continue }
      /* MEDIA 之前的正文先存着：路径后有话就用后面的，没话就回退用前面的 */
      if (!mediaSeen) { keptBeforeMedia = kept.slice(); kept.length = 0; mediaSeen = true }
      files.push({ name: path.basename(hit.target), mime: mimeOf(hit.target), bytes: hit.st.size, data: fs.readFileSync(hit.target).toString('base64') })
      const remain = tail.slice(usedLen).trim()
      if (remain !== '') kept.push(remain)
    }
    /* 路径后没有任何文字：保留 MEDIA 前那句，避免正文为空 */
    if (mediaSeen && kept.join('').trim() === '' && keptBeforeMedia.length > 0) {
      kept.push(...keptBeforeMedia)
    }
    return { text: kept.join('\n').trim(), attachments: files }
  }

  /* -------------------------------------------------------------- 人设 */

  const pkey = (clientId, chatKey) => clientId + '\u0000' + chatKey
  function personaBlock(p) {
    const head = p.name ? '【会话人设】你现在扮演「' + p.name + '」。' : '【会话人设】'
    return head + String(p.prompt).trim() + '\n（以上设定先于后续对话，请始终遵循，不要向用户复述这段设定）\n---\n'
  }
  function applyPersona(clientId, chatKey, text) {
    const key = pkey(clientId, chatKey)
    const p = personas.get(key)
    if (!p || !p.prompt) return { text, applied: false }
    if (p.injected === p.version) return { text, applied: false }
    p.injected = p.version
    persist()
    return { text: personaBlock(p) + text, applied: true }
  }

  /* -------------------------------------------------------------- 用户人设 + skill 包 */

  /* 默认人设：接收用户第一次来消息时自动创建，回答更像真人 */
  const DEFAULT_PERSONA_NAME = '默认助手'
  const DEFAULT_PERSONA_PROMPT = [
    '你在群聊或私聊里以真人身份说话，像一个熟悉的同事。',
    '说话规则：',
    '1) 简短自然，像微信聊天，不要用 Markdown 标题、不堆列表；',
    '2) 不要自称 AI，不要说「作为语言模型」，除非别人直接问；',
    '3) 有人叫你、问你、或 @ 你，就正常回答；没人问、纯闲聊时保持安静；',
    '4) 需要动手的活（查资料、看代码、写东西）直接做，用结果说话；',
    '5) 不确定的事别编，直接说不清楚或者去查一下。',
  ].join('\n')

  const SKILLS_ROOT = path.join(BASE_DIR, 'zhiliao', 'work', 'skills')
  const MAX_SKILL_ZIP = 20 * 1024 * 1024

  /** 纯 Node 读 zip 中央目录文件名（零依赖），用于 zip-slip 校验 */
  function zipEntryNames(buf) {
    let eocd = -1
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
      if (buf[i] === 0x50 && buf[i + 1] === 0x4b && buf[i + 2] === 0x05 && buf[i + 3] === 0x06) { eocd = i; break }
    }
    if (eocd < 0) throw new Error('不是合法的 zip 文件')
    const count = buf.readUInt16LE(eocd + 10)
    let off = buf.readUInt32LE(eocd + 16)
    const names = []
    for (let i = 0; i < count; i += 1) {
      if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break
      const nl = buf.readUInt16LE(off + 28)
      const el = buf.readUInt16LE(off + 30)
      const cl = buf.readUInt16LE(off + 32)
      names.push(buf.subarray(off + 46, off + 46 + nl).toString('utf8'))
      off += 46 + nl + el + cl
    }
    return names
  }

  function assertSafeZip(names) {
    for (const raw of names) {
      const n = String(raw).replace(/\\/g, '/')
      if (n === '' || n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..')) {
        throw new Error('skill 压缩包含非法路径：' + raw)
      }
    }
  }

  /** 解压 skill 包到该用户专属目录；系统自带 bsdtar/unzip，无 npm 依赖 */
  function extractSkills(senderId, buf, originalName) {
    const names = zipEntryNames(buf)
    assertSafeZip(names)
    const dest = path.join(SKILLS_ROOT, safeName(senderId, 0))
    /* 重新上传视为替换：先清空旧目录，避免新旧文件混在一起 */
    try { fs.rmSync(dest, { recursive: true, force: true }) } catch { /* 忽略 */ }
    fs.mkdirSync(dest, { recursive: true })
    const tmpZip = path.join(path.dirname(STATE_FILE), 'skill-' + crypto.randomUUID().slice(0, 12) + '.zip')
    fs.writeFileSync(tmpZip, buf)
    try {
      const exe = process.platform === 'win32' ? 'C:/Windows/System32/tar.exe' : 'tar'
      execFileSync(exe, ['-xf', tmpZip, '-C', dest], { timeout: 30000, stdio: 'ignore' })
    } finally {
      try { fs.unlinkSync(tmpZip) } catch { /* ignore */ }
    }
    const skills = names.filter((n) => !n.endsWith('/')).map((n) => ({
      name: path.basename(n),
      path: path.join(dest, n.replace(/\//g, path.sep)),
    }))
    return { dir: dest, skills, archive: String(originalName || 'skills.zip') }
  }

  /** 用户级人设：只做版本记账；正文改由插件写进 system prompt（不在会话里显示） */
  function applyUserPersona(ownerId, text) {
    const p = userPersonas.get(ownerId)
    if (!p || !p.prompt) return { text, applied: false }
    if (p.injected === p.version) return { text, applied: false }
    p.injected = p.version
    persist()
    return { text, applied: true }
  }

  /* -------------------------------------------------------------- 出站推送 */

  /** 把 message.out 发给所有「订阅了该 chatKey 且有 message.out 权限」的连接 */
  function pushOut(chatKey, payload) {
    let sent = 0
    for (const client of clients) {
      if (!has(client, 'message.out')) continue
      /* 同时受会话白名单约束（不能靠 server 端 push 绕过权限） */
      const permission = checkPermission(client, { senderId: '', chatKey, text: '', atBot: true })
      if (permission !== '' && permission !== 'user-not-allowed' && permission !== 'user-denied' && permission !== 'text-too-long') continue
      if (send(client, { type: 'message.out', ts: now(), ...payload })) {
        client.lastChatKey = payload.chatKey
        client.lastOutAt = now()
        sent += 1
      }
    }
    audit({ event: 'message.out', chatKey, messageId: payload.messageId, sent })
    return sent
  }

  /* -------------------------------------------------------------- 消息处理 */

  async function handleFrame(client, obj) {
    if (!obj || typeof obj !== 'object' || typeof obj.type !== 'string') {
      return error(client, '', 'bad.message', '消息必须是带 type 的 JSON 对象')
    }

    /* 首帧鉴权 */
    if (client.auth === null) {
      if (obj.type !== 'auth') {
        error(client, obj.requestId || 'auth', 'auth.required', '首帧必须是 auth')
        client.socket.end()
        return
      }
      const clientId = String(obj.clientId || '').trim()
      const cfg = loadClients().get(clientId)
      if (clientId === '' || !cfg || cfg.secret === '' || !safeEqual(cfg.secret, String(obj.token || ''))) {
        authFailures += 1
        lastAuthError = clientId === '' ? 'clientId 为空' : (cfg ? 'token 不匹配' : 'clientId 未登记')
        error(client, 'auth', 'auth.failed', 'bad clientId or token')
        client.socket.end()
        return
      }
      const wanted = Array.isArray(obj.capabilities) ? obj.capabilities.map(String) : cfg.capabilities
      const caps = wanted.filter((c) => cfg.capabilities.includes(c))
      client.auth = { clientId, cfg, capabilities: caps }
      /* 同一 clientId 只保留一条记录：重复连接复用它并更新在线状态 */
      let rec = [...connections.values()].find((r) => r.clientId === clientId)
      if (rec) {
        client.connectionId = rec.id
        rec.connected = true
        rec.connectedAt = now()
        rec.disconnectedAt = 0
      } else {
        rec = {
          id: client.connectionId, clientId, connected: true,
          connectedAt: now(), disconnectedAt: 0, lastMessageAt: 0, messageCount: 0,
          chatKeys: [], senderIds: [], receiverIds: [], receiverNames: {},
        }
        connections.set(client.connectionId, rec)
      }
      persist()
      send(client, {
        type: 'auth.ok', clientId, serverTime: now(),
        permissions: {
          'message.in': has(client, 'message.in'),
          'message.out': has(client, 'message.out'),
          push: has(client, 'push'),
          persona: has(client, 'persona'),
          attachment: has(client, 'attachment'),
        },
      })
      audit({ event: 'auth', action: 'ok', clientId })
      return
    }

    const clientId = client.auth.clientId

    if (obj.type === 'ping') {
      send(client, { type: 'pong', ts: Number(obj.ts) || now() })
      return
    }

    /* 入站消息 */
    if (obj.type === 'message.in') {
      if (!has(client, 'message.in')) return error(client, obj.requestId, 'permission.denied', 'no message.in capability')
      const requestId = String(obj.requestId || '').trim()
      const messageId = String(obj.messageId || '').trim()
      const chatKey = normalizeChatKey(obj.chatKey)
      const senderId = String(obj.senderId || '').trim()
      const senderName = String(obj.senderName || '').trim()
      /* 接收人 = dsh 这一侧（我们）：chatKey 形如 direct:<receiverId>:<senderId> */
      const receiverId = String(obj.receiverId || '').trim()
      if (chatKey !== '' && receiverId !== '') chatOwners.set(chatKey, receiverId)
      const receiverName = String(obj.receiverName || '').trim()
      const groupName = String(obj.groupName || '').trim()
      const atList = Array.isArray(obj.atList)
        ? obj.atList.map((v) => String(v).trim()).filter((v) => v !== '') : []
      const atBot = obj.atBot === true || (receiverId !== '' && atList.includes(receiverId))
      const hasAtt = Array.isArray(obj.attachments) && obj.attachments.length > 0
      const text = String(obj.text || '')
      /* /智聊 指令：AI 在当前会话处理完，把结果投到会话（默认当前会话，可指定目标），支持 @ 多人 */
      let replyToChatKey = ''
      let replyAtList = []
      let bodyText = text
      if (/^\/智聊(?:\s|$)/.test(text)) {
        let rest = text.replace(/^\/智聊\s*/, '')
        /* 可选目标：/智聊 group:g1 @u2 正文；不写目标就发当前会话 */
        const tk = rest.match(/^(direct:[^\s:]+:[^\s:]+|group:[^\s:]+)\s*/)
        replyToChatKey = tk !== null ? (normalizeChatKey(tk[1]) || '') : chatKey
        if (tk !== null) rest = rest.slice(tk[0].length)
        if (replyToChatKey === '') return error(client, requestId, 'bad.message', '目标 chatKey 非法')
        /* 可选 @：/智聊 @u2 @u3 正文 */
        while (true) {
          const at = rest.match(/^@(\S+)\s*/)
          if (at === null) break
          replyAtList.push(at[1])
          rest = rest.slice(at[0].length)
        }
        bodyText = rest.trim()
        if (bodyText === '') {
          return error(client, requestId, 'bad.message', '指令缺少正文，例：/智聊 帮我总结今天的待办；群聊可写 /智聊 @u2 内容')
        }
      }
      if (requestId === '' || messageId === '' || chatKey === '' || senderId === '' || (text.trim() === '' && !hasAtt)) {
        return error(client, requestId, 'bad.message', '需要 requestId/messageId/chatKey（direct:<接收人ID>:<发送人ID> 或 group:<群ID>）/senderId 以及 text 或 attachments')
      }
      const reason = checkPermission(client, { chatKey, senderId, receiverId, text, atBot })
      if (reason !== '') {
        audit({ event: 'message.in', action: 'deny', clientId, messageId, reason })
        send(client, { type: 'message.ack', requestId, messageId, accepted: false, reason })
        return
      }

      let saved = []
      try {
        saved = saveAttachments(clientId, messageId, obj.attachments)
      } catch (e) {
        return error(client, requestId, 'bad.message', String((e && e.message) || e))
      }
      routes.set(messageId, { clientId, chatKey, replyTo: messageId, ts: now() })
      const rec = connections.get(client.connectionId)
      if (rec) {
        rec.lastMessageAt = now()
        rec.messageCount += 1
        if (!rec.chatKeys.includes(chatKey)) rec.chatKeys.push(chatKey)
        if (!Array.isArray(rec.senderIds)) rec.senderIds = []
        if (!rec.senderIds.includes(senderId)) rec.senderIds.push(senderId)
        if (!Array.isArray(rec.receiverIds)) rec.receiverIds = []
        if (receiverId !== '') {
          if (!rec.receiverIds.includes(receiverId)) rec.receiverIds.push(receiverId)
          if (!rec.receiverNames || typeof rec.receiverNames !== 'object') rec.receiverNames = {}
          if (receiverName !== '') rec.receiverNames[receiverId] = receiverName
        }
      }
      persist()

      /* 用户级人设优先；没设过才回落旧的按会话人设（兼容 WS persona.set 帧） */
      /* 人设/规则按接收人（dsh 这一侧的用户） */
      const ownerId = receiverId !== '' ? receiverId : senderId
      /* 接收用户第一次来消息：自动建一个默认人设（之后可在面板里改） */
      if (!userPersonas.has(ownerId)) {
        userPersonas.set(ownerId, {
          name: DEFAULT_PERSONA_NAME,
          prompt: DEFAULT_PERSONA_PROMPT,
          version: now(),
          injected: 0,
          skills: [],
          auto: true,
        })
        persist()
        audit({ event: 'user-persona.default', receiverId: ownerId })
      }
      let finalText = applyUserPersona(ownerId, withAttachmentText(bodyText, saved))
      if (!finalText.applied) {
        const legacy = applyPersona(clientId, chatKey, finalText.text)
        finalText = { text: legacy.text, applied: legacy.applied }
      }
      audit({ event: 'message.in', action: 'accept', clientId, messageId, chatKey, attachments: saved.length, persona: finalText.applied })

      /* 驱动 agent：复用插件现有 handler */
      try {
        const result = await options.onInbound({
          msgId: clientId + ':' + messageId,
          requestId,
          chatKey,
          text: finalText.text,
          senderId,
          senderName: String(obj.senderName || ''),
          atBot,
          atList,
          receiverId,
          receiverName,
          senderName,
          groupName,
          clientId,
          /* 该用户的文件推送方式：base64 / binary */
          fileMode: (userRules.has(ownerId) && userRules.get(ownerId).fileMode === 'binary') ? 'binary' : 'base64',
          /* 首条消息：让插件把人设也带在正文里兜底（system prompt 万一没被读到也不丢人设） */
          firstMessage: rec !== undefined && rec !== null ? Number(rec.messageCount) <= 1 : true,
          /* 转发指令：把 AI 结果投到指定会话 */
          replyToChatKey,
          replyAtList,
          /* 会话级优先；会话没设过才用该用户默认 */
          requireConfirm: (() => {
            const cr = chatRules.get(chatKey)
            if (cr !== null && cr !== undefined && cr.requireConfirmSet === true) return cr.requireConfirm === true
            return userRules.has(ownerId) && userRules.get(ownerId).requireConfirm === true
          })(),
          userName: userRules.has(ownerId) ? String(userRules.get(ownerId).userName || '') : '',
          /* 人设与 skill 由插件写进 system prompt，隐藏、不在会话里刷屏 */
          personaName: userPersonas.has(ownerId) ? String(userPersonas.get(ownerId).name || '') : '',
          personaText: userPersonas.has(ownerId) ? String(userPersonas.get(ownerId).prompt || '') : '',
          personaSkills: userPersonas.has(ownerId) && Array.isArray(userPersonas.get(ownerId).skills)
            ? userPersonas.get(ownerId).skills.map((s) => s.path) : [],
        })
        send(client, {
          type: 'message.ack', requestId, messageId,
          accepted: result && result.ok !== false,
          queued: result && result.queued === true,
          ignored: result && result.ignored ? result.ignored : undefined,
          sessionId: result && result.sessionId ? result.sessionId : undefined,
          attachments: saved.length,
          personaApplied: finalText.applied,
          error: result && result.error ? String(result.error) : undefined,
        })
        /* 重复消息（命中 dedupe）：把缓存回复补投一次，避免客户端刷新后重发永远收不到 */
        if (result && result.dedupe === 'duplicate' && typeof result.reply === 'string' && result.reply.trim() !== '') {
          send(client, {
            type: 'message.out', ts: now(),
            messageId: 'r-dup-' + crypto.randomUUID().slice(0, 8),
            replyTo: messageId, chatKey,
            text: result.reply, attachments: [], atList: [], replayed: true,
          })
        }
        audit({ event: 'message.in', action: 'forward', clientId, messageId, ok: Boolean(result && result.ok !== false) })
      } catch (e) {
        error(client, requestId, 'internal.error', String((e && e.message) || e))
        audit({ event: 'message.in', action: 'error', clientId, messageId, error: String((e && e.message) || e) })
      }
      return
    }

    /* 人设 */
    if (obj.type === 'persona.set' || obj.type === 'persona.get' || obj.type === 'persona.delete') {
      if (!has(client, 'persona')) return error(client, obj.requestId, 'permission.denied', 'no persona capability')
      const chatKey = normalizeChatKey(obj.chatKey)
      if (chatKey === '') return error(client, obj.requestId, 'bad.message', 'chatKey 非法：必须形如 direct:<我方>:<对方> 或 group:<群ID>')
      const key = pkey(clientId, chatKey)
      let persona = null
      if (obj.type === 'persona.set') {
        const prompt = String(obj.prompt || '').trim()
        if (prompt === '') return error(client, obj.requestId, 'bad.message', 'prompt 不能为空')
        persona = { name: String(obj.name || '').trim().slice(0, 60), prompt: prompt.slice(0, 4000), version: now(), injected: 0 }
        personas.set(key, persona)
        persist()
      } else if (obj.type === 'persona.get') {
        persona = personas.get(key) || null
      } else {
        personas.delete(key)
        persist()
      }
      send(client, { type: 'persona.result', requestId: obj.requestId, ok: true, chatKey, persona })
      audit({ event: 'persona', action: obj.type, clientId, chatKey })
      return
    }

    /* 主动推送（WS 管理客户端） */
    if (obj.type === 'push.send') {
      if (!has(client, 'push')) return error(client, obj.requestId, 'permission.denied', 'no push capability')
      const chatKey = normalizeChatKey(obj.chatKey)
      const text = String(obj.text || '')
      if (chatKey === '' || (text.trim() === '' && !(Array.isArray(obj.attachments) && obj.attachments.length > 0))) {
        return error(client, obj.requestId, 'bad.message', '需要 chatKey 与 text/attachments')
      }
      if (client.auth.cfg.chats.allow.length > 0 && !client.auth.cfg.chats.allow.some((p) => matchChat(p, chatKey))) {
        return error(client, obj.requestId, 'permission.denied', 'chat-not-allowed')
      }
      const messageId = 'p-' + crypto.randomUUID().slice(0, 12)
      const atts = Array.isArray(obj.attachments) ? obj.attachments : []
      const out = atts.slice(0, MAX_FILES).map((a, i) => {
        const buf = Buffer.from(String((a && a.data) || ''), 'base64')
        const name = safeName(a && a.name, i)
        return { name, mime: String((a && a.mime) || mimeOf(name)), bytes: buf.length, data: buf.toString('base64') }
      })
      const atList = Array.isArray(obj.atList)
        ? obj.atList.map((v) => String(v).trim()).filter((v) => v !== '') : []
      const sent = pushOut(chatKey, { messageId, replyTo: '', chatKey, text, attachments: out, atList })
      send(client, { type: 'push.ack', requestId: obj.requestId, ok: true, messageId, sent })
      return
    }

    /* 客户端回执 */
    if (obj.type === 'message.out.ack') {
      audit({ event: 'message.out.ack', clientId, messageId: obj.messageId, ok: obj.ok === true })
      return
    }

    error(client, obj.requestId, 'bad.message', '未知 type：' + String(obj.type))
  }

  /* -------------------------------------------------------------- 服务器 */

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'))
    const route = url.pathname

    /* 插件回投：转成 message.out 帧（沿用现有 replyBaseUrl 机制） */
    if (route === '/internal/reply' || route === '/zhiliao/internal/reply') {
      readBody(req, MAX_FRAME).then((raw) => {
        let body = null
        try { body = JSON.parse(raw || '{}') } catch { body = null }
        if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: 'bad-json' })
        const requestId = String(body.requestId || '')
        const routeInfo = routes.get(requestId)
        if (!routeInfo) return sendJson(res, 404, { ok: false, error: 'unknown-requestId' })
        /* 转发指令：body.chatKey 可覆盖目标会话 */
        const targetChatKey = normalizeChatKey(body.chatKey) || routeInfo.chatKey
        const media = extractMedia(body.text)
        /* MEDIA: 提取的是 base64；接收用户配 binary 时同样存盘换成 URL */
        if (media.attachments.length > 0) {
          const ownerId = chatOwners.get(targetChatKey) || ''
          const rule = ownerId !== '' && userRules.has(ownerId) ? userRules.get(ownerId) : null
          const wantBinary = rule !== null && rule !== undefined
            ? rule.fileMode === 'binary'
            : [...userRules.values()].some((r) => r.fileMode === 'binary')
          if (wantBinary) {
            for (const a of media.attachments) {
              if (!a || typeof a.data !== 'string' || a.data === '') continue
              try {
                fs.mkdirSync(FILE_DIR, { recursive: true })
                const buf = Buffer.from(a.data, 'base64')
                const ext = path.extname(a.name || '').slice(0, 12)
                const stored = 'f-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex') + ext
                fs.writeFileSync(path.join(FILE_DIR, stored), buf)
                a.url = 'http://' + HOST + ':' + String(PORT) + '/file/' + stored
                a.mode = 'binary'
                delete a.data
              } catch { /* 存盘失败保留 base64 */ }
            }
          }
        }
        const messageId = 'r-' + crypto.randomUUID().slice(0, 12)
        /* 回复时可 @ 多人：插件解析 AI 文本里的 @<id> 后随 atList 下发 */
        const atList = Array.isArray(body.atList)
          ? body.atList.map((v) => String(v).trim()).filter((v) => v !== '') : []
        const sent = pushOut(targetChatKey, {
          messageId,
          replyTo: routeInfo.replyTo,
          chatKey: targetChatKey,
          text: media.text,
          attachments: media.attachments,
          atList,
        })
        routes.delete(requestId)
        persist()
        audit({ event: 'reply', action: 'deliver', requestId, messageId, sent })
        return sendJson(res, 200, { ok: sent > 0, delivered: sent > 0, messageId, sent })
      }).catch((error) => sendJson(res, 500, { ok: false, error: String((error && error.message) || error) }))
      return
    }

    /* 本地管理推送：插件面板 / 脚本 / agent 调它 */
    /* 二进制流推送：body 是文件原始字节，query 带 chatKey/name/mime/at */
    /* 二进制附件下载：客户端拿原始字节（支持 Range 简化为一次性返回） */
    if (route.startsWith('/file/') && (req.method === 'GET' || req.method === 'HEAD')) {
      let name = ''
      try { name = decodeURIComponent(route.slice('/file/'.length)) } catch { name = '' }
      const safe = path.basename(name)
      const target = path.join(FILE_DIR, safe)
      if (safe === '' || !target.startsWith(FILE_DIR)) return sendJson(res, 400, { ok: false, error: 'bad-path' })
      fs.readFile(target, (error, buf) => {
        if (error) return sendJson(res, 404, { ok: false, error: 'not-found' })
        try {
          res.writeHead(200, {
            'content-type': mimeOf(safe),
            'content-length': buf.length,
            'cache-control': 'no-store',
            'content-disposition': 'inline; filename="' + encodeURIComponent(safe) + '"',
          })
          if (req.method === 'HEAD') res.end()
          else res.end(buf)
        } catch { /* 连接已断 */ }
      })
      return
    }

    if (route === '/push-binary') {
      readBodyBuffer(req, 20 * 1024 * 1024).then((buf) => {
        if (!adminOk(req, ADMIN_TOKEN)) {
          return sendJson(res, 403, { ok: false, error: 'forbidden' })
        }
        if (buf === null || buf.length === 0) return sendJson(res, 400, { ok: false, error: 'empty-body' })
        let q = null
        try { q = new URLSearchParams(String(req.url || '').split('?')[1] || '') } catch { q = null }
        const chatKey = normalizeChatKey(q !== null ? q.get('chatKey') : '')
        if (chatKey === '') return sendJson(res, 400, { ok: false, error: 'chatKey-required' })
        const at = String((q !== null ? q.get('at') : '') || '').trim().replace(/^@/, '')

        /* 正文：支持 textFile（UTF-8 文件），也支持 JSON 模式里的 text */
        let bodyText = ''
        const textFile = String((q !== null ? q.get('textFile') : '') || '').trim()
        if (textFile !== '') {
          try {
            const st2 = fs.statSync(textFile)
            if (st2.isFile() && st2.size <= 1024 * 1024) bodyText = fs.readFileSync(textFile, 'utf8')
          } catch { bodyText = '' }
        }

        /* 把字节存盘 → URL（真二进制下发，客户端 GET 拿原始字节） */
        const store = (name, mime, bytes) => {
          try {
            fs.mkdirSync(FILE_DIR, { recursive: true })
            const ext = path.extname(name).slice(0, 12)
            const stored = 'f-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex') + ext
            fs.writeFileSync(path.join(FILE_DIR, stored), bytes)
            return { name, mime, bytes: bytes.length, url: 'http://' + HOST + ':' + String(PORT) + '/file/' + stored, mode: 'binary' }
          } catch {
            return { name, mime, bytes: bytes.length, data: bytes.toString('base64'), mode: 'binary' }
          }
        }

        let attachments = []
        const ctype = String(req.headers['content-type'] || '')
        if (ctype.includes('application/json')) {
          /* JSON 模式：一次带多个文件（base64 上传），服务端仍按二进制语义落盘给 URL */
          let payload = null
          try { payload = JSON.parse(buf.toString('utf8')) } catch { payload = null }
          if (payload === null || !Array.isArray(payload.files) || payload.files.length === 0) {
            return sendJson(res, 400, { ok: false, error: 'bad-files' })
          }
          const target = normalizeChatKey(payload.chatKey || '') || chatKey
          if (payload.text !== undefined && String(payload.text) !== '') bodyText = String(payload.text)
          /* @ 列表：body.atList 优先，query.at 兜底（支持多人 @） */
          const jsonAtList = Array.isArray(payload.atList)
            ? payload.atList.map((v) => String(v).trim().replace(/^@/, '')).filter((v) => v !== '') : []
          const finalAtList = jsonAtList.length > 0 ? jsonAtList : (at === '' ? [] : [at])
          for (const f of payload.files) {
            if (f === null || typeof f !== 'object') continue
            const nm = safeName(String(f.name || 'file.bin'), 0)
            const mm = String(f.mime || mimeOf(nm))
            let bytes = null
            try { bytes = Buffer.from(String(f.data || ''), 'base64') } catch { bytes = null }
            if (bytes !== null && bytes.length > 0) attachments.push(store(nm, mm, bytes))
          }
          if (attachments.length === 0) return sendJson(res, 400, { ok: false, error: 'no-valid-files' })
          const messageId = 'p-' + crypto.randomUUID().slice(0, 12)
          const sent = pushOut(target, { messageId, replyTo: '', chatKey: target, text: bodyText, attachments, atList: finalAtList })
          return sendJson(res, 200, {
            ok: true, delivered: sent > 0, messageId, sent, mode: 'binary', count: attachments.length,
            urls: attachments.map((a) => a.url).filter((u) => typeof u === 'string' && u !== ''),
            ...(sent === 0 ? { warning: 'no-client-online', hint: '服务正常，请求已受理；只是当前没有在线 IM 客户端（sent=0）。请让用户先连上 ws://<WS_HOST>:<WS_PORT>/ws 并完成 auth，不要重试或声称服务已挂，消息不会自动补发。' } : {}),
          })
        }

        /* 原模式：raw body 单文件 */
        const name = safeName((q !== null ? q.get('name') : '') || 'file.bin', 0)
        const mime = String((q !== null ? q.get('mime') : '') || mimeOf(name))
        const att = store(name, mime, buf)
        const messageId = 'p-' + crypto.randomUUID().slice(0, 12)
        const sent = pushOut(chatKey, {
          messageId, replyTo: '', chatKey, text: bodyText, attachments: [att],
          atList: at === '' ? [] : [at],
        })
        return sendJson(res, 200, {
          ok: true, delivered: sent > 0, messageId, sent, mode: 'binary', url: att.url,
          ...(sent === 0 ? { warning: 'no-client-online', hint: '服务正常，请求已受理；只是当前没有在线 IM 客户端（sent=0）。请让用户先连上 ws://<WS_HOST>:<WS_PORT>/ws 并完成 auth，不要重试或声称服务已挂，消息不会自动补发。' } : {}),
        })
      }).catch((error) => sendJson(res, 500, { ok: false, error: String((error && error.message) || error) }))
      return
    }

    if (route === '/push') {
      readBody(req, MAX_FRAME).then((raw) => {
        if (!adminOk(req, ADMIN_TOKEN)) {
          return sendJson(res, 403, { ok: false, error: 'forbidden' })
        }
        let body = null
        try { body = JSON.parse(raw || '{}') } catch { body = null }
        if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: 'bad-json' })
        const chatKey = normalizeChatKey(body.chatKey)
        let text = String(body.text || '')
        /* 正文可放在 UTF-8 文件里：Windows 命令行传中文会变 ???，走文件就不会 */
        const textFile = String(body.file || '').trim()
        if (textFile !== '') {
          try {
            const st = fs.statSync(textFile)
            if (!st.isFile()) return sendJson(res, 400, { ok: false, error: 'file-not-readable' })
            if (st.size > 1024 * 1024) return sendJson(res, 400, { ok: false, error: 'file-too-large' })
            text = fs.readFileSync(textFile, 'utf8')
          } catch {
            return sendJson(res, 400, { ok: false, error: 'file-not-readable' })
          }
        }
        if (chatKey === '' || text.trim() === '') return sendJson(res, 400, { ok: false, error: 'bad-args' })
        /* 二进制内容被当成正文（图片/文件没走 attachments）：拒收并指路 */
        if (/^(\u0089PNG|\u00FF\u00D8|GIF8)/.test(text) || text.indexOf('IHDR') >= 0 || text.indexOf('\u0000') >= 0) {
          return sendJson(res, 400, {
            ok: false,
            error: 'text-looks-binary',
            hint: '正文里是二进制内容。图片/文件请走 attachments: [{name, mime, data(base64)}]，或用 zhiliao-push.mjs 的 --image 参数。',
          })
        }
        /* 命令行传中文会变成 ?：直接拒绝并把正确用法告诉调用方 */
        if (textFile === '' && (text.trim().startsWith('???') || /\?\?/.test(text))) {
          return sendJson(res, 400, {
            ok: false,
            error: 'text-garbled',
            hint: '命令行传中文会变成 ?。请把正文写成 UTF-8 文件，然后执行 node ~/.dsh/dsh-buddy-expert-hub/zhiliao-push.mjs <chatKey> <该文件> [@uid]，或改用 file 字段。',
          })
        }
        const messageId = 'p-' + crypto.randomUUID().slice(0, 12)
        const atts = Array.isArray(body.attachments) ? body.attachments : []
        const out = atts.slice(0, MAX_FILES).map((a, i) => {
          const buf = Buffer.from(String((a && a.data) || ''), 'base64')
          const name = safeName(a && a.name, i)
          return { name, mime: String((a && a.mime) || mimeOf(name)), bytes: buf.length, data: buf.toString('base64') }
        })
        const atList = Array.isArray(body.atList)
          ? body.atList.map((v) => String(v).trim()).filter((v) => v !== '') : []
        /* 附件形态按该会话接收人的配置决定：binary → 存盘给 URL（无 data）；base64 → 直接给 data */
        const ownerId = chatOwners.get(chatKey) || ''
        const ownRule = ownerId !== '' && userRules.has(ownerId) ? userRules.get(ownerId) : null
        /* 内存映射没记录（群聊推送常不走 message.in）时：任一用户配了 binary 就按 binary */
        const wantBinary = ownRule !== null
          ? ownRule.fileMode === 'binary'
          : [...userRules.values()].some((r) => r.fileMode === 'binary')
        if (wantBinary) {
          for (const a of out) {
            if (!a || typeof a.data !== 'string' || a.data === '') continue
            try {
              fs.mkdirSync(FILE_DIR, { recursive: true })
              const buf = Buffer.from(a.data, 'base64')
              const ext = path.extname(a.name || '').slice(0, 12)
              const stored = 'f-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex') + ext
              fs.writeFileSync(path.join(FILE_DIR, stored), buf)
              a.url = 'http://' + HOST + ':' + String(PORT) + '/file/' + stored
              a.mode = 'binary'
              delete a.data
            } catch { /* 存盘失败就保留 base64 */ }
          }
        }
        const sent = pushOut(chatKey, { messageId, replyTo: '', chatKey, text, attachments: out, atList })
        /* ok = 接口处理成功；delivered = 是否有在线客户端收到（离线没有队列） */
        return sendJson(res, 200, {
          ok: true, delivered: sent > 0, messageId, sent,
          ...(sent === 0 ? { warning: 'no-client-online', hint: '服务正常，请求已受理；只是当前没有在线 IM 客户端（sent=0）。请让用户先连上 ws://<WS_HOST>:<WS_PORT>/ws 并完成 auth，不要重试或声称服务已挂，消息不会自动补发。' } : {}),
        })
      }).catch((error) => sendJson(res, 500, { ok: false, error: String((error && error.message) || error) }))
      return
    }

    /* 接收用户：按 receiverId 汇总 dsh 这一侧的用户，逐人设置群 @ / 发送确认 / 人设 */
    if (route === '/users' && req.method === 'GET') {
      if (!adminOk(req, ADMIN_TOKEN)) {
        return sendJson(res, 403, { ok: false, error: 'forbidden' })
      }
      const map = new Map()
      /* 每个接收人取「最新一条消息」上报的名称（按连接的最后消息时间/连接时间取最大） */
      const latestName = new Map()
      const ensure = (rid) => {
        if (!map.has(rid)) {
          map.set(rid, {
            receiverId: rid, receiverName: '', clientIds: [], requireMention: null,
            requireConfirm: false, userName: '', chatKeyCount: 0, chatKeys: [], chatRules: {}, fileMode: 'base64', persona: null,
          })
        }
        return map.get(rid)
      }
      for (const conn of connections.values()) {
        const recvIds = Array.isArray(conn.receiverIds) ? conn.receiverIds : []
        const ts = Number(conn.lastMessageAt) || Number(conn.connectedAt) || 0
        for (const rid of recvIds) {
          const row = ensure(rid)
          if (conn.clientId !== '' && !row.clientIds.includes(conn.clientId)) row.clientIds.push(conn.clientId)
          row.chatKeyCount += Array.isArray(conn.chatKeys) ? conn.chatKeys.length : 0
          for (const ck of (Array.isArray(conn.chatKeys) ? conn.chatKeys : [])) {
            if (!row.chatKeys.includes(ck)) row.chatKeys.push(ck)
          }
          const name = conn.receiverNames && typeof conn.receiverNames[rid] === 'string'
            ? String(conn.receiverNames[rid]).trim() : ''
          if (name !== '') {
            const prev = latestName.get(rid)
            if (prev === undefined || ts >= prev.ts) latestName.set(rid, { name, ts })
          }
        }
      }
      for (const [rid, rule] of userRules) {
        const row = ensure(rid)
        row.requireMention = rule.requireMention
        row.requireConfirm = rule.requireConfirm === true
        row.fileMode = rule.fileMode === 'binary' ? 'binary' : 'base64'
        row.userName = String(rule.userName || '')
      }
      for (const [key, cr] of chatRules) {
        if (cr === null || cr === undefined || cr.requireConfirmSet !== true) continue
        for (const u of map.values()) {
          if (u.chatKeys.includes(key)) u.chatRules[key] = cr.requireConfirm === true
        }
      }
      for (const u of map.values()) {
        /* 名称优先级：最新消息上报 > 手动设置 > 人设名 */
        const latest = latestName.get(u.receiverId)
        const p2 = userPersonas.get(u.receiverId)
        u.receiverName = (latest !== undefined ? latest.name : '')
          || u.userName
          || (p2 !== undefined && p2.name ? p2.name : '')
        u.persona = p2 !== undefined ? { name: p2.name, prompt: p2.prompt, skills: p2.skills || [], archive: p2.archive || '', auto: p2.auto === true } : null
      }
      return sendJson(res, 200, { ok: true, users: [...map.values()] })
    }
    if (route === '/user-rule' && req.method === 'POST') {
      if (!adminOk(req, ADMIN_TOKEN)) {
        return sendJson(res, 403, { ok: false, error: 'forbidden' })
      }
      readBody(req, MAX_FRAME).then((raw) => {
        let body = null
        try { body = JSON.parse(raw || '{}') } catch { body = null }
        /* 规则按接收人存；兼容旧的 senderId 字段名 */
        const targetId = body !== null && typeof body === 'object'
          ? String(body.receiverId || body.senderId || '').trim() : ''
        if (targetId === '') return sendJson(res, 400, { ok: false, error: 'bad-args' })
        const rule = {
          requireMention: body.requireMention === true,
          requireConfirm: body.requireConfirm === true,
          userName: String(body.userName || '').trim().slice(0, 60),
        }
        userRules.set(targetId, Object.assign({}, rule, {
          fileMode: body.fileMode === 'binary' ? 'binary' : 'base64',
        }))
        persist()
        audit({ event: 'user-rule.set', receiverId: targetId, requireMention: rule.requireMention, requireConfirm: rule.requireConfirm })
        return sendJson(res, 200, { ok: true, receiverId: targetId, rule })
      }).catch((error) => sendJson(res, 500, { ok: false, error: String((error && error.message) || error) }))
      return
    }

    /* 按会话设置 requireConfirm：chatKey 为空=恢复跟随用户默认 */
    if (route === '/chat-rule' && req.method === 'POST') {
      if (!adminOk(req, ADMIN_TOKEN)) {
        return sendJson(res, 403, { ok: false, error: 'forbidden' })
      }
      readBody(req, MAX_FRAME).then((raw) => {
        let body = null
        try { body = JSON.parse(raw || '{}') } catch { body = null }
        const b = body !== null && typeof body === 'object' ? body : {}
        /* 批量：rules={chatKey:bool} 设覆盖，clear=[chatKey] 清覆盖；单条模式保留兼容 */
        if (b.rules !== null && typeof b.rules === 'object' && !Array.isArray(b.rules)) {
          let changed = 0
          for (const [key, value] of Object.entries(b.rules)) {
            const ck = normalizeChatKey(key)
            if (ck === '' || typeof value !== 'boolean') continue
            chatRules.set(ck, { requireConfirm: value, requireConfirmSet: true })
            changed += 1
          }
          if (Array.isArray(b.clear)) {
            for (const key of b.clear) {
              const ck = normalizeChatKey(key)
              if (ck !== '') chatRules.delete(ck)
            }
          }
          persist()
          audit({ event: 'chat-rule.batch', set: changed, cleared: Array.isArray(b.clear) ? b.clear.length : 0 })
          return sendJson(res, 200, { ok: true, mode: 'batch', set: changed, count: chatRules.size })
        }
        const chatKey = normalizeChatKey(b.chatKey)
        if (chatKey === '') return sendJson(res, 400, { ok: false, error: 'bad-args' })
        if (Object.prototype.hasOwnProperty.call(b, 'requireConfirm') && typeof b.requireConfirm === 'boolean') {
          chatRules.set(chatKey, { requireConfirm: b.requireConfirm, requireConfirmSet: true })
        } else {
          /* 没带 requireConfirm = 删除覆盖，回到用户默认 */
          chatRules.delete(chatKey)
        }
        persist()
        audit({ event: 'chat-rule.set', chatKey, requireConfirmSet: chatRules.has(chatKey) })
        return sendJson(res, 200, {
          ok: true, chatKey,
          rule: chatRules.has(chatKey) ? chatRules.get(chatKey) : { requireConfirmSet: false },
        })
      }).catch((error) => sendJson(res, 500, { ok: false, error: String((error && error.message) || error) }))
      return
    }

    /* 按用户设置人设 + skill 压缩包（面板表单用） */
    if (route === '/user-persona' && req.method === 'POST') {
      if (!adminOk(req, ADMIN_TOKEN)) {
        return sendJson(res, 403, { ok: false, error: 'forbidden' })
      }
      readBody(req, MAX_FRAME).then((raw) => {
        let body = null
        try { body = JSON.parse(raw || '{}') } catch { body = null }
        if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: 'bad-json' })
        const targetId = String(body.receiverId || body.senderId || '').trim()
        const prompt = String(body.prompt || '').trim()
        if (targetId === '' || prompt === '') return sendJson(res, 400, { ok: false, error: '需要 receiverId 与 prompt' })
        let unpacked = null
        try {
          if (body.skill !== null && typeof body.skill === 'object'
            && typeof body.skill.data === 'string' && body.skill.data !== '') {
            const buf = Buffer.from(body.skill.data, 'base64')
            if (buf.length === 0) throw new Error('压缩包为空')
            if (buf.length > MAX_SKILL_ZIP) throw new Error('压缩包超过 20MB')
            unpacked = extractSkills(targetId, buf, body.skill.name)
          }
        } catch (error) {
          return sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
        }
        const old = userPersonas.get(targetId)
        const persona = {
          name: String(body.name || '').trim().slice(0, 60),
          prompt: prompt.slice(0, 4000),
          version: now(),
          injected: 0,
          skills: unpacked !== null ? unpacked.skills : (old !== undefined && Array.isArray(old.skills) ? old.skills : []),
          skillDir: unpacked !== null ? unpacked.dir : (old !== undefined ? old.skillDir : ''),
          archive: unpacked !== null ? unpacked.archive : (old !== undefined ? old.archive : ''),
        }
        userPersonas.set(targetId, persona)
        persist()
        audit({ event: 'user-persona.set', receiverId: targetId, skills: persona.skills.length })
        return sendJson(res, 200, { ok: true, persona })
      }).catch((error) => sendJson(res, 500, { ok: false, error: String((error && error.message) || error) }))
      return
    }

    /* 断开连接：只断开 socket，保留连接记录 */
    if (route === '/connection-disconnect' && req.method === 'POST') {
      if (!adminOk(req, ADMIN_TOKEN)) {
        return sendJson(res, 403, { ok: false, error: 'forbidden' })
      }
      readBody(req, MAX_FRAME).then((raw) => {
        let body = null
        try { body = JSON.parse(raw || '{}') } catch { body = null }
        const id = body !== null && typeof body === 'object' ? String(body.connectionId || '') : ''
        const rec = connections.get(id)
        if (id === '' || rec === undefined) return sendJson(res, 404, { ok: false, error: 'connection-not-found' })
        for (const c of clients) {
          if (c.connectionId === id) {
            try { c.socket.end() } catch { /* ignore */ }
            clients.delete(c)
          }
        }
        rec.connected = false
        rec.disconnectedAt = now()
        persist()
        audit({ event: 'connection.disconnect', connectionId: id, clientId: rec.clientId })
        return sendJson(res, 200, { ok: true, disconnected: true })
      }).catch((error) => sendJson(res, 500, { ok: false, error: String((error && error.message) || error) }))
      return
    }

    /* 删除用户：清该用户的人设/群@规则，并从连接记录里移除（连接本身保留） */
    if (route === '/user-delete' && req.method === 'POST') {
      if (!adminOk(req, ADMIN_TOKEN)) {
        return sendJson(res, 403, { ok: false, error: 'forbidden' })
      }
      readBody(req, MAX_FRAME).then((raw) => {
        let body = null
        try { body = JSON.parse(raw || '{}') } catch { body = null }
        const targetId = body !== null && typeof body === 'object'
          ? String(body.receiverId || body.senderId || '').trim() : ''
        if (targetId === '') return sendJson(res, 400, { ok: false, error: 'bad-args' })
        userPersonas.delete(targetId)
        userRules.delete(targetId)
        for (const conn of connections.values()) {
          if (Array.isArray(conn.receiverIds)) conn.receiverIds = conn.receiverIds.filter((s) => s !== targetId)
        }
        persist()
        audit({ event: 'user.delete', receiverId: targetId })
        return sendJson(res, 200, { ok: true, deleted: true, receiverId: targetId })
      }).catch((error) => sendJson(res, 500, { ok: false, error: String((error && error.message) || error) }))
      return
    }

    /* 连接管理：断开保留、手动删除、按连接设置人设（管理令牌） */
    if (route === '/connections' && (req.method === 'GET' || req.method === 'DELETE')) {
      if (!adminOk(req, ADMIN_TOKEN)) {
        return sendJson(res, 403, { ok: false, error: 'forbidden' })
      }
      if (req.method === 'GET') {
        /* 只回在线连接：断开的、未鉴权的都不展示 */
      const list = [...connections.values()]
          .filter((r) => r.connected === true && r.clientId !== '')
          .map((r) => ({ ...r }))
          .sort((a, b) => Number(b.connectedAt || 0) - Number(a.connectedAt || 0))
        return sendJson(res, 200, {
          ok: true,
          connections: list,
          failed: authFailures,
          lastError: lastAuthError,
        })
      }
      const id = String(url.searchParams.get('id') || '')
      const rec = connections.get(id)
      if (!rec) return sendJson(res, 404, { ok: false, error: 'connection-not-found' })
      /* 删除 = 断开活跃连接 + 清掉该 clientId 的人设/回投路由；下次连接是全新记录 */
      for (const c of clients) if (c.connectionId === id) { try { c.socket.destroy() } catch { /* ignore */ } }
      const prefix = rec.clientId + '\u0000'
      for (const k of [...personas.keys()]) if (k.startsWith(prefix)) personas.delete(k)
      for (const [k, v] of [...routes]) if (v.clientId === rec.clientId) routes.delete(k)
      connections.delete(id)
      persist()
      audit({ event: 'connection.delete', connectionId: id, clientId: rec.clientId })
      return sendJson(res, 200, { ok: true, deleted: true })
    }

    if (route === '/persona' && req.method === 'POST') {
      if (!adminOk(req, ADMIN_TOKEN)) {
        return sendJson(res, 403, { ok: false, error: 'forbidden' })
      }
      readBody(req, MAX_FRAME).then((raw) => {
        let body = null
        try { body = JSON.parse(raw || '{}') } catch { body = null }
        if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: 'bad-json' })
        const rec = connections.get(String(body.connectionId || ''))
        const chatKey = normalizeChatKey(body.chatKey)
        const prompt = String(body.prompt || '').trim()
        if (!rec || chatKey === '' || prompt === '') return sendJson(res, 400, { ok: false, error: 'bad-args' })
        const key = pkey(rec.clientId, chatKey)
        const persona = { name: String(body.name || '').trim().slice(0, 60), prompt: prompt.slice(0, 4000), version: now(), injected: 0 }
        personas.set(key, persona)
        persist()
        audit({ event: 'persona.set', connectionId: rec.id, clientId: rec.clientId, chatKey })
        return sendJson(res, 200, { ok: true, persona })
      }).catch((error) => sendJson(res, 500, { ok: false, error: String((error && error.message) || error) }))
      return
    }

    if (route === '/healthz') return sendJson(res, 200, { ok: true, clients: clients.size, connections: connections.size, pending: routes.size })
    return sendJson(res, 404, { ok: false, error: 'not-found' })
  })

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://' + (req.headers.host || 'localhost'))
    if (url.pathname !== '/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }
    const key = String(req.headers['sec-websocket-key'] || '')
    if (key === '') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
      socket.destroy()
      return
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64')
    socket.write('HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\nConnection: Upgrade\r\n'
      + 'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n')

    const connectionId = 'c-' + crypto.randomUUID().slice(0, 12)
    const client = { socket, auth: null, lastSeen: now(), buffer: Buffer.alloc(0), connectionId }
    clients.add(client)
    /* 未鉴权不建记录：避免刷新/重连刷出一堆「未鉴权·已断开」空行 */
    socket.setNoDelay(true)

    socket.on('data', (chunk) => {
      client.lastSeen = now()
      client.buffer = Buffer.concat([client.buffer, chunk])
      let parsed
      try { parsed = parseFrames(client.buffer) } catch (error) {
        audit({ event: 'frame-error', error: String((error && error.message) || error) })
        socket.destroy()
        return
      }
      client.buffer = parsed.rest
      for (const frame of parsed.frames) {
        if (frame.type === 'ping') { socket.write(encodeFrame(frame.payload, 0xa)); continue }
        if (frame.type === 'pong') continue
        if (frame.type === 'close') { socket.end(); continue }
        if (frame.type === 'text') {
          if (frame.text.length > MAX_TEXT) { error(client, '', 'bad.message', 'message-too-large'); continue }
          let obj = null
          try { obj = JSON.parse(frame.text) } catch { error(client, '', 'bad.message', 'invalid-json'); continue }
          void handleFrame(client, obj).catch((e) => error(client, obj && obj.requestId, 'internal.error', String((e && e.message) || e)))
        }
      }
    })

    socket.on('error', () => { clients.delete(client) })
    socket.on('close', (hadError) => {
      clients.delete(client)
      const rec = connections.get(client.connectionId)
      if (rec) { rec.connected = false; rec.disconnectedAt = now(); persist() }
      audit({
        event: 'close',
        clientId: client.auth !== null ? client.auth.clientId : '',
        reason: hadError === true ? 'socket-error' : 'normal',
        lifetimeMs: now() - Number(client.connectedAt || now()),
        lastSeenMsAgo: now() - Number(client.lastSeen || now()),
        chatKey: client.lastChatKey || '',
      })
    })
  })

  const heartbeat = setInterval(() => {
    const t = now()
    for (const client of clients) {
      const idle = t - Number(client.lastSeen || t)
      if (idle > HEARTBEAT_MS) {
        audit({ event: 'timeout', clientId: client.auth ? client.auth.clientId : '',
          lastSeenMsAgo: idle, lastOutMsAgo: t - Number(client.lastOutAt || t) })
        try { client.socket.end() } catch { /* 已断开 */ }
        continue
      }
      /* 主动 ping：WebSocket 标准帧 opcode 0x9，客户端自动回 pong（pong 会更新 lastSeen） */
      if (idle >= WS_PING_MS) {
        try {
          client.socket.write(encodeFrame(Buffer.alloc(0), 0x9))
          client.lastPingAt = t
        } catch { /* 写失败交给超时处理 */ }
      }
    }
  }, 10000)
  heartbeat.unref()

  /* 端口被占用等错误必须捕获：未处理的 'error' 事件会让整个宿主进程退出 */
  server.on('error', (error) => {
    const code = String((error && error.code) || '')
    audit({ event: 'listen-error', host: HOST, port: PORT, code, error: String((error && error.message) || error) })
    console.warn('[zhiliao-ws] 监听 ' + HOST + ':' + String(PORT) + ' 失败（' + code + '）：'
      + String((error && error.message) || error))
  })

  /** 删除 FILE_DIR 下 mtime 超过 7 天的文件；只处理普通文件，防目录穿越 */
  let removedFiles = 0
  function cleanupOldFiles() {
    let removed = 0
    try {
      if (!fs.existsSync(FILE_DIR)) return
      const cutoff = Date.now() - FILE_TTL_MS
      for (const name of fs.readdirSync(FILE_DIR)) {
        const safe = path.basename(name)
        if (safe !== name || safe === '') continue
        const target = path.join(FILE_DIR, safe)
        try {
          const st = fs.statSync(target)
          if (!st.isFile()) continue
          if (st.mtimeMs < cutoff) {
            fs.unlinkSync(target)
            removed += 1
          }
        } catch { /* 单个文件失败跳过，不影响其它 */ }
      }
      if (removed > 0) {
        removedFiles += removed
        audit({ event: 'file-cleanup', removed, retainedDays: retainDays })
      }
    } catch { /* 目录不可读就跳过 */ }
  }
  /* 启动时先清一次（长期运行避免历史积压），之后每 7 天 */
  cleanupOldFiles()
  const fileCleanupTimer = setInterval(cleanupOldFiles, FILE_TTL_MS)
  if (typeof fileCleanupTimer.unref === 'function') fileCleanupTimer.unref()

  server.listen(PORT, HOST, () => {
    audit({ event: 'listen', host: HOST, port: PORT, configPath: CONFIG_PATH })
  })

  /*
   * 服务绑在局域网地址时，AI / 老脚本常写死 127.0.0.1:<port>，会 ECONNREFUSED。
   * 额外开一个回环 TCP 代理转发到真实 HOST:PORT —— 不动主 server，WS 升级帧也能透传。
   */
  let loopbackProxy = null
  const isLoopbackHost = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1' || HOST === '0.0.0.0' || HOST === ''
  if (!isLoopbackHost) {
    loopbackProxy = net.createServer((local) => {
      const remote = net.connect(PORT, HOST)
      local.pipe(remote)
      remote.pipe(local)
      local.on('error', () => remote.destroy())
      remote.on('error', () => local.destroy())
      /* 一端关闭时主动关另一端，避免半开连接累积 */
      local.on('close', () => remote.destroy())
      remote.on('close', () => local.destroy())
    })
    loopbackProxy.on('error', (error) => {
      /* 端口已被占用就不抢，记录后继续 */
      audit({ event: 'loopback-proxy-error', error: String((error && error.message) || error), port: PORT })
    })
    loopbackProxy.listen(PORT, '127.0.0.1', () => {
      audit({ event: 'loopback-proxy-listen', host: '127.0.0.1', port: PORT, target: HOST })
    })
  }

  return {
    server,
    cleanupOldFiles,
    removedFiles() { return removedFiles },
    push(chatKey, text, attachments) {
      const messageId = 'p-' + crypto.randomUUID().slice(0, 12)
      const out = Array.isArray(attachments) ? attachments : []
      const sent = pushOut(chatKey, { messageId, replyTo: '', chatKey, text: String(text || ''), attachments: out })
      return { messageId, sent }
    },
    close() {
      clearInterval(heartbeat)
      clearInterval(fileCleanupTimer)
      if (loopbackProxy !== null) {
        try { loopbackProxy.close() } catch { /* 已关 */ }
      }
      for (const client of clients) { try { client.socket.end() } catch { /* ignore */ } }
      clients.clear()
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
}
