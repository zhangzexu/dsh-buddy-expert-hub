/**
 * dsh-buddy-expert-hub — 智聊（ZhiLiao）状态层。
 *
 * 阶段 0 只有 dedupe 表；阶段 2 补齐 bindings / sessions 两表与待发草稿。
 * 三个表各自一个 JSON 文件，阶段 0 的 `zhiliao/dedupe.json`（里面预留了
 * bindings / sessions 字段）会被自动迁移到新文件，老数据不丢。
 *
 * 设计要点（仿 lib/ingest.js）：
 *  - 零 npm 依赖，只用 node: 内置模块 + 同仓 csv.js 的原子写；
 *  - 读坏 / 结构不符的文件一律当空表，不让一条脏记录卡住整条链路；
 *  - 导出的状态函数都是「读进来 → 改内存对象 → 由调用方 save」的纯逻辑，
 *    只有 load/save 碰磁盘，便于单测与并发推理；
 *  - 一个 BINDING 对多个 CHAT_SESSION：每个 chatKey 独立 dshSessionId，
 *    私聊对与群各自独立上下文（用户决策 #2）。
 *
 * @module dsh-buddy-expert-hub/zhiliao
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import { atomicWrite } from './csv.js'

/** 智聊状态文件格式版本（v3：zhiliao-server API Key / convKey 绑定）。 */
export const ZHILIAO_STATE_VERSION = 3

/** 默认 webhook secret（与 HuLa Server 阶段 1 的默认值一致）。 */
export const ZHILIAO_DEFAULT_SECRET = 'zhiliao-dev-secret'

/** 阶段 0 遗留的测试 token（仅在 testMode 打开时认）。 */
export const ZHILIAO_TEST_TOKEN = 'zhiliao-test-token'

/** dedupe 表最多保留多少条，超出按时间砍最老的。 */
const DEDUPE_KEEP_MAX = 5000

/** binding 的合法 id 形状。 */
const BINDING_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/

/**
 * 智聊目录布局。
 * @param {string} baseDir 插件数据根目录（`~/.dsh/dsh-buddy-expert-hub`）
 * @returns {{root: string, work: string, dedupe: string, bindings: string, sessions: string, pending: string}} 路径集合
 */
export function zhiliaoPaths(baseDir) {
  const root = path.join(String(baseDir), 'zhiliao')
  return {
    root,
    work: path.join(root, 'work'),
    dedupe: path.join(root, 'dedupe.json'),
    bindings: path.join(root, 'bindings.json'),
    sessions: path.join(root, 'sessions.json'),
    pending: path.join(root, 'pending.json'),
  }
}

/**
 * 生成一张空状态表。
 * @returns {{version: number, bindings: Object<string, any>, sessions: Object<string, any>, dedupe: Object<string, any>, pending: Object<string, any>}} 空状态
 */
function emptyState() {
  return { version: ZHILIAO_STATE_VERSION, bindings: {}, sessions: {}, dedupe: {}, pending: {} }
}

/**
 * 安全读取一个 JSON 对象文件。
 * @param {string} file 文件路径
 * @returns {Object<string, any>|null} 对象或 null
 */
function readObjectFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 从磁盘读一次三表；阶段 0 的 dedupe.json 里若还带着 bindings / sessions 字段，
 * 用它补齐（平滑迁移，不丢老数据）。
 * @param {string} baseDir 插件数据根目录
 * @returns {{version: number, bindings: Object<string, any>, sessions: Object<string, any>, dedupe: Object<string, any>, pending: Object<string, any>}} 状态对象
 */
function loadFromDisk(baseDir) {
  const paths = zhiliaoPaths(baseDir)
  const legacy = readObjectFile(paths.dedupe) || {}
  const rawBindings = readObjectFile(paths.bindings)
  const rawSessions = readObjectFile(paths.sessions)
  const rawPending = readObjectFile(paths.pending)
  const state = emptyState()
  // 三表文件都写成 `{version, <表名>: {...}}`；老文件可能直接是裸 map，两种都认。
  const unwrap = (raw, name) => {
    if (raw === null) return null
    if (raw[name] !== null && typeof raw[name] === 'object' && !Array.isArray(raw[name])) return raw[name]
    return raw
  }
  const legacyBindings = legacy.bindings !== null && typeof legacy.bindings === 'object' && !Array.isArray(legacy.bindings) ? legacy.bindings : {}
  const legacySessions = legacy.sessions !== null && typeof legacy.sessions === 'object' && !Array.isArray(legacy.sessions) ? legacy.sessions : {}
  const srcBindings = unwrap(rawBindings, 'bindings') || legacyBindings
  const srcSessions = unwrap(rawSessions, 'sessions') || legacySessions
  const srcDedupe = legacy.dedupe !== null && typeof legacy.dedupe === 'object' && !Array.isArray(legacy.dedupe) ? legacy.dedupe : {}
  const srcPending = unwrap(rawPending, 'pending') || {}
  if (srcBindings !== null && typeof srcBindings === 'object' && !Array.isArray(srcBindings)) state.bindings = srcBindings
  if (srcSessions !== null && typeof srcSessions === 'object' && !Array.isArray(srcSessions)) state.sessions = srcSessions
  if (srcDedupe !== null && typeof srcDedupe === 'object' && !Array.isArray(srcDedupe)) state.dedupe = srcDedupe
  if (srcPending !== null && typeof srcPending === 'object' && !Array.isArray(srcPending)) state.pending = srcPending
  return normalizeState(state)
}

/**
 * 归一化状态（补默认表、裁剪 dedupe）。
 * @param {any} state 原始状态对象
 * @returns {{version: number, bindings: Object<string, any>, sessions: Object<string, any>, dedupe: Object<string, any>, pending: Object<string, any>}} 归一化状态
 */
function normalizeState(state) {
  const next = state !== null && typeof state === 'object' ? state : {}
  const asObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {}
  const bindings = asObject(next.bindings)
  for (const key of Object.keys(bindings)) {
    const normalized = normalizeBinding(bindings[key], Date.now())
    if (normalized !== null) bindings[key] = normalized
  }
  const sessions = asObject(next.sessions)
  const pending = asObject(next.pending)
  const dedupe = asObject(next.dedupe)
  // 记账只需覆盖「最近可能重复投递」的窗口：按 at 排序砍掉最老的一批。
  const keys = Object.keys(dedupe)
  if (keys.length > DEDUPE_KEEP_MAX) {
    const sorted = keys.sort((a, b) => {
      const ta = dedupe[a] !== null && typeof dedupe[a] === 'object' ? Number(dedupe[a].at) || 0 : 0
      const tb = dedupe[b] !== null && typeof dedupe[b] === 'object' ? Number(dedupe[b].at) || 0 : 0
      return ta - tb
    })
    for (const key of sorted.slice(0, keys.length - DEDUPE_KEEP_MAX)) delete dedupe[key]
  }
  return { version: ZHILIAO_STATE_VERSION, bindings, sessions, pending, dedupe }
}

/**
 * 把归一化状态写盘（四文件原子写）。失败会 throw，由调用方决定保留 dirty。
 * @param {string} baseDir 插件数据根目录
 * @param {{bindings: Object<string, any>, sessions: Object<string, any>, dedupe: Object<string, any>, pending: Object<string, any>}} state 归一化状态
 * @returns {void}
 */
function writeState(baseDir, state) {
  const paths = zhiliaoPaths(baseDir)
  const stamp = (value) => JSON.stringify(value, null, 2) + '\n'
  atomicWrite(paths.bindings, stamp({ version: ZHILIAO_STATE_VERSION, bindings: state.bindings }))
  atomicWrite(paths.sessions, stamp({ version: ZHILIAO_STATE_VERSION, sessions: state.sessions }))
  atomicWrite(paths.pending, stamp({ version: ZHILIAO_STATE_VERSION, pending: state.pending }))
  // dedupe.json 仍保留 bindings / sessions 空镜像：阶段 0 的老代码若被回滚也能读到结构。
  atomicWrite(paths.dedupe, stamp({
    version: ZHILIAO_STATE_VERSION,
    bindings: {},
    sessions: {},
    dedupe: state.dedupe,
  }))
}

/* --------------------------------------------------------- 缓存 / 写锁 / 合并落盘 */

/** 进程内唯一真源；只在 withZhiliaState 内被原地修改。 */
let stateCache = null
/** 缓存对应的数据根目录（换目录时重新加载）。 */
let stateCacheDir = ''
/** 有未落盘修改。 */
let stateDirty = false
/** 已排了一次合并落盘（同一 tick 多次修改只写一次）。 */
let flushScheduled = false
/** 最近一次落盘失败原因；失败时保留 dirty 等下次重试。 */
let flushError = ''
/** 事务串行链：保证同一时刻只有一个 mutator 在改内存 state。 */
let stateChain = Promise.resolve()
/** 已排入但还没跑完的事务数：用于决定「立即落盘」还是「合并落盘」。 */
let pendingTx = 0

/**
 * 深拷贝一份状态（给只读调用方，避免它们绕过写锁改到缓存）。
 * @param {any} value 状态
 * @returns {any} 拷贝
 */
function cloneState(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * 读取智聊状态。命中缓存时返回**拷贝**，调用方随意读；要改必须走 withZhiliaState。
 * @param {string} baseDir 插件数据根目录
 * @returns {{version: number, bindings: Object<string, any>, sessions: Object<string, any>, dedupe: Object<string, any>, pending: Object<string, any>}} 状态快照
 */
export function loadZhiliaState(baseDir) {
  const dir = String(baseDir)
  if (stateCache !== null && stateCacheDir === dir) return cloneState(stateCache)
  return loadFromDisk(dir)
}

/**
 * 直接落盘一个状态对象（保留阶段 0 语义与签名：写盘后更新缓存）。
 * 并发场景请优先用 `withZhiliaState`，否则仍可能用旧快照覆盖别人的写。
 * @param {string} baseDir 插件数据根目录
 * @param {any} state 状态对象
 * @returns {void}
 */
export function saveZhiliaState(baseDir, state) {
  const dir = String(baseDir)
  const normalized = normalizeState(state)
  writeState(dir, normalized)
  stateCache = normalized
  stateCacheDir = dir
  stateDirty = false
  flushError = ''
}

/**
 * 合并落盘调度：同一 tick 的多次事务只触发一次写盘。
 * @param {string} fallbackDir 无缓存时的兜底目录
 * @returns {void}
 */
function scheduleFlush(fallbackDir) {
  if (flushScheduled === true) return
  flushScheduled = true
  setImmediate(() => {
    flushScheduled = false
    if (stateDirty !== true || stateCache === null) return
    try {
      writeState(stateCacheDir !== '' ? stateCacheDir : String(fallbackDir), stateCache)
      stateDirty = false
      flushError = ''
    } catch (error) {
      flushError = String((error !== null && typeof error === 'object' && error.message) || error)
      // 保留 dirty：下一次写事务会再次尝试落盘；同时留一条可观测告警。
      // eslint-disable-next-line no-console
      console.warn('[zhiliao] 状态落盘失败，保留 dirty 待重试：' + flushError + '（dirty=' + String(stateDirty) + '）')
    }
  })
}

/**
 * 立即落盘未写的修改（不抛异常，失败保留 dirty）。
 * @returns {void}
 */
function flushNow() {
  if (stateDirty !== true || stateCache === null) return
  try {
    writeState(stateCacheDir, stateCache)
    stateDirty = false
    flushError = ''
  } catch (error) {
    flushError = String((error !== null && typeof error === 'object' && error.message) || error)
    // eslint-disable-next-line no-console
    console.warn('[zhiliao] 状态落盘失败，保留 dirty 待重试：' + flushError)
  }
}

/**
 * 在一次串行事务里读-改内存状态，退出后标 dirty 并落盘。
 *
 * 落盘策略：**没有其它事务在场时立即同步落盘**（把「内存有、磁盘没有」的窗口压到 0）；
 * 并发突发时用 `scheduleFlush` 合并成一次写，避免 16 并发反复整表写。
 *
 * **锁内禁止 await 网络 / LLM**，只做内存改动；否则 16 并发会被串成 1 并发。
 *
 * @template T
 * @param {string} baseDir 插件数据根目录
 * @param {(state: Object<string, any>) => T|Promise<T>} mutator 修改函数
 * @returns {Promise<T>} mutator 返回值
 */
export function withZhiliaState(baseDir, mutator) {
  const dir = String(baseDir)
  pendingTx += 1
  const run = stateChain.then(async () => {
    if (stateCache === null || stateCacheDir !== dir) {
      stateCache = loadFromDisk(dir)
      stateCacheDir = dir
      stateDirty = false
    }
    try {
      return await mutator(stateCache)
    } finally {
      // mutator 抛错时也可能已经改了一半内存状态：必须照样标 dirty 并落盘，
      // 否则「内存有、磁盘没有」，重启后表现为账本丢条目。
      stateDirty = true
      pendingTx -= 1
      if (pendingTx === 0) flushNow()
      else scheduleFlush(dir)
    }
  })
  // 链上只保留完成信号：一次事务失败不能毒死后续所有写。
  stateChain = run.then(() => undefined, () => undefined)
  return run
}

/**
 * 立即落盘未写的修改（优雅退出 / 测试用）。
 * @returns {{ok: boolean, dirty: boolean, error: string}} 结果
 */
export function flushZhiliaState() {
  if (stateDirty !== true || stateCache === null) return { ok: true, dirty: false, error: '' }
  try {
    writeState(stateCacheDir, stateCache)
    stateDirty = false
    flushError = ''
    return { ok: true, dirty: false, error: '' }
  } catch (error) {
    flushError = String((error !== null && typeof error === 'object' && error.message) || error)
    return { ok: false, dirty: true, error: flushError }
  }
}

/**
 * 丢弃内存缓存，下次从磁盘重读（外部改了文件 / 测试注入场景）。
 * @returns {void}
 */
export function invalidateZhiliaState() {
  stateCache = null
  stateCacheDir = ''
  stateDirty = false
  flushError = ''
}

/**
 * 状态缓存健康快照（排障用）。
 * @returns {{dirty: boolean, lastError: string, cached: boolean}} 诊断
 */
export function zhiliaStateDiagnostics() {
  return { dirty: stateDirty === true, lastError: flushError, cached: stateCache !== null }
}

/* ---------------------------------------------------------------- dedupe */

/**
 * 查 dedupe 条目。调用方自己决定「哪些 status 算重复」。
 * @param {{dedupe?: Object<string, any>}} state 状态对象
 * @param {string} msgId 消息 id
 * @returns {{status: string, reply: string, at: number}|null} 条目或 null
 */
export function checkDedupe(state, msgId) {
  const table = state !== null && typeof state === 'object' && state.dedupe !== null
    && typeof state.dedupe === 'object' ? state.dedupe : {}
  const key = String(msgId || '')
  if (key === '') return null
  const entry = table[key]
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
  return entry
}

/**
 * 标记「处理中」：调用方在 create 之前写入，落盘后形成互斥账本。
 * @param {{dedupe?: Object<string, any>}} state 状态对象
 * @param {string} msgId 消息 id
 * @returns {{status: string, reply: string, at: number}} 新条目
 */
export function markProcessing(state, msgId) {
  const table = state.dedupe
  const entry = { status: 'processing', reply: '', at: Date.now() }
  table[String(msgId)] = entry
  return entry
}

/**
 * 标记「完成」并缓存回复文本。
 * @param {{dedupe?: Object<string, any>}} state 状态对象
 * @param {string} msgId 消息 id
 * @param {string} reply 最终回复文本
 * @returns {{status: string, reply: string, at: number}} 新条目
 */
export function markDone(state, msgId, reply) {
  const table = state.dedupe
  const entry = { status: 'done', reply: typeof reply === 'string' ? reply : '', at: Date.now() }
  table[String(msgId)] = entry
  return entry
}

/**
 * 标记「失败」：失败条目不算重复，可以立即重放。
 * @param {{dedupe?: Object<string, any>}} state 状态对象
 * @param {string} msgId 消息 id
 * @param {string} error 错误信息（仅记账，不回传）
 * @returns {{status: string, reply: string, at: number, error: string}} 新条目
 */
export function markFailed(state, msgId, error) {
  const table = state.dedupe
  const entry = {
    status: 'failed',
    reply: '',
    at: Date.now(),
    error: typeof error === 'string' ? error.slice(0, 500) : '',
  }
  table[String(msgId)] = entry
  return entry
}

/**
 * 清掉崩溃遗留的「处理中」条目，允许重放；done 条目不动。
 * @param {{dedupe?: Object<string, any>}} state 状态对象
 * @param {number} [maxAgeMs=300000] 超过这个年龄的 processing 视为僵死
 * @returns {number} 被清掉的条目数
 */
export function resetStaleProcessing(state, maxAgeMs = 5 * 60 * 1000) {
  const table = state !== null && typeof state === 'object' && state.dedupe !== null
    && typeof state.dedupe === 'object' ? state.dedupe : {}
  const now = Date.now()
  const maxAge = Number.isFinite(Number(maxAgeMs)) ? Math.max(0, Number(maxAgeMs)) : 5 * 60 * 1000
  let reset = 0
  for (const key of Object.keys(table)) {
    const entry = table[key]
    if (entry === null || typeof entry !== 'object' || entry.status !== 'processing') continue
    const at = Number(entry.at)
    if (!Number.isFinite(at) || now - at > maxAge) {
      delete table[key]
      reset += 1
    }
  }
  return reset
}

/**
 * chatKey → 稳定 sessionId。
 * @param {string} chatKey 会话键，如 `direct:uidA:uidB` / `group:gid`
 * @returns {string} `zhiliao-` + sha256 前 32 位十六进制
 */
export function stableSessionId(chatKey) {
  return 'zhiliao-' + createHash('sha256').update(String(chatKey || '')).digest('hex').slice(0, 32)
}

/* ---------------------------------------------------------------- binding */

/**
 * 把一条原始 binding 归一到完整字段（缺省值集中在这里，面板/处理器共享）。
 * @param {any} raw 原始对象
 * @param {number} now 当前时间戳
 * @returns {Object<string, any>|null} 归一后的 binding；bindingId 非法返回 null
 */
function normalizeBinding(raw, now) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const bindingId = String(raw.bindingId || '').trim()
  if (!BINDING_ID_RE.test(bindingId)) return null
  const scope = raw.scope !== null && typeof raw.scope === 'object' && !Array.isArray(raw.scope) ? raw.scope : {}
  const groups = Array.isArray(scope.groups)
    ? scope.groups.filter((v) => typeof v === 'string' && v !== '').slice(0, 200)
    : []
  let dshSessionId = String(raw.dshSessionId || '').trim()
  if (dshSessionId === '') dshSessionId = 'zhiliao-binding-' + stableSessionId(bindingId).slice('zhiliao-'.length)
  /* 已标记待重绑的旧绑定：跨重启保留 needsRebind/legacy，不能因为字段已迁移而丢失。 */
  if (raw.needsRebind === true) {
    return {
      bindingId,
      dshSessionId,
      baseUrl: String(raw.baseUrl || '').trim(),
      apiKeyRef: '',
      aiId: '',
      userId: String(raw.userId || '').trim(),
      displayName: String(raw.displayName || '').trim().slice(0, 80) || String(raw.userId || '') || bindingId,
      takeoverDefault: false,
      enabled: false,
      autoReply: raw.autoReply !== false,
      requireConfirm: raw.requireConfirm === true,
      replyPrefix: String(raw.replyPrefix || '').slice(0, 200),
      scope: { groups, mentionOnly: scope.mentionOnly !== false, dms: scope.dms !== false },
      needsRebind: true,
      legacy: raw.legacy !== null && typeof raw.legacy === 'object' ? raw.legacy : {},
      createdAt: Number(raw.createdAt) > 0 ? Number(raw.createdAt) : now,
      updatedAt: Number(raw.updatedAt) > 0 ? Number(raw.updatedAt) : now,
    }
  }
  /* v2/HuLa 绑定：保留原字段到 legacy 供排查，标 needsRebind，不静默丢弃。 */
  const legacyHuLa = typeof raw.hulaUid === 'string' || typeof raw.tokenRef === 'string'
    || typeof raw.identityType === 'string' || typeof raw.replyBaseUrl === 'string'
  const userId = String(raw.userId || raw.hulaUid || '').trim()
  if (legacyHuLa && String(raw.apiKeyRef || '') === '') {
    return {
      bindingId,
      dshSessionId,
      baseUrl: String(raw.baseUrl || raw.replyBaseUrl || '').trim(),
      apiKeyRef: '',
      aiId: '',
      userId,
      displayName: String(raw.displayName || '').trim().slice(0, 80) || userId || bindingId,
      enabled: false,
      autoReply: raw.autoReply !== false,
      requireConfirm: raw.requireConfirm === true,
      replyPrefix: String(raw.replyPrefix || '').slice(0, 200),
      scope: { groups, mentionOnly: scope.mentionOnly !== false, dms: scope.dms !== false },
      needsRebind: true,
      legacy: {
        hulaUid: String(raw.hulaUid || '').trim(),
        identityType: raw.identityType === 'bot' ? 'bot' : 'original-user',
        botUid: String(raw.botUid || '').trim(),
        tokenRef: String(raw.tokenRef || '').trim(),
        tokenStatus: String(raw.tokenStatus || ''),
        replyBaseUrl: String(raw.replyBaseUrl || '').trim(),
        paused: raw.paused === true,
      },
      createdAt: Number(raw.createdAt) > 0 ? Number(raw.createdAt) : now,
      updatedAt: Number(raw.updatedAt) > 0 ? Number(raw.updatedAt) : now,
    }
  }
  if (userId === '' && String(raw.apiKeyRef || '') === '') return null
  return {
    bindingId,
    dshSessionId,
    baseUrl: String(raw.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKeyRef: String(raw.apiKeyRef || '').trim(),
    aiId: String(raw.aiId || '').trim(),
    userId,
    displayName: String(raw.displayName || '').trim().slice(0, 80) || userId || bindingId,
    takeoverDefault: raw.takeoverDefault === true,
    enabled: raw.enabled !== false,
    autoReply: raw.autoReply !== false,
    requireConfirm: raw.requireConfirm === true,
    replyPrefix: String(raw.replyPrefix || '').slice(0, 200),
    scope: { groups, mentionOnly: scope.mentionOnly !== false, dms: scope.dms !== false },
    createdAt: Number(raw.createdAt) > 0 ? Number(raw.createdAt) : now,
    updatedAt: Number(raw.updatedAt) > 0 ? Number(raw.updatedAt) : now,
  }
}

/**
 * 列出绑定（按创建时间升序）。
 * @param {{bindings?: Object<string, any>}} state 状态对象
 * @returns {Object<string, any>[]} 绑定数组
 */
export function listBindings(state) {
  const table = state !== null && typeof state === 'object' && state.bindings !== null
    && typeof state.bindings === 'object' ? state.bindings : {}
  return Object.keys(table)
    .map((key) => table[key])
    .filter((b) => b !== null && typeof b === 'object')
    .sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0))
}

/**
 * 创建 / 更新一条绑定（幂等，保留 createdAt）。
 * @param {{bindings?: Object<string, any>}} state 状态对象
 * @param {any} raw 绑定字段
 * @returns {Object<string, any>|null} 保存后的 binding；非法返回 null
 */
export function saveBinding(state, raw) {
  const now = Date.now()
  const binding = normalizeBinding(raw, now)
  if (binding === null) return null
  const old = state.bindings[binding.bindingId]
  if (old !== null && typeof old === 'object') {
    binding.createdAt = Number(old.createdAt) > 0 ? Number(old.createdAt) : now
    if (binding.apiKeyRef === '') binding.apiKeyRef = String(old.apiKeyRef || '')
  }
  binding.updatedAt = now
  state.bindings[binding.bindingId] = binding
  return binding
}

/**
 * 删除绑定（sessions 历史保留但标 archived，便于追溯）。
 * @param {{bindings?: Object<string, any>, sessions?: Object<string, any>}} state 状态对象
 * @param {string} bindingId 绑定 id
 * @returns {boolean} 是否删掉了绑定
 */
export function removeBinding(state, bindingId) {
  const key = String(bindingId || '')
  if (key === '' || !Object.prototype.hasOwnProperty.call(state.bindings, key)) return false
  delete state.bindings[key]
  for (const chatKey of Object.keys(state.sessions)) {
    const session = state.sessions[chatKey]
    if (session !== null && typeof session === 'object' && session.bindingId === key) {
      session.status = 'archived'
      session.lastActiveAt = Date.now()
    }
  }
  return true
}

/**
 * 按 id 查绑定。
 * @param {{bindings?: Object<string, any>}} state 状态对象
 * @param {string} bindingId 绑定 id
 * @returns {Object<string, any>|null} 绑定或 null
 */
export function findBindingById(state, bindingId) {
  const key = String(bindingId || '')
  const found = state !== null && typeof state === 'object' && state.bindings !== null
    && typeof state.bindings === 'object' ? state.bindings[key] : null
  return found !== null && typeof found === 'object' ? found : null
}

/**
 * 按 zhiliao-server userId 查第一个绑定（保留旧函数名兼容调用方）。
 * @param {{bindings?: Object<string, any>}} state 状态对象
 * @param {string} userId 用户 id
 * @returns {Object<string, any>|null} 绑定或 null
 */
export function findBindingByUserId(state, userId) {
  const uid = String(userId || '')
  if (uid === '') return null
  for (const binding of listBindings(state)) {
    if (binding.userId === uid) return binding
  }
  return null
}

export const findBindingByHulaUid = findBindingByUserId

/* ------------------------------------------------------------ chat session */

/**
 * 取或建一个 chatKey → dshSessionId 映射；同一 chatKey 永远同一个 id。
 * @param {{sessions?: Object<string, any>}} state 状态对象
 * @param {string} chatKey 会话键
 * @param {string} bindingId 所属绑定 id
 * @param {string} cwd 工作目录（全表统一）
 * @returns {Object<string, any>} chat session 条目
 */
export function getOrCreateChatSession(state, chatKey, bindingId, cwd) {
  const key = String(chatKey || '')
  const found = state.sessions[key]
  if (found !== null && typeof found === 'object' && !Array.isArray(found)) {
    // 旧映射缺 cwd / bindingId 时补齐，不换 dshSessionId（上下文必须稳定）。
    let changed = false
    if (typeof found.cwd !== 'string' || found.cwd === '') { found.cwd = String(cwd || ''); changed = true }
    if (typeof found.bindingId !== 'string' || found.bindingId === '') { found.bindingId = String(bindingId || ''); changed = true }
    if (!Number.isFinite(Number(found.lastSeq))) { found.lastSeq = 0; changed = true }
    if (found.status !== 'active') { found.status = 'active'; changed = true }
    if (changed) found.lastActiveAt = Date.now()
    return found
  }
  const now = Date.now()
  const session = {
    chatKey: key,
    dshSessionId: stableSessionId(key),
    bindingId: String(bindingId || ''),
    cwd: String(cwd || ''),
    lastMsgId: '',
    followCursor: 0,
    lastSeq: 0,
    lastActiveAt: now,
    status: 'active',
    createdAt: now,
  }
  state.sessions[key] = session
  return session
}

/**
 * 查 chat session。
 * @param {{sessions?: Object<string, any>}} state 状态对象
 * @param {string} chatKey 会话键
 * @returns {Object<string, any>|null} 条目或 null
 */
export function findChatSession(state, chatKey) {
  const found = state !== null && typeof state === 'object' && state.sessions !== null
    && typeof state.sessions === 'object' ? state.sessions[String(chatKey || '')] : null
  return found !== null && typeof found === 'object' && !Array.isArray(found) ? found : null
}

/**
 * 局部更新 chat session（白名单字段）。
 * @param {{sessions?: Object<string, any>}} state 状态对象
 * @param {string} chatKey 会话键
 * @param {Object<string, any>} patch 待更新字段
 * @returns {Object<string, any>|null} 更新后的条目；不存在返回 null
 */
export function updateChatSession(state, chatKey, patch) {
  const session = findChatSession(state, chatKey)
  if (session === null) return null
  const allowed = ['lastMsgId', 'followCursor', 'lastSeq', 'lastActiveAt', 'status', 'bindingId', 'cwd']
  for (const key of allowed) {
    if (patch !== null && typeof patch === 'object' && Object.prototype.hasOwnProperty.call(patch, key)) {
      session[key] = patch[key]
    }
  }
  return session
}

/* ----------------------------------------------------------- pending reply */

/**
 * 存一条待发草稿（requireConfirm=true 时用）。同一 msgId 重复调用不覆盖已有草稿。
 * @param {{pending?: Object<string, any>}} state 状态对象
 * @param {string} msgId 消息 id
 * @param {Object<string, any>} payload 草稿字段
 * @returns {Object<string, any>} 草稿条目
 */
export function savePendingReply(state, msgId, payload) {
  const key = String(msgId || '')
  const old = state.pending[key]
  if (old !== null && typeof old === 'object' && !Array.isArray(old)) return old
  const entry = {
    msgId: key,
    chatKey: String((payload && (payload.convKey || payload.chatKey)) || ''),
    convKey: String((payload && (payload.convKey || payload.chatKey)) || ''),
    bindingId: String((payload && payload.bindingId) || ''),
    text: String((payload && payload.text) || ''),
    atUidList: Array.isArray(payload && payload.atUidList) ? payload.atUidList.map((v) => String(v)) : [],
    replyToMsgId: key,
    at: Date.now(),
  }
  state.pending[key] = entry
  return entry
}

/**
 * 查待发草稿。
 * @param {{pending?: Object<string, any>}} state 状态对象
 * @param {string} msgId 消息 id
 * @returns {Object<string, any>|null} 草稿或 null
 */
export function findPendingReply(state, msgId) {
  const found = state !== null && typeof state === 'object' && state.pending !== null
    && typeof state.pending === 'object' ? state.pending[String(msgId || '')] : null
  return found !== null && typeof found === 'object' && !Array.isArray(found) ? found : null
}

/**
 * 列出全部待发草稿（按时间升序）。
 * @param {{pending?: Object<string, any>}} state 状态对象
 * @returns {Object<string, any>[]} 草稿数组
 */
export function listPendingReplies(state) {
  const table = state !== null && typeof state === 'object' && state.pending !== null
    && typeof state.pending === 'object' ? state.pending : {}
  return Object.keys(table)
    .map((key) => table[key])
    .filter((p) => p !== null && typeof p === 'object')
    .sort((a, b) => Number(a.at || 0) - Number(b.at || 0))
}

/**
 * 删掉待发草稿（发送成功或用户丢弃）。
 * @param {{pending?: Object<string, any>}} state 状态对象
 * @param {string} msgId 消息 id
 * @returns {boolean} 是否删掉
 */
export function removePendingReply(state, msgId) {
  const key = String(msgId || '')
  if (key === '' || !Object.prototype.hasOwnProperty.call(state.pending, key)) return false
  delete state.pending[key]
  return true
}

/* ------------------------------------------------------- webhook 验签 / 路由 */

/**
 * HMAC-SHA256 验签，恒定时间比对。
 * @param {Buffer|string} rawBody 原始请求体字节（绝不能用 JSON.parse 后的字符串）
 * @param {string} sign header x-zhiliao-sign 的值
 * @param {string} secret webhook secret；为空时用默认 secret
 * @returns {boolean} 是否匹配
 */
export function verifyWebhookSign(rawBody, sign, secret) {
  const received = String(sign || '')
  if (!/^[a-fA-F0-9]{64}$/.test(received)) return false
  const key = String(secret || '') !== '' ? String(secret) : ZHILIAO_DEFAULT_SECRET
  const expected = createHmac('sha256', key).update(rawBody).digest('hex')
  const a = Buffer.from(received, 'hex')
  const b = Buffer.from(expected, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * 按 payload 解析该消息该由哪条绑定处理（含群 @ 规则与 paused/disabled 过滤）。
 * @param {{bindings?: Object<string, any>}} state 状态对象
 * @param {{bindingId?: string, chatKey?: string, from?: string, atList?: string[], roomId?: string}} payload webhook 载荷
 * @returns {{binding: Object<string, any>|null, ignored: string}} 命中绑定或忽略原因
 */
export function resolveBinding(state, payload) {
  const p = payload !== null && typeof payload === 'object' ? payload : {}
  const convKey = String(p.convKey || p.chatKey || '')
  const senderId = String(p.senderId || p.from || '')
  const atList = Array.isArray(p.atList) ? p.atList.map((v) => String(v)) : []
  const isGroup = convKey.startsWith('g_')
  const isDirect = convKey.startsWith('s_')
  let binding = findBindingById(state, p.bindingId)

  if (binding === null) {
    if (isGroup) {
      // 群：@ 列表命中绑定的 userId/aiId；未配置 mentionOnly 的空 @ 群消息取第一条启用绑定。
      for (const b of listBindings(state)) {
        if (atList.includes(b.userId) || (b.aiId !== '' && atList.includes(b.aiId))) { binding = b; break }
      }
      if (binding === null && atList.length === 0) {
        binding = listBindings(state).find((b) => b.enabled === true && b.needsRebind !== true) || null
      }
    } else if (isDirect) {
      // s_<minUserId>_<maxUserId>：绑定 userId 是参与者，发送者是对端。
      const rest = convKey.slice(2)
      const sep = rest.indexOf('_')
      const a = sep > 0 ? rest.slice(0, sep) : ''
      const b = sep > 0 ? rest.slice(sep + 1) : ''
      for (const bindingItem of listBindings(state)) {
        if (bindingItem.userId === senderId) continue
        if (bindingItem.userId === a || bindingItem.userId === b) { binding = bindingItem; break }
      }
    }
  }
  if (binding === null) {
    if (isGroup && atList.length > 0) return { binding: null, ignored: 'mention-not-hit' }
    return { binding: null, ignored: 'no-binding' }
  }
  if (binding.needsRebind === true) return { binding, ignored: 'needs-rebind' }
  if (binding.enabled !== true) return { binding, ignored: 'disabled' }
  if (isGroup && binding.scope.mentionOnly !== false) {
    const hit = atList.includes(binding.userId) || (binding.aiId !== '' && atList.includes(binding.aiId))
    if (!hit) return { binding, ignored: 'mention-not-hit' }
  }
  return { binding, ignored: '' }
}

export default {
  ZHILIAO_STATE_VERSION,
  ZHILIAO_DEFAULT_SECRET,
  ZHILIAO_TEST_TOKEN,
  zhiliaoPaths,
  loadZhiliaState,
  saveZhiliaState,
  withZhiliaState,
  flushZhiliaState,
  invalidateZhiliaState,
  zhiliaStateDiagnostics,
  checkDedupe,
  markProcessing,
  markDone,
  markFailed,
  resetStaleProcessing,
  stableSessionId,
  listBindings,
  saveBinding,
  removeBinding,
  findBindingById,
  findBindingByHulaUid,
  getOrCreateChatSession,
  findChatSession,
  updateChatSession,
  savePendingReply,
  findPendingReply,
  listPendingReplies,
  removePendingReply,
  verifyWebhookSign,
  resolveBinding,
}
