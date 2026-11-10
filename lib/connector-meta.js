/**
 * dsh-buddy-expert-hub — 连接器认证 / 参数元数据的公共判定。
 *
 * 由 `scripts/build-connectors.mjs`（构建离线快照）与 `lib/index.js`（运行时采集）
 * 共用，保证「两条数据路径」算出的 authMode / requiredParams / needsSetup 完全一致，
 * 不会出现快照与在线市场判定不一致的漂移。
 *
 * 设计要点：
 *  - 只识别元数据里的 `auth_mode` 与 MCP 配置字符串中的 `${VAR}` 占位符；
 *  - 只提取「变量名」，绝不读取、拼接、持久化或输出变量的值；
 *  - 读取 WorkBuddy 连接状态时只读布尔字段（bound / everConnected），
 *    绝不触碰 `.credentials.v3.json`、`headerOverrides` 等密文字段；
 *  - 零 npm 依赖，仅使用 node: 内置模块。
 *
 * @module dsh-buddy-expert-hub/connector-meta
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 需要走「连接」流程（填参数或先在 WorkBuddy 登录）的认证模式。 */
export const SETUP_AUTH_MODES = ['token', 'oauth', 'oneid-token']

/** 免连接认证模式：服务端代持凭据 / MCP 直连，本身不要求用户填任何东西。 */
export const NO_SETUP_AUTH_MODES = ['server-side', 'mcp']

/** 需要 WorkBuddy 登录态的认证模式（前端展示登录引导，不提供假登录表单）。 */
export const OAUTH_AUTH_MODES = ['oauth', 'oneid-token']

/** 市场元数据文件相对市场目录的路径片段。 */
const MARKET_META_RELATIVE = ['.codebuddy-connector', 'connectors.json']

/** 递归扫描配置对象的最大深度，防御异常深的嵌套。 */
const MAX_SCAN_DEPTH = 12

/**
 * `${VAR}` 占位符正则：变量名按环境变量常见命名收敛，
 * 避免把 `${PATH:-x}` 之类的 shell 表达式误判成必填参数。
 */
const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * 读取 JSON 文件，失败一律返回 null（不抛、不打印）。
 * @param {string} file 绝对路径
 * @returns {any} 解析结果或 null
 */
function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 归一化认证模式：去空白、转小写；非字符串返回空串。
 * @param {unknown} value 原始值
 * @returns {string} 归一化后的模式
 */
export function normalizeAuthMode(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

/**
 * 递归提取 MCP 配置里所有 `${VAR}` 变量名，去重并排序。
 *
 * 覆盖 `headers` / `env` / `args` / `url` 以及任意嵌套的字符串；
 * 只收集变量名，不收集也不返回任何实际值。
 *
 * @param {unknown} config mcp.json 的 server 配置（可为 null）
 * @returns {string[]} 变量名数组（去重、字典序）
 */
export function extractRequiredParams(config) {
  /** @type {Set<string>} */
  const names = new Set()
  /**
   * @param {unknown} value 当前节点
   * @param {number} depth 当前深度
   * @returns {void}
   */
  const visit = (value, depth) => {
    if (depth > MAX_SCAN_DEPTH || value === null || value === undefined) return
    if (typeof value === 'string') {
      PLACEHOLDER_RE.lastIndex = 0
      let match = PLACEHOLDER_RE.exec(value)
      while (match !== null) {
        names.add(match[1])
        match = PLACEHOLDER_RE.exec(value)
      }
      return
    }
    if (Array.isArray(value)) {
      for (const child of value) visit(child, depth + 1)
      return
    }
    if (typeof value === 'object') {
      for (const child of Object.values(value)) visit(child, depth + 1)
    }
  }
  visit(config, 0)
  return Array.from(names).sort()
}

/**
 * 清洗必填参数名列表：只保留字符串，去空、去重、排序。
 * @param {unknown} value 原始列表
 * @returns {string[]} 合法变量名数组
 */
export function normalizeRequiredParams(value) {
  if (!Array.isArray(value)) return []
  /** @type {string[]} */
  const out = []
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const name = raw.trim()
    if (name === '' || out.indexOf(name) >= 0) continue
    out.push(name)
  }
  return out.sort()
}

/**
 * 判定连接器是否需要「连接」流程。
 *
 * 规则（与 WorkBuddy 连接器实现对齐）：
 *  - `token` / `oauth` / `oneid-token`：需要（不管有没有占位符）；
 *  - `server-side` / `mcp` / 无 auth_mode / 未知模式：仅当配置含 `${VAR}` 占位符时需要；
 *  - 其余一律免连接，点卡片直接进对话。
 *
 * @param {unknown} authMode 元数据里的 auth_mode
 * @param {unknown} requiredParams 从配置提取到的变量名
 * @returns {boolean} 是否需要连接
 */
export function computeNeedsSetup(authMode, requiredParams) {
  const mode = normalizeAuthMode(authMode)
  const params = Array.isArray(requiredParams) ? requiredParams : []
  if (SETUP_AUTH_MODES.indexOf(mode) >= 0) return true
  // NO_SETUP_AUTH_MODES（server-side / mcp）与无模式都走这里：
  // 只有配置里真的存在必填占位符才需要用户填参数。
  return params.length > 0
}

/**
 * 读取市场元数据里的 `auth_mode`，返回 id → 模式的映射。
 *
 * 兼容三种形态：纯数组、`{ connectors: [...] }`、`{ connectors: { id: {...} } }`。
 * 文件缺失 / 损坏时返回空 Map（调用方按「无认证模式」兜底）。
 *
 * @param {string} marketDir 市场目录绝对路径
 * @returns {Map<string, string>} id → 归一化后的 auth_mode
 */
export function readAuthModeMap(marketDir) {
  /** @type {Map<string, string>} */
  const result = new Map()
  const file = path.join(marketDir, ...MARKET_META_RELATIVE)
  const parsed = readJsonSafe(file)
  if (parsed === null) return result
  /** @type {any[]} */
  let entries = []
  if (Array.isArray(parsed)) {
    entries = parsed
  } else if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.connectors)) {
    entries = parsed.connectors
  } else if (parsed !== null && typeof parsed === 'object' && parsed.connectors !== null && typeof parsed.connectors === 'object') {
    entries = Object.entries(parsed.connectors).map(([id, meta]) =>
      meta !== null && typeof meta === 'object' ? Object.assign({}, meta, { id }) : { id })
  }
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    const id = typeof entry.id === 'string' ? entry.id : ''
    if (id === '') continue
    result.set(id, normalizeAuthMode(entry.auth_mode))
  }
  return result
}

/**
 * 读取 WorkBuddy 里「已完成连接 / 登录」的连接器 id 集合。
 *
 * 只读两份状态文件里的布尔字段：
 *   `~/.workbuddy/connectors/<userId>/connector-states.json` → `connectors[id].bound` / `.enabled`
 *   `~/.workbuddy/connectors/<userId>/connector-states.v3.json` → `everConnected`
 *
 * 安全约束：绝不读取 `.credentials.v3.json`、绝不解析 `headerOverrides` /
 * `encryption` 等密文字段，绝不向 `~/.workbuddy` 写入任何文件，也不打印内容。
 *
 * @param {string} [homeDir=os.homedir()] 用户主目录（测试时可注入临时目录）
 * @returns {Set<string>} 已连接 / 曾连接过的连接器 id
 */
export function readWorkbuddyReadyIds(homeDir = os.homedir()) {
  /** @type {Set<string>} */
  const ready = new Set()
  const root = path.join(homeDir, '.workbuddy', 'connectors')
  /** @type {import('node:fs').Dirent[]} */
  let users = []
  try {
    users = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return ready
  }
  for (const entry of users) {
    if (!entry.isDirectory()) continue
    const userDir = path.join(root, entry.name)
    const v4 = readJsonSafe(path.join(userDir, 'connector-states.json'))
    if (v4 !== null && typeof v4 === 'object' && v4.connectors !== null && typeof v4.connectors === 'object') {
      for (const [id, meta] of Object.entries(v4.connectors)) {
        if (meta !== null && typeof meta === 'object' && (meta.bound === true || meta.enabled === true)) ready.add(id)
      }
    }
    const v3 = readJsonSafe(path.join(userDir, 'connector-states.v3.json'))
    if (v3 !== null && typeof v3 === 'object') {
      const ever = v3.everConnected
      if (Array.isArray(ever)) {
        for (const id of ever) {
          if (typeof id === 'string' && id !== '') ready.add(id)
        }
      } else if (ever !== null && typeof ever === 'object') {
        for (const [id, flag] of Object.entries(ever)) {
          if (flag === true && id !== '') ready.add(id)
        }
      }
    }
  }
  return ready
}

/**
 * 判断某个 OAuth / OneID 连接器是否已在 WorkBuddy 完成登录。
 * @param {string} id 连接器 id
 * @param {Set<string>} [readyIds] 预先读好的就绪集合，避免重复扫盘
 * @returns {boolean} 是否已登录就绪
 */
export function workbuddyOAuthReady(id, readyIds) {
  const ids = readyIds instanceof Set ? readyIds : readWorkbuddyReadyIds()
  return ids.has(String(id === null || id === undefined ? '' : id))
}

/**
 * 判断认证模式是否需要 WorkBuddy 登录态。
 * @param {unknown} authMode 认证模式
 * @returns {boolean} 是否为 OAuth / OneID 类型
 */
export function isOAuthMode(authMode) {
  return OAUTH_AUTH_MODES.indexOf(normalizeAuthMode(authMode)) >= 0
}

/** 参数表单文本的长度上限，防止异常数据把弹窗撑爆。 */
const FIELD_LABEL_MAX = 120
const FIELD_PLACEHOLDER_MAX = 200
const FIELD_DESCRIPTION_MAX = 400
const SCHEMA_TEXT_MAX = 300
const DOC_URL_MAX = 400

/** 合法环境变量名（与 `${VAR}` 占位符正则保持同一口径）。 */
const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 取第一个非空字符串，裁剪首尾空白并限长。
 * @param {number} max 最大长度
 * @param {...unknown} values 候选值（优先中文，再回落英文 / 变量名）
 * @returns {string} 文本或空串
 */
function firstText(max, ...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim().slice(0, max)
  }
  return ''
}

/**
 * 只接受 http(s) 链接，避免把 `javascript:` 之类的危险 URL 渲染成可点链接。
 * @param {unknown} value 原始值
 * @returns {string} 安全 URL 或空串
 */
function safeDocUrl(value) {
  if (typeof value !== 'string') return ''
  const text = value.trim()
  return /^https?:\/\//i.test(text) ? text.slice(0, DOC_URL_MAX) : ''
}

/**
 * 归一化「如何配置」说明（用于弹窗标题 / 描述 / 获取凭据链接）。
 * @param {unknown} value 原始数据
 * @returns {{ title: string, description: string, docUrl: string, docLabel: string }|null} 归一化对象或 null
 */
export function normalizeSetupSchema(value) {
  if (value === null || typeof value !== 'object') return null
  const title = firstText(SCHEMA_TEXT_MAX, value.title)
  const description = firstText(SCHEMA_TEXT_MAX, value.description)
  const docUrl = safeDocUrl(value.docUrl)
  const docLabel = firstText(FIELD_LABEL_MAX, value.docLabel)
  if (title === '' && description === '' && docUrl === '') return null
  return { title, description, docUrl, docLabel }
}

/**
 * 读取并归一化连接器的 `token-schema.json`（WorkBuddy 的参数权威来源）。
 *
 * 只取展示与校验所需的字段；`required:false` 的字段保留为选填，不做必填强校验。
 * 文件缺失 / 结构不合法返回 null，调用方回落到 mcp.json 的 `${VAR}` 占位符。
 *
 * @param {string} connectorDir 连接器目录绝对路径
 * @returns {{ title: string, description: string, docUrl: string, docLabel: string, fields: Array<Record<string, any>> }|null} 归一化 schema
 */
export function readTokenSchema(connectorDir) {
  const parsed = readJsonSafe(path.join(connectorDir, 'token-schema.json'))
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.fields)) return null
  /** @type {Array<Record<string, any>>} */
  const fields = []
  for (const raw of parsed.fields) {
    if (raw === null || typeof raw !== 'object') continue
    const key = typeof raw.key === 'string' ? raw.key.trim() : ''
    if (key === '' || PARAM_NAME_RE.test(key) === false) continue
    if (fields.some((field) => field.key === key)) continue
    fields.push({
      key,
      label: firstText(FIELD_LABEL_MAX, raw.label, raw.label_en, key),
      placeholder: firstText(FIELD_PLACEHOLDER_MAX, raw.placeholder, raw.placeholder_en),
      description: firstText(FIELD_DESCRIPTION_MAX, raw.description, raw.description_en),
      required: raw.required === true,
      type: firstText(24, raw.type) || 'password',
    })
  }
  return {
    title: firstText(SCHEMA_TEXT_MAX, parsed.title, parsed.title_en),
    description: firstText(SCHEMA_TEXT_MAX, parsed.description, parsed.description_en),
    docUrl: safeDocUrl(parsed.docUrl),
    docLabel: firstText(FIELD_LABEL_MAX, parsed.docLabel, parsed.docLabel_en),
    fields,
  }
}

/**
 * 以 `paramFields[].required` 为准反推必填 / 选填名单，保证表单与后端校验同源。
 * @param {unknown} value 原始字段列表
 * @param {string[]} requiredParams 兜底必填名单（旧快照只有数组时用）
 * @param {string[]} optionalParams 兜底选填名单
 * @returns {Array<Record<string, any>>} 归一化、去重、排序后的字段列表
 */
export function normalizeParamFields(value, requiredParams, optionalParams) {
  /** @type {Array<Record<string, any>>} */
  const fields = []
  if (Array.isArray(value)) {
    for (const raw of value) {
      if (raw === null || typeof raw !== 'object') continue
      const key = typeof raw.key === 'string' ? raw.key.trim() : ''
      if (key === '' || PARAM_NAME_RE.test(key) === false) continue
      if (fields.some((field) => field.key === key)) continue
      fields.push({
        key,
        label: firstText(FIELD_LABEL_MAX, raw.label) || key,
        placeholder: firstText(FIELD_PLACEHOLDER_MAX, raw.placeholder),
        description: firstText(FIELD_DESCRIPTION_MAX, raw.description),
        required: raw.required === true,
        type: firstText(24, raw.type) || 'password',
      })
    }
  }
  const required = Array.isArray(requiredParams) ? requiredParams : []
  const optional = Array.isArray(optionalParams) ? optionalParams : []
  if (fields.length === 0) {
    for (const key of required) {
      if (PARAM_NAME_RE.test(key) === false || fields.some((field) => field.key === key)) continue
      fields.push({ key, label: key, placeholder: '', description: '', required: true, type: 'password' })
    }
    for (const key of optional) {
      if (PARAM_NAME_RE.test(key) === false || fields.some((field) => field.key === key)) continue
      fields.push({ key, label: key, placeholder: '', description: '', required: false, type: 'password' })
    }
  }
  fields.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
  return fields
}

/**
 * 归一化外部数据（内置快照 / 整包导入）里的参数字段。
 *
 * `paramFields` 是运行时唯一权威：表单渲染与 `/connectors/connect` 校验都从它反推
 * `requiredParams` / `optionalParams`，避免两份名单漂移。
 *
 * @param {Record<string, any>} entry 外部条目
 * @returns {{ requiredParams: string[], optionalParams: string[], paramFields: Array<Record<string, any>>, setupSchema: Record<string, string>|null }} 参数元数据
 */
export function normalizeParamMeta(entry) {
  const requiredParams = normalizeRequiredParams(entry.requiredParams)
  const optionalParams = normalizeRequiredParams(entry.optionalParams).filter((key) => requiredParams.indexOf(key) < 0)
  const paramFields = normalizeParamFields(entry.paramFields, requiredParams, optionalParams)
  return {
    requiredParams: paramFields.filter((field) => field.required === true).map((field) => field.key),
    optionalParams: paramFields.filter((field) => field.required !== true).map((field) => field.key),
    paramFields,
    setupSchema: normalizeSetupSchema(entry.setupSchema),
  }
}

/**
 * 汇总连接器的参数元数据：token-schema.json 为权威，`${VAR}` 占位符作为补充。
 *
 * - schema 里 `required:true` 的字段进必填名单，`required:false` 的进选填名单；
 * - mcp.json 里出现但 schema 未覆盖的 `${VAR}` 一律按必填补充（保守兼容老连接器）；
 * - 只返回变量名 / 文案 / 链接，绝不返回任何实际值。
 *
 * @param {unknown} config mcp.json 的 server 配置
 * @param {string} connectorDir 连接器目录绝对路径（用于读 token-schema.json）
 * @returns {{ requiredParams: string[], optionalParams: string[], paramFields: Array<Record<string, any>>, setupSchema: Record<string, string>|null }} 参数元数据
 */
export function connectorParamMeta(config, connectorDir) {
  const schema = typeof connectorDir === 'string' && connectorDir !== '' ? readTokenSchema(connectorDir) : null
  /** @type {Array<Record<string, any>>} */
  const fields = []
  const seen = new Set()
  if (schema !== null) {
    for (const field of schema.fields) {
      if (seen.has(field.key)) continue
      seen.add(field.key)
      fields.push(field)
    }
  }
  for (const name of extractRequiredParams(config)) {
    if (seen.has(name)) continue
    seen.add(name)
    fields.push({ key: name, label: name, placeholder: '', description: '', required: true, type: 'password' })
  }
  fields.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
  return {
    requiredParams: fields.filter((field) => field.required === true).map((field) => field.key),
    optionalParams: fields.filter((field) => field.required !== true).map((field) => field.key),
    paramFields: fields,
    setupSchema: schema === null
      ? null
      : normalizeSetupSchema({
          title: schema.title,
          description: schema.description,
          docUrl: schema.docUrl,
          docLabel: schema.docLabel,
        }),
  }
}
