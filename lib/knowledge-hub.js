/**
 * dsh-buddy-expert-hub — 在线资料库（Knowledge Hub）客户端。
 *
 * 零 npm 依赖，只用 Node 内置 fetch。职责边界：
 *  - 只负责「配置读取 / 认证 / HTTP 契约 / 树形目录合成」，不碰插件 state、不写文件；
 *  - 敏感凭据从 credentials.enc 读（复用 connector-secret），绝不落 state.json、绝不回显；
 *  - 所有数据请求用用户 API Key（PAT）走 `Authorization: Bearer`，clientId/clientSecret
 *    只用于「客户端接入校验」(POST /api/open/auth/client)，与数据权限解耦；
 *  - 统一把 R{code,message,data} 拆成 data，非 0 一律抛 KhubError，供上层决定是否回落本地。
 *
 * 在线服务契约（来自 knowledge-hub/docs/03-api.md 与服务端源码）：
 *  GET  /api/spaces                     空间列表  [{id,name,type,nodeCount,...}]
 *  GET  /api/spaces/{id}/tree            目录树（递归 children）
 *  GET  /api/nodes/{id}/children        子节点
 *  GET  /api/nodes/{id}/content         {id,version,content}   文本正文
 *  PUT  /api/nodes/{id}/content         {content,baseVersion}    乐观锁，冲突 409
 *  GET  /api/nodes/{id}/csv             {name,version,headers,matrix,text,...}
 *  PUT  /api/nodes/{id}/csv/matrix      {matrix,baseVersion}    整表覆盖，冲突 409
 *  POST /api/nodes                      新建
 *  PUT  /api/nodes/{id}                 重命名 / 移动
 *  DELETE /api/nodes/{id}               递归软删除（无恢复端点）
 *
 * @module dsh-buddy-expert-hub/knowledge-hub
 */

import { readSecrets } from './connector-secret.js'

/** clientSecret 在 credentials.enc 里的键名。 */
export const KHUB_CLIENT_SECRET_KEY = 'DSH_KHUB_CLIENT_SECRET'
/** 用户 API Key（PAT）在 credentials.enc 里的键名。 */
export const KHUB_API_KEY_KEY = 'DSH_KHUB_API_KEY'

/** 非敏感配置默认值（存 state.json）。 */
export const KHUB_DEFAULT_SETTINGS = { baseUrl: '', clientId: '', enabled: true }

/** 在线请求默认超时：够本机/内网，又不让不可达后端拖住面板。 */
export const KHUB_TIMEOUT_MS = 6000

/**
 * 可判定的在线错误。code 用字符串，便于上层按 code 决定提示与回落。
 */
export class KhubError extends Error {
  /**
   * @param {string} message 中文可读信息
   * @param {string} code 机器码（not-configured / timeout / network / bad-response / api）
   * @param {number} status HTTP 状态码（无则 0）
   */
  constructor(message, code, status) {
    super(message)
    this.name = 'KhubError'
    this.code = String(code || 'api')
    this.status = Number(status || 0)
  }
}

/** 去尾斜杠、去空白；只接受 http(s)，拒绝其它协议与非法字符。 */
export function normalizeBaseUrl(raw) {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (text === '') return ''
  if (!/^https?:\/\//i.test(text)) return ''
  if (/[\u0000-\u001f\u007f\s]/.test(text)) return ''
  let parsed
  try { parsed = new URL(text) } catch { return '' }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
  if (!parsed.hostname) return ''
  return (parsed.origin + parsed.pathname.replace(/\/+$/, '')).replace(/\/+$/, '')
}

/** baseUrl 是否可用。 */
export function isValidBaseUrl(raw) {
  return normalizeBaseUrl(raw) !== ''
}

/**
 * 把 state 里的非敏感字段 + 加密文件里的敏感字段合成运行时配置。
 * @param {object|null} settings state.settings.khub
 * @param {string} baseDir 插件数据目录（credentials.enc 所在目录）
 * @returns {{baseUrl: string, clientId: string, clientSecret: string, apiKey: string, enabled: boolean}}
 */
export function configFromSettings(settings, baseDir) {
  const raw = settings !== null && typeof settings === 'object' && !Array.isArray(settings) ? settings : {}
  let secrets = {}
  try { secrets = readSecrets(baseDir) } catch { /* 读不到就当没配 */ }
  return {
    baseUrl: normalizeBaseUrl(raw.baseUrl),
    clientId: typeof raw.clientId === 'string' ? raw.clientId.trim().slice(0, 120) : '',
    clientSecret: typeof secrets[KHUB_CLIENT_SECRET_KEY] === 'string' ? secrets[KHUB_CLIENT_SECRET_KEY] : '',
    apiKey: typeof secrets[KHUB_API_KEY_KEY] === 'string' ? secrets[KHUB_API_KEY_KEY] : '',
    /* 只有显式 false 才算关闭；没有该字段（旧配置 / 新填）一律视为开启。 */
    enabled: raw.enabled !== false,
  }
}

/** 是否具备发起数据请求的最小条件（启用 + 地址 + PAT）。 */
export function configReady(config) {
  return config !== null && typeof config === 'object' &&
    config.enabled !== false && config.baseUrl !== '' && config.apiKey !== ''
}

/**
 * 供 GET /khub/settings 回显：绝不返回密钥明文。
 * @param {object|null} settings state.settings.khub
 * @param {string} baseDir 插件数据目录
 * @returns {object} 可安全下发给前端的字段
 */
export function publicSettings(settings, baseDir) {
  const config = configFromSettings(settings, baseDir)
  return {
    ok: true,
    baseUrl: config.baseUrl,
    clientId: config.clientId,
    enabled: config.enabled,
    apiKeyConfigured: config.apiKey !== '',
    clientSecretConfigured: config.clientSecret !== '',
    ready: configReady(config),
  }
}

/**
 * 调在线资料库。任何失败都抛 KhubError，调用方 catch 后回落本地。
 * @param {object} config configFromSettings 的结果
 * @param {{method?: string, path: string, body?: any, timeoutMs?: number}} options
 * @returns {Promise<any>} R.data
 */
export async function khubRequest(config, options) {
  const opts = options !== null && typeof options === 'object' ? options : {}
  if (config === null || typeof config !== 'object' || config.baseUrl === '') {
    throw new KhubError('尚未配置在线资料库服务地址', 'not-configured')
  }
  if (!config.apiKey) throw new KhubError('尚未配置在线资料库用户 API Key', 'not-configured')
  const method = String(opts.method || 'GET').toUpperCase()
  const url = config.baseUrl + String(opts.path || '')
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : KHUB_TIMEOUT_MS
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers = { Accept: 'application/json', Authorization: 'Bearer ' + config.apiKey }
    if (opts.body !== undefined && opts.body !== null) headers['Content-Type'] = 'application/json'
    const resp = await fetch(url, {
      method,
      headers,
      body: opts.body === undefined || opts.body === null ? undefined : JSON.stringify(opts.body),
      signal: controller.signal,
    })
    let json
    try { json = await resp.json() } catch {
      throw new KhubError('在线资料库返回的不是 JSON（HTTP ' + String(resp.status) + '）', 'bad-response', resp.status)
    }
    if (json === null || typeof json !== 'object') {
      throw new KhubError('在线资料库响应格式异常', 'bad-response', resp.status)
    }
    if (!resp.ok || Number(json.code) !== 0) {
      const msg = String(json.message || ('HTTP ' + String(resp.status)))
      throw new KhubError(msg, String(json.code === undefined ? resp.status : json.code), resp.status)
    }
    return json.data
  } catch (error) {
    if (error instanceof KhubError) throw error
    if (error !== null && typeof error === 'object' && error.name === 'AbortError') {
      throw new KhubError('连接在线资料库超时（' + String(timeoutMs) + 'ms）', 'timeout')
    }
    throw new KhubError('连接在线资料库失败：' + String((error && error.message) || error), 'network')
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 取原始字节（图片 / PDF / 其它附件）。
 *
 * 与 khubRequest 的区别：不解析 R 包装，直接回 Buffer + Content-Type。
 * iframe / img 无法带 Authorization 头，所以由插件服务端代理转发 PAT。
 *
 * @param {object} config 运行时配置
 * @param {string} path 以 / 开头的在线路径
 * @param {number} [timeoutMs] 超时
 * @returns {Promise<{buffer: Buffer, contentType: string, disposition: string}>}
 */
export async function khubBinary(config, path, timeoutMs) {
  if (config === null || typeof config !== 'object' || config.baseUrl === '') {
    throw new KhubError('尚未配置在线资料库服务地址', 'not-configured')
  }
  if (!config.apiKey) throw new KhubError('尚未配置在线资料库用户 API Key', 'not-configured')
  const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : 20000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), limit)
  try {
    const resp = await fetch(config.baseUrl + String(path || ''), {
      headers: { Authorization: 'Bearer ' + config.apiKey },
      signal: controller.signal,
    })
    if (!resp.ok) throw new KhubError('读取在线文件失败（HTTP ' + String(resp.status) + '）', 'api', resp.status)
    const buffer = Buffer.from(await resp.arrayBuffer())
    return {
      buffer,
      contentType: String(resp.headers.get('content-type') || 'application/octet-stream'),
      disposition: String(resp.headers.get('content-disposition') || ''),
    }
  } catch (error) {
    if (error instanceof KhubError) throw error
    if (error !== null && typeof error === 'object' && error.name === 'AbortError') {
      throw new KhubError('读取在线文件超时（' + String(limit) + 'ms）', 'timeout')
    }
    throw new KhubError('读取在线文件失败：' + String((error && error.message) || error), 'network')
  } finally {
    clearTimeout(timer)
  }
}

/** REST 薄封装：每一项都返回 R.data。 */
export const api = {
  spaces: (c) => khubRequest(c, { path: '/api/spaces' }),
  tree: (c, spaceId) => khubRequest(c, { path: '/api/spaces/' + encodeURIComponent(spaceId) + '/tree' }),
  children: (c, nodeId) => khubRequest(c, { path: '/api/nodes/' + encodeURIComponent(nodeId) + '/children' }),
  node: (c, nodeId) => khubRequest(c, { path: '/api/nodes/' + encodeURIComponent(nodeId) }),
  // 容器后代扁平清单（带 relPath），Markdown 相对路径引用解析用
  attachments: (c, nodeId) => khubRequest(c, { path: '/api/nodes/' + encodeURIComponent(nodeId) + '/attachments' }),
  content: (c, nodeId) => khubRequest(c, { path: '/api/nodes/' + encodeURIComponent(nodeId) + '/content' }),
  saveContent: (c, nodeId, content, baseVersion) => khubRequest(c, {
    method: 'PUT', path: '/api/nodes/' + encodeURIComponent(nodeId) + '/content',
    body: { content, baseVersion: baseVersion === undefined || baseVersion === null ? null : baseVersion },
  }),
  csv: (c, nodeId) => khubRequest(c, { path: '/api/nodes/' + encodeURIComponent(nodeId) + '/csv' }),
  saveCsvMatrix: (c, nodeId, matrix, baseVersion) => khubRequest(c, {
    method: 'PUT', path: '/api/nodes/' + encodeURIComponent(nodeId) + '/csv/matrix',
    body: { matrix, baseVersion: baseVersion === undefined || baseVersion === null ? null : baseVersion },
  }),
  createNode: (c, payload) => khubRequest(c, { method: 'POST', path: '/api/nodes', body: payload }),
  updateNode: (c, nodeId, payload) => khubRequest(c, {
    method: 'PUT', path: '/api/nodes/' + encodeURIComponent(nodeId), body: payload,
  }),
  deleteNode: (c, nodeId) => khubRequest(c, {
    method: 'DELETE', path: '/api/nodes/' + encodeURIComponent(nodeId),
  }),
  search: (c, spaceId, keyword) => khubRequest(c, {
    path: '/api/spaces/' + encodeURIComponent(spaceId) + '/search?keyword=' + encodeURIComponent(keyword || ''),
  }),
  /* ---- 收藏 ---- */
  favGroups: (c) => khubRequest(c, { path: '/api/me/fav-groups' }),
  favorites: (c, groupId) => khubRequest(c, {
    path: '/api/me/favorites' + (groupId ? '?groupId=' + encodeURIComponent(groupId) : ''),
  }),
  favorite: (c, nodeId, groupId) => khubRequest(c, {
    method: 'POST', path: '/api/me/favorites/' + encodeURIComponent(nodeId),
    body: { groupId: groupId === undefined || groupId === null ? null : Number(groupId) },
  }),
  moveFavorite: (c, nodeId, groupId) => khubRequest(c, {
    method: 'PUT', path: '/api/me/favorites/' + encodeURIComponent(nodeId),
    body: { groupId: groupId === undefined || groupId === null ? null : Number(groupId) },
  }),
  unfavorite: (c, nodeId) => khubRequest(c, {
    method: 'DELETE', path: '/api/me/favorites/' + encodeURIComponent(nodeId),
  }),
  createFavGroup: (c, body) => khubRequest(c, { method: 'POST', path: '/api/me/fav-groups', body }),
  deleteFavGroup: (c, id) => khubRequest(c, {
    method: 'DELETE', path: '/api/me/fav-groups/' + encodeURIComponent(id),
  }),
  /* ---- 分享 ---- */
  nodeShares: (c, nodeId) => khubRequest(c, { path: '/api/nodes/' + encodeURIComponent(nodeId) + '/shares' }),
  createShare: (c, nodeId, body) => khubRequest(c, {
    method: 'POST', path: '/api/nodes/' + encodeURIComponent(nodeId) + '/share', body,
  }),
  updateShare: (c, shareId, permission) => khubRequest(c, {
    method: 'PUT', path: '/api/shares/' + encodeURIComponent(shareId), body: { permission },
  }),
  deleteShare: (c, shareId) => khubRequest(c, {
    method: 'DELETE', path: '/api/shares/' + encodeURIComponent(shareId),
  }),
  sharesOut: (c) => khubRequest(c, { path: '/api/me/shares/out' }),
  sharesIn: (c) => khubRequest(c, { path: '/api/me/shares/in' }),
  revokeShare: (c, shareId) => khubRequest(c, {
    method: 'DELETE', path: '/api/me/shares/' + encodeURIComponent(shareId),
  }),
  /* ---- 版本 ---- */
  versions: (c, nodeId) => khubRequest(c, { path: '/api/nodes/' + encodeURIComponent(nodeId) + '/versions' }),
  versionDetail: (c, nodeId, no) => khubRequest(c, {
    path: '/api/nodes/' + encodeURIComponent(nodeId) + '/versions/' + encodeURIComponent(no),
  }),
  restoreVersion: (c, nodeId, no) => khubRequest(c, {
    method: 'POST', path: '/api/nodes/' + encodeURIComponent(nodeId) + '/versions/' + encodeURIComponent(no) + '/restore',
  }),
  /* ---- 最近 / 访问 ---- */
  recent: (c, limit) => khubRequest(c, { path: '/api/me/recent?limit=' + String(Number(limit) > 0 ? Number(limit) : 20) }),
  visit: (c, nodeId) => khubRequest(c, {
    method: 'POST', path: '/api/me/visit/' + encodeURIComponent(nodeId),
  }),
  /** 客户端接入校验：验证 clientId/clientSecret 有效（不产生数据权限）。 */
  clientToken: (c) => khubRequest(c, {
    method: 'POST', path: '/api/open/auth/client',
    body: { clientId: c.clientId, clientSecret: c.clientSecret },
  }),
}

/**
 * 连接测试：PAT 列空间 + client 凭据校验（后者可选，没配就跳过）。
 * @param {object} config 运行时配置
 * @returns {Promise<object>} {ok, spaces, clientChecked, clientName, message}
 */
export async function probe(config) {
  const spaces = await api.spaces(config)
  const list = Array.isArray(spaces) ? spaces : []
  let clientChecked = false
  let clientName = ''
  if (config.clientId !== '' && config.clientSecret !== '') {
    const token = await api.clientToken(config)
    clientChecked = true
    clientName = token !== null && typeof token === 'object' && typeof token.name === 'string' ? token.name : config.clientId
  }
  return {
    ok: true,
    spaceCount: list.length,
    spaces: list.map((s) => ({ id: s.id, name: s.name, type: s.type, nodeCount: s.nodeCount })),
    clientChecked,
    clientName,
    message: '连接成功，可访问 ' + String(list.length) + ' 个空间' + (clientChecked ? '，客户端凭据有效' : ''),
  }
}

/**
 * 递归扁平化目录树，给每个节点带上 spaceId / spaceName / parentId / depth。
 * @param {any[]} nodes tree 的 children
 * @param {object} space 所属空间
 * @param {number} parentId 父节点 id
 * @param {number} depth 层级
 * @returns {any[]}
 */
export function flattenTree(nodes, space, parentId, depth) {
  const out = []
  const list = Array.isArray(nodes) ? nodes : []
  for (const node of list) {
    if (node === null || typeof node !== 'object') continue
    const id = Number(node.id)
    if (!Number.isFinite(id)) continue
    out.push(Object.assign({}, node, {
      spaceId: space.id,
      spaceName: space.name,
      spaceType: space.type,
      parentId: Number.isFinite(parentId) ? parentId : 0,
      depth: Number.isFinite(depth) ? depth : 0,
    }))
    if (Array.isArray(node.children) && node.children.length > 0) {
      out.push(...flattenTree(node.children, space, id, (Number.isFinite(depth) ? depth : 0) + 1))
    }
  }
  return out
}

/** 把 CSV 表头转成插件的 fields 定义（在线目录不走 validateMenu，key 可含中文）。 */
export function fieldsFromHeaders(headers) {
  const list = Array.isArray(headers) ? headers : []
  const clean = list.length > 0 ? list.map((h, i) => String(h === null || h === undefined ? '' : h).trim() || ('列' + String(i + 1))) : ['列1']
  const seen = new Set()
  return clean.map((label, idx) => {
    let key = label
    if (seen.has(key)) key = label + '_' + String(idx + 1)
    seen.add(key)
    return { key, label, type: 'string', required: false, default: '', options: [] }
  })
}

/**
 * 从在线资料库合成插件工作台清单。
 *
 * 资料库的模型是「HTML 节点下挂 CSV 子节点」（与插件 workbench-menu 等价），
 * 因此把每个 HTML 节点变成一个工作台，其 CSV 子节点变成 tables。
 * fields 需要读一次 CSV 取表头，故对 CSV 节点并发取一次 /csv。
 *
 * @param {object} config 运行时配置
 * @returns {Promise<{workbenches: any[], errors: string[], spaces: any[], flatNodes: any[]}>}
 */
export async function collectCatalog(config) {
  const spaces = await api.spaces(config)
  const spaceList = Array.isArray(spaces) ? spaces : []
  const errors = []
  const workbenches = []
  const flatNodes = []
  const trees = await Promise.all(spaceList.map(async (space) => {
    try { return { space, tree: await api.tree(config, space.id), error: '' } }
    catch (error) {
      errors.push(space.name + '：读取目录失败 ' + String((error && error.message) || error))
      return { space, tree: [], error: '' }
    }
  }))
  for (const item of trees) {
    const flattened = flattenTree(item.tree, item.space, 0, 0)
    flatNodes.push(...flattened)
    const htmlNodes = flattened.filter((n) => String(n.nodeType || '').toUpperCase() === 'HTML')
    for (const htmlNode of htmlNodes) {
      const csvNodes = flattened.filter((n) =>
        Number(n.parentId) === Number(htmlNode.id) && String(n.nodeType || '').toUpperCase() === 'CSV')
      const tables = []
      for (const csv of csvNodes) {
        try {
          const data = await api.csv(config, csv.id)
          const headers = data !== null && Array.isArray(data.headers) ? data.headers : []
          tables.push({
            file: 'node-' + String(csv.id) + '.csv',
            name: String(csv.name || ('数据表 ' + String(csv.id))),
            nodeId: Number(csv.id),
            fields: fieldsFromHeaders(headers),
            keys: fieldsFromHeaders(headers).map((f) => f.key),
          })
        } catch (error) {
          errors.push(csv.name + '：读取表头失败 ' + String((error && error.message) || error))
        }
      }
      if (tables.length === 0) continue // 没有挂载 CSV 的 HTML 不作为工作台
      workbenches.push({
        id: 'khub-' + String(htmlNode.id),
        name: String(htmlNode.name || ('在线工作台 ' + String(htmlNode.id))).replace(/\.html?$/i, ''),
        file: 'node-' + String(htmlNode.id) + '.html',
        nodeId: Number(htmlNode.id),
        spaceId: item.space.id,
        spaceName: item.space.name,
        tables,
        menu: [{ id: 'overview', label: '总览', view: '', prompt: '' }],
      })
    }
  }
  return { workbenches, errors, spaces: spaceList, flatNodes }
}

export default {
  KHUB_CLIENT_SECRET_KEY, KHUB_API_KEY_KEY, KHUB_DEFAULT_SETTINGS, KHUB_TIMEOUT_MS,
  KhubError, normalizeBaseUrl, isValidBaseUrl, configFromSettings, configReady,
  publicSettings, khubRequest, khubBinary, api, probe, flattenTree, fieldsFromHeaders, collectCatalog,
}
