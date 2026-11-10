/**
 * dsh-buddy-expert-hub — 连接器「安装」层（本地定义 + 云端仓库 + 手动新增）。
 *
 * 与「连接」的区别：
 *   - **安装**：把连接器定义保存到 `$DSH_HOME/dsh-buddy-expert-hub/connectors/<id>/connector.json`，
 *     只是「我知道了这台 MCP server」，不写宿主 profile、不保存凭据。
 *   - **连接**：在已安装的基础上校验参数、加密保存凭据、写入 profile 的 mcp-client 实例。
 *
 * 只有两层「发现位置」（条目字段 `origin`，表示这一条当前在哪里被扫到）：
 *   - `local`：本地定义目录 `$DSH_HOME/dsh-buddy-expert-hub/connectors/<id>/connector.json`（= 已安装）
 *   - `cloud`：资源仓库 `repo/connectors/connectors.json` 单文件（兼容旧的 `repo/connectors/<id>/connector.json` 目录形态）
 * 合并优先级 `local` > `cloud`（同 id 时本地定义覆盖）。
 *
 * 两种「定义来源」（定义字段 `source`，表示这条定义是谁写下来的，装到本地后依然保留）：
 *   - `manual`：用户在本面板「新增连接器」弹窗里手填的
 *   - `cloud`：从 git 资源仓库下载安装的（历史值 `market` 已并入此值）
 * 两层语义必须分清：`origin` 回答「现在在哪」，`source` 回答「从哪来」。
 * 历史定义文件缺 `source` 字段时，本地目录一律按 `manual`、云端目录按 `cloud` 兜底。
 *
 * 零依赖，仅 node: 内置模块。
 *
 * @module dsh-buddy-expert-hub/connector-store
 */

import fs from 'node:fs'
import path from 'node:path'

/** 本地/云端连接器定义目录名（分别挂在 BASE_DIR 与 REPO_DIR 下）。 */
export const CONNECTORS_DIR_NAME = 'connectors'

/** 定义文件名（本地目录 `<id>/connector.json`）。 */
const DEF_FILE = 'connector.json'

/** 云端定义的单文件清单名（资源仓库 `connectors/connectors.json`）。 */
const CLOUD_DEF_FILE = 'connectors.json'

/** 图标扩展名白名单（与 host 侧 `/icon` 探测顺序一致）。 */
const ICON_EXTS = ['.svg', '.png', '.jpg', '.jpeg', '.webp']

/** 允许的传输类型（内部统一用连字符形式）。 */
const TRANSPORTS = new Set(['streamable-http', 'stdio'])

/** 需要参数的认证模式。 */
const AUTH_WITH_SETUP = new Set(['token', 'oauth', 'oneid-token'])

/**
 * 能原样保留的认证模式（含免连接的 `server-side` / `mcp`）。
 *
 * 声明了就照抄（快照里这两种模式很常见，前端要据此显示「无需连接」），
 * 不认识的值一律不采信，回落到「有必填参数就是 token、否则留空」。
 */
const KNOWN_AUTH_MODES = new Set(['token', 'oauth', 'oneid-token', 'server-side', 'mcp'])

/**
 * 定义来源的合法取值：本地自定义 / 云端下载。
 *
 * 历史值 `market`（WorkBuddy 本机市场）已并入 `cloud` —— 现在所有非手填来源
 * 都来自 git 资源仓库，没必要再区分「市场」这一层。
 * 注意与 `origin`（local / cloud）是两个不同维度的概念。
 */
export const SOURCE_VALUES = new Set(['manual', 'cloud'])

/**
 * 本地连接器目录。
 * @param {string} baseDir 插件数据目录
 * @returns {string} 目录路径
 */
export function localConnectorsDir(baseDir) {
  return path.join(baseDir, CONNECTORS_DIR_NAME)
}

/**
 * 云端连接器目录（资源仓库内）。
 * @param {string} repoDir 仓库副本目录
 * @returns {string} 目录路径
 */
export function cloudConnectorsDir(repoDir) {
  return path.join(repoDir, CONNECTORS_DIR_NAME)
}

/**
 * 云端连接器单文件清单的路径（资源仓库 `connectors/connectors.json`）。
 *
 * 这是云端定义的**主路径**：整个仓库的连接器都收在这一个 JSON 数组里，
 * 不再是一 id 一目录。`/status` 也用它判断「仓库可用」。
 *
 * @param {string} repoDir 仓库副本目录
 * @returns {string} 文件路径
 */
export function cloudConnectorsFile(repoDir) {
  return path.join(cloudConnectorsDir(repoDir), CLOUD_DEF_FILE)
}

/**
 * 归一化传输类型，统一成四种规范值：
 * `streamable-http` / `stdio` / `sse` / `cli`。
 *
 * `streamableHttp` / `streamable-http` / `http` 是**同一个东西**的三种写法
 * （MCP 的 Streamable HTTP 传输），一律归一成 `streamable-http` —— 仓库里有 4 条
 * 标成 `http`，它们与 `streamableHttp` 一样能被宿主 `mcp-client` 装载，
 * 若保留成独立值就会被 `CONNECTABLE_TRANSPORTS` 误判成「暂不支持」。
 *
 * 只有 `streamable-http` 与 `stdio` 是宿主能装载的，`sse` / `cli` 两种
 * **保留原值而不是丢弃** —— 资源仓库里它们真实存在（`sse` 9 条 / `cli` 45 条），
 * 丢了用户就永远不知道仓库里还有这些连接器。
 * 是否可连接由 {@link describeConnectability} 统一判定。
 *
 * 无法识别时原样返回小写值，交给 {@link normalizeDefinition} 决定拒绝还是标记不可连接。
 *
 * @param {any} value 原始传输类型
 * @returns {string} 归一化后的类型（可能为空串 / 非法值）
 */
function normalizeTransport(value) {
  const raw = String(value === null || value === undefined ? '' : value).trim().toLowerCase()
  /* `http` → `streamable-http`：MCP 的 http 传输就是 Streamable HTTP，别名而已。 */
  if (raw === 'streamablehttp' || raw === 'streamable-http' || raw === 'http') return 'streamable-http'
  if (raw === 'stdio' || raw === 'cli' || raw === 'sse') return raw
  return raw
}

/** 宿主 mcp-client 真正能装载的传输类型（其余一律「不可连接」）。 */
const CONNECTABLE_TRANSPORTS = new Set(['streamable-http', 'stdio'])

/** `${VAR}` 占位符（与 connector-meta 的提取规则同一口径）。 */
const PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g

/**
 * 判断 URL 是否是可用的 http(s) 地址，**放行 `${VAR}` 占位**。
 *
 * 资源仓库里存在 `"${TDENGINE_API_SCHEMA}://${TDENGINE_API_HOST}:${PORT}/api/v1/mcp/stream"`
 * 这种模板 URL：地址在连接时才由用户填的参数拼出来，落盘阶段无法也无需判定真实 scheme。
 * 这里把 scheme 位置的占位符先替换成 `https`、其余占位符替换成中性字符再校验，
 * 既拦住 `javascript:` / `file:` 这类危险 scheme，又不误杀合法模板。
 *
 * @param {string} url 原始 URL
 * @returns {boolean} 是否为可接受的 http(s) 地址（含模板形式）
 */
function isAcceptableHttpUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return false
  const probe = url
    .trim()
    .replace(/^\$\{[A-Za-z_][A-Za-z0-9_]*\}/, 'https')
    .replace(PLACEHOLDER_RE, 'x')
  return /^https?:\/\/[^\s]+$/i.test(probe)
}

/**
 * 判定一条定义「能不能在面板内安装 / 连接」，并给出中文原因。
 *
 * 四个不可连接的情形（按优先级）：
 *  1. 配置里根本没有 MCP server 块（等价于 `cli` 类型：仓库里只有 cli.json）；
 *  2. 传输类型不是 `streamable-http` / `stdio`（即 `sse` / `cli`；`http` 已归一成
 *     `streamable-http`，不算在内）；
 *  3. `url` 或 `command` 里含 `${VAR}` 占位符 —— 这类地址要人工填真实值才能连，
 *     面板内的连接流程无法代替用户补全（例如 tdengine 的 `${SCHEMA}://${HOST}:${PORT}/…`）；
 *  4. `url` 根本不是 http(s) 地址（`javascript:` / `file:` / `data:` 这类）——
 *     宽松模式收得下条目，但**绝不能把它标成可连接**，否则等于把危险 scheme 交给宿主。
 *
 * 注意：`headers` / `env` 里的 `${VAR}` 不算不可连接 —— 那是正常的参数占位，
 * 连接弹窗会逐项收集（agent-earth 这类条目靠它工作）。
 *
 * @param {{ transport?: string, url?: string, command?: string, hasServer?: boolean }} info 定义要素
 * @returns {{ connectable: boolean, unsupportedReason: string }} 判定结果（可连接时原因为空串）
 */
function describeConnectability(info) {
  const transport = String(info !== null && typeof info === 'object' ? info.transport || '' : '')
  const hasServer = info !== null && typeof info === 'object' ? info.hasServer !== false : true
  if (hasServer === false || transport === 'cli') {
    return { connectable: false, unsupportedReason: '该连接器为 CLI 类型，没有 MCP 配置' }
  }
  if (CONNECTABLE_TRANSPORTS.has(transport) === false) {
    return { connectable: false, unsupportedReason: '传输方式 ' + transport + ' 暂不支持在面板内连接' }
  }
  const url = typeof info.url === 'string' ? info.url : ''
  const command = typeof info.command === 'string' ? info.command : ''
  if (url.indexOf('${') >= 0 || command.indexOf('${') >= 0) {
    return { connectable: false, unsupportedReason: 'URL 含占位符，需手动编辑宿主 cordis.patch.yml 填入真实地址' }
  }
  /* 危险 scheme 的兜底：宽松模式只放宽「字段缺失」，不放宽 URL 合法性。 */
  if (transport === 'streamable-http' && isAcceptableHttpUrl(url) === false) {
    return { connectable: false, unsupportedReason: 'URL 必须是 http(s) 地址，无法在面板内连接' }
  }
  return { connectable: true, unsupportedReason: '' }
}

/**
 * 归一化图标扩展名：统一带前导点，且必须落在白名单内。
 * @param {any} value 原始扩展名（可能是 `.png` 或 `png`）
 * @returns {string} 合法扩展名（含点）；非法或缺失返回空串
 */
function normalizeIconExt(value) {
  const raw = String(value === null || value === undefined ? '' : value).trim().toLowerCase()
  if (raw === '') return ''
  const withDot = raw.startsWith('.') ? raw : '.' + raw
  return ICON_EXTS.includes(withDot) ? withDot : ''
}

/**
 * 归一化「如何配置」说明（只保留四段展示文本，不透传多余字段）。
 * @param {any} value 原始 setupSchema
 * @returns {{ title: string, description: string, docUrl: string, docLabel: string }|null} 归一化结果或 null
 */
function normalizeSetupSchemaLocal(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const text = (input, max) => (typeof input === 'string' ? input.trim().slice(0, max) : '')
  const title = text(value.title, 300)
  const description = text(value.description, 300)
  const docUrl = /^https?:\/\//i.test(text(value.docUrl, 400)) ? text(value.docUrl, 400) : ''
  const docLabel = text(value.docLabel, 120)
  if (title === '' && description === '' && docUrl === '') return null
  return { title, description, docUrl, docLabel }
}

/**
 * 安全读 JSON。
 * @param {string} file 路径
 * @returns {any|null} 解析结果
 */
function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 目录是否可读。
 * @param {string} dir 路径
 * @returns {boolean} 是否目录
 */
function isDir(dir) {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/**
 * 是否是一个已存在的普通文件（用于「覆盖前先留档」的判定）。
 * @param {string} file 路径
 * @returns {boolean} 是否存在且为普通文件
 */
function isExistingFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * 反斜杠路径转 POSIX 形式，用于错误文案 / 对外输出（Windows 下也要给人看得懂的路径）。
 * @param {string} value 路径
 * @returns {string} POSIX 风格路径
 */
function toPosixPath(value) {
  return String(value).split(path.sep).join('/')
}

/**
 * 从 headers / env 的字符串里提取 `${VAR}`。
 * @param {Record<string, any>|null} obj headers 或 env
 * @returns {string[]} 变量名
 */
function collectVars(obj) {
  const out = new Set()
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return []
  for (const value of Object.values(obj)) {
    if (typeof value !== 'string') continue
    for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) out.add(match[1])
  }
  return [...out]
}

/**
 * 由名称派生 id（kebab-case），与已有 id 冲突时追加序号。
 * @param {string} name 名称
 * @param {Iterable<string>} existing 已占用的 id
 * @returns {string} 唯一 id
 */
export function makeIdFromName(name, existing) {
  const base = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'connector'
  const taken = new Set(existing)
  if (!taken.has(base)) return base
  for (let i = 2; i < 1000; i += 1) {
    const candidate = base + '-' + i
    if (!taken.has(candidate)) return candidate
  }
  return base + '-' + Date.now().toString(36)
}

/**
 * 判断一个字符串能否直接当作**单段目录名**使用。
 *
 * 拒绝：空串、`.`、`..`、含 `/` 或 `\`、含 NUL、以 `.` 开头（隐藏目录 / `..x`）、超长。
 * 这是所有「用 id 拼磁盘路径」的地方的第一道闸门 —— 云端定义文件是不可信输入，
 * `id: "../../victim"` 曾经能把目录建到 `connectors/` 之外，甚至让卸载删掉上层目录。
 *
 * @param {any} value 待校验值
 * @returns {boolean} 是否可安全用作单段目录名
 */
export function isSafeSegmentName(value) {
  if (typeof value !== 'string') return false
  const name = value.trim()
  if (name === '' || name === '.' || name === '..') return false
  if (name.length > 200) return false
  if (name.includes('/') || name.includes('\\')) return false
  if (name.includes('\0')) return false
  if (name.startsWith('.')) return false
  return true
}

/**
 * 短哈希（djb2 → base36），只用于让净化后的目录名保持稳定且不易撞名。
 * @param {string} text 输入
 * @returns {string} 6 位左右的 base36 串
 */
function shortHash(text) {
  let hash = 5381
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0
  return hash.toString(36).slice(0, 6)
}

/**
 * id → 安全的磁盘目录名（始终是单段，且一定落在 `connectors/` 下一层）。
 *
 * 合法 id 原样使用；不合法（含路径分隔符 / 前导点 / `..`）时净化成单段名字并追加短哈希，
 * 避免两个不同 id 净化后撞到同一个目录。定义文件里只保存原始 `id`，
 * 因此列表里仍按原始 id 展示，不会出现「装完就消失」。
 *
 * @param {any} id 连接器 id
 * @returns {string} 可安全拼接的目录名
 */
export function diskNameOfId(id) {
  const raw = typeof id === 'string' ? id.trim() : ''
  if (isSafeSegmentName(raw) && !raw.includes('..')) return raw
  const base = raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[.\-]+/, '')
    .replace(/[.\-]+$/, '')
    .replace(/\.{2,}/g, '.')
    .slice(0, 60) || 'connector'
  return base + '-' + shortHash(raw === '' ? 'connector' : raw)
}

/** 目录名冲突时最多尝试的后缀数（`name-2` … `name-N`）。 */
const MAX_DIR_SUFFIX = 200

/**
 * 为一条定义挑选**可写入**的目录名，保证「一个 id 只对应一个目录」。
 *
 * 三类情况：
 *  1. 目录不存在 → 直接用 `diskNameOfId(id)` 的结果；
 *  2. 目录已存在且文件里的 `id` 与要写的一致 → 复用它（同 id 覆盖写盘）；
 *  3. 目录已存在但属于**另一个 id** → 依次尝试 `name-2`、`name-3` …
 *
 * 为什么需要第 3 类：`diskNameOfId` 不是单射 —— 自报 `id:"../x"` 会被净化成
 * `x-yj8wtk`，而另一个连接器完全可以合法地把 id 取成 `x-yj8wtk`；Windows / macOS 的
 * 路径还大小写不敏感，`Alpha` 与 `alpha` 会落到同一个目录。若直接覆盖，先装的那条
 * 定义会被**静默顶掉并从列表消失**，卸载时还会跨 id 误删。这里用「换一个空位」消解，
 * 而不是失败：调用方（安装 / 手动新增）本来就期待成功，目录名对用户不可见。
 *
 * 目录存在但读不到 `connector.json`（装到一半留下的空目录）→ 直接写入，不阻塞。
 *
 * @param {string} root `connectors/` 的绝对路径
 * @param {any} id 连接器 id
 * @returns {string} 可用的目录名；连续冲突到上限时返回空串
 */
function resolveWritableDirName(root, id) {
  const target = String(id)
  /* 已经装过同一个 id（可能落在带后缀的目录里）→ 复用它，避免每次写盘都新开目录。 */
  const existingDir = findDefinitionDir(root, target)
  if (existingDir !== null) return path.basename(existingDir)
  const base = diskNameOfId(target)
  for (let i = 1; i <= MAX_DIR_SUFFIX; i += 1) {
    const name = i === 1 ? base : base + '-' + i
    const dir = path.join(root, name)
    if (!isDir(dir)) return name
    const existing = readJsonSafe(path.join(dir, DEF_FILE))
    if (existing === null) return name
    if (String(existing.id) === target) return name
  }
  return ''
}

/**
 * 按定义里的 `id` 找出它实际落盘的目录（**不能直接拿 id 当目录名**）。
 *
 * 目录名可能带净化哈希或 `-2` 后缀（见 {@link resolveWritableDirName}），
 * 所以必须逐个目录读文件比对 `id`；只有全程都没有 id 匹配时，才退回
 * 「名字等于 `diskNameOfId(id)` 且文件不可读」的残留目录（用于清理孤儿空目录）。
 *
 * @param {string} root `connectors/` 的绝对路径
 * @param {any} id 连接器 id
 * @returns {string|null} 目录绝对路径；找不到返回 null
 */
export function findDefinitionDir(root, id) {
  const target = String(id)
  const nominal = diskNameOfId(target)
  let entries = []
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  let orphan = null
  for (const entry of entries) {
    if (entry.isDirectory() !== true) continue
    if (!isSafeSegmentName(entry.name)) continue
    const dir = path.join(root, entry.name)
    const existing = readJsonSafe(path.join(dir, DEF_FILE))
    if (existing === null) {
      if (orphan === null && entry.name.toLowerCase() === nominal.toLowerCase()) orphan = dir
      continue
    }
    if (String(existing.id) === target) return dir
  }
  return orphan
}

/**
 * 把任意输入收敛成合法的定义来源（`manual` / `cloud`）。
 *
 * 历史遗留值一律按「不是手填的就来自 git」处理：
 *   - `market`（旧 WorkBuddy 市场下载）→ `cloud`，因为市场竞争已并入云端；
 *   - `local`（更早的脏值，曾经被误写进 `source`）→ `cloud`，它同样表示「不是手填的」。
 * 其余无法识别的值退回兜底来源，保证 `source` 只会出现两种取值（`local` 只属于 `origin`）。
 *
 * @param {any} value 原始取值
 * @param {string} [fallback] 兜底来源，缺省 `manual`
 * @returns {string} 合法来源
 */
export function normalizeSource(value, fallback) {
  const raw = String(value === null || value === undefined ? '' : value).trim().toLowerCase()
  if (raw === 'market' || raw === 'local') return 'cloud'
  if (SOURCE_VALUES.has(raw)) return raw
  const safe = String(fallback === null || fallback === undefined ? '' : fallback).trim().toLowerCase()
  if (safe === 'market' || safe === 'local') return 'cloud'
  return SOURCE_VALUES.has(safe) ? safe : 'manual'
}

/**
 * 把任意来源的定义规范化成统一结构；非法输入返回 `{ ok:false, error }`。
 *
 * `source` 的取值优先级：**定义文件里的 `source` > `meta.source` / `meta.fallbackSource` > `manual`**。
 * 文件优先是关键：扫描已有定义时若无条件覆盖，装到本地后就再也分不清
 * 是自己手填的（manual）还是从资源仓库下载的（cloud）。
 *
 * `options.lenient === true` 时**不因传输类型 / URL 不合法而拒收**（云端仓库用）：
 * 上游有 `cli` / `sse` / `http` / `${VAR}` 模板地址这些真实脏数据，拒收等于让它们
 * 从列表里消失；改为收下并打上 `connectable:false` + 中文原因的标记。
 * 手动新增（`/connectors/create`）与安装（`/connectors/install`）必须走严格模式，
 * 用户手填的东西必须合法。
 *
 * @param {any} raw 原始定义（手动表单 / 仓库条目 / 云端定义文件）
 * @param {{ id?: string, source?: string, fallbackSource?: string, origin?: string, now?: number }} meta 补充元数据
 * @param {{ lenient?: boolean, hasServer?: boolean }} [options] 宽松模式开关
 * @returns {{ ok: boolean, def?: Record<string, any>, error?: string }} 结果
 */
export function normalizeDefinition(raw, meta, options) {
  const src = raw !== null && typeof raw === 'object' ? raw : {}
  const info = meta !== null && typeof meta === 'object' ? meta : {}
  const opts = options !== null && typeof options === 'object' ? options : {}
  const lenient = opts.lenient === true
  /* 宽松模式允许只有 id 的条目：名称用 id 兜底，免得整条被拒。 */
  const name = String(src.name || '').trim() || (lenient ? String(info.id || src.id || '').trim() : '')
  if (name === '') return { ok: false, error: '名称不能为空' }

  const transport = normalizeTransport(src.transport)
  const url = typeof src.url === 'string' ? src.url.trim() : ''
  const command = typeof src.command === 'string' ? src.command.trim() : ''
  if (lenient !== true) {
    if (!TRANSPORTS.has(transport)) return { ok: false, error: '传输方式必须是 streamable-http 或 stdio' }
    if (transport === 'streamable-http') {
      if (url === '') return { ok: false, error: 'streamable-http 必须填写 URL' }
      if (!isAcceptableHttpUrl(url)) return { ok: false, error: 'URL 必须是 http(s) 地址' }
    } else if (command === '') {
      return { ok: false, error: 'stdio 必须填写启动命令' }
    }
  }

  const objField = (value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
    const out = {}
    for (const [key, val] of Object.entries(value)) {
      if (typeof key !== 'string' || key.trim() === '') continue
      if (typeof val === 'string') out[key] = val
    }
    return out
  }

  const headers = objField(src.headers)
  const env = objField(src.env)
  const args = Array.isArray(src.args)
    ? src.args.filter((x) => typeof x === 'string' && x !== '')
    : []

  const id = String(info.id || src.id || '').trim() ||
    makeIdFromName(name, [])

  // 必填参数：显式给出优先，否则从 headers/env 的占位符推断
  const explicit = Array.isArray(src.requiredParams)
    ? src.requiredParams.filter((x) => typeof x === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(x))
    : []
  const inferred = [...new Set([...collectVars(headers), ...collectVars(env)])]
  const requiredParams = [...new Set(explicit.length > 0 ? explicit : inferred)].sort()

  const authModeRaw = String(src.authMode || '').trim().toLowerCase()
  const authMode = KNOWN_AUTH_MODES.has(authModeRaw)
    ? authModeRaw
    : (requiredParams.length > 0 ? 'token' : '')

  const fields = Array.isArray(src.paramFields) ? src.paramFields : []
  const byKey = new Map()
  for (const field of fields) {
    if (field === null || typeof field !== 'object') continue
    const key = typeof field.key === 'string' ? field.key : ''
    if (key === '') continue
    byKey.set(key, {
      key,
      label: typeof field.label === 'string' && field.label !== '' ? field.label : key,
      placeholder: typeof field.placeholder === 'string' ? field.placeholder : '',
      description: typeof field.description === 'string' ? field.description : '',
      required: field.required !== false,
      type: field.type === 'password' ? 'password' : 'text',
    })
  }
  for (const key of requiredParams) {
    if (!byKey.has(key)) {
      byKey.set(key, { key, label: key, placeholder: '', description: '', required: true, type: 'password' })
    }
  }
  const paramFields = [...byKey.values()]

  /* 选填参数：显式给出优先；与必填重合的一律剔除（同一变量不能既是必填又是选填）。 */
  const explicitOptional = Array.isArray(src.optionalParams)
    ? src.optionalParams.filter((x) => typeof x === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(x))
    : []
  const optionalParams = [...new Set(explicitOptional)]
    .filter((key) => requiredParams.indexOf(key) < 0)
    .sort()

  /* 与 connector-meta 的口径一致：显式布尔 needsSetup 优先保留，缺省按认证模式 / 必填参数推断。 */
  const needsSetup = typeof src.needsSetup === 'boolean'
    ? src.needsSetup
    : Boolean(AUTH_WITH_SETUP.has(authMode) || requiredParams.length > 0)

  // 兜底来源：meta.fallbackSource（扫描目录时给）> meta.source（安装 / 手动新增时给）> manual
  const fallbackSource = normalizeSource(info.fallbackSource || info.source, 'manual')

  /* 能不能在面板内安装 / 连接：宽松模式收下的脏数据在这里被标记出来，
     而不是从列表里消失。严格模式（手填 / 安装）进来的一定是可连接的。 */
  const hasServer = opts.hasServer !== false
  const { connectable, unsupportedReason } = describeConnectability({ transport, url, command, hasServer })

  const def = {
    id,
    name: name.slice(0, 120),
    description: String(src.description || '').slice(0, 600),
    author: String(src.author || '').slice(0, 120),
    transport,
    /* url / command 原样保留：`sse` / `http` 条目也要在详情里显示它到底指向哪，
       供用户自己判断能否手动配置。 */
    url: transport === 'stdio' ? '' : url,
    command: transport === 'stdio' || command !== '' ? command : '',
    args,
    cwd: typeof src.cwd === 'string' ? src.cwd : '',
    headers,
    env,
    authMode,
    requiredParams,
    optionalParams,
    paramFields,
    setupSchema: normalizeSetupSchemaLocal(src.setupSchema),
    needsSetup,
    /* 图标扩展名：资源仓库 entries 里带 `iconExt`（如 `.png`），前端据此拼 /icon URL。
       本地自定义定义通常没有，留空即可（/icon 会按白名单逐个探测）。 */
    iconExt: normalizeIconExt(src.iconExt),
    connectable,
    unsupportedReason,
    /* 传输类型被「块结构」纠正过（上游把 HTTP 误标成 stdio）时留个痕，便于排查上游数据；
       前端不展示这个字段。 */
    transportFixed: src.transportFixed === true,
    source: normalizeSource(src.source, fallbackSource),
    origin: String(info.origin || src.origin || ''),
    /* 安装时间：显式 now > 定义文件里的旧值 > 现在。
       扫描已有定义时必须沿用文件里的值，否则每次列表刷新都会把「安装时间」刷成「刚刚」。 */
    installedAt: typeof info.now === 'number' && Number.isFinite(info.now)
      ? info.now
      : (typeof src.installedAt === 'number' && Number.isFinite(src.installedAt) ? src.installedAt : Date.now()),
  }
  return { ok: true, def }
}

/**
 * 定义 → 前端条目（补齐 config / transport 驼峰别名，保持与仓库条目同形）。
 *
 * 传输类型对外仍用驼峰别名（`streamableHttp` / `stdio`），但 `sse` / `cli`
 * **不做别名替换**，原样透出 —— 前端靠它 + `connectable` 一起决定禁用态文案，
 * 把 sse 硬说成 streamableHttp 会让「不可连接」的原因自相矛盾。
 *
 * @param {Record<string, any>} def 规范化定义
 * @returns {Record<string, any>} 前端条目
 */
export function definitionToItem(def) {
  const transport = def.transport === 'stdio' || def.transport === 'sse' || def.transport === 'cli'
    ? def.transport
    : 'streamableHttp'
  let server = null
  if (def.transport === 'stdio') {
    server = {
      type: 'stdio',
      command: def.command,
      ...(def.args.length > 0 ? { args: def.args } : {}),
      ...(def.cwd !== '' ? { cwd: def.cwd } : {}),
      ...(Object.keys(def.env).length > 0 ? { env: def.env } : {}),
    }
  } else if (def.transport === 'streamable-http' || def.transport === 'sse') {
    /* `sse` 也照样把配置透出去：面板里「复制配置」要给用户一份完整可用的 JSON，
       能不能连由 `connectable` 决定，配置本身不该被吞掉。 */
    server = {
      type: def.transport === 'sse' ? 'sse' : 'streamableHttp',
      url: def.url,
      ...(Object.keys(def.headers).length > 0 ? { headers: def.headers } : {}),
    }
  }
  /* `cli` 条目没有 MCP 配置块：config 给 null，前端「MCP 配置」区块自然不渲染。 */
  return {
    id: def.id,
    name: def.name,
    description: def.description,
    author: def.author,
    /* 搜索用的小写全文（id + 名称 + 描述 + 作者）：`GET /connectors?q=` 依赖它，
       否则云端条目一条都搜不到。对外返回前由 `publicConnector` 剥掉。 */
    searchText: [def.id, def.name, def.description, def.author].join(' ').toLowerCase(),
    transport,
    url: typeof def.url === 'string' ? def.url : '',
    iconExt: typeof def.iconExt === 'string' ? def.iconExt : '',
    config: server === null ? null : { mcpServers: { [def.id]: server } },
    authMode: def.authMode,
    requiredParams: Array.isArray(def.requiredParams) ? def.requiredParams : [],
    optionalParams: Array.isArray(def.optionalParams) ? def.optionalParams : [],
    paramFields: Array.isArray(def.paramFields) ? def.paramFields : [],
    /* 没有「如何配置」说明时对外给 null（前端据此不渲染引导块），而不是塞一个空对象。 */
    setupSchema: def.setupSchema === null || typeof def.setupSchema !== 'object' ? null : def.setupSchema,
    needsSetup: def.needsSetup === true,
    /* 可连接性：false 时前端禁用安装 / 连接入口，并用 `unsupportedReason` 说明原因。 */
    connectable: def.connectable !== false,
    unsupportedReason: typeof def.unsupportedReason === 'string' ? def.unsupportedReason : '',
    source: def.source,
    origin: def.origin,
    installed: true,
    installedAt: def.installedAt,
  }
}

/**
 * 扫描一个连接器定义目录。
 *
 * 定义文件里自带的 `source` 优先保留（安装到本地后仍能区分 manual / cloud）；
 * 只有文件缺这个字段的老定义，才用 `fallbackSource` 兜底。
 *
 * 条目 id 取定义文件里的 `id`（缺失时用目录名）：磁盘写入时目录名会被净化，
 * 但对外仍按定义自报的 id 展示，避免「装成功却查不到」。目录名本身必须能安全
 * 用作单段路径（见 {@link isSafeSegmentName}），否则整条跳过。
 *
 * 读出的每条定义额外带上 `file`（定义文件绝对路径），供详情展示；该字段只在
 * 本地已安装条目上对外返回，见 {@link mergeConnectorSources}。
 *
 * @param {string} dir 目录
 * @param {string} fallbackSource 兜底来源（local 目录传 manual，云端目录传 cloud）
 * @returns {Array<Record<string, any>>} 定义列表
 */
function scanDefinitions(dir, fallbackSource) {
  if (!isDir(dir)) return []
  const out = []
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  for (const entry of entries) {
    if (entry.isDirectory() !== true) continue
    if (!isSafeSegmentName(entry.name)) continue
    const file = path.join(dir, entry.name, DEF_FILE)
    const raw = readJsonSafe(file)
    if (raw === null) continue
    const result = normalizeDefinition(raw, {
      id: String(raw.id || entry.name),
      fallbackSource,
    })
    if (result.ok !== true) continue
    result.def.file = file
    out.push(result.def)
  }
  return out
}

/**
 * 本地已安装连接器定义。
 *
 * 历史定义可能没有 `source` 字段，按「本地自定义（manual）」处理。
 *
 * @param {string} baseDir 插件数据目录
 * @returns {Array<Record<string, any>>} 定义列表
 */
export function listLocalDefinitions(baseDir) {
  return scanDefinitions(localConnectorsDir(baseDir), 'manual')
}

/**
 * 推断仓库条目的传输类型（五种值之一）。
 *
 * 上游数据有三处不可靠，所以**块结构优先于顶层声明**：
 *  1. 12 条把 HTTP 服务标成了 `stdio`（块里只有 `{url, timeout}`，没有 `command`）——
 *     一条 stdio 定义不可能没有启动命令，据此判定为 `streamable-http`（并打 `transportFixed`）；
 *  2. 有些条目只有块结构、没写顶层 `transport`；
 *  3. 完全没有 `config.mcpServers` 块的条目（仓库里只有 `cli.json`）判为 `cli`。
 *
 * `sse` / `cli` 保留原值：它们是**真的**不是 streamable-http，
 * 不能靠结构改写冒充（把 SSE 端点当 streamable-http 连，装上去也用不了）。
 * 顶层写 `http` 的按 {@link normalizeTransport} 归一成 `streamable-http`（同义写法）。
 *
 * @param {Record<string, any>} src 仓库条目
 * @param {Record<string, any>} block `config.mcpServers[<key>]` 块
 * @param {boolean} hasServer 是否存在 MCP server 块
 * @returns {{ transport: string, transportFixed: boolean }} 传输类型与是否被结构纠正过
 */
function resolveCloudTransport(src, block, hasServer) {
  const declared = normalizeTransport(
    typeof src.transport === 'string' && src.transport.trim() !== '' ? src.transport : block.type,
  )
  if (hasServer !== true) return { transport: 'cli', transportFixed: declared !== 'cli' }
  const hasCommand = typeof block.command === 'string' && block.command.trim() !== ''
  const hasUrl = typeof block.url === 'string' && block.url.trim() !== ''
  if (declared === 'stdio' && hasCommand === false && hasUrl === true) {
    return { transport: 'streamable-http', transportFixed: true }
  }
  if (declared === '') {
    if (hasCommand) return { transport: 'stdio', transportFixed: false }
    if (hasUrl) return { transport: 'streamable-http', transportFixed: false }
    return { transport: 'cli', transportFixed: false }
  }
  return { transport: declared, transportFixed: false }
}

/**
 * 把资源仓库 `connectors/connectors.json` 里的**单条条目**转成规范化定义。
 *
 * 条目的权威配置在 `config.mcpServers[<key>]`（一个条目只描述一台 server）：
 * 传输类型见 {@link resolveCloudTransport}（块结构优先于顶层声明）；
 * url / command / args / env / headers 一律以 server 块为准（顶层 `url` 只是冗余副本）。
 *
 * 云端走**宽松模式**：`cli` / `sse` / `http` / 占位符地址这些宿主连不了的条目也照收，
 * 只打上 `connectable:false` + 中文原因 —— 全量出现在列表里，绝不静默丢弃。
 * 真正解析不了的（缺 id）才返回 `{ ok:false }`，由调用方计数。
 *
 * @param {any} entry 仓库条目
 * @returns {{ ok: boolean, def?: Record<string, any>, error?: string, transport?: string }} 结果
 */
function definitionFromCloudEntry(entry) {
  const src = entry !== null && typeof entry === 'object' ? entry : {}
  const servers = src.config !== null && typeof src.config === 'object' ? src.config.mcpServers : null
  const keys = servers !== null && typeof servers === 'object' && Array.isArray(servers) === false
    ? Object.keys(servers)
    : []
  const server = keys.length > 0 ? servers[keys[0]] : null
  const hasServer = server !== null && typeof server === 'object'
  const block = hasServer ? server : {}
  const id = typeof src.id === 'string' && src.id.trim() !== '' ? src.id.trim() : keys[0]
  if (id === undefined || id === '') return { ok: false, error: '条目缺少 id' }
  const { transport, transportFixed } = resolveCloudTransport(src, block, hasServer)
  return normalizeDefinition({
    id,
    name: src.name || id,
    description: src.description,
    author: src.author,
    transport,
    transportFixed,
    url: block.url !== undefined ? block.url : src.url,
    command: block.command,
    args: block.args,
    cwd: block.cwd,
    headers: block.headers,
    env: block.env,
    authMode: src.authMode,
    requiredParams: src.requiredParams,
    optionalParams: src.optionalParams,
    paramFields: src.paramFields,
    setupSchema: src.setupSchema,
    needsSetup: src.needsSetup,
    iconExt: src.iconExt,
  }, { id, source: 'cloud', origin: '' }, { lenient: true, hasServer })
}

/**
 * 读取资源仓库的单文件连接器清单，并把被跳过的条目一并带回。
 *
 * 「跳过」不再是静默行为：每条都记下 id / 名称 / 传输类型 / 中文原因，
 * 由 `/status` 的 `connectorsSkipped` 对外报告，避免用户以为仓库里只有这么多连接器。
 *
 * @param {string} file `connectors/connectors.json` 的绝对路径
 * @returns {{ defs: Array<Record<string, any>>, skipped: Array<Record<string, string>> }|null}
 *   定义列表与被跳过的条目；文件缺失 / 解析失败 / 不是数组时返回 null
 */
function readCloudDefinitionList(file) {
  const parsed = readJsonSafe(file)
  if (!Array.isArray(parsed)) return null
  const defs = []
  const skipped = []
  for (const entry of parsed) {
    const src = entry !== null && typeof entry === 'object' ? entry : {}
    try {
      const result = definitionFromCloudEntry(entry)
      if (result.ok === true) {
        defs.push(result.def)
        continue
      }
      skipped.push({
        id: typeof src.id === 'string' ? src.id : '',
        name: typeof src.name === 'string' ? src.name : '',
        transport: typeof result.transport === 'string'
          ? result.transport
          : (typeof src.transport === 'string' ? src.transport : ''),
        reason: String(result.error || '无法解析'),
      })
    } catch (error) {
      skipped.push({
        id: typeof src.id === 'string' ? src.id : '',
        name: typeof src.name === 'string' ? src.name : '',
        transport: typeof src.transport === 'string' ? src.transport : '',
        reason: '解析异常：' + String((error && error.message) || error),
      })
    }
  }
  return { defs, skipped }
}

/**
 * 云端（资源仓库）连接器定义，**含被跳过的条目清单**。
 *
 * 主路径是单文件 `repo/connectors/connectors.json`（整个仓库的连接器收在一个 JSON 数组里）；
 * 只有该文件缺失或解析失败时，才回退扫描旧的 `repo/connectors/<id>/connector.json` 目录形态，
 * 两种形态都不存在时返回空列表。
 *
 * `defs` 是**全量**：`cli` / `sse` / `http` / 占位符地址这些连不了的条目也在里面，
 * 只是带着 `connectable:false` + `unsupportedReason`。`skipped` 只装真正解析不了的
 * （缺 id / 结构异常），正常数据下应当是空的 —— 它对应 `/status` 的 `connectorSkipped`。
 *
 * @param {string} repoDir 仓库副本目录
 * @returns {{ defs: Array<Record<string, any>>, skipped: Array<Record<string, string>> }} 结果
 */
export function listCloudDefinitionsWithSkipped(repoDir) {
  const root = typeof repoDir === 'string' ? repoDir : ''
  const fromFile = readCloudDefinitionList(cloudConnectorsFile(root))
  if (fromFile !== null) return fromFile
  return { defs: scanDefinitions(cloudConnectorsDir(root), 'cloud'), skipped: [] }
}

/**
 * 云端（资源仓库）连接器定义（全量，含 `connectable:false` 的条目）。
 *
 * 不可连接的条目也在这里返回：列表要如实显示仓库里到底有多少连接器，
 * 「能不能连」由每条的 `connectable` / `unsupportedReason` 表达。
 * 被统计进 `skipped` 的坏条目见 {@link listCloudDefinitionsWithSkipped}。
 *
 * @param {string} repoDir 仓库副本目录
 * @returns {Array<Record<string, any>>} 定义列表
 */
export function listCloudDefinitions(repoDir) {
  return listCloudDefinitionsWithSkipped(repoDir).defs
}

/**
 * 写入一个本地定义（幂等：同 id 覆盖）。
 *
 * 安全：`def.id` 来自不可信输入（云端定义文件 / 请求体），**绝不直接拼路径** ——
 * 一律走 {@link resolveWritableDirName} 选一个安全、且**未被别的 id 占用**的单段目录名，
 * 并再校验拼出的绝对路径确实在 `connectors/` 之内（双保险），杜绝 `id: "../../x"`
 * 写到目录之外；也不会让两个不同 id 抢同一个目录而互相覆盖。
 *
 * 语义：覆盖同名定义时**保留最初的 `installedAt`**（「安装时间」= 这条连接器第一次
 * 装上的时间；卸载后重装因为文件已删而重新计时）。落盘内容不带 `file`
 * （扫描时附加的临时字段），避免定义文件写进自己的路径。
 *
 * **落盘前用严格模式自检**（见 {@link normalizeDefinition} 的 `lenient` 缺省值）：
 * 扫描本地定义走的就是严格校验，若这里放行一条严格校验过不去的定义，磁盘上就会留下
 * 一个**读不回来的幽灵目录** —— 列表里看不见、`counts.installed` 不计数、界面也没法卸载。
 * 所以「能写进磁盘的一定读得回来」由这里兜底：自检不过直接 `{ ok:false }`，连目录都不建。
 *
 * **目标文件已损坏时不做静默覆盖**：`connector.json` 存在但解析不出来时，先把它改名成
 * `connector.json.corrupt-<时间戳>`（逐字节保留用户手写内容）再写新定义；改名失败则
 * **拒绝写入**并返回可读错误。损坏文件对列表本不可见，静默覆盖等于无声销毁用户数据。
 *
 * @param {string} baseDir 插件数据目录
 * @param {Record<string, any>} def 规范化定义
 * @returns {{ ok: boolean, file?: string, error?: string }} 结果
 */
export function saveLocalDefinition(baseDir, def) {
  try {
    const input = def !== null && typeof def === 'object' ? def : {}
    /* 严格自检：与 listLocalDefinitions 的读回路径同一套规则（lenient 缺省即严格）。 */
    const selfCheck = normalizeDefinition(input, {
      id: String(input.id || ''),
      fallbackSource: normalizeSource(input.source, 'manual'),
    })
    if (selfCheck.ok !== true) {
      return { ok: false, error: '连接器定义不合法：' + String(selfCheck.error || '校验未通过') }
    }
    const root = path.resolve(localConnectorsDir(baseDir))
    const dirName = resolveWritableDirName(root, input.id)
    if (dirName === '') {
      return { ok: false, error: '目录名冲突：该位置已被其他连接器占用，请换一个名称后重试' }
    }
    const dir = path.resolve(root, dirName)
    if (!dir.startsWith(root + path.sep)) {
      return { ok: false, error: '非法的连接器 id：' + String(input.id) }
    }
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, DEF_FILE)
    const stored = Object.assign({}, input)
    const existing = readJsonSafe(file)
    /* 目标已有 connector.json 但解析不出来（崩溃中断写盘 / 用户手改 JSON 改坏）：
       这类内容对列表是「不可见」的，直接覆盖等于把用户本可手工抢救的文本无声销毁。
       处理顺序是「先留档，留档不成就拒绝写入」：
         1. 先把它改名成 `connector.json.corrupt-<时间戳>`（与原文件逐字节相同），再写新定义 ——
            目录随之变回一条正常定义，用户既能看见也能卸载，备份不会被扫描当成定义；
         2. 改名失败（权限 / 占用）时**拒绝写入**并返回可读错误：绝不静默覆盖。 */
    if (existing === null && isExistingFile(file)) {
      const backup = file + '.corrupt-' + String(Date.now())
      try {
        fs.renameSync(file, backup)
      } catch {
        return {
          ok: false,
          error: '目标定义文件已损坏（无法解析），为避免覆盖已拒绝写入：' +
            toPosixPath(path.relative(baseDir, file)) + '，请手动处理后再试',
        }
      }
    }
    if (existing !== null && typeof existing.installedAt === 'number' && Number.isFinite(existing.installedAt)) {
      stored.installedAt = existing.installedAt
    }
    delete stored.file
    fs.writeFileSync(file, JSON.stringify(stored, null, 2) + '\n', 'utf8')
    return { ok: true, file }
  } catch (error) {
    return { ok: false, error: '保存连接器定义失败：' + String((error && error.message) || error) }
  }
}

/**
 * 删除本地定义。
 *
 * 安全：`id` 必须能安全用作单段目录名（见 {@link isSafeSegmentName}），否则直接拒绝、
 * **不碰文件系统**；目标目录由 {@link findDefinitionDir} 按「文件里的 id」定位，
 * 而不是把 id 当目录名 —— 否则净化哈希 / `-2` 后缀 / 大小写不敏感文件系统都会导致
 * 删错目录（例如卸 `Alpha` 连带删掉 `alpha`）。
 *
 * @param {string} baseDir 插件数据目录
 * @param {string} id 连接器 id
 * @returns {{ ok: boolean, removed: boolean, error?: string }} 结果
 */
export function removeLocalDefinition(baseDir, id) {
  if (!isSafeSegmentName(id)) return { ok: false, removed: false, error: '非法的连接器 id：' + String(id) }
  const root = path.resolve(localConnectorsDir(baseDir))
  const dir = findDefinitionDir(root, String(id).trim())
  if (dir === null) return { ok: true, removed: false }
  if (!path.resolve(dir).startsWith(root + path.sep)) {
    return { ok: false, removed: false, error: '非法的连接器 id：' + String(id) }
  }
  if (!isDir(dir)) return { ok: true, removed: false }
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    return { ok: true, removed: true }
  } catch (error) {
    return { ok: false, removed: false, error: '删除连接器定义失败：' + String((error && error.message) || error) }
  }
}

/**
 * 从合并后的条目反解出可保存的定义（安装用）。
 *
 * `source` 由调用方给定（云端安装传 `cloud`），会原样写进定义文件，
 * 之后读回时不再被覆盖 —— 这是「装到本地后仍能分辨来源」的关键。
 *
 * `origin` 不写进定义文件：它是「当前在哪被扫到」的运行时概念，由合并阶段决定。
 *
 * @param {Record<string, any>} item 合并后的连接器条目
 * @param {string} source 来源（cloud）
 * @returns {{ ok: boolean, def?: Record<string, any>, error?: string }} 结果
 */
export function definitionFromItem(item, source) {
  const servers = item !== null && typeof item === 'object' && item.config !== null &&
    typeof item.config === 'object' ? item.config.mcpServers : null
  const key = servers !== null && typeof servers === 'object' ? Object.keys(servers)[0] : undefined
  const server = key === undefined ? null : servers[key]
  if (server === null || typeof server !== 'object') return { ok: false, error: '该连接器没有可用的 MCP 配置' }
  return normalizeDefinition({
    id: String(item.id),
    name: String(item.name || item.id),
    description: String(item.description || ''),
    author: String(item.author || ''),
    transport: server.type || 'streamableHttp',
    url: server.url,
    command: server.command,
    args: server.args,
    cwd: server.cwd,
    headers: server.headers,
    env: server.env,
    authMode: item.authMode,
    requiredParams: item.requiredParams,
    optionalParams: item.optionalParams,
    paramFields: item.paramFields,
    setupSchema: item.setupSchema,
    needsSetup: item.needsSetup,
    iconExt: item.iconExt,
  }, { id: String(item.id), source, origin: '' })
}

/**
 * 合并两个来源（local > cloud）。
 *
 * 两层标记各自独立：
 *   - `origin`：这条当前在哪被扫到（local / cloud），本地项一律 `local`；
 *   - `source`：这条定义是谁写下来的（manual / cloud），**原样保留定义里的值**，
 *     所以「从云端下载后装到本地」的条目是 `origin=local` + `source=cloud`。
 *
 * `file`（本地定义文件绝对路径）只挂到本地已安装条目上，云端条目不返回路径。
 *
 * @param {Array<Record<string, any>>} local 本地定义
 * @param {Array<Record<string, any>>} cloud 云端定义
 * @param {Set<string>} connectedIds 已连接 id
 * @returns {Array<Record<string, any>>} 合并后的条目（每条带 origin / source / installed / connected）
 */
export function mergeConnectorSources(local, cloud, connectedIds) {
  const connected = connectedIds instanceof Set ? connectedIds : new Set()
  const map = new Map()
  for (const def of Array.isArray(cloud) ? cloud : []) {
    const item = definitionToItem(def)
    map.set(item.id, Object.assign(item, { origin: 'cloud', installed: false, connected: connected.has(item.id) }))
  }
  for (const def of Array.isArray(local) ? local : []) {
    const item = definitionToItem(def)
    /* 定义层附带的定义文件路径只对本地已安装条目暴露 */
    item.file = typeof def.file === 'string' ? def.file : ''
    map.set(item.id, Object.assign(item, { origin: 'local', installed: true, connected: connected.has(item.id) }))
  }
  return [...map.values()]
}

/**
 * 统计合并结果的条数，供 `GET /connectors` 的 `counts` 使用。
 *
 * 三套口径并存，键名不冲突：
 *   - `all` / `installed` / `cloud`：按 `origin` / `installed` 统计（历史口径，勿改语义）；
 *   - `sources.{manual,cloud}`：只统计**已安装**条目，按定义来源 `source` 聚合；
 *   - `connectable` / `unsupported`：按 `connectable` 统计。列表是**全量**的
 *     （仓库里 `cli` / `sse` 类型、以及地址含 `${VAR}` 占位符的条目也会出现，
 *     只是标着「不可连接」），所以「有多少条真能用」必须单独给个数，否则用户会
 *     把 316 当成「316 个都能连」。恒等式：`connectable + unsupported === all`。
 *
 * 之所以用嵌套 `sources`：扁平的 `counts.cloud` 已经被「云端可见条目数」占用，
 * 再放一个「来源=云端的已安装条目数」会互相覆盖，故新口径统一收在 `sources` 下。
 *
 * @param {Array<Record<string, any>>} merged 合并后的条目
 * @returns {{ all: number, installed: number, cloud: number, connectable: number, unsupported: number,
 *   sources: { manual: number, cloud: number } }} 计数表
 */
export function countConnectorSources(merged) {
  const list = Array.isArray(merged) ? merged : []
  const installed = list.filter((item) => item !== null && typeof item === 'object' && item.installed === true)
  const tally = (source) => installed.filter((item) => normalizeSource(item.source, 'manual') === source).length
  const unsupported = list.filter((item) => item !== null && typeof item === 'object' && item.connectable === false).length
  return {
    all: list.length,
    installed: installed.length,
    cloud: list.filter((item) => item !== null && typeof item === 'object' && item.origin === 'cloud').length,
    connectable: list.length - unsupported,
    unsupported,
    sources: {
      manual: tally('manual'),
      cloud: tally('cloud'),
    },
  }
}

export default {
  CONNECTORS_DIR_NAME,
  SOURCE_VALUES,
  countConnectorSources,
  diskNameOfId,
  findDefinitionDir,
  isSafeSegmentName,
  makeIdFromName,
  normalizeDefinition,
  normalizeSource,
  definitionToItem,
  definitionFromItem,
  listLocalDefinitions,
  listCloudDefinitions,
  listCloudDefinitionsWithSkipped,
  saveLocalDefinition,
  removeLocalDefinition,
  mergeConnectorSources,
  localConnectorsDir,
  cloudConnectorsDir,
  cloudConnectorsFile,
}
