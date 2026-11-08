/**
 * dsh-buddy-expert-hub — 连接器「连接时自动写入宿主 mcp-client 配置」。
 *
 * 背景：宿主 `@deepseek-ai/dsh-mcp-client` 是「一插件实例一 server」的静态
 * 配置，运行期没有动态挂载接口。此前插件的「连接」只做参数校验与状态登记，
 * 工具真正可调仍需用户手改 `~/.dsh/profiles/<profile>/cordis.patch.yml`。
 *
 * 本模块把这一步自动化：
 *   1. 从连接器 `config.mcpServers` 生成 `- insert:` 片段（`!!js` 表达式只引用
 *      「读取本地加密凭据」的固定代码，用户文本一律作为字符串常量拼接，绝不含凭据明文）
 *   2. 把表单填的值**加密写入本地文件**（`credentials.enc`，AES-256-GCM），
 *      不碰系统环境变量，Windows / Linux / macOS 行为一致
 *   3. 备份并幂等写入所有 profile 的 `cordis.patch.yml`，失败整体回滚
 *
 * 不读取 `~/.workbuddy` 的任何凭据、不解密、不写 `~/.workbuddy`。
 * 新增实例要生效仍**需要重启 dsh web**（插件不能重启自己所在的宿主进程）。
 *
 * @module dsh-buddy-expert-hub/connector-provision
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// 凭据本地加密存储：配置文件里只放解密表达式，不放明文
import { buildSecretExpr, saveSecrets, secretFilePath } from './connector-secret.js'

/** 需要写入的 profile（用户选择「全部写入」）。 */
const PROFILE_NAMES = ['desktop', 'web', 'hubtest']

/** 合法的环境变量名，防止把任意字符串塞进 `process.env.X`。 */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** `${VAR}` 占位符。 */
const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * 字面量片段里允许原样保留的字符；含其它字符的片段整体走 `\uXXXX` 转义。
 * 目的不是过滤（拼接方式已经改成字符串常量），而是让恶意文本不会以
 * 可识别的代码形态落进宿主 patch 文件。
 */
const LITERAL_SAFE_RE = /^[A-Za-z0-9 _.,:/+=?&%#@!~-]*$/

/**
 * 把用户文本片段编成 JS 字符串常量。
 *
 * 干净片段（只含字母数字与常见标点）保持 `JSON.stringify()` 的可读形式；
 * 含反引号 / `$` / `{` / 反斜杠 / 引号 / 括号等注入嫌疑字符的片段整体改成
 * `\uXXXX` 转义 —— 求值结果逐字节不变，但 `execSync`、`child_process`、
 * `${...}` 这类 token 都不会以明文出现在 YAML 里，也不存在任何模板插值。
 *
 * @param {string} text 用户文本片段
 * @returns {string} JS 字符串常量（带双引号）
 */
function jsStringLiteral(text) {
  const value = String(text)
  if (LITERAL_SAFE_RE.test(value)) return JSON.stringify(value)
  let out = '"'
  for (let i = 0; i < value.length; i += 1) {
    out += '\\u' + value.charCodeAt(i).toString(16).padStart(4, '0')
  }
  return out + '"'
}

/**
 * YAML 安全的双引号字符串（YAML 1.2 兼容 JSON 双引号）。
 * @param {any} value 任意值
 * @returns {string} 带引号的 YAML 标量
 */
function yamlString(value) {
  return JSON.stringify(String(value === null || value === undefined ? '' : value))
}

/**
 * YAML map 的 key：常规标识符用裸标量（可读性），含特殊字符才加引号。
 * @param {string} key 键名
 * @returns {string} YAML key
 */
function yamlKey(key) {
  const text = String(key)
  return /^[A-Za-z0-9_-]+$/.test(text) ? text : yamlString(text)
}

/**
 * 由连接器 id 推出宿主的 `serverName`（`[A-Za-z0-9_-]{1,32}`）。
 * @param {string} id 连接器 id
 * @returns {string} serverName
 */
export function normalizeServerName(id) {
  const cleaned = String(id || '').replace(/[^A-Za-z0-9_-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  return cleaned === '' ? 'connector' : cleaned
}

/**
 * 取配置里的第一台 MCP server。
 * @param {any} config 连接器 config（即原始 mcp.json）
 * @returns {{ key: string, server: any }|null} 第一台 server
 */
function firstServer(config) {
  const servers = config !== null && typeof config === 'object' ? config.mcpServers : null
  if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) return null
  const key = Object.keys(servers)[0]
  if (key === undefined || servers[key] === null || typeof servers[key] !== 'object') return null
  return { key, server: servers[key] }
}

/**
 * 把一段 JS 表达式包成 YAML 的 `!!js '...'` 标量。
 *
 * YAML 单引号标量里的单引号必须双写；这里的表达式只由固定代码与
 * `jsStringLiteral()` 产生的字符串常量组成，不含任何用户可控代码。
 *
 * @param {string} expr JS 表达式
 * @returns {string} YAML 标量
 */
function yamlJsExpr(expr) {
  return "!!js '" + String(expr).replace(/'/g, "''") + "'"
}

/**
 * 把含 `${VAR}` 的字符串转成 `!!js` YAML 表达式片段（结构性防注入）。
 *
 * 历史实现把用户文本直接塞进模板字面量：只替换白名单占位符，其它 `${...}`
 * 会保留为插值，闭合反引号还能追加任意 JS —— 宿主加载 patch 时求值即 RCE。
 *
 * 现在按 `PLACEHOLDER_RE` 把文本切成「字面量片段」与「变量片段」：
 *   - 字面量片段一律用 {@link jsStringLiteral} 包成 JS 字符串常量
 *     （干净文本用 `JSON.stringify()`，含注入嫌疑字符时整体 `\uXXXX` 转义）；
 *   - 变量片段用 {@link buildSecretExpr} 生成「读取本地加密凭据」的表达式；
 *   - 两类片段用 `+` 拼接，例如 `Bearer ${TOKEN}` 生成
 *     `"Bearer " + <解密表达式>`。
 * 用户文本永远只是字符串内容，反引号 / `${...}` / 反斜杠都不再有机会被求值；
 * 占位符替换功能对所有输入都保留，不会退化成把凭据明文写进 YAML。
 *
 * 纯 `${VAR}` 仍走单表达式分支；不含占位符的普通文本仍走 `yamlString()`。
 *
 * @param {any} raw 原始字符串（可能来自不可信请求体）
 * @param {string} secretDir 插件数据目录（凭据文件所在目录）
 * @returns {{ yaml: string, vars: string[] }} YAML 值片段与引用到的变量名
 */
function jsExprFor(raw, secretDir) {
  const text = String(raw === null || raw === undefined ? '' : raw)
  const exact = text.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/)
  if (exact !== null) {
    return { yaml: yamlJsExpr(buildSecretExpr(exact[1], secretDir)), vars: [exact[1]] }
  }
  /** @type {string[]} 待拼接的片段（字符串常量或解密表达式） */
  const parts = []
  /** @type {string[]} 引用到的变量名（按出现顺序，保留重复，与旧实现一致） */
  const vars = []
  let cursor = 0
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    const at = typeof match.index === 'number' ? match.index : 0
    if (at > cursor) parts.push(jsStringLiteral(text.slice(cursor, at)))
    parts.push('(' + buildSecretExpr(match[1], secretDir) + ')')
    vars.push(match[1])
    cursor = at + match[0].length
  }
  if (vars.length === 0) return { yaml: yamlString(text), vars: [] }
  if (cursor < text.length) parts.push(jsStringLiteral(text.slice(cursor)))
  return { yaml: yamlJsExpr(parts.join(' + ')), vars }
}

/**
 * 收集连接器需要的环境变量名：`config` 里的 `${VAR}` 占位符 +
 * `paramFields` 的 key（覆盖 `env.SCRM_APP_KEY: ""` 这类空串占位）。
 *
 * @param {any} item 连接器条目
 * @returns {string[]} 去重排序后的变量名
 */
export function connectorEnvVars(item) {
  const found = new Set()
  const parsed = firstServer(item && item.config)
  if (parsed !== null) {
    for (const group of ['headers', 'env']) {
      const obj = parsed.server[group]
      if (obj === null || typeof obj !== 'object') continue
      for (const [key, value] of Object.entries(obj)) {
        const text = String(value === null || value === undefined ? '' : value)
        for (const match of text.matchAll(PLACEHOLDER_RE)) found.add(match[1])
        // 空串但表单里有同名字段：仍需生成 process.env.<key> 引用
        if (text === '' && ENV_NAME_RE.test(key)) found.add(key)
      }
    }
  }
  const fields = Array.isArray(item && item.paramFields) ? item.paramFields : []
  for (const field of fields) {
    if (field !== null && typeof field.key === 'string' && ENV_NAME_RE.test(field.key)) found.add(field.key)
  }
  const required = Array.isArray(item && item.requiredParams) ? item.requiredParams : []
  for (const key of required) {
    if (typeof key === 'string' && ENV_NAME_RE.test(key)) found.add(key)
  }
  return [...found].filter((v) => ENV_NAME_RE.test(v)).sort()
}

/**
 * 生成 mcp-client 的 `- insert:` 片段。片段**只含变量名**，不含任何值。
 *
 * @param {any} item 连接器条目
 * @returns {{ ok: boolean, snippet?: string, serverName?: string, entryId?: string,
 *   envVars?: string[], transport?: string, error?: string }} 生成结果
 */
export function buildMcpClientSnippet(item, options) {
  const secretDir = options !== null && options !== undefined && typeof options.secretDir === 'string'
    ? options.secretDir : ''
  const parsed = firstServer(item && item.config)
  if (parsed === null) return { ok: false, error: '该连接器没有可用的 MCP server 配置' }
  const server = parsed.server
  const serverName = normalizeServerName(item.id)
  const entryId = 'mcp-' + serverName
  /* 宿主 mcp-client 只认 `stdio` 与 `streamable-http` 两种传输：
     `sse` / `cli` / 未知类型**绝不能**被改写成 streamable-http —— 把 SSE 端点标成
     streamable-http 写进宿主配置，装上去也用不了，还污染用户的 profile。
     同一原则见 connector-store 的 resolveCloudTransport 注释。 */
  const rawType = String(server.type || 'streamableHttp').trim().toLowerCase()
  const transport = rawType === 'stdio'
    ? 'stdio'
    : (rawType === 'streamablehttp' || rawType === 'streamable-http' || rawType === 'http')
      ? 'streamable-http'
      : ''
  if (transport === '') {
    return { ok: false, error: '传输方式 ' + rawType + ' 无法写入宿主 mcp-client 配置（仅支持 stdio / streamable-http）' }
  }
  /* 参数化地址（`${VAR}`）写进 profile 也不会被替换，只会得到一个连不上的 url。 */
  const snippetUrl = typeof server.url === 'string' ? server.url : ''
  if (transport === 'streamable-http' && snippetUrl.indexOf('${') >= 0) {
    return { ok: false, error: '连接地址含占位符，需先填真实地址后再写入宿主配置' }
  }
  const envVars = connectorEnvVars(item)

  const lines = []
  lines.push('- insert:')
  lines.push('    - id: ' + entryId)
  lines.push('      name: "@deepseek-ai/dsh-mcp-client"')
  lines.push('      config:')
  lines.push('        serverName: ' + serverName)
  lines.push('        transport: ' + transport)

  if (transport === 'streamable-http') {
    if (typeof server.url === 'string' && server.url !== '') lines.push('        url: ' + yamlString(server.url))
    if (server.headers !== null && typeof server.headers === 'object' && Object.keys(server.headers).length > 0) {
      lines.push('        headers:')
      for (const [key, value] of Object.entries(server.headers)) {
        lines.push('          ' + yamlKey(key) + ': ' + jsExprFor(value, secretDir).yaml)
      }
    }
  } else {
    if (typeof server.command === 'string' && server.command !== '') lines.push('        command: ' + yamlString(server.command))
    if (Array.isArray(server.args) && server.args.length > 0) {
      lines.push('        args:')
      for (const arg of server.args) lines.push('          - ' + yamlString(arg))
    }
    if (typeof server.cwd === 'string' && server.cwd !== '') lines.push('        cwd: ' + yamlString(server.cwd))
  }

  // env 两种传输都可能有；空串 + 表单必填字段要补成 process.env.<key>
  const fieldNames = new Set(envVars)
  const rawEnv = server.env !== null && typeof server.env === 'object' ? server.env : {}
  const envEntries = []
  for (const [key, value] of Object.entries(rawEnv)) {
    const text = String(value === null || value === undefined ? '' : value)
    if (text === '' && fieldNames.has(key)) {
      envEntries.push([key, yamlJsExpr(buildSecretExpr(key, secretDir))])
    } else if (text !== '') {
      envEntries.push([key, jsExprFor(text, secretDir).yaml])
    }
  }
  // 表单里有、但 env 里完全没出现的必填变量，也补一条 env 引用
  for (const key of envVars) {
    if (!envEntries.some(([k]) => k === key) && ENV_NAME_RE.test(key)) {
      envEntries.push([key, yamlJsExpr(buildSecretExpr(key, secretDir))])
    }
  }
  if (envEntries.length > 0) {
    lines.push('        env:')
    for (const [key, expr] of envEntries) lines.push('          ' + yamlKey(key) + ': ' + expr)
  }

  if (typeof server.timeout === 'number' && server.timeout > 0) {
    lines.push('        toolCallTimeoutMs: ' + Math.floor(server.timeout))
  }

  return {
    ok: true,
    snippet: lines.join('\n') + '\n',
    serverName,
    entryId,
    envVars,
    transport,
  }
}

/**
 * 列出将要写入的 profile 配置文件（只读，不写盘）。
 *
 * @param {string} dshHome DSH 主目录
 * @param {string[]} [profileNames] profile 名列表
 * @returns {Array<{ name: string, file: string, exists: boolean }>} 目标文件
 */
export function provisionTargets(dshHome, profileNames = PROFILE_NAMES) {
  return profileNames.map((name) => {
    const file = path.join(dshHome, 'profiles', name, 'cordis.patch.yml')
    return { name, file, exists: fs.existsSync(file) }
  })
}

/**
 * 生成连接前的确认预览：**不写任何文件、不设置环境变量**。
 *
 * @param {any} item 连接器条目
 * @param {string} dshHome DSH 主目录
 * @param {string[]} [profileNames] profile 名列表
 * @returns {Record<string, any>} 预览结果
 */
export function previewProvision(item, dshHome, profileNames = PROFILE_NAMES, secretDir = '') {
  const built = buildMcpClientSnippet(item, { secretDir })
  if (built.ok !== true) return { ok: false, error: built.error }
  const targets = provisionTargets(dshHome, profileNames)
  return {
    ok: true,
    id: String(item.id),
    snippet: built.snippet,
    entryId: built.entryId,
    serverName: built.serverName,
    transport: built.transport,
    // 只回变量名，绝不回传值
    envVars: built.envVars,
    secretsFile: secretDir === '' ? '' : secretFilePath(secretDir),
    targets: targets.map((t) => ({ name: t.name, file: t.file, exists: t.exists })),
    restartRequired: true,
    note: '片段只含「读取本地加密凭据」的表达式，不含凭据；新增实例需重启 dsh web 后生效。',
  }
}


/**
 * 检查片段条目是否已存在于 patch 文本中（幂等）。
 * @param {string} text patch 文件全文
 * @param {string} entryId 目标条目 id
 * @returns {boolean} 是否已存在
 */
function hasEntry(text, entryId) {
  const re = new RegExp('^\\s*- id:\\s*["\']?' + entryId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\']?\\s*$', 'm')
  return re.test(String(text))
}

/**
 * 执行配置写入：加密保存凭据 → 逐个备份并追加片段 → 失败整体回滚。
 *
 * @param {{
 *   item: any, params: Record<string, string>, dshHome: string,
 *   secretDir: string, profileNames?: string[], now?: Function,
 * }} options 选项
 * @returns {Record<string, any>} 写入结果（不含任何参数值）
 */
export function provisionConnector(options) {
  const item = options.item
  const params = options.params && typeof options.params === 'object' ? options.params : {}
  const dshHome = String(options.dshHome || '')
  const secretDir = String(options.secretDir || '')
  const profileNames = Array.isArray(options.profileNames) ? options.profileNames : PROFILE_NAMES
  const stamp = typeof options.now === 'function'
    ? String(options.now()).replace(/[-:T.Z]/g, '').slice(0, 14)
    : new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)

  const built = buildMcpClientSnippet(item, { secretDir })
  if (built.ok !== true) return { ok: false, error: built.error }
  if (dshHome === '') return { ok: false, error: '未找到 DSH_HOME' }
  if (secretDir === '') return { ok: false, error: '未找到插件数据目录，无法保存凭据' }

  // 必填变量必须有值；值只在本函数内使用，绝不进入返回值或日志
  const required = Array.isArray(item.requiredParams) ? item.requiredParams : []
  for (const key of required) {
    const value = typeof params[key] === 'string' ? params[key].trim() : ''
    if (value === '') return { ok: false, error: '缺少连接参数：' + key }
  }

  const envVars = built.envVars
  let secretsFile = ''
  try {
    const patch = {}
    for (const key of envVars) {
      const value = typeof params[key] === 'string' ? params[key] : ''
      if (value.trim() === '') continue // 选填留空：不写入凭据
      patch[key] = value
    }
    if (Object.keys(patch).length > 0) {
      secretsFile = saveSecrets(secretDir, patch).file
    }
  } catch (error) {
    return { ok: false, error: '保存加密凭据失败：' + String((error && error.message) || error) }
  }

  const targets = provisionTargets(dshHome, profileNames)
  const missing = targets.filter((t) => !t.exists)
  if (missing.length > 0) {
    return { ok: false, error: '以下 profile 配置文件不存在：' + missing.map((t) => t.name).join('、') }
  }

  const written = []
  const backups = []
  try {
    for (const target of targets) {
      const text = fs.readFileSync(target.file, 'utf8')
      if (hasEntry(text, built.entryId)) {
        written.push({ name: target.name, file: target.file, action: 'alreadyPresent' })
        continue
      }
      const backup = target.file + '.bak-' + stamp
      fs.copyFileSync(target.file, backup)
      backups.push(backup)
      const prefix = text.endsWith('\n') || text === '' ? '' : '\n'
      fs.writeFileSync(target.file, text + prefix + built.snippet)
      written.push({ name: target.name, file: target.file, action: 'written', backup })
    }
  } catch (error) {
    // 整体回滚：把本轮已写入的文件从备份恢复
    for (const entry of written) {
      if (entry.action !== 'written' || !entry.backup) continue
      try { fs.copyFileSync(entry.backup, entry.file) } catch { /* 尽力恢复 */ }
    }
    return { ok: false, error: '写入 profile 失败，已回滚：' + String((error && error.message) || error) }
  }

  return {
    ok: true,
    id: String(item.id),
    entryId: built.entryId,
    serverName: built.serverName,
    // 只回变量名与加密文件路径，绝不回传值
    envVars,
    secretsFile,
    profiles: written,
    backups,
    snippet: built.snippet,
    restartRequired: true,
  }
}

export default { previewProvision, provisionConnector, buildMcpClientSnippet, connectorEnvVars, normalizeServerName }
