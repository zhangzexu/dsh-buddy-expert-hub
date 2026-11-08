/**
 * dsh-buddy-expert-hub — host 半（Node 侧）。
 *
 * 职责：
 *  1. 维护 `DSH_HOME/dsh-buddy-expert-hub/` 工作目录（repo 浅克隆、索引缓存、导入落盘、状态文件）；
 *  2. 采集 ntd-resource 仓库中的专家 / 专家团 / 技能，以及本机 WorkBuddy 连接器市场快照；
 *  3. 通过 webServer 的 prefix 路由把数据以 JSON 形式提供给 client 半。
 *
 * 设计要点：
 *  - 零 npm 依赖，仅使用 node: 内置模块；
 *  - 所有路由统一返回 `{ ok: true, ... } | { ok: false, error }`；
 *  - 索引懒加载：首次请求触发一次后台同步，接口立即返回 `{ ok:false, busy:true }`；
 *  - 任何异常都必须被吞掉，绝不因为本插件导致 dsh web 启动失败。
 *
 * @module dsh-buddy-expert-hub
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
// frontmatter 解析只有一份实现，与 scripts/build-connectors.mjs 共用（块标量坑踩过两次）
import { parseFrontmatter, unquote } from './frontmatter.js'
// 认证模式 / 必填参数 / WorkBuddy 登录态判定与构建脚本共用，避免两条数据路径漂移
import {
  isOAuthMode,
  normalizeAuthMode,
  normalizeParamFields,
  normalizeRequiredParams,
  normalizeSetupSchema,
  readWorkbuddyReadyIds,
  workbuddyOAuthReady,
} from './connector-meta.js'
// 连接时自动生成并写入宿主 mcp-client 配置（片段生成 / 环境变量 / 三 profile 幂等写入）
import { previewProvision, provisionConnector } from './connector-provision.js'
// 连接器「安装」层：本地定义 / 云端仓库定义 / 手动新增，与「连接」解耦
import {
  cloudConnectorsDir,
  cloudConnectorsFile,
  countConnectorSources,
  definitionFromItem,
  definitionToItem,
  findDefinitionDir,
  listCloudDefinitions,
  listCloudDefinitionsWithSkipped,
  listLocalDefinitions,
  localConnectorsDir,
  makeIdFromName,
  mergeConnectorSources,
  normalizeDefinition,
  removeLocalDefinition,
  saveLocalDefinition,
} from './connector-store.js'

// ---------------------------------------------------------------------------
// 常量与路径
// ---------------------------------------------------------------------------

/**
 * 插件包根目录（index.js 位于 lib/ 下，向上一层即包根）。
 *
 * 注意：这里**不能**用 `BASE_DIR` —— 后者是 `$DSH_HOME/dsh-buddy-expert-hub` 数据目录，
 * 而 `builtin/` 是随插件包一起发布的只读资源。发布包必须包含 `builtin`（见
 * `scripts/check-package.mjs`）。
 */
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 内置技能的平台目录名：Windows 取 `windows`，其余平台（darwin / linux 等）取 `linux`。
 * @returns {'windows'|'linux'} 目录名
 */
function builtinPlatform() {
  return process.platform === 'win32' ? 'windows' : 'linux'
}

/** 内置技能「这是内置装进来的」标记文件名（写在 $DSH_HOME/skills/<dir>/ 下）。 */
const BUILTIN_MARKER = '.builtin-skill.json'

/** 单个内置技能文件的字节上限（防止误把大二进制塞进包）。 */
const BUILTIN_MAX_FILE_BYTES = 2 * 1024 * 1024

/** 单个内置技能的总体积上限。 */
const BUILTIN_MAX_TOTAL_BYTES = 40 * 1024 * 1024

/** 单个内置技能的文件数上限。 */
const BUILTIN_MAX_FILES = 400

/** 数据源仓库地址。 */
const SOURCE_URL = 'https://gitee.com/zhangzexu/dsh-buddy-expert-hub-resource.git'

/** 路由前缀，client 端所有请求都以它开头。 */
const ROUTE_PREFIX = '/dsh-buddy-expert-hub'

/**
 * 索引结构版本；不匹配时自动重建。改动采集逻辑（不只是结构）时也要 +1。
 *
 * 版本 5：连接器不再进索引。连接器改为「云端（资源仓库 `connectors/connectors.json`）
 * + 本地已安装定义」两源实时合并，索引里不再有 `connectors` / `connectorSource` /
 * `counts.connectors` 三个字段，旧 `index.json` 必须整体作废重建。
 */
const INDEX_VERSION = 5

/** DSH 主目录，可用 DSH_HOME 环境变量覆盖。 */
const DSH_HOME =
  typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh')

/** 本插件的工作目录（全新插件，不读取也不迁移任何旧目录）。 */
const BASE_DIR = path.join(DSH_HOME, 'dsh-buddy-expert-hub')
const REPO_DIR = path.join(BASE_DIR, 'repo')
const INDEX_FILE = path.join(BASE_DIR, 'index.json')
const STATE_FILE = path.join(BASE_DIR, 'state.json')

/** 导入时额外保留的 WorkBuddy 原始目录包（含 skills/，便于溯源与后续扩展）。 */
const IMPORTED_DIR = path.join(BASE_DIR, 'imported')

/** DSH 的本地专家目录 —— 导入落盘的权威位置，也是「已导入」的唯一来源。 */
const LOCAL_EXPERTS_DIR = path.join(DSH_HOME, 'experts')

/** NTD 已同步好的资源仓库副本（只读复用，可能没有 skills/）。 */
const NTD_RESOURCE_DIR = path.join(DSH_HOME, 'ntd-resource')

/** 本地专家 / 技能缺失时对外暴露的稳定错误码。 */
const CODE_SKILLS_MISSING = 'skills-missing'

/** 详情页正文（agent markdown / SKILL.md）截断长度。 */
const README_LIMIT = 2000

/** 单次查询的最大条数，防止前端误传超大 limit。 */
const MAX_LIMIT = 1000

/** `/pick` 每组条数：空查询 / 有查询。 */
const PICK_LIMIT_IDLE = 8
const PICK_LIMIT_QUERY = 20

/** `/pick` 单条描述的截断长度。 */
const PICK_DESC_LIMIT = 60

/** ---------------------------------------------------------------------------
 * 整包导出 / 导入（本地资料库）。
 * 导出把面板当前可见的全部数据（含正文与头像）打成单个 gzip JSON；
 * 导入后索引里的专家 / 团队 / 技能三类改从 bundle.json 读取，不依赖仓库 / 网络。
 * 连接器不进索引，始终来自「资源仓库 + 本地已安装定义」，与资料库无关。
 * ------------------------------------------------------------------------- */
const LIBRARY_DIR = path.join(BASE_DIR, 'library')

/** 导出包的标识与版本（导入时的合法性校验依据）。 */
const EXPORT_KIND = 'dsh-buddy-expert-hub-export'
const EXPORT_FORMAT_VERSION = 1

/** 导入文件大小上限（300MB）。 */
const LIBRARY_MAX_BYTES = 300 * 1024 * 1024

/** 专家分类中文映射。 */
const CATEGORY_LABELS = {
  '01-ProductDesign': '产品设计',
  '02-Engineering': '工程技术',
  '03-GameSpatial': '游戏与空间',
  '04-DataAI': '数据与 AI',
  '06-ContentCreative': '内容创意',
  '08-FinanceInvestment': '金融投资',
  '10-ProjectQuality': '项目质量',
  '11-SecurityCompliance': '安全合规',
  '12-IndustryConsultant': '行业顾问',
  '13-TencentZone': '腾讯专区',
}

/** 头像 / 图标支持的扩展名 → MIME。 */
const IMAGE_MIME = {
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
}

/** 连接器图标探测顺序。 */
const ICON_EXTS = ['.svg', '.png', '.jpg', '.jpeg', '.webp']

// ---------------------------------------------------------------------------
// 运行时状态（进程内缓存）
// ---------------------------------------------------------------------------

/** @type {{ busy: boolean, progress: string, lastError: string|null, lastErrorText: string|null, warnings: string[], lastSync: string|null, lastDataRoot: string|null, importedIds: string[], library: { dir: string, importedAt: string, previousDataRoot: string }|null, settings: { sourceUrl: string|null, skillhubUrl: string|null, builtinSkills: boolean }, index: any }} */
const state = {
  busy: false,
  progress: '',
  lastError: null,
  lastErrorText: null,
  warnings: [],
  lastSync: null,
  lastDataRoot: null,
  importedIds: [],
  library: null,
  /* builtinSkills：内置技能总开关。只由用户显式 toggle 改变，启动时绝不自动安装。 */
  settings: { sourceUrl: null, skillhubUrl: null, builtinSkills: false },
  /* 已安装技能：<目录名> → { enabled, source: 'repo'|'market'|'local', installedAt } */
  installedSkills: {},
  /* 已连接连接器：<连接器 id> → { connectedAt } */
  connectedConnectors: {},
  index: null,
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

/**
 * 输出 JSON 响应。
 * @param {import('node:http').ServerResponse} res 响应对象
 * @param {any} body 响应体
 * @param {number} [status=200] HTTP 状态码
 * @returns {void}
 */
function send(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/**
 * 通过文件头魔数嗅探图片 MIME。
 * 本地专家头像统一落盘为 avatar.png，源文件可能是 jpg/webp，因此不能只看扩展名。
 * @param {Buffer} data 文件内容
 * @param {string} fallback 扩展名推断出的 MIME
 * @returns {string} 最终 MIME
 */
function sniffImageMime(data, fallback) {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 8 && data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data.length >= 4 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif'
  if (
    data.length >= 12 &&
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return 'image/webp'
  }
  const head = data.slice(0, 64).toString('utf8').trim().toLowerCase()
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml'
  return fallback
}

/**
 * 输出工作目录内的图片资源。
 * @param {import('node:http').ServerResponse} res 响应对象
 * @param {string} filePath 图片绝对路径
 * @returns {void}
 */
function sendImage(res, filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const mime = IMAGE_MIME[ext]
  if (mime === undefined) {
    send(res, { ok: false, error: '不支持的图片格式' }, 404)
    return
  }
  let data
  try {
    data = fs.readFileSync(filePath)
  } catch {
    send(res, { ok: false, error: '资源不存在' }, 404)
    return
  }
  res.writeHead(200, {
    'Content-Type': sniffImageMime(data, mime),
    'Content-Length': String(data.length),
    'Cache-Control': 'public, max-age=600',
  })
  res.end(data)
}

/** 常见文件系统错误码 → 面向用户的中文提示。 */
const ERROR_HINTS = {
  EACCES: '资源目录不可写，请检查 ~/.dsh 权限',
  EPERM: '资源目录不可写，请检查 ~/.dsh 权限',
  ENOENT: '资源目录不存在',
  ENOSPC: '磁盘空间不足',
  EEXIST: '目标已存在',
  EROFS: '所在磁盘为只读，无法写入',
  EBUSY: '文件正被其他程序占用',
  EMFILE: '打开的文件过多，请稍后重试',
  ENOTDIR: '路径中的某一级不是目录',
  EISDIR: '目标是一个目录',
}

/**
 * 把 Node 原始错误翻译成给用户看的文案。
 * 原始错误仍然完整保存在 `state.lastError` 里供排查，接口对外只给人话。
 * @param {any} error 任意异常
 * @returns {string} 面向用户的错误文案
 */
function humanError(error) {
  if (error === null || error === undefined) return '未知错误'
  const code = typeof error.code === 'string' ? error.code : ''
  const hint = ERROR_HINTS[code]
  if (hint !== undefined) {
    const name = typeof error.path === 'string' && error.path !== '' ? '（' + path.basename(error.path) + '）' : ''
    return hint + name
  }
  const message = String(error.message || error)
  // git / 网络相关
  if (/git|clone|fetch|resolve host|Could not resolve|RPC failed|timed out/i.test(message)) {
    return '资源仓库同步失败，请检查网络或 git 是否可用'
  }
  // 兜底：把形如 `EEXIST: file already exists, mkdir 'D:\...'` 的串压掉路径部分。
  const stripped = message.replace(/(['"])(?:[A-Za-z]:)?[^'"]*[\\/][^'"]*\1/g, '…')
  return tidy(stripped, 300)
}

/**
 * 构造同步失败异常：**对外是中文可读文案**，底层错误细节只进 `lastErrorRaw`。
 *
 * `humanError()` 会把任何含 git / fetch 字样的英文错误压成一句通用提示，
 * 直接抛 `new Error(...)` 会丢掉「到底是拉取失败还是重置失败」这一层信息。
 * 这里把可直接展示的中文文案挂在 `userMessage` 上，由 `runSync` 的 catch 取用。
 *
 * @param {string} message 给用户看的中文文案
 * @param {string} [detail] 底层错误细节（只用于排查）
 * @returns {Error} 带 `userMessage` 的错误对象
 */
function syncFailure(message, detail) {
  const extra = String(detail === null || detail === undefined ? '' : detail).trim()
  const error = new Error(extra === '' ? message : message + '｜' + extra)
  error.userMessage = message
  return error
}

/**
 * 统一的错误响应体。
 * @param {any} error 任意异常
 * @returns {{ ok: false, error: string }} 错误载荷
 */
function fail(error) {
  return { ok: false, error: humanError(error) }
}

/**
 * 读取并解析 JSON；任何异常返回 null。
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
 * 读取文本；任何异常返回 null。
 * @param {string} file 绝对路径
 * @returns {string|null} 文本内容
 */
function readTextSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * 判断路径是否为已存在的普通文件。
 * @param {string} file 绝对路径
 * @returns {boolean} 是否为文件
 */
function isFile(file) {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * 判断路径是否为已存在的目录。
 * @param {string} dir 绝对路径
 * @returns {boolean} 是否为目录
 */
function isDir(dir) {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/**
 * 解析整数查询参数。
 * @param {string|null} raw 原始字符串
 * @param {number} fallback 缺省值
 * @param {number} min 下界
 * @param {number} max 上界
 * @returns {number} 归一化后的整数
 */
function intParam(raw, fallback, min, max) {
  const parsed = Number.parseInt(raw === null || raw === undefined ? '' : String(raw), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(Math.max(parsed, min), max)
}

/**
 * 归一化查询串：去空白、转小写。
 * @param {string|null} raw 原始查询串
 * @returns {string} 归一化结果（空串表示不过滤）
 */
function normalizeQuery(raw) {
  return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
}

/**
 * Windows 反斜杠路径转 POSIX 形式，用于对外输出与 URL 参数。
 * @param {string} value 路径
 * @returns {string} POSIX 风格路径
 */
function toPosix(value) {
  return String(value).split(path.sep).join('/')
}

/**
 * 压缩空白并截断。
 * @param {string} value 原文
 * @param {number} max 最大长度
 * @returns {string} 清洗后的文本
 */
function tidy(value, max) {
  const text = String(value === null || value === undefined ? '' : value)
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? text.slice(0, max) : text
}

/**
 * 压缩空白后截断，超长时补省略号（`/pick` 的一句话描述用）。
 * @param {any} value 原文
 * @param {number} max 最大长度
 * @returns {string} 截断后的文本
 */
function clipText(value, max) {
  const text = tidy(value, max + 1)
  if (text.length <= max) return text
  return text.slice(0, max).trimEnd() + '…'
}

/**
 * 去掉 markdown 的 frontmatter 块（含结束分隔线）。
 * @param {string} text 全文
 * @returns {string} 正文
 */
function stripFrontmatter(text) {
  if (typeof text !== 'string') return ''
  const matched = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text)
  return matched === null ? text : text.slice(matched[0].length)
}

/**
 * 从 `中文 | English` 形式的描述里取中文部分。
 * @param {string} description 原始描述
 * @returns {string} 中文描述
 */
function pickChinese(description) {
  const text = String(description === null || description === undefined ? '' : description)
  const sep = text.indexOf(' | ')
  const picked = sep >= 0 ? text.slice(0, sep) : text
  return tidy(picked, 600)
}

/**
 * 从多语言字段里取中文，缺省回落英文。
 * @param {any} field 形如 `{ zh, en }` 的字段
 * @param {number} [max=600] 最大长度
 * @returns {string} 提取后的文本
 */
function pickText(field, max = 600) {
  if (field === null || field === undefined) return ''
  if (typeof field === 'string') return tidy(field, max)
  if (typeof field !== 'object') return ''
  const zh = field.zh
  if (typeof zh === 'string' && zh.trim() !== '') return tidy(zh, max)
  const en = field.en
  if (typeof en === 'string' && en.trim() !== '') return tidy(en, max)
  return ''
}

/**
 * 把任意多语言数组规整成 `{ zh, en }[]`。
 * @param {any} list 原始数组
 * @param {number} [limit=40] 最多保留条数
 * @returns {Array<{ zh: string, en: string }>} 规整后的数组
 */
function normalizePairs(list, limit = 40) {
  if (!Array.isArray(list)) return []
  /** @type {Array<{ zh: string, en: string }>} */
  const out = []
  for (const entry of list) {
    if (typeof entry === 'string') {
      const text = tidy(entry, 400)
      if (text !== '') out.push({ zh: text, en: '' })
    } else if (entry !== null && typeof entry === 'object') {
      const zh = typeof entry.zh === 'string' ? tidy(entry.zh, 400) : ''
      const en = typeof entry.en === 'string' ? tidy(entry.en, 400) : ''
      if (zh !== '' || en !== '') out.push({ zh, en })
    }
    if (out.length >= limit) break
  }
  return out
}

/**
 * 把任意多语言字符串数组规整成中文串数组。
 * @param {any} list 原始数组
 * @param {number} [limit=16] 最多保留条数
 * @returns {string[]} 中文标签
 */
function normalizeTags(list, limit = 16) {
  if (!Array.isArray(list)) return []
  /** @type {string[]} */
  const out = []
  for (const entry of list) {
    const text = pickText(entry, 60)
    if (text !== '' && !out.includes(text)) out.push(text)
    if (out.length >= limit) break
  }
  return out
}

// ---------------------------------------------------------------------------
// 数据根
// ---------------------------------------------------------------------------

/** 数据根缓存；同步成功后可被强制指向 REPO_DIR。 */
let dataRootCache = null

/**
 * 切换成 git 数据源且数据根变化时置位：等待用户点「刷新」。
 *
 * **持久化到 state.json**（见 restoreState / persistState）：重启后仍要为 true，
 * 否则冷启动会按「索引缺失」自动 kickSync 触发一次 30MB 克隆，且前端不再提示点刷新。
 * 同时充当「抑制自动同步」的统一开关：只在用户主动 `/refresh` 时才允许同步。
 */
let indexSwitchPending = false

/**
 * 最近一次同步失败的时间戳（仅内存，不持久化）。
 *
 * 非空时抑制 `requireIndex()` / `/status` 的自动 kickSync：首次同步失败后
 * 每次轮询都重试一次克隆会让界面永远停在「首次同步中」。只在用户主动
 * `/refresh` 时重试，成功路径清位。
 * @type {number|null}
 */
let lastSyncFailedAt = null

/**
 * 自动同步是否被抑制（P1-1 的持久化待刷新标志 + P1-4 的失败抑制共用一套机制）。
 * @returns {boolean} true 表示只允许由用户主动 `/refresh` 触发同步
 */
function autoSyncSuppressed() {
  return indexSwitchPending === true || lastSyncFailedAt !== null
}

/**
 * 判断目录下是否存在非空的 experts/ 目录。
 * @param {string} dir 候选数据根
 * @returns {boolean} 是否可作为数据根
 */
function hasExpertsDir(dir) {
  const expertsDir = path.join(dir, 'experts')
  if (!isDir(expertsDir)) return false
  try {
    return fs.readdirSync(expertsDir).length > 0
  } catch {
    return false
  }
}

/**
 * 判断目录能否作为本机数据根。
 *
 * 与 hasExpertsDir 的区别：不要求 experts/ 存在且非空，
 * experts/ skills/ connectors/ 三者只要有一个是目录就可用 ——
 * 只放连接器的本机资源目录也必须是合法数据源。
 * @param {string} dir 候选数据根绝对路径
 * @returns {boolean} 目录存在且至少含一个资源子目录
 */
function isUsableDataRoot(dir) {
  if (typeof dir !== 'string' || dir === '' || !isDir(dir)) return false
  return ['experts', 'skills', 'connectors'].some((name) => isDir(path.join(dir, name)))
}

/**
 * 返回本机资源目录不可用的中文原因；可用时返回空串。
 * @param {string} dir 本机目录绝对路径
 * @returns {string} 错误文案，或空串表示可用
 */
function localDataRootError(dir) {
  if (!isDir(dir)) return '本机目录不存在：' + dir
  if (!isUsableDataRoot(dir)) {
    return '本机目录里没有 experts/、skills/ 或 connectors/ 中的任何一个：' + dir
  }
  return ''
}

/**
 * 解析当前数据根，优先级：
 *   1. 设置里配置的本机资源目录（且 isUsableDataRoot 通过）；
 *   2. 同步后缓存的数据根（命中条件同样放宽到 isUsableDataRoot）；
 *   3. NTD 已同步的 `$DSH_HOME/ntd-resource`（只读复用，可能是稀疏检出）；
 *   4. 插件自己的 `$DSH_HOME/dsh-buddy-expert-hub/repo`。
 *
 * 后两级仍沿用 hasExpertsDir 的严格判定，避免把外部稀疏目录的行为改坏。
 * @returns {string|null} 数据根绝对路径，全部不可用时返回 null
 */
function dataRoot() {
  const configured = parseSource(resolveSourceUrl())
  if (configured.kind === 'local' && isUsableDataRoot(configured.dir)) return configured.dir
  if (dataRootCache !== null && isUsableDataRoot(dataRootCache)) return dataRootCache
  if (hasExpertsDir(NTD_RESOURCE_DIR)) return NTD_RESOURCE_DIR
  if (hasExpertsDir(REPO_DIR)) return REPO_DIR
  return null
}

/**
 * 判断数据根下是否有技能数据。
 * @returns {boolean} skills/ 是否存在
 */
function dataRootHasSkills() {
  const root = dataRoot()
  return root !== null && isDir(path.join(root, 'skills'))
}

// ---------------------------------------------------------------------------
// 数据源地址（可配置）
// ---------------------------------------------------------------------------

/** 相对路径的统一中文提示（前端与后端保持同一句）。 */
const LOCAL_PATH_HINT =
  '本机目录请填绝对路径（如 /home/me/dsh-buddy-expert-hub-resource 或 D:\\data\\resource）；相对路径不支持'

/**
 * 校验 git 仓库地址，沿用旧规则：只允许 https:// 与 git@，且不得含空白或 `..`。
 *
 * 这个值会原样传给 git（clone / remote set-url），因此 git 分支的校验从宽机制从严；
 * 本机目录走 parseLocalSource，不受这里的限制。
 * @param {string} value 待校验字符串
 * @returns {boolean} 是否为合法 git 仓库地址
 */
function isGitSourceUrl(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed === '') return false
  if (/\s/.test(trimmed)) return false
  if (trimmed.includes('..')) return false
  // https:// 形式：不允许携带空白；git@ 形式：host:path。
  if (trimmed.startsWith('https://')) return /^https:\/\/[^\s]+$/.test(trimmed)
  if (trimmed.startsWith('git@')) return /^git@[^\s/:\\]+:[^\s]+$/.test(trimmed)
  return false
}

/**
 * 把 file:// 地址还原成本机目录。
 *
 * 优先用 node:url 的 fileURLToPath（能正确处理 file://C:/x、UNC 与百分号转义）；
 * Windows 上 `file:///home/me/x` 这类无盘符的 POSIX 路径会抛错，
 * 此时退回 URL 的 pathname 再交给 path.resolve 归一。
 * @param {string} raw file:// 形式的地址
 * @returns {{ dir: string, error: string }} 绝对目录或中文错误
 */
function fileUrlToDir(raw) {
  let parsed
  try {
    parsed = new URL(raw)
  } catch {
    return { dir: '', error: 'file:// 地址格式不正确：' + raw }
  }
  if (parsed.protocol !== 'file:') {
    return { dir: '', error: 'file:// 地址格式不正确：' + raw }
  }
  try {
    return { dir: path.resolve(fileURLToPath(parsed)), error: '' }
  } catch {
    let pathname = parsed.pathname
    try {
      pathname = decodeURIComponent(pathname)
    } catch {
      // 无法解码时保留原 pathname，后续的目录存在性校验会给出明确错误
    }
    const host =
      parsed.hostname === '' || parsed.hostname.toLowerCase() === 'localhost' ? '' : parsed.hostname
    const fallback = host === '' ? pathname : '//' + host + pathname
    if (fallback === '' || fallback === '/' || fallback === '//') {
      return { dir: '', error: 'file:// 地址缺少目录部分：' + raw }
    }
    return { dir: path.resolve(fallback), error: '' }
  }
}

/**
 * 解析本机目录形式的地址：POSIX 绝对路径、Windows 盘符、UNC、~ 展开、file://。
 *
 * 允许路径含空格与 `..`（最终由 path.resolve 归一，并由保存接口检查真实存在），
 * 但拒绝相对路径、NUL 与控制字符。
 * @param {string} raw 已去首尾空白的地址
 * @returns {{ kind: 'git'|'local'|'none', url: string, dir: string, error: string }} 解析结果
 */
function parseLocalSource(raw) {
  const rejected = (error) => ({ kind: 'none', url: '', dir: '', error })
  let candidate = raw
  if (/^file:\/\//i.test(raw)) {
    const fileResult = fileUrlToDir(raw)
    if (fileResult.error !== '') return rejected(fileResult.error)
    candidate = fileResult.dir
  } else if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) {
    candidate = path.join(os.homedir(), raw.slice(1).replace(/^[\\/]/, ''))
  }
  if (/[\u0000-\u001f\u007f]/.test(candidate)) return rejected('本机目录不能包含控制字符')
  // POSIX 绝对路径、Windows 盘符路径与 UNC 都算绝对形式；
  // 显式补上后两者是为了在 Linux 上也能识别 Windows 写法并给出「目录不存在」而非格式错误。
  const isAbsoluteForm =
    path.isAbsolute(candidate) || /^[A-Za-z]:[\\/]/.test(candidate) || /^[\\/]{2}/.test(candidate)
  if (!isAbsoluteForm) return rejected(LOCAL_PATH_HINT)
  return { kind: 'local', url: raw, dir: path.resolve(candidate), error: '' }
}

/**
 * 统一解析数据源地址。
 *
 * kind 取值：
 *   git   —— 远程 git 仓库，url 为仓库地址，只有在 git 同步分支里才会传给 git；
 *   local —— 本机资源目录，dir 为 path.resolve 后的绝对目录，绝不传给 git；
 *   none  —— 不合法，error 为可直接展示给用户的中文原因。
 * @param {string} value 用户填写的地址
 * @returns {{ kind: 'git'|'local'|'none', url: string, dir: string, error: string }} 解析结果
 */
function parseSource(value) {
  const rejected = (error) => ({ kind: 'none', url: '', dir: '', error })
  if (typeof value !== 'string') return rejected('数据源地址必须是字符串')
  const trimmed = value.trim()
  if (trimmed === '') return rejected('数据源地址不能为空')
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return rejected('数据源地址不能包含控制字符')
  if (isGitSourceUrl(trimmed)) return { kind: 'git', url: trimmed, dir: '', error: '' }
  if (trimmed.startsWith('git@')) return rejected('git@ 地址格式形如 git@host:owner/repo.git')
  if (trimmed.startsWith('https://')) return rejected('https 仓库地址格式不正确（不能含空格或 ..）')
  // 其它协议（ssh://、http://、ftp:// 等）一律拒绝，避免被当成相对路径
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed) && !/^file:\/\//i.test(trimmed)) {
    return rejected('数据源地址不支持该协议：请填 https://、git@ 或本机目录绝对路径')
  }
  return parseLocalSource(trimmed)
}

/**
 * 判断地址是否为受支持的数据源（git 仓库地址或本机目录）。
 *
 * 保留这个入口供 resolveSourceUrl 与 state.json 恢复使用；
 * 需要区分类型或拿到具体错误文案的调用方请直接用 parseSource。
 * @param {string} value 待校验字符串
 * @returns {boolean} 是否是可解析的数据源地址
 */
function isValidSourceUrl(value) {
  return parseSource(value).kind !== 'none'
}

/**
 * 通用 http(s) 地址校验（Skillhub 内网地址用；允许 http 以兼容内网部署）。
 * @param {string} value 地址
 * @returns {boolean} 是否合法
 */
function isValidHttpUrl(value) {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed === '' || /\s/.test(trimmed)) return false
  if (!/^https?:\/\//.test(trimmed)) return false
  try {
    const url = new URL(trimmed)
    return url.hostname !== ''
  } catch {
    return false
  }
}

/**
 * 当前生效的数据源地址：用户覆盖值（git 仓库或本机目录）优先，否则回落内置默认。
 * @returns {string} 生效的仓库地址或本机目录字符串
 */
function resolveSourceUrl() {
  const override = state.settings && typeof state.settings.sourceUrl === 'string' ? state.settings.sourceUrl : ''
  return override !== '' && isValidSourceUrl(override) ? override : SOURCE_URL
}

// ---------------------------------------------------------------------------
// 目录与状态持久化
// ---------------------------------------------------------------------------

/**
 * 确保工作目录存在。
 * @returns {void}
 */
function ensureDirs() {
  fs.mkdirSync(BASE_DIR, { recursive: true })
  fs.mkdirSync(LOCAL_EXPERTS_DIR, { recursive: true })
}

/**
 * 静默地确保工作目录存在（启动阶段使用）。
 * @returns {void}
 */
function ensureDirsQuiet() {
  try {
    fs.mkdirSync(BASE_DIR, { recursive: true })
  } catch (error) {
    state.warnings.push('无法创建工作目录：' + humanError(error))
  }
}

/**
 * 从 state.json 恢复 lastSync / importedIds。
 * @returns {void}
 */
function restoreState() {
  const saved = readJsonSafe(STATE_FILE)
  if (saved === null || typeof saved !== 'object') return
  if (typeof saved.lastSync === 'string') state.lastSync = saved.lastSync
  if (typeof saved.dataRoot === 'string' && saved.dataRoot !== '') {
    state.lastDataRoot = saved.dataRoot
  }
  /* 「待刷新」标志必须跨重启存活：切回 git 后重启，索引缓存作废、自动同步被抑制，
     /status 仍要报 indexStale 让前端提示点刷新。旧版 state.json 没有该字段，
     缺省 false；loadIndexCache 检测到本机目录残留缓存时会自行补上。 */
  if (saved.indexSwitchPending === true) indexSwitchPending = true
  if (Array.isArray(saved.importedIds)) {
    state.importedIds = saved.importedIds.filter((id) => typeof id === 'string')
  }
  if (
    saved.library !== null &&
    typeof saved.library === 'object' &&
    typeof saved.library.dir === 'string' &&
    saved.library.dir !== '' &&
    typeof saved.library.importedAt === 'string'
  ) {
    state.library = {
      dir: saved.library.dir,
      importedAt: saved.library.importedAt,
      previousDataRoot: typeof saved.library.previousDataRoot === 'string' ? saved.library.previousDataRoot : '',
    }
  }
  // 旧版 state.json 没有 settings 字段：无感升级为默认值。
  // isValidSourceUrl 现在同时接受 git 地址与本机目录，保存的本地数据源不会被丢弃。
  if (saved.settings !== null && typeof saved.settings === 'object' && typeof saved.settings.sourceUrl === 'string') {
    state.settings.sourceUrl = isValidSourceUrl(saved.settings.sourceUrl) ? saved.settings.sourceUrl : null
  }
  // 旧版 state.json 没有 skillhubUrl：同样无感升级（null = 未配置）。
  if (saved.settings !== null && typeof saved.settings === 'object' && typeof saved.settings.skillhubUrl === 'string') {
    state.settings.skillhubUrl = isValidHttpUrl(saved.settings.skillhubUrl) ? saved.settings.skillhubUrl : null
  }
  /* 内置技能总开关：旧 state.json 没有该字段，缺省视为关闭（false）。
     开着但目录被用户删掉时，重新 toggle 一次即可（README 写明）。 */
  if (saved.settings !== null && typeof saved.settings === 'object' && typeof saved.settings.builtinSkills === 'boolean') {
    state.settings.builtinSkills = saved.settings.builtinSkills
  }
  // 已安装技能 / 已连接连接器：旧 state 没有这两个字段，缺失即视为空表。
  if (saved.installedSkills !== null && typeof saved.installedSkills === 'object' && !Array.isArray(saved.installedSkills)) {
    for (const [dir, meta] of Object.entries(saved.installedSkills)) {
      if (meta === null || typeof meta !== 'object') continue
      state.installedSkills[dir] = {
        enabled: meta.enabled !== false,
        source: meta.source === 'market' || meta.source === 'repo' || meta.source === 'local' ? meta.source : 'local',
        installedAt: typeof meta.installedAt === 'number' ? meta.installedAt : 0,
      }
    }
  }
  if (saved.connectedConnectors !== null && typeof saved.connectedConnectors === 'object' && !Array.isArray(saved.connectedConnectors)) {
    for (const [id, meta] of Object.entries(saved.connectedConnectors)) {
      if (meta === null || typeof meta !== 'object') continue
      state.connectedConnectors[id] = {
        connectedAt: typeof meta.connectedAt === 'number' ? meta.connectedAt : 0,
      }
    }
  }
}

/**
 * 把 lastSync / dataRoot / importedIds / library 写回 state.json。
 * @returns {void}
 */
function persistState() {
  try {
    fs.mkdirSync(BASE_DIR, { recursive: true })
    const payload = {
      lastSync: state.lastSync,
      dataRoot: state.lastDataRoot,
      indexSwitchPending,
      importedIds: state.importedIds,
      library: state.library,
      settings: state.settings,
      installedSkills: state.installedSkills,
      connectedConnectors: state.connectedConnectors,
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2), 'utf8')
  } catch (error) {
    state.warnings.push('无法写入状态文件：' + humanError(error))
  }
}

/**
 * 从磁盘加载索引缓存（版本不匹配、或原数据根已消失则视为无效）。
 * @returns {any|null} 索引对象或 null
 */
function loadIndexCache() {
  if (state.index !== null) return state.index
  if (!isFile(INDEX_FILE)) return null
  const saved = readJsonSafe(INDEX_FILE)
  if (saved === null || typeof saved !== 'object') return null
  if (saved.version !== INDEX_VERSION) return null
  if (!Array.isArray(saved.experts) || !Array.isArray(saved.skills)) {
    return null
  }
  // library 模式的缓存：目录与 bundle 指纹都必须与当前状态一致。
  if (typeof saved.librarySignature === 'string' && saved.librarySignature !== '') {
    if (state.library === null || state.library.dir !== saved.libraryDir) return null
    if (saved.librarySignature !== librarySignature()) return null
    state.index = saved
    if (typeof saved.builtAt === 'string') state.lastSync = saved.builtAt
    return state.index
  }
  // 常规模式缓存遇到 library 状态：数据源已切换，缓存作废。
  if (state.library !== null) return null
  // 用「生效地址」而不是覆盖值：没配覆盖时默认 SOURCE_URL 就是 git 数据源。
  const configured = parseSource(resolveSourceUrl())
  /* 冷启动专用防线：配置为 git，但落盘索引却绑在「本机目录」上。
     这正是「本机目录 B → 切回 git → 重启」留下的残局：旧实现只在
     configured.kind === 'local' 时校验绑定，git 分支整段跳过，于是
     dataRootCache 被设成 B，git 根永远不生效，连 indexStale 提示都没有。
     git 模式只可能用 REPO_DIR 或 NTD_RESOURCE_DIR 两种内置根，其余一律
     判为本机目录残留，缓存必须作废，绝不能回灌 dataRootCache。 */
  if (configured.kind === 'git' && typeof saved.dataRoot === 'string' && saved.dataRoot !== '') {
    const cached = path.resolve(saved.dataRoot)
    if (cached !== path.resolve(REPO_DIR) && cached !== path.resolve(NTD_RESOURCE_DIR)) {
      // 置「待刷新」并持久化：既让 /status 继续提示，也抑制冷启动自动克隆。
      if (indexSwitchPending !== true) {
        indexSwitchPending = true
        persistState()
      }
      // 顺手删掉这份作废缓存：避免每个请求都重复读盘，也杜绝旧索引再次复活。
      try {
        fs.rmSync(INDEX_FILE, { force: true })
      } catch {
        // 删除失败不阻断：loadIndexCache 每次仍会把这份缓存判为无效
      }
      return null
    }
  }
  // 索引必须绑定当前数据根：配置的是本机目录时，落盘缓存若来自另一个根
  // （例如切换数据源后 index.json 没删掉），绝不能拿来渲染列表与详情。
  if (
    configured.kind === 'local' &&
    typeof saved.dataRoot === 'string' &&
    path.resolve(saved.dataRoot) !== path.resolve(configured.dir)
  ) {
    return null
  }
  // 缓存对应的数据根被删掉了就作废，避免展示幽灵数据。
  // 本机资源目录可能只有 connectors/，因此这里用放宽后的 isUsableDataRoot。
  if (typeof saved.dataRoot !== 'string' || !isUsableDataRoot(saved.dataRoot)) return null
  state.index = saved
  // 让运行时的数据根与索引保持一致：索引里的 counts 是由这个根算出来的，
  // 否则会出现「counts.skills 有值但 status.hasSkills 为 false」的自相矛盾。
  dataRootCache = saved.dataRoot
  if (typeof saved.builtAt === 'string') state.lastSync = saved.builtAt
  return state.index
}

/**
 * 切换到「本机目录」数据源且数据根变化时让旧索引立即作废。
 *
 * 只允许本机目录调用：重建走 `requireIndex() -> kickSync(false) -> runSync(false)`
 * 的既有懒加载，命中 local 分支，只读本地文件、不联网、不执行任何 git 命令。
 * 切到 git 数据源时绝不能清索引，否则下一次轮询会触发一次克隆；那种情况
 * 由 indexSwitchPending + /status 的 indexStale 提示用户点「刷新」。
 * 删除失败不阻断保存：冷启动时 loadIndexCache 还会按数据根再挡一道。
 * @returns {void}
 */
function invalidateIndexForNewRoot() {
  state.index = null
  try {
    fs.rmSync(INDEX_FILE, { force: true })
  } catch {
    // 落盘的旧缓存最多在下次冷启动被读到，loadIndexCache 的绑定校验会把它作废。
  }
}

// ---------------------------------------------------------------------------
// 索引构建 — 专家 / 专家团
// ---------------------------------------------------------------------------

/**
 * 若文件存在则返回其相对数据根的 POSIX 路径。
 * @param {string[]} segments 数据根内的路径片段
 * @returns {string|null} 相对路径或 null
 */
function repoRelativeIfExists(segments) {
  const root = dataRoot()
  if (root === null) return null
  const absolute = path.join(root, ...segments)
  if (!isFile(absolute)) return null
  return toPosix(path.join(...segments))
}

/**
 * 把团队 plugin.json 的 members 规整成前端可直接渲染的结构。
 * @param {any} members 原始 members
 * @param {string} expertDirName 专家目录名
 * @returns {Array<Record<string, any>>} 成员列表
 */
function normalizeMembers(members, expertDirName) {
  if (!Array.isArray(members)) return []
  /** @type {Array<Record<string, any>>} */
  const out = []
  for (const member of members) {
    if (member === null || typeof member !== 'object') continue
    const id = typeof member.id === 'string' ? member.id : ''
    if (id === '') continue
    const avatarRel = typeof member.avatar === 'string' ? member.avatar : ''
    const avatar =
      avatarRel === '' ? null : repoRelativeIfExists(['experts', expertDirName, ...toPosix(avatarRel).split('/')])
    out.push({
      id,
      name: pickText(member.displayName, 60) || pickText(member.name, 60) || id,
      profession: pickText(member.profession, 60),
      avatar,
      role: member.role === 'lead' ? 'lead' : 'member',
    })
  }
  return out
}

/**
 * 解析单个专家目录。
 * @param {string} dirName 专家目录名
 * @returns {{ item: Record<string, any>|null, skipped: Record<string, string>|null }} 解析结果
 */
function readExpert(dirName) {
  const base = dataRoot()
  if (base === null) {
    return { item: null, skipped: { id: dirName, reason: '没有可用的数据源' } }
  }
  const expertDir = path.join(base, 'experts', dirName)
  const pluginFile = path.join(expertDir, '.codebuddy-plugin', 'plugin.json')
  const plugin = readJsonSafe(pluginFile)
  if (plugin === null || typeof plugin !== 'object') {
    return { item: null, skipped: { id: dirName, reason: '缺少可解析的 .codebuddy-plugin/plugin.json' } }
  }

  const type = plugin.expertType === 'team' ? 'team' : 'agent'
  const avatarRel = typeof plugin.avatar === 'string' ? plugin.avatar : ''
  const avatar =
    avatarRel === ''
      ? null
      : repoRelativeIfExists(['experts', dirName, ...toPosix(avatarRel).split('/')])

  const tags = normalizeTags(plugin.tags)
  const quickPrompts = normalizePairs(plugin.quickPrompts)
  const skillRefs = Array.isArray(plugin.skills)
    ? plugin.skills.map((ref) => tidy(String(ref), 200)).filter((ref) => ref !== '')
    : []

  // 仓库里存在多种 plugin.json 变体：有的没有 displayName/profession/categoryId/avatar，
  // 有的把中文描述放在顶层 description_zh —— 这里逐级回落，保证卡片不会出现空白。
  const displayName = pickText(plugin.displayName, 80) || tidy(plugin.name || dirName, 80) || dirName
  const description =
    pickText(plugin.displayDescription, 600) ||
    tidy(plugin.description_zh || '', 600) ||
    tidy(plugin.description || '', 600)

  const item = {
    id: dirName,
    type,
    name: tidy(typeof plugin.name === 'string' ? plugin.name : dirName, 120) || dirName,
    displayName,
    displayNameEn: typeof plugin.displayName === 'object' && plugin.displayName !== null ? tidy(plugin.displayName.en || '', 80) : '',
    profession: pickText(plugin.profession, 80),
    description,
    avatar,
    categoryId: tidy(plugin.categoryId || '', 60),
    tags,
    quickPrompts,
    defaultInitPrompt: pickText(plugin.defaultInitPrompt, 1200),
    skills: skillRefs,
    agentName: tidy(plugin.agentName || '', 120),
    version: tidy(plugin.version || '', 40),
    members: type === 'team' ? normalizeMembers(plugin.members, dirName) : [],
    teamInfo:
      type === 'team' && plugin.teamInfo !== null && typeof plugin.teamInfo === 'object'
        ? {
            leadAgent: tidy(plugin.teamInfo.leadAgent || '', 120),
            memberAgents: Array.isArray(plugin.teamInfo.memberAgents)
              ? plugin.teamInfo.memberAgents.map((name) => tidy(String(name), 120))
              : [],
          }
        : null,
    searchText: '',
  }

  item.searchText = [
    item.id,
    item.name,
    item.displayName,
    item.displayNameEn,
    item.profession,
    item.description,
    item.categoryId,
    tags.join(' '),
  ]
    .join(' ')
    .toLowerCase()

  return { item, skipped: null }
}

/**
 * 采集全部专家与专家团。
 * @returns {{ items: Array<Record<string, any>>, skipped: Array<Record<string, string>> }} 采集结果
 */
function collectExperts() {
  const base = dataRoot()
  const root = base === null ? '' : path.join(base, 'experts')
  /** @type {Array<Record<string, any>>} */
  const items = []
  /** @type {Array<Record<string, string>>} */
  const skipped = []
  if (root === '' || !isDir(root)) return { items, skipped }

  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch (error) {
    skipped.push({ id: 'experts', reason: String((error && error.message) || error) })
    return { items, skipped }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue
    try {
      const parsed = readExpert(entry.name)
      if (parsed.item !== null) items.push(parsed.item)
      if (parsed.skipped !== null) skipped.push(parsed.skipped)
    } catch (error) {
      skipped.push({ id: entry.name, reason: String((error && error.message) || error) })
    }
  }

  items.sort((left, right) => {
    if (left.type !== right.type) return left.type === 'agent' ? -1 : 1
    // 缺少 categoryId 的条目排到最后，避免顶到最前面。
    const leftEmpty = left.categoryId === ''
    const rightEmpty = right.categoryId === ''
    if (leftEmpty !== rightEmpty) return leftEmpty ? 1 : -1
    const cat = left.categoryId.localeCompare(right.categoryId)
    if (cat !== 0) return cat
    return left.displayName.localeCompare(right.displayName, 'zh-Hans-CN')
  })

  return { items, skipped }
}

// ---------------------------------------------------------------------------
// 索引构建 — 技能
// ---------------------------------------------------------------------------

/**
 * 递归遍历技能目录，收集 SKILL.md。
 * @param {string} dir 当前绝对目录
 * @param {string} collection 所属集合（skills/ 下第一层目录名）
 * @param {string} root 数据根（用于生成相对路径）
 * @param {Array<Record<string, any>>} out 输出数组
 * @returns {void}
 */
function walkSkills(dir, collection, root, out) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const absolute = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walkSkills(absolute, collection, root, out)
      continue
    }
    if (entry.name !== 'SKILL.md') continue
    const text = readTextSafe(absolute)
    if (text === null) continue
    const front = parseFrontmatter(text)
    const dirRel = toPosix(path.relative(root, dir))
    const fallbackName = path.basename(dir)
    const name = tidy(front.name || fallbackName, 120) || fallbackName
    const description = pickChinese(front.description_zh || front.description || '')
    out.push({
      id: dirRel,
      name,
      description,
      collection,
      path: dirRel + '/SKILL.md',
    })
  }
}

/**
 * 采集全部技能。
 * @returns {{ items: Array<Record<string, any>>, collections: Array<{ id: string, count: number }> }} 采集结果
 */
function collectSkills() {
  const base = dataRoot()
  const root = base === null ? '' : path.join(base, 'skills')
  /** @type {Array<Record<string, any>>} */
  const items = []
  if (root === '' || !isDir(root)) return { items, collections: [] }

  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return { items, collections: [] }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue
    walkSkills(path.join(root, entry.name), entry.name, base, items)
  }

  items.sort((left, right) => {
    const byCollection = left.collection.localeCompare(right.collection)
    if (byCollection !== 0) return byCollection
    return left.name.localeCompare(right.name)
  })

  /** @type {Map<string, number>} */
  const buckets = new Map()
  for (const item of items) buckets.set(item.collection, (buckets.get(item.collection) || 0) + 1)
  const collections = Array.from(buckets.entries())
    .map(([id, count]) => ({ id, count }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))

  return { items, collections }
}

// ---------------------------------------------------------------------------
// 索引构建 — 汇总
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 本地资料库（整包导入）
// ---------------------------------------------------------------------------

/** bundle.json 解析缓存；键为目录，切换数据源时自动失效。 */
let libraryBundleCache = { dir: null, bundle: null }

/**
 * 读取当前资料库的 bundle.json（带缓存）。
 * @returns {any|null} bundle 对象或 null（未处于 library 模式 / 文件损坏）
 */
function libraryBundle() {
  if (state.library === null) return null
  if (libraryBundleCache.dir === state.library.dir && libraryBundleCache.bundle !== null) {
    return libraryBundleCache.bundle
  }
  const bundle = readJsonSafe(path.join(state.library.dir, 'bundle.json'))
  if (bundle === null || typeof bundle !== 'object' || bundle.kind !== EXPORT_KIND) return null
  libraryBundleCache = { dir: state.library.dir, bundle }
  return bundle
}

/**
 * 当前资料库 bundle 的内容指纹（sha1 前缀 + 字节数）。
 * 参与索引缓存校验 —— 换了 bundle 缓存自动作废。
 * @returns {string} 指纹；无 bundle 时返回空串
 */
function librarySignature() {
  if (state.library === null) return ''
  try {
    const buf = fs.readFileSync(path.join(state.library.dir, 'bundle.json'))
    return createHash('sha1').update(buf).digest('hex').slice(0, 16) + ':' + String(buf.length)
  } catch {
    return ''
  }
}

/**
 * 重新计算条目的 searchText（bundle 条目落盘时已剥离）。
 * @param {Record<string, any>} item 条目
 * @param {string[]} extra 额外参与搜索的字段
 * @returns {void}
 */
function fillSearchText(item, extra) {
  item.searchText = [item.id, item.name, item.displayName, item.displayNameEn, item.profession, item.description, item.categoryId]
    .concat(extra)
    .filter((part) => typeof part === 'string')
    .join(' ')
    .toLowerCase()
}

/**
 * 从 bundle 构建索引（library 模式下专家 / 团队 / 技能三类数据以此为准）。
 *
 * 列表条目剥离 readme / content / avatarB64（详情与头像走专门通道）：
 *  - 专家 / 团队：avatarB64 直接放进 item.avatar（data URI，前端直出）；
 *  - 技能：SKILL.md 正文进 libraryContents，`/detail` 从这里取；
 *  - 专家 / 团队正文同样进 libraryContents（`/detail` 优先命中）。
 *
 * 连接器在 library 模式下**改从导出包快照取**：存进 `libraryConnectors`，
 * `mergedConnectors()` 在该模式下只读这份快照。旧实现把 `connectors` 写进导出包、
 * 导入时还强制校验它是数组，却完全不消费它，`/status` 仍按旧数据根扫描 ——
 * 于是专家 / 技能来自 bundle（新）、连接器来自旧仓库（旧），新旧混算。
 * 注意字段名用 `libraryConnectors` 而不是历史幽灵字段 `connectors`。
 *
 * @param {any} bundle 已校验的导出包
 * @returns {any} 索引对象
 */
function buildLibraryIndex(bundle) {
  /** @type {Record<string, string>} */
  const contents = {}
  /** @type {Array<Record<string, any>>} */
  const experts = []
  for (const entry of Array.isArray(bundle.experts) ? bundle.experts : []) {
    if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string') continue
    const item = Object.assign({}, entry)
    const readme = typeof entry.readme === 'string' ? entry.readme : ''
    if (readme !== '') contents['expert:' + entry.id] = readme
    delete item.readme
    item.avatar = typeof entry.avatarB64 === 'string' && entry.avatarB64 !== '' ? entry.avatarB64 : null
    delete item.avatarB64
    item.members = Array.isArray(entry.members)
      ? entry.members.map((member) => Object.assign({}, member))
      : []
    fillSearchText(item, [item.tags, item.quickPrompts])
    experts.push(item)
  }

  /** @type {Array<Record<string, any>>} */
  const skills = []
  for (const entry of Array.isArray(bundle.skills) ? bundle.skills : []) {
    if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string') continue
    const item = Object.assign({}, entry)
    const content = typeof entry.content === 'string' ? entry.content : ''
    if (content !== '') contents['skill:' + entry.id] = content
    delete item.content
    item.path = ''
    fillSearchText(item, [item.collection])
    skills.push(item)
  }

  /* 连接器快照：只保留带合法 id 的对象条目，逐条补齐列表 / 计数需要的字段。
     导出包是可分享的，里面已经被 publicConnector 剥掉 params / credentials，
     这里再强制删一次 file（本机绝对路径）与 connected（本机连接登记）。 */
  /** @type {Array<Record<string, any>>} */
  const libraryConnectors = []
  for (const entry of Array.isArray(bundle.connectors) ? bundle.connectors : []) {
    if (entry === null || typeof entry !== 'object' || typeof entry.id !== 'string') continue
    const copy = Object.assign({}, entry)
    delete copy.file
    delete copy.params
    delete copy.credentials
    // 连接登记是本机状态，不随包分发，导入后由 libraryConnectorItems 现算。
    delete copy.connected
    libraryConnectors.push(copy)
  }

  const expertCount = experts.filter((item) => item.type !== 'team').length
  const teamCount = experts.filter((item) => item.type === 'team').length

  return {
    version: INDEX_VERSION,
    builtAt: new Date().toISOString(),
    sourceUrl: resolveSourceUrl(),
    dataRoot: state.library === null ? '' : state.library.dir,
    libraryDir: state.library === null ? '' : state.library.dir,
    librarySignature: librarySignature(),
    hasSkills: skills.length > 0,
    repoReady: true,
    libraryContents: contents,
    libraryConnectors,
    experts,
    skipped: [],
    skills,
    skillCollections: skillCollectionsOf(skills),
    counts: {
      experts: expertCount,
      teams: teamCount,
      skills: skills.length,
    },
  }
}

/**
 * 按集合汇总技能数量（与 collectSkills 的输出同形）。
 * @param {Array<Record<string, any>>} skills 技能条目
 * @returns {Array<{ id: string, count: number }>} 集合计数
 */
function skillCollectionsOf(skills) {
  const counter = new Map()
  for (const item of skills) {
    const key = typeof item.collection === 'string' && item.collection !== '' ? item.collection : '未分类'
    counter.set(key, (counter.get(key) || 0) + 1)
  }
  return Array.from(counter.entries())
    .map(([id, count]) => ({ id, count }))
    .sort((left, right) => (left.id < right.id ? -1 : 1))
}

/**
 * library 模式下从 bundle 取详情正文（专家 / 团队 / 技能）。
 * @param {'expert'|'skill'} type 类型前缀
 * @param {string} id 条目 id
 * @returns {string|null} 正文；未命中返回 null（回落常规读取路径）
 */
function libraryContent(type, id) {
  const index = state.index
  if (index === null || index.libraryContents === undefined || index.libraryContents === null) return null
  const text = index.libraryContents[type + ':' + id]
  return typeof text === 'string' ? text : null
}

/**
 * 全量重建索引（同步 IO，只读数据源文件）。
 *
 * 连接器不进索引（见 {@link mergedConnectors}），这里只采集专家 / 团队 / 技能。
 *
 * @param {string|null} root 数据根
 * @returns {any} 索引对象
 */
function buildIndex(root) {
  // library 模式：专家 / 团队 / 技能全部来自 bundle.json，不读数据根。
  if (state.library !== null) {
    const bundle = libraryBundle()
    if (bundle !== null) return buildLibraryIndex(bundle)
    // bundle 丢失 / 损坏：清掉 library 回落常规数据源，绝不能卡死在坏包上。
    state.warnings.push('本地资料库损坏，已回落原数据源')
    state.library = null
    persistState()
  }

  const expertResult = collectExperts()
  const skillResult = collectSkills()

  const expertCount = expertResult.items.filter((item) => item.type !== 'team').length
  const teamCount = expertResult.items.filter((item) => item.type === 'team').length

  return {
    version: INDEX_VERSION,
    builtAt: new Date().toISOString(),
    sourceUrl: resolveSourceUrl(),
    dataRoot: root === null ? '' : root,
    hasSkills: root !== null && isDir(path.join(root, 'skills')),
    repoReady: root !== null,
    experts: expertResult.items,
    skipped: expertResult.skipped,
    skills: skillResult.items,
    skillCollections: skillResult.collections,
    counts: {
      experts: expertCount,
      teams: teamCount,
      skills: skillResult.items.length,
    },
  }
}

/**
 * 把索引写入磁盘缓存。
 * @param {any} index 索引对象
 * @returns {void}
 */
function saveIndex(index) {
  ensureDirs()
  fs.writeFileSync(INDEX_FILE, JSON.stringify(index), 'utf8')
}

// ---------------------------------------------------------------------------
// 仓库同步（git）
// ---------------------------------------------------------------------------

/**
 * 执行 git 命令。
 * @param {string[]} args 参数列表
 * @param {string} cwd 工作目录
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, message?: string, missing?: boolean }>} 执行结果
 */
function runGit(args, cwd) {
  return new Promise((resolve) => {
    const options = {
      cwd,
      timeout: 300000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: Object.assign({}, process.env, {
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: '',
        NO_COLOR: '1',
        LC_ALL: 'C',
      }),
    }
    execFile('git', args, options, (error, stdout, stderr) => {
      const out = String(stdout || '')
      const err = String(stderr || '')
      if (error !== null && error !== undefined) {
        const missing = error.code === 'ENOENT'
        resolve({
          ok: false,
          missing,
          stdout: out,
          stderr: err,
          message: missing
            ? '未找到 git 命令，请先安装 Git 并确保它在 PATH 中'
            : err.trim() !== ''
              ? err.trim()
              : String(error.message || error),
        })
        return
      }
      resolve({ ok: true, stdout: out, stderr: err })
    })
  })
}

/**
 * 判断插件自己的克隆目录是否已就绪。
 * @returns {boolean} 是否就绪
 */
function isRepoReady() {
  return hasExpertsDir(REPO_DIR)
}

/**
 * 更新已存在的克隆；离线或非 git 仓库时保留现有文件并记录告警。
 *
 * 数据源地址可配置：本地 clone 的 origin 与当前生效地址不一致时先 set-url
 * 再 fetch（不删 clone，`--depth 1` 本来就浅）。set-url 后 fetch 失败只告警，
 * reset 不会执行 —— 不会出现「fetch 新地址、reset 落在旧内容」的混态。
 * @returns {Promise<void>}
 */
async function updateRepo() {
  // 双保险：本机目录绝不进入任何 git 命令（runSync 的本地分支本就不会走到这里）。
  const source = parseSource(resolveSourceUrl())
  if (source.kind !== 'git') {
    state.warnings.push('本机资源目录模式不执行 git 操作，跳过更新')
    return
  }
  const probe = await runGit(['rev-parse', '--git-dir'], REPO_DIR)
  if (!probe.ok) {
    /* 目录里根本没有 .git（用户自己放的本机资源根 / 测试桩）：没有远端可更新，
       保留「跳过更新」的既有语义；但真有 .git 却跑不了 git 时必须判失败，
       否则「刷新」会在什么都没更新的情况下报成功。 */
    if (isDir(path.join(REPO_DIR, '.git'))) {
      throw syncFailure('资源仓库更新失败：无法读取版本库信息，请检查 Git 安装或仓库状态后重试',
        probe.message || '')
    }
    state.warnings.push('现有资源目录不是 git 仓库，跳过更新')
    return
  }
  // 远端地址切换：配置的地址与 clone 时的 origin 不同则先改 origin。
  const wanted = source.url
  const originProbe = await runGit(['remote', 'get-url', 'origin'], REPO_DIR)
  const currentOrigin = originProbe.ok ? String(originProbe.stdout || '').trim() : ''
  if (currentOrigin !== '' && currentOrigin !== wanted) {
    const switched = await runGit(['remote', 'set-url', 'origin', wanted], REPO_DIR)
    if (switched.ok) {
      state.warnings.push('资源仓库地址已切换为 ' + wanted)
    } else {
      state.warnings.push('切换资源仓库地址失败，继续使用原地址：' + humanError({ message: switched.message || '' }))
    }
  }
  /* 纯本地 git 仓库（没有 origin）：没有远端可拉，直接用已有检出重建索引。
     这类仓库常见于离线验收 / 手动放置的仓库副本，不能判成同步失败。 */
  if (currentOrigin === '') {
    state.warnings.push('资源仓库没有配置 origin，跳过远端更新，使用本地检出')
    return
  }
  const fetched = await runGit(['-c', 'advice.detachedHead=false', 'fetch', '--depth', '1', 'origin', 'main'], REPO_DIR)
  if (!fetched.ok) {
    /* 旧实现只 warnings.push 后 return，runSync 照常 saveIndex / lastSync=now，
       /refresh?wait=1 返回 ok:true —— 刷新失败却报成功。这里必须抛到 catch。 */
    throw syncFailure('拉取远端更新失败：索引未更新，请检查网络或仓库地址后重试',
      fetched.message || '')
  }
  const reset = await runGit(['reset', '--hard', 'FETCH_HEAD'], REPO_DIR)
  if (reset.ok) return
  const fallback = await runGit(['reset', '--hard', 'origin/main'], REPO_DIR)
  if (!fallback.ok) {
    throw syncFailure('重置到远端版本失败：索引未更新，请重试', fallback.message || '')
  }
}

/**
 * 克隆仓库到插件工作目录。
 * @returns {Promise<void>}
 */
async function cloneRepo() {
  // 双保险：本机目录绝不进入任何 git 命令（runSync 的本地分支本就不会走到这里）。
  const source = parseSource(resolveSourceUrl())
  if (source.kind !== 'git') {
    throw new Error('本机资源目录模式不执行 git 操作，请检查数据源设置')
  }
  if (isDir(REPO_DIR)) {
    fs.rmSync(REPO_DIR, { recursive: true, force: true })
  }
  const cloned = await runGit(['clone', '--depth', '1', source.url, REPO_DIR], BASE_DIR)
  if (!cloned.ok) {
    throw new Error(String(cloned.message || '克隆资源仓库失败'))
  }
}

/**
 * 统计目录下指定文件名的文件数量（跳过 `.git`）。
 * @param {string} dir 根目录
 * @param {string} fileName 文件名（精确匹配）
 * @returns {number} 数量
 */
function countFilesNamed(dir, fileName) {
  let total = 0
  /** @type {string[]} */
  const stack = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) break
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (entry.name === '.git') continue
        stack.push(path.join(current, entry.name))
        continue
      }
      if (entry.isFile() && entry.name === fileName) total += 1
    }
  }
  return total
}

/**
 * 校验插件自己那份克隆的检出完整性。
 *
 * `git clone --depth 1` 在某些网络 / 代理环境下会「只落一部分文件就返回成功」，
 * 旧逻辑直接当作同步成功写进索引 —— 用户看到的是静默的半量数据（934 而不是 3818），
 * 而且界面上完全看不出来。这里以 `git ls-tree HEAD` 的应有数量为基准：
 * 磁盘少了就先 `checkout -f` 补齐，补不齐才判失败（失败会中断同步、不写索引）。
 *
 * @param {string} repo 仓库目录
 * @returns {Promise<{ ok: boolean, expected: number, actual: number, repaired: boolean, message: string }>} 校验结果
 */
async function verifyRepoCheckout(repo) {
  const list = await runGit(['ls-tree', '-r', 'HEAD', '--name-only'], repo)
  if (!list.ok) {
    // 读不到清单就无从判定：放行 + 告警，宁可少校验也不要误报同步失败
    return { ok: true, expected: -1, actual: -1, repaired: false, message: '无法读取仓库清单，跳过完整性校验' }
  }
  const expected = String(list.stdout)
    .split(/\r?\n/)
    .filter((line) => line.endsWith('/SKILL.md')).length
  if (expected === 0) {
    return { ok: true, expected: 0, actual: 0, repaired: false, message: '仓库没有技能文件，跳过完整性校验' }
  }

  let actual = countFilesNamed(repo, 'SKILL.md')
  if (actual >= expected) return { ok: true, expected, actual, repaired: false, message: '' }

  // 落盘不完整：用同一个 HEAD 重新检出一次（不联网，只补磁盘）
  await runGit(['checkout', '-f', 'HEAD'], repo)
  actual = countFilesNamed(repo, 'SKILL.md')
  if (actual >= expected) return { ok: true, expected, actual, repaired: true, message: '' }

  const detail = '（磁盘 ' + String(actual) + ' / 应有 ' + String(expected) + '）'
  return {
    ok: false,
    expected,
    actual,
    repaired: false,
    message: actual === 0
      ? '资源仓库为空检出' + detail + '，请重试'
      : '资源仓库检出未完成' + detail + '，请重试',
  }
}

/**
 * 同步流程。
 *
 * `ensureRepo === true`（用户点了刷新）：无论如何都保证 `dsh-buddy-expert-hub/repo` 存在并更新，
 * 成功后把数据根切到它（它才带 skills/）。
 * `ensureRepo === false`（懒加载）：只在完全没有任何数据源时才去克隆，
 * 有 `~/.dsh/ntd-resource` 时直接用它建索引，避免无谓的 30MB 下载。
 *
 * 数据源配置成本机目录时整条 git 路径都不执行：不 clone、不 fetch、不 set-url、
 * 不 reset，只检查目录可用性后把数据根指向它并重建索引；
 * 目录被删或变空时明确报错，绝不退化成去克隆默认远程仓库。
 *
 * @param {boolean} ensureRepo 是否强制准备完整仓库
 * @returns {Promise<void>}
 */
async function runSync(ensureRepo) {
  if (state.busy) return
  state.busy = true
  state.lastError = null
  state.lastErrorText = null
  state.warnings = []
  /* 让同步与「本次请求的响应」错开一个微任务：本机目录的懒加载全程没有 IO 等待，
     若同步跑完才生成占位响应，busy 已经被 finally 清成 false，接口会自相矛盾地
     返回「不忙但索引未就绪」。错开后 busy 描述的是响应生成时的真实状态。 */
  await Promise.resolve()

  // 首克隆要 25~40s，进度文案恒定会让人以为卡死 —— 每秒回写「已用时 Ns」。
  const startedAt = Date.now()
  let stage = '正在检查资源仓库…'
  let ticker = null
  const renderProgress = () => {
    const elapsed = Math.round((Date.now() - startedAt) / 1000)
    state.progress = stage + '（已用时 ' + String(elapsed) + 's）'
  }
  const setStage = (text) => {
    stage = text
    renderProgress()
  }

  try {
    setStage('正在检查资源仓库…')
    ticker = setInterval(renderProgress, 1000)

    ensureDirs()
    const parsedSource = parseSource(resolveSourceUrl())
    const hasLocalRoot = dataRoot() !== null

    if (parsedSource.kind === 'local') {
      // 本机目录模式：仓库就绪检查、远端更新、克隆这三条 git 路径全部跳过。
      // 「刷新」在这里等价于重新读取目录并重建索引，立刻反映本机文件的增删改。
      setStage('正在读取本机资源目录…')
      const unusable = localDataRootError(parsedSource.dir)
      if (unusable !== '') {
        throw new Error('本机资源目录不可用：' + unusable + '；请检查路径或在设置里改回仓库地址')
      }
      dataRootCache = parsedSource.dir
    } else if (isRepoReady()) {
      setStage('正在更新资源仓库…')
      await updateRepo()
      dataRootCache = REPO_DIR
    } else if (ensureRepo || !hasLocalRoot) {
      setStage('正在克隆资源仓库（首次约 30MB）…')
      await cloneRepo()
      dataRootCache = REPO_DIR
    }

    const root = dataRoot()
    if (root === null) {
      throw new Error('没有可用的数据源：请检查网络，或确认 ~/.dsh/ntd-resource 是否存在')
    }

    // 插件自己克隆的那份必须确认落盘完整，否则会静默产出半量数据
    // （外部数据根 ~/.dsh/ntd-resource 可能是稀疏检出，那是用户自己的选择，不在这里判定）
    if (root === REPO_DIR) {
      setStage('正在校验资源仓库完整性…')
      const integrity = await verifyRepoCheckout(root)
      if (integrity.repaired) {
        state.warnings.push('资源仓库检出曾不完整，已自动补齐（' + String(integrity.actual) + ' 个技能文件）')
      }
      if (integrity.message !== '' && integrity.ok === true && integrity.expected > 0) {
        state.warnings.push(integrity.message)
      }
      if (integrity.ok !== true) {
        // 不要把这个残缺的根留在缓存里，否则下一次懒加载会继续用它建索引
        dataRootCache = null
        throw new Error(integrity.message)
      }
    }

    setStage('正在构建索引…')
    const index = buildIndex(root)
    saveIndex(index)
    state.index = index
    state.lastSync = index.builtAt
    state.lastDataRoot = root
    // 索引已按新数据根重建，切到 git 数据源时的「待刷新」提示可以撤掉了。
    indexSwitchPending = false
    // 本次同步成功，解除「失败后抑制自动同步」，并把标志一起持久化。
    lastSyncFailedAt = null
    persistState()
    state.progress = ''
  } catch (error) {
    // 原始错误保留在 lastError 供排查，对外只给人话（lastErrorText）。
    state.lastError = String((error && error.stack) || (error && error.message) || error)
    /* 同步流程主动抛出的错误带中文 userMessage，避免被 humanError 压成通用提示；
       底层细节仍完整保留在 lastErrorRaw。 */
    state.lastErrorText = error !== null && error !== undefined && typeof error.userMessage === 'string'
      ? error.userMessage
      : humanError(error)
    state.progress = ''
    /* 失败后不再由 /status 或数据接口自动重试同步（否则每轮轮询都重跑一次
       30MB 克隆）；只有用户主动点 /refresh 才重试。 */
    lastSyncFailedAt = Date.now()
    /* 删掉盘上的旧索引：否则下一个请求 loadIndexCache() 会把它装回内存并
       重设 dataRootCache，/status 又报 indexReady:true + 旧 counts（旧索引复活）。
       lastSync / indexSwitchPending 只在成功路径更新，这里一个都不动。 */
    state.index = null
    try {
      fs.rmSync(INDEX_FILE, { force: true })
    } catch {
      // 删除失败不阻断错误返回
    }
  } finally {
    if (ticker !== null) clearInterval(ticker)
    state.busy = false
  }
}

/**
 * 若空闲则触发一次后台同步（不等待）。
 * @param {boolean} [ensureRepo=false] 是否强制准备完整仓库
 * @returns {void}
 */
function kickSync(ensureRepo) {
  if (state.busy) return
  void runSync(ensureRepo === true)
}

/**
 * 取得索引；不可用时触发同步并返回 null。
 *
 * 自动同步被「持久化待刷新标志」或「上次同步失败」抑制时不触发：
 * 前者避免冷启动自动克隆 30MB，后者避免失败后每轮轮询重试一次。
 * 两条路径都只在用户主动 `/refresh` 时才重新同步。
 *
 * @returns {any|null} 索引对象或 null
 */
function requireIndex() {
  const index = loadIndexCache()
  if (index !== null) return index
  if (!autoSyncSuppressed()) kickSync(false)
  return null
}

/**
 * 索引不可用时的统一响应。
 *
 * `busy` 取真实同步状态（修复硬编码 `true` 的谎报）；`error` 与 `message`
 * 同时给出，前端两条取值链（`res.error || res.message` 与 `res.message`）都不会空白。
 *
 * @returns {{ ok: false, busy: boolean, indexReady: false, error: string, message: string }} 占位响应
 */
function busyPayload() {
  const message = indexSwitchPending
    ? '数据源已切换，点「刷新」以应用新数据源'
    : state.lastErrorText !== null
      ? '资源仓库尚未就绪：' + state.lastErrorText
      : '首次同步中，请稍候…'
  return {
    ok: false,
    busy: state.busy,
    indexReady: false,
    error: message,
    message,
  }
}

// ---------------------------------------------------------------------------
// 本地专家（$DSH_HOME/experts/<id>/，DSH 原生导入格式）
// ---------------------------------------------------------------------------
//
// 目录结构（与 DSH 自身导入产物一致）：
//   <id>/expert.yml           —— id / display_name / description / order
//   <id>/role.md              —— agent markdown 全文
//   <id>/avatar.png           —— 头像（源文件可能是 jpg/webp，输出时按魔数嗅探 MIME）
//   <id>/.expert-source.json  —— 溯源信息
//   <id>/team.json            —— 仅团队：teamInfo + members
//   <id>/members/<id>.md      —— 仅团队：各成员角色说明
// ---------------------------------------------------------------------------

/**
 * 解析扁平的 `key: value` YAML（expert.yml 只有四行标量）。
 * @param {string} text 文件内容
 * @returns {Record<string, string>} 键值表
 */
function parseFlatYaml(text) {
  /** @type {Record<string, string>} */
  const out = {}
  const lines = String(text === null || text === undefined ? '' : text).split(/\r?\n/)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('- ')) continue
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    if (!/^[A-Za-z0-9_-]+$/.test(key)) continue
    out[key] = unquote(line.slice(idx + 1))
  }
  return out
}

/**
 * 在本地专家目录里找头像文件。
 * @param {string} dir 本地专家目录
 * @returns {string|null} 头像绝对路径
 */
function findLocalAvatar(dir) {
  const names = ['avatar.png', 'avatar.jpg', 'avatar.jpeg', 'avatar.webp', 'avatar.svg', 'icon.png']
  for (const name of names) {
    const absolute = path.join(dir, name)
    if (isFile(absolute)) return absolute
  }
  return null
}

/**
 * 把 team.json 的 members 规整成前端结构。
 * @param {any} team team.json 内容
 * @returns {Array<Record<string, any>>} 成员列表
 */
function normalizeLocalMembers(team) {
  if (team === null || typeof team !== 'object' || !Array.isArray(team.members)) return []
  /** @type {Array<Record<string, any>>} */
  const out = []
  for (const member of team.members) {
    if (member === null || typeof member !== 'object') continue
    const id = typeof member.id === 'string' ? member.id : ''
    if (id === '') continue
    out.push({
      id,
      name: tidy(member.name || id, 60) || id,
      profession: tidy(member.profession || '', 60),
      avatar: null,
      role: member.role === 'lead' ? 'lead' : 'member',
    })
  }
  return out
}

/** 合法的「单段目录名」：不以点/分隔符开头，不含路径分隔符。 */
const SAFE_DIR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * 判断一段路径里是否含有 `..` 片段（目录穿越）。
 * @param {string} value 原始路径
 * @returns {boolean} 含穿越片段
 */
function hasParentSegment(value) {
  return String(value).replace(/\\/g, '/').split('/').some((segment) => segment === '..')
}

/**
 * 把 `.expert-source.json` 里记录的 `sourcePath` + `pluginDir` 解析成清单文件绝对路径。
 *
 * 这两个字段来自本地文件，属于不可信输入：必须挡住 `..` 穿越（否则一个诱饵目录
 * 就能让面板读出任意位置的 `.codebuddy-plugin/plugin.json`）。校验方式与
 * `safeRepoPath` 保持一致：先拒绝穿越片段，再在 resolve 之后做前缀白名单。
 *
 * @param {string} sourcePath 原始包所在目录（绝对路径，允许以 `~` 开头）
 * @param {string} pluginDir 包目录名（单段）
 * @returns {string|null} 清单绝对路径；不可信或不存在时返回 null
 */
function resolveSourceManifestPath(sourcePath, pluginDir) {
  const dir = String(pluginDir === null || pluginDir === undefined ? '' : pluginDir).trim()
  if (!SAFE_DIR_NAME_RE.test(dir)) return null
  const raw = String(sourcePath === null || sourcePath === undefined ? '' : sourcePath).trim()
  if (raw === '' || hasParentSegment(raw)) return null
  // 旧版本会把 `~` 原样写进 sourcePath，这里补一次家目录展开。
  const expanded = raw.charAt(0) === '~' ? path.join(os.homedir(), raw.slice(1)) : raw
  if (!path.isAbsolute(expanded)) return null
  const base = path.resolve(expanded)
  const file = path.resolve(base, dir, '.codebuddy-plugin', 'plugin.json')
  if (!file.startsWith(base + path.sep)) return null
  return isFile(file) ? file : null
}

/**
 * 读取本地专家对应的原始 WorkBuddy 包清单（`plugin.json`）。
 *
 * 手工放置（或旧版本导入）的本地包只有 `expert.yml` + `role.md`，缺版本号与成员名单；
 * 这两样在原始市场包里是全的，而 `.expert-source.json` 记录了它的位置。
 * 读不到就返回 null，上层全部按缺省处理。
 *
 * @param {string} id 本地专家 id
 * @returns {Record<string, any>|null} 清单对象
 */
function readLocalSourceManifest(id) {
  const source = readJsonSafe(path.join(LOCAL_EXPERTS_DIR, id, '.expert-source.json'))
  /** @type {string[]} */
  const candidates = [path.join(IMPORTED_DIR, id, '.codebuddy-plugin', 'plugin.json')]
  if (source !== null && typeof source === 'object') {
    const resolved = resolveSourceManifestPath(source.sourcePath, source.pluginDir)
    if (resolved !== null) candidates.push(resolved)
  }
  for (const file of candidates) {
    const manifest = readJsonSafe(file)
    if (manifest !== null && typeof manifest === 'object') return manifest
  }
  return null
}

/**
 * 把 slug 转成可读名字（`software-company` → `Software Company`）。
 * @param {string} value 原始值
 * @returns {string} 可读名字
 */
function titleFromSlug(value) {
  const text = tidy(value, 120)
  if (text === '') return ''
  if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(text)) return text
  return text
    .split(/[._-]+/)
    .filter((word) => word !== '')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

/**
 * 从原始包清单里取团队成员。
 * 头像指向市场目录，`/local-avatar` 取不到，这里统一留空由前端回落首字母色块。
 * @param {Record<string, any>|null} manifest 原始包清单
 * @returns {Array<Record<string, any>>} 成员条目
 */
function normalizeManifestMembers(manifest) {
  if (manifest === null || !Array.isArray(manifest.members)) return []
  /** @type {Array<Record<string, any>>} */
  const out = []
  for (const member of manifest.members) {
    if (member === null || typeof member !== 'object') continue
    const id = typeof member.id === 'string' ? member.id : ''
    if (id === '') continue
    out.push({
      id,
      name: pickText(member.name, 60) || titleFromSlug(id),
      profession: pickText(member.profession, 60),
      avatar: null,
      role: member.role === 'lead' ? 'lead' : 'member',
    })
  }
  return out
}

/**
 * 最后兜底：连原始包都没有时，用 `.expert-source.json` 里的 agent 名单拼出成员。
 * @param {Record<string, any>|null} source 溯源信息
 * @returns {Array<Record<string, any>>} 成员条目
 */
function membersFromSource(source) {
  if (source === null || typeof source !== 'object') return []
  const lead = tidy(typeof source.leadAgent === 'string' ? source.leadAgent : '', 120)
  const list = Array.isArray(source.memberAgents)
    ? source.memberAgents.map((name) => tidy(String(name), 120)).filter((name) => name !== '')
    : []
  /** @type {Array<Record<string, any>>} */
  const out = []
  if (lead !== '') out.push({ id: lead, name: titleFromSlug(lead), profession: '', avatar: null, role: 'lead' })
  for (const name of list) {
    if (name === lead) continue
    out.push({ id: name, name: titleFromSlug(name), profession: '', avatar: null, role: 'member' })
  }
  return out
}

/**
 * 扫描 `$DSH_HOME/experts/` 下的本地专家。
 * 这是「已导入」的权威来源，不依赖插件私有目录；只认含 expert.yml 的目录。
 * @returns {Array<Record<string, any>>} 本地专家条目
 */
function listLocalExperts() {
  if (!isDir(LOCAL_EXPERTS_DIR)) return []
  let entries
  try {
    entries = fs.readdirSync(LOCAL_EXPERTS_DIR, { withFileTypes: true })
  } catch {
    return []
  }

  /** @type {Array<Record<string, any>>} */
  const items = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue
    const dir = path.join(LOCAL_EXPERTS_DIR, entry.name)
    const metaFile = path.join(dir, 'expert.yml')
    if (!isFile(metaFile)) continue
    try {
      const meta = parseFlatYaml(readTextSafe(metaFile) || '')
      const source = readJsonSafe(path.join(dir, '.expert-source.json'))
      const team = readJsonSafe(path.join(dir, 'team.json'))
      const manifest = readLocalSourceManifest(entry.name)
      const isTeam = (source !== null && source.expertType === 'team') || team !== null
      const avatarFile = findLocalAvatar(dir)
      // 成员来源按可信度排序：导入时写的 team.json > 原始包清单 > 溯源里的 agent 名单。
      const fromTeam = isTeam ? normalizeLocalMembers(team) : []
      const fromManifest = isTeam && fromTeam.length === 0 ? normalizeManifestMembers(manifest) : []
      const members =
        isTeam && fromTeam.length === 0 && fromManifest.length === 0 ? membersFromSource(source) : (fromTeam.length > 0 ? fromTeam : fromManifest)
      // DSH 专家包不存版本号，退回原始包清单（`expert.yml` 若写了 version 则优先）。
      const version = tidy(meta.version || '', 40) || tidy(manifest !== null && typeof manifest.version === 'string' ? manifest.version : '', 40)
      const orderRaw = Number.parseInt(meta.order === undefined ? '' : meta.order, 10)
      const displayName = tidy(meta.display_name || '', 80) || tidy(meta.id || entry.name, 80) || entry.name
      const description = tidy(meta.description || '', 600)
      const skillRefs =
        source !== null && Array.isArray(source.skills)
          ? source.skills.map((name) => tidy(String(name), 120)).filter((name) => name !== '')
          : []

      const item = {
        id: entry.name,
        type: isTeam ? 'team' : 'agent',
        local: true,
        source: 'local',
        name: tidy(meta.id || entry.name, 120) || entry.name,
        displayName,
        displayNameEn: '',
        // DSH 的专家包格式不存「职业」；这里留空，由 mergeLocalExperts 从仓库条目补齐。
        profession: tidy(meta.profession || '', 80),
        description,
        avatar: avatarFile === null ? null : 'local:' + entry.name,
        categoryId: '',
        tags: [],
        quickPrompts: [],
        defaultInitPrompt: '',
        skills: skillRefs,
        agentName: '',
        version,
        members,
        teamInfo: isTeam
          ? {
              leadAgent: tidy((source && source.leadAgent) || '', 120),
              memberAgents:
                source !== null && Array.isArray(source.memberAgents)
                  ? source.memberAgents.map((name) => tidy(String(name), 120))
                  : [],
            }
          : null,
        order: Number.isFinite(orderRaw) ? orderRaw : 300,
        searchText: '',
      }
      item.searchText = [item.id, item.name, item.displayName, item.description, 'local', '本地专家']
        .join(' ')
        .toLowerCase()
      items.push(item)
    } catch {
      // 单个目录损坏不影响整体
    }
  }

  items.sort((left, right) => {
    if (left.order !== right.order) return left.order - right.order
    return left.displayName.localeCompare(right.displayName, 'zh-Hans-CN')
  })
  return items
}

/**
 * 读取本地专家正文。
 * @param {string} id 本地专家 id
 * @returns {string} role.md 正文
 */
function readLocalRole(id) {
  const text = readTextSafe(path.join(LOCAL_EXPERTS_DIR, id, 'role.md'))
  return text === null ? '' : stripFrontmatter(text).trim().slice(0, README_LIMIT)
}

/**
 * 在专家目录里挑一个 agent markdown 文件。
 * @param {string} expertDir 数据源里的专家目录
 * @param {Record<string, any>} item 索引条目
 * @returns {{ rel: string, abs: string }|null} 相对路径与绝对路径
 */
function pickAgentFile(expertDir, item) {
  const plugin = readJsonSafe(path.join(expertDir, '.codebuddy-plugin', 'plugin.json'))
  /** @type {string[]} */
  const candidates = []
  if (plugin !== null && Array.isArray(plugin.agents)) {
    for (const rel of plugin.agents) {
      if (typeof rel === 'string' && rel.trim() !== '') candidates.push(rel)
    }
  }
  if (typeof item.agentName === 'string' && item.agentName !== '') {
    candidates.push('agents/' + item.agentName + '.md')
  }
  candidates.push('agents/' + item.id + '.md', 'README.md')

  const prefix = path.resolve(expertDir) + path.sep
  for (const rel of candidates) {
    const absolute = path.resolve(expertDir, rel)
    if (!absolute.startsWith(prefix)) continue
    if (isFile(absolute)) return { rel: toPosix(rel), abs: absolute }
  }
  return null
}

/**
 * 把 YAML 标量转义成双引号风格。
 * 描述里常见全角冒号、中文引号、换行；统一压成单行并转义反斜杠与双引号，
 * 保证永远不会破坏 YAML 结构。
 * @param {string} value 原始值
 * @returns {string} 可安全写入 yml 的值
 */
function yamlQuote(value) {
  const text = tidy(value, 4000)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
  return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/**
 * 在多语言字段里严格取中文（不做英文回落）。
 * @param {any} field 形如 `{ zh, en }` 的字段
 * @returns {string} 中文字符串，缺失返回空串
 */
function zhOnly(field) {
  if (field === null || field === undefined) return ''
  if (typeof field === 'string') return tidy(field, 4000)
  if (typeof field !== 'object') return ''
  return typeof field.zh === 'string' ? tidy(field.zh, 4000) : ''
}

/**
 * 在多语言字段里严格取英文。
 * @param {any} field 形如 `{ zh, en }` 的字段
 * @returns {string} 英文字符串，缺失返回空串
 */
function enOnly(field) {
  if (field === null || field === undefined || typeof field !== 'object') return ''
  return typeof field.en === 'string' ? tidy(field.en, 4000) : ''
}

/**
 * 把 kebab / snake 形式的 id 转成 Title Case。
 * 非字母开头的段（如 `4p12s`）原样保留，不会崩。
 * @param {string} value 原始 id
 * @returns {string} 可读名称
 */
function titleCaseKebab(value) {
  const text = tidy(value, 120)
  if (text === '') return ''
  return text
    .split(/[-_\s]+/)
    .filter((part) => part !== '')
    .map((part) => (/^[A-Za-z]/.test(part) ? part.charAt(0).toUpperCase() + part.slice(1) : part))
    .join(' ')
}

/**
 * 计算专家的人名（用于 expert.yml 的 display_name）。
 *
 * 顺序与官方 `dsh-ntd-experts` scanner 一致（`scanner.js` 的 displayName 字段）：
 * `displayName.zh → displayName.en → profession.zh → profession.en → TitleCase(id)`。
 * displayName 优先于 profession —— 前者是人名（「吴八哥」），后者是岗位（「高级开发工程师」）。
 *
 * @param {Record<string, any>} plugin plugin.json 内容
 * @param {string} id 专家 id
 * @returns {string} 显示名
 */
function expertDisplayName(plugin, id) {
  return (
    zhOnly(plugin.displayName) ||
    enOnly(plugin.displayName) ||
    zhOnly(plugin.profession) ||
    enOnly(plugin.profession) ||
    titleCaseKebab(id)
  )
}

/**
 * 从 plugin.json 的 members 里取成员显示名（中文优先）。
 * @param {any} member 原始成员
 * @returns {string} 成员名
 */
function memberDisplayName(member) {
  return zhOnly(member.displayName) || zhOnly(member.name) || (typeof member.id === 'string' ? member.id : '')
}

/**
 * 从 plugin.json 的 members 里取成员职业（中文优先）。
 * @param {any} member 原始成员
 * @returns {string} 职业
 */
function memberProfession(member) {
  return zhOnly(member.profession)
}

/**
 * 按 DSH 原生格式把专家落盘到 `$DSH_HOME/experts/<id>/`。
 *
 * 产物：
 *   expert.yml / role.md / avatar.<ext> / .expert-source.json
 *   团队额外：team.json + members/<memberId>.md
 *
 * @param {string} rootDir 数据根（用于定位源目录）
 * @param {Record<string, any>} plugin 专家目录里的 plugin.json 内容
 * @returns {{ ok: boolean, error?: string, id?: string, dir?: string, files?: string[] }} 结果
 */
function writeDshExpertPackage(rootDir, plugin) {
  if (rootDir === null) return { ok: false, error: '没有可用的数据源' }
  if (plugin === null || typeof plugin !== 'object') return { ok: false, error: 'plugin.json 内容无效' }

  const dirName = tidy(plugin.__dirName || plugin.name || '', 120)
  if (safeId(dirName) === null) return { ok: false, error: '专家 id 非法' }
  const expertDir = path.join(rootDir, 'experts', dirName)
  if (!isDir(expertDir)) return { ok: false, error: '源目录不存在：' + toPosix(path.join('experts', dirName)) }

  const type = plugin.expertType === 'team' ? 'team' : 'agent'
  const id = tidy(plugin.name || dirName, 120) || dirName
  const targetDir = path.join(LOCAL_EXPERTS_DIR, dirName)
  fs.mkdirSync(targetDir, { recursive: true })

  /** @type {string[]} */
  const written = []

  // ---- role.md -----------------------------------------------------------
  const agentFile = pickAgentFile(expertDir, {
    id: dirName,
    agentName: tidy(plugin.agentName || '', 120),
  })
  let roleBody = agentFile === null ? '' : readTextSafe(agentFile.abs) || ''

  const rawMembers = Array.isArray(plugin.members) ? plugin.members : []
  const teamInfo = plugin.teamInfo !== null && typeof plugin.teamInfo === 'object' ? plugin.teamInfo : null
  const memberAgents =
    teamInfo !== null && Array.isArray(teamInfo.memberAgents)
      ? teamInfo.memberAgents.map((name) => tidy(String(name), 120)).filter((name) => name !== '')
      : []

  if (type === 'team') {
    const lines = ['', '', '## 团队成员', '']
    if (rawMembers.length === 0) {
      lines.push('（团队成员信息缺失）')
    } else {
      for (const member of rawMembers) {
        if (member === null || typeof member !== 'object') continue
        const name = memberDisplayName(member)
        if (name === '') continue
        const profession = memberProfession(member)
        const suffix = member.role === 'lead' ? '（团长）' : ''
        lines.push('- ' + name + ' · ' + (profession === '' ? '—' : profession) + suffix)
      }
    }
    lines.push('')
    roleBody = roleBody + lines.join('\n')
  }
  fs.writeFileSync(path.join(targetDir, 'role.md'), roleBody, 'utf8')
  written.push('role.md')

  // ---- expert.yml --------------------------------------------------------
  const displayName = expertDisplayName(plugin, id)
  const description =
    zhOnly(plugin.displayDescription) ||
    tidy(plugin.description_zh || '', 4000) ||
    tidy(plugin.description || '', 4000) ||
    enOnly(plugin.displayDescription)
  const expertYml = [
    'id: ' + yamlQuote(id),
    'display_name: ' + yamlQuote(displayName),
    'description: ' + yamlQuote(description),
    'order: 300',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(targetDir, 'expert.yml'), expertYml, 'utf8')
  written.push('expert.yml')

  // ---- avatar.<ext> ------------------------------------------------------
  // 团队本身常常没有 avatar 字段，回落用团长的头像，避免导入后完全没有头像。
  let avatarName = null
  let avatarRel = typeof plugin.avatar === 'string' ? plugin.avatar : ''
  if (avatarRel === '' && type === 'team') {
    const leadId = tidy((teamInfo === null ? '' : teamInfo.leadAgent) || plugin.agentName || '', 120)
    const leadMember = rawMembers.find(
      (member) => member !== null && typeof member === 'object' && member.id === leadId,
    )
    if (leadMember !== undefined && typeof leadMember.avatar === 'string') avatarRel = leadMember.avatar
    if (avatarRel === '') {
      const firstWithAvatar = rawMembers.find(
        (member) => member !== null && typeof member === 'object' && typeof member.avatar === 'string',
      )
      if (firstWithAvatar !== undefined) avatarRel = firstWithAvatar.avatar
    }
  }
  if (avatarRel !== '') {
    const sourceAvatar = path.resolve(expertDir, avatarRel)
    const prefix = path.resolve(expertDir) + path.sep
    if (sourceAvatar.startsWith(prefix) && isFile(sourceAvatar)) {
      const ext = path.extname(sourceAvatar).toLowerCase()
      avatarName = IMAGE_MIME[ext] === undefined ? 'avatar.png' : 'avatar' + ext
      fs.copyFileSync(sourceAvatar, path.join(targetDir, avatarName))
      written.push(avatarName)
    }
  }

  // ---- 团队附属文件 ------------------------------------------------------
  if (type === 'team') {
    const membersDir = path.join(targetDir, 'members')
    let memberCount = 0
    for (const name of memberAgents) {
      const safeName = safeId(name)
      if (safeName === null) continue
      const source = path.join(expertDir, 'agents', safeName + '.md')
      if (!isFile(source)) continue
      fs.mkdirSync(membersDir, { recursive: true })
      fs.copyFileSync(source, path.join(membersDir, safeName + '.md'))
      memberCount += 1
    }
    if (memberCount > 0) written.push('members/(' + String(memberCount) + ')')

    // 成员头像复制到 members/avatars/，避免 team.json 里留下指向未复制目录的悬空路径。
    const memberAvatarDir = path.join(targetDir, 'members', 'avatars')
    const expertPrefix = path.resolve(expertDir) + path.sep
    const teamMembers = rawMembers
      .filter((member) => member !== null && typeof member === 'object' && typeof member.id === 'string')
      .map((member) => {
        let memberAvatar = null
        const rel = typeof member.avatar === 'string' ? member.avatar : ''
        if (rel !== '') {
          const sourceAvatar = path.resolve(expertDir, rel)
          if (sourceAvatar.startsWith(expertPrefix) && isFile(sourceAvatar)) {
            const fileName = path.basename(sourceAvatar)
            fs.mkdirSync(memberAvatarDir, { recursive: true })
            fs.copyFileSync(sourceAvatar, path.join(memberAvatarDir, fileName))
            memberAvatar = 'members/avatars/' + fileName
          }
        }
        return {
          id: member.id,
          name: memberDisplayName(member),
          profession: memberProfession(member),
          avatar: memberAvatar,
          role: member.role === 'lead' ? 'lead' : 'member',
        }
      })
    if (teamMembers.some((member) => member.avatar !== null)) {
      written.push('members/avatars/(' + String(teamMembers.filter((m) => m.avatar !== null).length) + ')')
    }

    const teamJson = {
      id,
      name: displayName,
      description,
      // 团队自身头像：已经复制到 <id>/avatar.<ext> 时才写，其余情况为 null。
      avatar: avatarName,
      leadAgent: tidy((teamInfo === null ? '' : teamInfo.leadAgent) || plugin.agentName || '', 120),
      order: 300,
      teamInfo:
        teamInfo === null
          ? null
          : {
              leadAgent: tidy(teamInfo.leadAgent || '', 120),
              memberAgents,
            },
      members: teamMembers,
    }
    fs.writeFileSync(path.join(targetDir, 'team.json'), JSON.stringify(teamJson, null, 2), 'utf8')
    written.push('team.json')
  }

  // ---- .expert-source.json ----------------------------------------------
  // `fingerprint` 是 DSH 消费方（如 dsh-ntd-experts 的 contract.js）的必填字段，
  // 缺失会被判为 MANIFEST_BROKEN（界面上显示「清单缺失，请卸载重装」）。
  // 取源清单 plugin.json + 源 agent markdown 的 sha256，保证同源同值：
  // 既能满足非空校验，也不会因为时间戳/随机数让重复导入产生不同指纹。
  const manifestAbs = path.join(expertDir, '.codebuddy-plugin', 'plugin.json')
  const manifestRaw = isFile(manifestAbs) ? readTextSafe(manifestAbs) || '' : JSON.stringify(plugin)
  const roleRaw = agentFile === null ? '' : readTextSafe(agentFile.abs) || ''
  const fingerprint = createHash('sha256')
    .update(manifestRaw + '\n' + roleRaw, 'utf8')
    .digest('hex')

  const source = {
    sourcePath: 'https://gitee.com/zhangzexu/dsh-buddy-expert-hub-resource',
    pluginDir: dirName,
    agentFile: agentFile === null ? '' : path.basename(agentFile.rel),
    fingerprint,
    importedAt: new Date().toISOString(),
    expertType: type,
    leadAgent: tidy((teamInfo === null ? '' : teamInfo.leadAgent) || plugin.agentName || '', 120),
    memberAgents,
    memberCount: rawMembers.length,
    skills: Array.isArray(plugin.skills)
      ? plugin.skills.map((ref) => path.basename(toPosix(String(ref)))).filter((name) => name !== '')
      : [],
  }
  fs.writeFileSync(path.join(targetDir, '.expert-source.json'), JSON.stringify(source, null, 2), 'utf8')
  written.push('.expert-source.json')

  return { ok: true, id: dirName, dir: targetDir, files: written }
}

/**
 * 额外保留一份 WorkBuddy 原始目录包到 `$DSH_HOME/dsh-buddy-expert-hub/imported/<id>/bundle/`。
 * DSH 不读这里，但保留它可以在需要时还原 skills/ 等完整依赖，也便于溯源。
 * @param {string} rootDir 数据根
 * @param {string} id 专家目录名
 * @returns {{ ok: boolean, path?: string, error?: string }} 结果
 */
function writeSourceBundle(rootDir, id) {
  const sourceDir = path.join(rootDir, 'experts', id)
  if (!isDir(sourceDir)) return { ok: false, error: '源目录不存在' }
  const bundleDir = path.join(IMPORTED_DIR, id, 'bundle')
  try {
    fs.mkdirSync(bundleDir, { recursive: true })
    fs.cpSync(sourceDir, bundleDir, { recursive: true, force: true })
    return { ok: true, path: bundleDir }
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) }
  }
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/**
 * 按查询串过滤列表（依赖条目预置的 searchText）。
 * @param {Array<Record<string, any>>} items 原始列表
 * @param {string} query 归一化查询串
 * @returns {Array<Record<string, any>>} 过滤结果
 */
function filterByQuery(items, query) {
  if (query === '') return items
  return items.filter((item) => typeof item.searchText === 'string' && item.searchText.includes(query))
}

/**
 * 技能条目匹配：技能数量大（数千条），索引里不冗余存 searchText，
 * 匹配时按需拼接，避免索引文件膨胀。
 * @param {Record<string, any>} item 技能条目
 * @param {string} query 归一化查询串
 * @returns {boolean} 是否命中
 */
function matchSkill(item, query) {
  if (query === '') return true
  const haystack = (item.name + ' ' + item.description + ' ' + item.id).toLowerCase()
  return haystack.includes(query)
}

/**
 * 对外输出的专家条目（剥离 searchText）。
 * @param {Record<string, any>} item 索引条目
 * @returns {Record<string, any>} 可序列化条目
 */
function publicExpert(item) {
  const copy = Object.assign({}, item)
  delete copy.searchText
  return copy
}

/**
 * 对外输出的技能条目（剥离 searchText）。
 * @param {Record<string, any>} item 索引条目
 * @returns {Record<string, any>} 可序列化条目
 */
function publicSkill(item) {
  const copy = Object.assign({}, item)
  delete copy.searchText
  return copy
}

/**
 * 对外输出的连接器条目（剥离 searchText，保留 config 供详情复制）。
 *
 * 安全约束：对外 `config` 里的 `${VAR}` 必须保持占位符原样；任何可能在
 * 进程内出现过的参数值 / 凭据字段都在这里被显式剔除，绝不回显给前端。
 *
 * @param {Record<string, any>} item 索引条目
 * @returns {Record<string, any>} 可序列化条目
 */
function publicConnector(item) {
  const copy = Object.assign({}, item)
  delete copy.searchText
  delete copy.params
  delete copy.credentials
  /* 定义文件路径只对本地已安装条目有意义；未安装条目一律不回传，避免带出仓库内路径。 */
  if (copy.installed !== true) delete copy.file
  return copy
}

/**
 * 分页切片。
 * @param {Array<any>} items 列表
 * @param {number} limit 每页条数
 * @param {number} offset 起始偏移
 * @returns {Array<any>} 当前页
 */
function paginate(items, limit, offset) {
  const start = Math.min(Math.max(offset, 0), items.length)
  return items.slice(start, start + limit)
}

// ---------------------------------------------------------------------------
// 路径安全
// ---------------------------------------------------------------------------

/**
 * 把相对数据根的路径解析为绝对路径，并防止目录穿越。
 * @param {string|null} relativePath 相对路径
 * @returns {string|null} 安全的绝对路径或 null
 */
function safeRepoPath(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') return null
  if (relativePath.includes('\0')) return null
  const base = dataRoot()
  if (base === null) return null
  const root = path.resolve(base)
  const target = path.resolve(root, relativePath)
  if (target !== root && !target.startsWith(root + path.sep)) return null
  if (!isFile(target)) return null
  try {
    const realRoot = fs.realpathSync(root)
    const realTarget = fs.realpathSync(target)
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) return null
  } catch {
    return null
  }
  return target
}

/**
 * 把数据根内的相对路径解析成**目录**（`safeRepoPath` 只接受文件，不能复用）。
 * 同样做越界校验：解析后必须仍在数据根内。
 * @param {string} relativePath 相对数据根的路径
 * @returns {string|null} 绝对目录路径；非法或不存在返回 null
 */
function safeRepoDir(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.trim() === '') return null
  if (relativePath.includes('\0')) return null
  const base = dataRoot()
  if (base === null) return null
  const root = path.resolve(base)
  const target = path.resolve(root, relativePath)
  if (target !== root && !target.startsWith(root + path.sep)) return null
  return isDir(target) ? target : null
}

/**
 * 与 {@link safeRepoDir} 相同，但额外做 `realpathSync` 二次校验。
 *
 * 词法层的包含性检查挡不住「目录本身是指向数据根外的符号链接」：
 * 路径看起来仍以 `root + sep` 开头，实际读到的却是链接目标。这里把
 * 数据根与目标目录都解析成真实路径后再比一次前缀，符号链接逃逸一并挡掉。
 *
 * @param {string} relativePath 相对数据根的路径
 * @returns {string|null} 绝对目录路径；非法 / 不存在 / 越界 / 链接逃逸返回 null
 */
function safeRepoDirReal(relativePath) {
  const target = safeRepoDir(relativePath)
  if (target === null) return null
  const base = dataRoot()
  if (base === null) return null
  try {
    const realRoot = fs.realpathSync(path.resolve(base))
    const realTarget = fs.realpathSync(target)
    if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) return null
  } catch {
    return null
  }
  return target
}

/**
 * 校验外部传入的标识符（连接器 id / 专家目录名）。
 * 只允许字母数字开头，且仅含字母数字、点、下划线、连字符。
 * @param {string|null} value 原始值
 * @returns {string|null} 合法值或 null
 */
function safeId(value) {
  if (typeof value !== 'string') return null
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) ? value : null
}

/**
 * 解析连接器图标文件路径。
 *
 * 两条来源，按顺序探测（扩展名按 {@link ICON_EXTS} 逐个试）：
 *  1. 资源仓库 `<数据根>/connectors/icons/<id><ext>`（仓库随包发布的品牌图标）；
 *  2. 本地已安装定义目录 `<BASE_DIR>/connectors/<dir>/<id><ext>`
 *     （用户自己往定义目录里放了图标时生效；目录名不一定等于 id，
 *      必须按定义文件里的 id 反查，见 {@link findDefinitionDir}）。
 *
 * 都找不到返回 null，由 `/icon` 路由回 404（前端回落首字母占位）。
 * 插件本身不再内置任何图标数据（`data/icons` 已删除）。
 *
 * @param {string} id 连接器 id
 * @returns {string|null} 图标绝对路径或 null
 */
function resolveConnectorIcon(id) {
  const safe = safeId(id)
  if (safe === null) return null
  const root = dataRoot()
  if (root !== null) {
    const cloudIconsDir = path.join(cloudConnectorsDir(root), 'icons')
    for (const ext of ICON_EXTS) {
      const file = path.join(cloudIconsDir, safe + ext)
      if (isFile(file)) return file
    }
  }
  const localDir = findDefinitionDir(localConnectorsDir(BASE_DIR), safe)
  if (localDir !== null) {
    for (const ext of ICON_EXTS) {
      const file = path.join(localDir, safe + ext)
      if (isFile(file)) return file
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// 请求体读取
// ---------------------------------------------------------------------------

/**
 * 读取请求体（限制 1MB）。
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {Promise<string>} UTF-8 文本
 */
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 1024 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', (error) => reject(error))
  })
}

/**
 * 读取原始字节请求体（资料库导入用；默认上限 300MB）。
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @param {number} [maxBytes=LIBRARY_MAX_BYTES] 大小上限
 * @returns {Promise<Buffer>} 原始字节
 */
function readRawBody(req, maxBytes = LIBRARY_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > maxBytes) {
        reject(new Error('文件过大（上限 300MB）'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', (error) => reject(error))
  })
}

// ---------------------------------------------------------------------------
// 路由处理
// ---------------------------------------------------------------------------

/**
 * `/status`：插件与数据源整体状态。
 *
 * `counts.connectors` 是「云端 + 本地」合并后的条数，**每次现算**：只读仓库里一个
 * JSON 文件和本地定义目录，成本可忽略，换来的是装 / 卸之后立刻准确。
 * 同时给出 `counts.connectable`（宿主真能装载的条数）与 `counts.unsupported`
 * （`cli` / `sse` 类型或地址含 `${VAR}` 占位符的条数），三者满足
 * `connectable + unsupported === connectors` —— 列表是全量的，别让用户把
 * 「316 条」误读成「316 个都能连」。
 *
 * `connectorSource` 只有两个取值：
 *   - `repo`：资源仓库的 `connectors/connectors.json` 可读；
 *   - `none`：读不到（仓库没同步 / 文件缺失），此时连接器列表只剩本地已安装条目。
 *
 * `connectorSkipped` 是**真正解析不了**的连接器条数（缺 id / 结构异常），正常数据下为 0。
 * 注意它和「不可连接」不是一回事：`cli` / `sse` / 占位符地址这些条目照样进列表，
 * 只是带 `connectable:false`，条数记在 `counts.unsupported` 里 —— 仓库里的东西绝不静默消失。
 *
 * `indexDataRoot` 是当前索引对应的数据根；`indexStale` 只在「切到 git 数据源、
 * 数据根变了、旧索引仍保留」时为 true，前端据此提示点「刷新」。
 * 切到本机目录时索引会作废并自动重建，该值恒为 false。
 *
 * @returns {Record<string, any>} 状态载荷
 */
function handleStatus() {
  const index = loadIndexCache()
  const root = dataRoot()
  // 以索引为准：counts 是索引算出来的，hasSkills 必须描述同一份数据。
  const hasSkills = index === null ? dataRootHasSkills() : index.hasSkills === true

  // 徽标数量必须与列表条数一致：列表是「索引 + 本地专家合并去重」后的结果，
  // 所以这里也要按同样口径算，不能只报索引里的数量。
  const local = index === null ? [] : listLocalExperts()
  /* 云端清单只解析一次：条数 / 不可连接数 / 被跳过的坏条目共用同一份结果。
     本地资料库模式下连接器改从 bundle 快照取（见 buildLibraryIndex），
     不再扫旧数据根，避免「专家来自 bundle、连接器来自旧仓库」的新旧混算。 */
  const cloudScan = state.library === null
    ? listCloudDefinitionsWithSkipped(root === null ? '' : root)
    : { defs: [], skipped: [] }
  const connectorItems = state.library === null ? mergeConnectorItems(cloudScan) : mergedConnectors()
  const connectorCounts = countConnectorSources(connectorItems)
  // 切到 git 数据源且数据根变化时旧索引会被保留到下次同步：
  // 这里如实报出索引来自哪个根，让前端提示「数据源已切换，点刷新以应用新数据源」。
  // 切到本机目录时索引已作废并自动重建，indexStale 自然为 false；
  // git URL 互换（数据根不变）时 indexSwitchPending 不会被置位，也是 false。
  const indexDataRoot = index !== null && typeof index.dataRoot === 'string' ? index.dataRoot : ''
  /* 冷启动作废旧缓存后 index 可能为 null，但「待刷新」标志已持久化：
     此时用 state.lastDataRoot（state.json 里记的旧根）补齐 indexDataRoot，
     /status 仍返回 indexStale:true，前端仍提示点「刷新」。 */
  const staleRoot = indexDataRoot !== ''
    ? indexDataRoot
    : (typeof state.lastDataRoot === 'string' ? state.lastDataRoot : '')
  const indexStale =
    state.library === null &&
    indexSwitchPending &&
    staleRoot !== '' &&
    (root === null || path.resolve(staleRoot) !== path.resolve(root))
  const counts =
    index === null
      ? {
          experts: 0,
          teams: 0,
          skills: 0,
          connectors: connectorCounts.all,
          connectable: connectorCounts.connectable,
          unsupported: connectorCounts.unsupported,
        }
      : {
          experts: mergeLocalExperts(index.experts.filter((item) => item.type !== 'team'), 'agent').length,
          teams: mergeLocalExperts(index.experts.filter((item) => item.type === 'team'), 'team').length,
          skills: index.counts.skills,
          connectors: connectorCounts.all,
          connectable: connectorCounts.connectable,
          unsupported: connectorCounts.unsupported,
        }

  const payload = {
    ok: true,
    repoReady: root !== null,
    indexReady: index !== null,
    lastSync: state.lastSync,
    counts,
    localCounts: {
      experts: local.filter((item) => item.type !== 'team').length,
      teams: local.filter((item) => item.type === 'team').length,
    },
    sourceUrl: resolveSourceUrl(),
    sourceKind: parseSource(resolveSourceUrl()).kind,
    usingDefaultSource: resolveSourceUrl() === SOURCE_URL,
    dataRoot: root,
    indexDataRoot: indexDataRoot !== '' ? indexDataRoot : (indexSwitchPending ? staleRoot : ''),
    indexStale,
    library: state.library === null ? null : { dir: state.library.dir, importedAt: state.library.importedAt },
    hasSkills,
    connectorSource: state.library !== null
      ? 'library'
      : (root !== null && isFile(cloudConnectorsFile(root)) ? 'repo' : 'none'),
    connectorSkipped: cloudScan.skipped.length,
    skipped: index === null ? [] : index.skipped || [],
    busy: state.busy,
    progress: state.progress,
    lastError: state.lastErrorText,
    lastErrorRaw: state.lastError,
    warnings: state.warnings.slice(0, 5),
    importedCount: local.length,
    baseDir: BASE_DIR,
    localExpertsDir: LOCAL_EXPERTS_DIR,
  }
  /* 懒加载放在快照算完之后：响应里的 busy 描述「本次请求到达时」的真实状态，
     不会被本次请求自己刚触发的同步改成 true。自动同步在「待刷新」或「上次失败」
     期间一律抑制，只有用户主动点 /refresh 才允许重试。 */
  if (index === null && !autoSyncSuppressed()) kickSync(false)
  return payload
}

// ---------------------------------------------------------------------------
// 设置（数据源地址）
// ---------------------------------------------------------------------------

/**
 * `GET /settings`：当前设置。
 * @returns {Record<string, any>} 响应载荷
 */
function handleSettingsGet() {
  const effective = resolveSourceUrl()
  // 内置技能的三个数只扫一次磁盘（items 与 excluded 各扫一遍目录，重复扫会白白多几次 IO）。
  const builtinCounts = builtinSkillSummary()
  return {
    ok: true,
    sourceUrl: effective,
    sourceKind: parseSource(effective).kind,
    defaultUrl: SOURCE_URL,
    usingDefault: effective === SOURCE_URL,
    skillhubUrl: typeof state.settings.skillhubUrl === 'string' ? state.settings.skillhubUrl : '',
    /* 内置技能开关：设置弹窗打开时用它初始化开关与文案（N 取 builtinSkillCount）。
       builtinSkillPluginCount / builtinSkillExcluded 是文案里「其中 N 个来自内置插件、
       另有 M 个未纳入」的两个数：这里只扫一次磁盘（builtinSkillSummary）。 */
    builtinSkills: state.settings.builtinSkills === true,
    builtinPlatform: builtinPlatform(),
    builtinSkillCount: builtinCounts.total,
    builtinSkillPluginCount: builtinCounts.plugin,
    builtinSkillExcluded: builtinCounts.excluded,
  }
}

/**
 * `POST /settings`：保存数据源地址（git 仓库或本机资源目录）。
 *
 * 本机目录会在保存时校验目录存在性与结构（experts/ skills/ connectors/ 至少其一），
 * 不合格直接 400，绝不静默回落到 git 仓库。
 * 保存后**不清 repo 目录、不自动同步**；让 dataRootCache 失效，
 * `/status` 下次读取会按新配置重算数据根。若数据根真的变了，旧索引立即作废
 * （清内存索引 + 删 index.json），下一次数据请求按既有 lazy 逻辑重建，
 * 避免新目录的 connectors 与旧目录的 experts/skills 混在同一响应里。
 * state.json 写入前先备份 .bak。
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {Promise<{ body: Record<string, any>, status: number }>} 响应
 */
async function handleSettingsSave(req) {
  let raw
  try {
    raw = await readRawBody(req, 64 * 1024)
  } catch (error) {
    return { body: { ok: false, error: humanError(error) }, status: 400 }
  }
  let payload
  try {
    payload = JSON.parse(raw.toString('utf8'))
  } catch {
    return { body: { ok: false, error: '请求体不是合法 JSON' }, status: 400 }
  }
  const value = payload !== null && typeof payload === 'object' && typeof payload.sourceUrl === 'string' ? payload.sourceUrl.trim() : ''
  if (value === '') {
    return { body: { ok: false, error: '仓库地址不能为空；要恢复默认请使用「恢复默认」' }, status: 400 }
  }
  // 统一解析：git 地址沿用旧校验；本机目录还要检查目录本身是否可用。
  const parsed = parseSource(value)
  if (parsed.kind === 'none') {
    return { body: { ok: false, error: parsed.error }, status: 400 }
  }
  if (parsed.kind === 'local') {
    const unusable = localDataRootError(parsed.dir)
    if (unusable !== '') {
      return { body: { ok: false, error: unusable }, status: 400 }
    }
  }

  // Skillhub 地址：可选字段。不传则保持原值（向后兼容）；传空串表示清除配置。
  let nextSkillhub
  if (payload !== null && typeof payload === 'object' && payload.skillhubUrl !== undefined) {
    const rawHub = typeof payload.skillhubUrl === 'string' ? payload.skillhubUrl.trim() : ''
    if (rawHub !== '' && !isValidHttpUrl(rawHub)) {
      return { body: { ok: false, error: 'Skillhub 地址需为 http(s):// 形式' }, status: 400 }
    }
    nextSkillhub = rawHub === '' ? null : rawHub
  }

  // 记下改配置前的数据根：索引是绑定数据根的，根变了就必须作废。
  const oldRoot = dataRoot()
  // 写入前备份 state.json，写坏也不能留半截状态。
  try {
    if (isFile(STATE_FILE)) fs.copyFileSync(STATE_FILE, STATE_FILE + '.bak')
  } catch {
    // 备份失败不阻断保存（state 本身还没动）
  }

  state.settings.sourceUrl = value
  if (nextSkillhub !== undefined) state.settings.skillhubUrl = nextSkillhub
  // 地址可能指向另一个仓库或另一个本机目录，数据根按新配置重算
  // （dataRoot 直接读配置，不依赖是否跑过同步；不删现有 clone、不自动同步）。
  dataRootCache = null
  // 分场景处理「数据根变了但旧索引还在」：
  //  A 新数据源是本机目录 —— 重建零联网，直接作废旧索引，下一次请求 lazy 重建；
  //  B 新数据源是 git —— 不清索引（否则下一次轮询会触发 clone），只置位让
  //    /status 报 indexStale，由前端提示用户点「刷新」，git 的「不自动同步」语义不变；
  //  C git URL A → git URL B 且数据根没变 —— oldRoot === newRoot，什么都不做。
  const newRoot = dataRoot()
  if (oldRoot !== newRoot) {
    if (parsed.kind === 'local') {
      indexSwitchPending = false
      lastSyncFailedAt = null
      invalidateIndexForNewRoot()
    } else {
      indexSwitchPending = true
    }
  }
  // 设置与「待刷新」标志一起落盘：重启后仍能提示点刷新，并抑制冷启动自动克隆。
  persistState()
  return {
    body: {
      ok: true,
      sourceUrl: value,
      sourceKind: parsed.kind,
      skillhubUrl: typeof state.settings.skillhubUrl === 'string' ? state.settings.skillhubUrl : '',
    },
    status: 200,
  }
}

/**
 * `POST /settings/reset`：删除覆盖，回落内置默认地址。
 * @returns {{ body: Record<string, any>, status: number }} 响应
 */
function handleSettingsReset() {
  if (state.settings.sourceUrl === null) {
    return {
      body: { ok: true, sourceUrl: SOURCE_URL, sourceKind: 'git', defaultUrl: SOURCE_URL, usingDefault: true },
      status: 200,
    }
  }
  // 恢复默认后新数据源一定是 git：数据根变了也「不清索引」，只置位
  // indexSwitchPending 让 /status 提示点刷新，避免下一次轮询触发 30MB 克隆。
  const oldRoot = dataRoot()
  try {
    if (isFile(STATE_FILE)) fs.copyFileSync(STATE_FILE, STATE_FILE + '.bak')
  } catch {
    // 备份失败不阻断重置
  }
  state.settings.sourceUrl = null
  dataRootCache = null
  const newRoot = dataRoot()
  if (oldRoot !== newRoot) indexSwitchPending = true
  // 与「待刷新」标志一起落盘，重启后行为不变。
  persistState()
  return {
    body: { ok: true, sourceUrl: SOURCE_URL, sourceKind: 'git', defaultUrl: SOURCE_URL, usingDefault: true },
    status: 200,
  }
}

// ---------------------------------------------------------------------------
// SkillHub 商店（技能市场）
// ---------------------------------------------------------------------------
//
// 协议依据：https://skillhub.cn/install/skillhub.md 指向的官方 CLI
// （`skills_store_cli.py`，kit 版本 2026.8.5）里写死的端点，已逐个实测：
//   GET  {base}/api/v1/categories                  → { count, items:[{key,name,nameEn,level,...}] }
//   GET  {base}/api/v1/search?q=&limit=            → { results:[{slug,displayName,summary,category,icon_url,...}] }
//   GET  {base}/api/v1/showcase/{hot|featured|newest|recommended|trending} → { section, skills:[...] }
//   GET  {base}/api/v1/download?slug=              → application/zip（平铺结构，SKILL.md 在根）
//
// 分类**不能**作为 search 的查询参数（实测 category/categoryKey/cat 都被忽略），
// 因此分类浏览走「用分类中文名当 q 检索 + 服务端按 category 字段过滤」。

/** SkillHub 官方 API 基址。 */
const SKILLHUB_DEFAULT_BASE = 'https://api.skillhub.cn'

/** SkillHub 请求超时（毫秒）。 */
const SKILLHUB_TIMEOUT = 20000

/** 分类缓存有效期（毫秒）。 */
const SKILLHUB_CATEGORY_TTL = 10 * 60 * 1000

/** 技能安装根目录（插件每次请求实时扫描，装完即可用，无需重启）。 */
const SKILLS_INSTALL_DIR = path.join(DSH_HOME, 'skills')

/** 分类缓存：按 base 分桶，避免切换内网地址后串味。 */
const skillhubCategoryCache = new Map()

/**
 * 生效的 SkillHub 基址：设置里配了就用设置，否则用官方默认。
 * @returns {string} 不含尾部斜杠的基址
 */
function resolveSkillhubBase() {
  const configured = typeof state.settings.skillhubUrl === 'string' ? state.settings.skillhubUrl.trim() : ''
  const base = configured !== '' && isValidHttpUrl(configured) ? configured : SKILLHUB_DEFAULT_BASE
  return base.replace(/\/+$/, '')
}

/**
 * 请求 SkillHub JSON 接口。任何失败都抛错，由调用方转成可读文案。
 * @param {string} urlPath 以 / 开头的路径（含 query）
 * @returns {Promise<any>} 解析后的 JSON
 */
async function skillhubGetJson(urlPath) {
  const url = resolveSkillhubBase() + urlPath
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SKILLHUB_TIMEOUT)
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!resp.ok) throw new Error('SkillHub 返回 HTTP ' + resp.status)
    return await resp.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 把 SkillHub 一条技能记录归一化成面板用的结构。
 * @param {any} raw 原始记录（search / showcase 两种来源字段略有差异）
 * @returns {Record<string, any>} 归一化条目
 */
function normalizeSkillhubItem(raw) {
  const item = raw !== null && typeof raw === 'object' ? raw : {}
  const namespace = item.namespace !== null && typeof item.namespace === 'object' ? item.namespace : {}
  const slug = typeof item.slug === 'string' ? item.slug : ''
  // 两种来源字段风格不同：search 用 snake_case + displayName，showcase 用 camelCase 且没有名字。
  const displayName = typeof item.displayName === 'string' && item.displayName !== ''
    ? item.displayName
    : (typeof item.name === 'string' && item.name !== '' ? item.name : '')
  const iconUrl = typeof item.icon_url === 'string' && item.icon_url !== ''
    ? item.icon_url
    : (typeof item.iconUrl === 'string' ? item.iconUrl : '')
  const summary = typeof item.summary === 'string' && item.summary !== ''
    ? item.summary
    : (typeof item.description === 'string' ? item.description : '')
  return {
    slug,
    name: displayName !== '' ? displayName : slug,
    summary,
    summaryZh: typeof item.description_zh === 'string' ? item.description_zh : '',
    category: typeof item.category === 'string' ? item.category : '',
    iconUrl,
    version: typeof item.version === 'string' ? item.version : '',
    downloads: typeof item.downloads === 'number' ? item.downloads : 0,
    installs: typeof item.installs === 'number' ? item.installs : 0,
    owner: typeof item.owner_name === 'string'
      ? item.owner_name
      : (typeof namespace.handle === 'string' ? namespace.handle : ''),
  }
}

/**
 * 取分类清单（带 10 分钟内存缓存）。
 * @returns {Promise<Array<Record<string, any>>>} 分类列表
 */
async function skillhubCategories() {
  const base = resolveSkillhubBase()
  const cached = skillhubCategoryCache.get(base)
  if (cached !== undefined && Date.now() - cached.at < SKILLHUB_CATEGORY_TTL) return cached.items
  const raw = await skillhubGetJson('/api/v1/categories')
  const items = Array.isArray(raw !== null && raw !== undefined ? raw.items : null) ? raw.items : []
  const normalized = items
    .filter((it) => it !== null && typeof it === 'object' && typeof it.key === 'string' && it.active !== false)
    .map((it) => ({
      key: it.key,
      name: typeof it.name === 'string' && it.name !== '' ? it.name : it.key,
      nameEn: typeof it.nameEn === 'string' ? it.nameEn : '',
      sortOrder: typeof it.sortOrder === 'number' ? it.sortOrder : 999,
    }))
    .sort((a, b) => a.sortOrder - b.sortOrder)
  skillhubCategoryCache.set(base, { at: Date.now(), items: normalized })
  return normalized
}

/**
 * `GET /skillhub/categories`。
 * @returns {Promise<Record<string, any>>} 响应体
 */
async function handleSkillhubCategories() {
  try {
    const items = await skillhubCategories()
    return { ok: true, base: resolveSkillhubBase(), items }
  } catch (error) {
    return {
      ok: false,
      base: resolveSkillhubBase(),
      items: [],
      error: '无法连接 SkillHub（' + resolveSkillhubBase() + '）：' + String((error && error.message) || error),
    }
  }
}

/**
 * `GET /skillhub/search`：关键词检索；给了 category 则用分类名检索并按分类字段过滤。
 *
 * 过滤后不足 3 条时回退为不过滤（分类名检索本身有相关性），避免用户点分类看到空列表。
 *
 * @param {URLSearchParams} query 查询参数（q / category / section / limit）
 * @returns {Promise<Record<string, any>>} 响应体
 */
async function handleSkillhubSearch(query) {
  const rawQuery = typeof query.get('q') === 'string' ? query.get('q').trim() : ''
  const categoryKey = typeof query.get('category') === 'string' ? query.get('category').trim() : ''
  const section = typeof query.get('section') === 'string' ? query.get('section').trim() : ''
  const limitRaw = Number(query.get('limit'))
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 60) : 24

  let categories = []
  try {
    categories = await skillhubCategories()
  } catch {
    categories = []
  }
  const categoryNameOf = (key) => {
    const hit = categories.find((it) => it.key === key)
    return hit !== undefined ? hit.name : ''
  }

  try {
    let rawItems = []
    // 榜单模式：section 走 showcase（无需关键词）。
    if (section !== '' && ['hot', 'featured', 'newest', 'recommended', 'trending'].indexOf(section) >= 0) {
      const raw = await skillhubGetJson('/api/v1/showcase/' + section)
      rawItems = Array.isArray(raw !== null && raw !== undefined ? raw.skills : null) ? raw.skills : []
    } else {
      // 关键词模式：category 有值时用分类中文名当检索词。
      const keyword = rawQuery !== '' ? rawQuery : categoryNameOf(categoryKey)
      if (keyword === '') {
        return { ok: true, base: resolveSkillhubBase(), items: [], categories, error: '' }
      }
      const raw = await skillhubGetJson('/api/v1/search?q=' + encodeURIComponent(keyword) + '&limit=' + String(limit))
      rawItems = Array.isArray(raw !== null && raw !== undefined ? raw.results : null) ? raw.results : []
    }

    let items = rawItems.map(normalizeSkillhubItem).filter((it) => it.slug !== '')
    // 分类过滤只对关键词模式生效（榜单本就是跨分类精选）。
    if (categoryKey !== '' && section === '' && rawQuery === '') {
      const filtered = items.filter((it) => it.category === categoryKey)
      if (filtered.length >= 3) items = filtered
    }
    return {
      ok: true,
      base: resolveSkillhubBase(),
      items,
      categories,
      categoryName: categoryNameOf(categoryKey),
      error: '',
    }
  } catch (error) {
    return {
      ok: false,
      base: resolveSkillhubBase(),
      items: [],
      categories,
      error: 'SkillHub 检索失败：' + String((error && error.message) || error),
    }
  }
}

/**
 * 解压 zip Buffer（仅用 node:zlib，不引第三方依赖）。
 *
 * 安全：拒绝绝对路径、盘符、`..` 段（Zip Slip），只接受相对路径。
 *
 * @param {Buffer} buf zip 内容
 * @returns {Array<{ name: string, data: Buffer }>} 文件列表（不含目录项）
 */
function unzipBuffer(buf) {
  // 从尾部回扫 End of Central Directory 签名 0x06054b50（最多 64KB 注释）。
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65558); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件')
  const entryCount = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const out = []

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('zip 中央目录损坏')
    }
    const method = buf.readUInt16LE(offset + 10)
    const compSize = buf.readUInt32LE(offset + 20)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen)
    offset += 46 + nameLen + extraLen + commentLen

    // 目录项：跳过（落盘时由文件路径自动建目录）。
    if (name.endsWith('/')) continue

    // Zip Slip 防护。
    const normalizedName = name.replace(/\\/g, '/')
    if (/^[a-zA-Z]:/.test(normalizedName) || normalizedName.startsWith('/') || normalizedName.split('/').indexOf('..') >= 0) {
      throw new Error('zip 内存在非法路径：' + name)
    }

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('zip 局部头损坏：' + name)
    }
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const raw = buf.subarray(dataStart, dataStart + compSize)

    let data
    if (method === 0) data = Buffer.from(raw)
    else if (method === 8) data = zlib.inflateRawSync(raw)
    else throw new Error('不支持的压缩方式 ' + String(method) + '：' + name)

    out.push({ name: normalizedName, data })
  }
  return out
}

/**
 * 读取 SKILL.md 的 frontmatter，取出 name / description 作展示与目录名兜底。
 * @param {Buffer} buf SKILL.md 内容
 * @returns {Record<string, string>} 解析结果
 */
function skillhubFrontmatter(buf) {
  try {
    const text = buf.toString('utf8')
    const meta = parseFrontmatter(text)
    return {
      name: typeof meta.name === 'string' ? unquote(meta.name).trim() : '',
      description: typeof meta.description === 'string' ? unquote(meta.description).trim() : '',
    }
  } catch {
    return { name: '', description: '' }
  }
}

/**
 * 已安装到 `$DSH_HOME/skills/` 的 SkillHub 技能（按 `_meta.json::slug` 识别）。
 * @returns {Set<string>} slug 集合
 */
function skillhubInstalledSlugs() {
  const installed = new Set()
  try {
    if (!isDir(SKILLS_INSTALL_DIR)) return installed
    for (const entry of fs.readdirSync(SKILLS_INSTALL_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const metaPath = path.join(SKILLS_INSTALL_DIR, entry.name, '_meta.json')
      try {
        if (!isFile(metaPath)) continue
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
        if (typeof meta.slug === 'string' && meta.slug !== '') installed.add(meta.slug)
      } catch {
        // 单个技能的元数据损坏不影响整体
      }
    }
  } catch {
    // 目录不可读时当作未安装
  }
  return installed
}

/**
 * `GET /skillhub/installed`：已安装技能（供前端显示「已安装」态）。
 * @returns {Record<string, any>} 响应体
 */
function handleSkillhubInstalled() {
  return { ok: true, dir: SKILLS_INSTALL_DIR, slugs: Array.from(skillhubInstalledSlugs()) }
}

/**
 * `POST /skillhub/install`：下载 zip → 解压落盘到 `$DSH_HOME/skills/<dir>/`。
 *
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {Promise<Record<string, any>>} 响应体（含 httpStatus）
 */
async function handleSkillhubInstall(req) {
  let payload
  try {
    const raw = await readRawBody(req, 64 * 1024)
    payload = JSON.parse(raw.toString('utf8'))
  } catch (error) {
    return { ok: false, error: '请求体不合法：' + humanError(error), httpStatus: 400 }
  }
  const slug = payload !== null && typeof payload === 'object' && typeof payload.slug === 'string'
    ? payload.slug.trim()
    : ''
  // slug 直接参与 URL 与磁盘目录名，从严校验（只允许字母数字与 . _ -）。
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(slug)) {
    return { ok: false, error: '技能标识不合法：' + slug, httpStatus: 400 }
  }

  const base = resolveSkillhubBase()
  const url = base + '/api/v1/download?slug=' + encodeURIComponent(slug)
  let buf
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SKILLHUB_TIMEOUT * 3)
    try {
      const resp = await fetch(url, { method: 'GET', signal: controller.signal })
      if (!resp.ok) throw new Error('HTTP ' + resp.status)
      buf = Buffer.from(await resp.arrayBuffer())
    } finally {
      clearTimeout(timer)
    }
  } catch (error) {
    return { ok: false, error: '下载失败：' + String((error && error.message) || error), httpStatus: 502 }
  }

  let files
  try {
    files = unzipBuffer(buf)
  } catch (error) {
    return { ok: false, error: '解压失败：' + String((error && error.message) || error), httpStatus: 502 }
  }
  const skillFile = files.find((f) => f.name === 'SKILL.md')
  if (skillFile === undefined) {
    return { ok: false, error: '该技能包内没有 SKILL.md', httpStatus: 422 }
  }

  // 目录名：优先 frontmatter.name（可读），否则 slug；两者都做安全化。
  const fm = skillhubFrontmatter(skillFile.data)
  const safeName = String(fm.name !== '' ? fm.name : slug).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  const dirName = safeName !== '' ? safeName : slug
  const targetDir = path.join(SKILLS_INSTALL_DIR, dirName)

  try {
    fs.mkdirSync(targetDir, { recursive: true })
    for (const file of files) {
      const dest = path.join(targetDir, file.name)
      // 二次校验：解析后必须仍在 targetDir 之内。
      const rel = path.relative(targetDir, dest)
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.writeFileSync(dest, file.data)
    }
  } catch (error) {
    return { ok: false, error: '写入失败：' + String((error && error.message) || error), httpStatus: 500 }
  }

  return {
    ok: true,
    slug,
    name: fm.name !== '' ? fm.name : dirName,
    description: fm.description,
    dir: targetDir,
    fileCount: files.length,
    // 插件每次请求实时读目录，装完立即可用（无需重启）。
    restartRequired: false,
  }
}

/**
 * `GET /skillhub/detail`：代理官方技能详情 `{base}/api/v1/skills/{slug}`。
 *
 * 该端点字段比列表丰富（stats / subCategories / overviewMd / sourceUrl），
 * 归一化后供前端详情抽屉使用；同时回显本地是否已安装。
 *
 * @param {URLSearchParams} query 查询参数（slug）
 * @returns {Promise<Record<string, any>>} 响应体
 */
async function handleSkillhubDetail(query) {
  const slug = typeof query.get('slug') === 'string' ? query.get('slug').trim() : ''
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(slug)) {
    return { ok: false, error: '技能标识不合法：' + slug }
  }
  let raw
  try {
    raw = await skillhubGetJson('/api/v1/skills/' + encodeURIComponent(slug))
  } catch (error) {
    return { ok: false, error: 'SkillHub 详情加载失败：' + String((error && error.message) || error) }
  }
  const skill = raw !== null && typeof raw === 'object' && raw.skill !== null && typeof raw.skill === 'object' ? raw.skill : {}
  const stats = skill.stats !== null && typeof skill.stats === 'object' ? skill.stats : {}
  const latest = raw !== null && typeof raw === 'object' && raw.latestVersion !== null && typeof raw.latestVersion === 'object'
    ? raw.latestVersion
    : {}
  const owner = raw !== null && typeof raw === 'object' && raw.owner !== null && typeof raw.owner === 'object' ? raw.owner : {}
  const tags = skill.tags !== null && typeof skill.tags === 'object' ? skill.tags : {}
  const subCategories = Array.isArray(skill.subCategories) ? skill.subCategories : []

  let categoryName = ''
  try {
    const cats = await skillhubCategories()
    const hit = cats.find((it) => it.key === skill.category)
    if (hit !== undefined) categoryName = hit.name
  } catch {
    categoryName = ''
  }

  return {
    ok: true,
    slug,
    name: typeof skill.displayName === 'string' && skill.displayName !== '' ? skill.displayName : slug,
    iconUrl: typeof skill.iconUrl === 'string' ? skill.iconUrl : '',
    summary: typeof skill.summary === 'string' ? skill.summary : '',
    summaryZh: typeof skill.summary_zh === 'string' ? skill.summary_zh : '',
    category: typeof skill.category === 'string' ? skill.category : '',
    categoryName,
    subCategories: subCategories
      .filter((it) => it !== null && typeof it === 'object' && typeof it.name === 'string')
      .map((it) => it.name),
    version: typeof tags.latest === 'string' && tags.latest !== ''
      ? tags.latest
      : (typeof latest.version === 'string' ? latest.version : ''),
    changelog: typeof latest.changelog === 'string' ? latest.changelog : '',
    downloads: typeof stats.downloads === 'number' ? stats.downloads : 0,
    installs: typeof stats.installs === 'number' ? stats.installs : 0,
    stars: typeof stats.stars === 'number' ? stats.stars : 0,
    versions: typeof stats.versions === 'number' ? stats.versions : 0,
    owner: typeof owner.displayName === 'string' && owner.displayName !== ''
      ? owner.displayName
      : (typeof skill.githubAuthorLogin === 'string' ? skill.githubAuthorLogin : ''),
    source: typeof skill.source === 'string' ? skill.source : '',
    sourceUrl: typeof skill.sourceUrl === 'string' ? skill.sourceUrl : '',
    overviewMd: typeof skill.overviewMd === 'string' ? skill.overviewMd : '',
    installed: skillhubInstalledSlugs().has(slug),
  }
}

// ---------------------------------------------------------------------------
// 已安装技能库（$DSH_HOME/skills）与连接器连接状态
// ---------------------------------------------------------------------------
//
// 语义（用户明确要求）：
//   - 卡片上的「+」= 安装 / 连接；已安装后「+」变成「对话」图标，点它才引用；
//   - 仓库技能也必须先安装（复制到 $DSH_HOME/skills）才能用；
//   - 「已安装」页可关闭某个技能：关闭后宿主启动扫描不到它，对话里自然不会加载。
//
// 关闭的实现不是打标记，而是把目录从 `skills/` **挪到** `skills-disabled/`：
// 插件只扫描 `skills/`，挪走即生效（实时读目录，无需重启）。

/** 被关闭的技能目录。 */
const SKILLS_DISABLED_DIR = path.join(DSH_HOME, 'skills-disabled')

/**
 * 技能目录名安全化。
 * @param {string} raw 原始名字
 * @returns {string} 只含 [A-Za-z0-9._-] 的目录名，非法返回空串
 */
function skillDirNameOf(raw) {
  const safe = String(raw || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  return safe !== '' ? safe.slice(0, 100) : ''
}

/**
 * 读技能目录的 SKILL.md frontmatter。
 * @param {string} dir 技能目录
 * @returns {{ name: string, description: string }|null} 元信息；没有 SKILL.md 返回 null
 */
function readSkillMeta(dir) {
  const text = readTextSafe(path.join(dir, 'SKILL.md'))
  if (text === null) return null
  const front = parseFrontmatter(text)
  const fallback = path.basename(dir)
  return {
    name: tidy(front.name || fallback, 120) || fallback,
    description: tidy(front.description || '', 400),
  }
}

/**
 * 列出一个根目录下的技能子目录（跳过隐藏目录）。
 * @param {string} root 根目录
 * @returns {string[]} 目录名列表
 */
function listSkillDirs(root) {
  if (!isDir(root)) return []
  try {
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

/**
 * 按目录名或 SkillHub slug 在本地技能库里找技能（含已关闭的）。
 * @param {string} id 目录名或 slug
 * @returns {{ dir: string, abs: string, name: string, description: string, enabled: boolean }|null} 命中记录
 */
function resolveInstalledSkill(id) {
  const key = tidy(id, 120)
  if (key === '') return null
  for (const enabled of [true, false]) {
    const root = enabled ? SKILLS_INSTALL_DIR : SKILLS_DISABLED_DIR
    for (const dir of listSkillDirs(root)) {
      const abs = path.join(root, dir)
      const meta = readSkillMeta(abs)
      if (meta === null) continue
      const marketMeta = readJsonSafe(path.join(abs, '_meta.json'))
      const slug = marketMeta !== null && typeof marketMeta.slug === 'string' ? marketMeta.slug : ''
      if (dir === key || slug === key) {
        return { dir, abs, name: meta.name, description: meta.description, enabled }
      }
    }
  }
  return null
}

/**
 * 统计一个目录树的文件数与总字节（**跳过符号链接**，避免越界复制）。
 *
 * 递归过程中遇到符号链接一律不跟随、不计数；读取失败按 0 处理，绝不抛错。
 * @param {string} dir 绝对目录
 * @returns {{ fileCount: number, bytes: number }} 统计结果
 */
function treeStats(dir) {
  const total = { fileCount: 0, bytes: 0 }
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return total
  }
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name)
    let info = null
    try {
      info = fs.lstatSync(absolute)
    } catch {
      continue
    }
    // 符号链接既不算文件也不算目录：内置技能里不应该出现，出现了也不复制。
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) {
      const nested = treeStats(absolute)
      total.fileCount += nested.fileCount
      total.bytes += nested.bytes
      continue
    }
    if (info.isFile()) {
      total.fileCount += 1
      total.bytes += info.size
    }
  }
  return total
}

/**
 * 把单个内置技能整树复制到目标目录。
 *
 * 安全约束（任一超限即整体失败，由调用方清理半成品目录）：
 *  - 跳过符号链接（不跟随、不复制）；
 *  - 单文件 ≤ BUILTIN_MAX_FILE_BYTES；
 *  - 单技能总字节 ≤ BUILTIN_MAX_TOTAL_BYTES；
 *  - 单技能文件数 ≤ BUILTIN_MAX_FILES。
 * @param {string} srcDir 内置技能源目录
 * @param {string} destDir 目标目录（`$DSH_HOME/skills/<dir>`）
 * @returns {{ ok: boolean, fileCount: number, bytes: number, error: string }} 复制结果
 */
function copyBuiltinSkillTree(srcDir, destDir) {
  let entries
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true })
  } catch (error) {
    return { ok: false, fileCount: 0, bytes: 0, error: '源目录读取失败：' + humanError(error) }
  }
  try {
    fs.mkdirSync(destDir, { recursive: true })
  } catch (error) {
    return { ok: false, fileCount: 0, bytes: 0, error: '目标目录创建失败：' + humanError(error) }
  }
  let fileCount = 0
  let bytes = 0
  for (const entry of entries) {
    const from = path.join(srcDir, entry.name)
    const to = path.join(destDir, entry.name)
    let info = null
    try {
      info = fs.lstatSync(from)
    } catch {
      continue
    }
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) {
      const nested = copyBuiltinSkillTree(from, to)
      if (nested.ok !== true) return nested
      fileCount += nested.fileCount
      bytes += nested.bytes
      if (fileCount > BUILTIN_MAX_FILES) {
        return { ok: false, fileCount, bytes, error: '文件数超过上限 ' + String(BUILTIN_MAX_FILES) }
      }
      if (bytes > BUILTIN_MAX_TOTAL_BYTES) {
        return { ok: false, fileCount, bytes, error: '总体积超过上限 ' + String(BUILTIN_MAX_TOTAL_BYTES) + ' 字节' }
      }
      continue
    }
    if (!info.isFile()) continue
    if (info.size > BUILTIN_MAX_FILE_BYTES) {
      return {
        ok: false,
        fileCount,
        bytes,
        error: '单文件超过上限 ' + String(BUILTIN_MAX_FILE_BYTES) + ' 字节：' + entry.name,
      }
    }
    try {
      fs.copyFileSync(from, to)
    } catch (error) {
      return { ok: false, fileCount, bytes, error: '文件复制失败：' + entry.name + '（' + humanError(error) + '）' }
    }
    fileCount += 1
    bytes += info.size
    if (fileCount > BUILTIN_MAX_FILES) {
      return { ok: false, fileCount, bytes, error: '文件数超过上限 ' + String(BUILTIN_MAX_FILES) }
    }
    if (bytes > BUILTIN_MAX_TOTAL_BYTES) {
      return { ok: false, fileCount, bytes, error: '总体积超过上限 ' + String(BUILTIN_MAX_TOTAL_BYTES) + ' 字节' }
    }
  }
  return { ok: true, fileCount, bytes, error: '' }
}

/**
 * 插件内置技能根目录：`PLUGIN_ROOT/builtin/<platform>/skills`。
 *
 * platform 由 builtinPlatform() 决定（win32 → windows，其余 → linux）。
 * 目录不存在时照样返回路径，由调用方按「不存在 = 空列表」处理，绝不抛错。
 * @returns {string} 内置技能根目录绝对路径
 */
function builtinSkillsRoot() {
  return path.join(PLUGIN_ROOT, 'builtin', builtinPlatform(), 'skills')
}

/**
 * 内置「插件技能」根目录：`PLUGIN_ROOT/builtin/<platform>/builtin-plugins`。
 *
 * 这里的技能来自随包内置的 CodeBuddy 插件包（`builtin-plugins/<插件>/skills/<技能>`）。
 * 目录不存在时照样返回路径，由调用方按「不存在 = 空列表」处理，绝不抛错。
 * @returns {string} 内置插件技能根目录绝对路径
 */
function builtinPluginsRoot() {
  return path.join(PLUGIN_ROOT, 'builtin', builtinPlatform(), 'builtin-plugins')
}

/**
 * `allowed-tools:` 后面**跟着实际值**才算「声明了限制」；写成 `allowed-tools: `（空）
 * 或整行留空都不算 —— 内置插件里多个技能故意留空占位，不能被误判。
 */
const PLUGIN_SKILL_ALLOWED_TOOLS = /allowed-tools:[ \t]*[^\s]/i

/**
 * `../Xxx` 形式的相对路径。要求 `../` 后面是 ASCII 字母，避免把文档里
 * 「禁用 `../` 相对路径」这种**反例说明**误判成真实引用。
 */
const PLUGIN_SKILL_PARENT_REF = /(^|\s)\.\.\/[A-Za-z]/

/** 插件根下的运行时目录：技能复制出来后这些目录并不存在。 */
const PLUGIN_SKILL_PLUGIN_DIR = /\b(core|agents|hooks|shared|dist|bin|prebuilds)\//

/** `Plugin` / `插件` 字样：基本都在讲「依赖宿主插件运行时」。 */
const PLUGIN_SKILL_PLUGIN_WORD = /\bPlugin\b|插件/

/** SKILL.md 里出现的 `scripts/<相对路径>` 引用（大小写敏感，按字面匹配）。 */
const PLUGIN_SKILL_SCRIPT_REF = /scripts\/[A-Za-z0-9._/-]*[A-Za-z0-9._-]/g

/**
 * 判断一个「插件技能」能否单独装进 `$DSH_HOME/skills` 使用。
 *
 * 原则：**宁可少装，不装坏技能**。内置插件的技能大多依赖所属插件的运行时
 * （`mcp__*` 工具、`ToolSearch` 发现的工具、`editor_sdk` 本地服务、插件根的
 * `core/ agents/ hooks/ shared/ dist/ bin/ prebuilds/`、或不在自己目录里的
 * `scripts/...`）。这类技能复制到本地技能库后会变成「列表里看得见、一调用就报
 * 工具不存在」，比不装更糟。因此只有**完全自包含**的技能才纳入内置技能。
 *
 * 规则顺序固定（越靠前越具体、越靠近「根本跑不起来」），命中即返回中文原因：
 *  1. 没有 `SKILL.md` → `缺少 SKILL.md`
 *  2. 出现 `mcp`（不区分大小写）→ `依赖 MCP 能力`
 *  3. 出现 `ToolSearch` → `依赖 ToolSearch 发现的工具`
 *  4. 出现 `editor_sdk`（不区分大小写）→ `依赖 editor_sdk 本地服务`
 *  5. `allowed-tools:` 声明了值 → `声明了 allowed-tools 限制`
 *  6. `../Xxx` 相对路径 → `引用了插件上级目录`
 *  7. `core/ agents/ hooks/ shared/ dist/ bin/ prebuilds/` → `引用插件内目录`
 *  8. `Plugin` / `插件` 字样 → `依赖插件运行时`
 *  9. 提到的 `scripts/...` 在本技能目录内不存在 → `引用的脚本不在技能目录内`
 * 全部不命中 → 返回 `''`（自包含，可纳入）。
 * @param {string} skillDir 技能目录（绝对路径）
 * @returns {string} 中文排除原因；`''` 表示可以纳入
 */
function pluginSkillReason(skillDir) {
  const skillFile = path.join(skillDir, 'SKILL.md')
  if (!isFile(skillFile)) return '缺少 SKILL.md'
  let text = ''
  try {
    text = fs.readFileSync(skillFile, 'utf8')
  } catch {
    return 'SKILL.md 读取失败'
  }
  if (/mcp/i.test(text)) return '依赖 MCP 能力'
  if (/ToolSearch/.test(text)) return '依赖 ToolSearch 发现的工具'
  if (/editor_sdk/i.test(text)) return '依赖 editor_sdk 本地服务'
  if (PLUGIN_SKILL_ALLOWED_TOOLS.test(text)) return '声明了 allowed-tools 限制'
  if (PLUGIN_SKILL_PARENT_REF.test(text)) return '引用了插件上级目录'
  if (PLUGIN_SKILL_PLUGIN_DIR.test(text)) return '引用插件内目录'
  if (PLUGIN_SKILL_PLUGIN_WORD.test(text)) return '依赖插件运行时'
  /* 逐个 `scripts/xxx` 引用核对是否在**本技能目录**内存在：
     只查存在性，不解析语义；允许尾部标点（`.py.` 这类句末点）两种写法都试一次。 */
  const refs = text.match(PLUGIN_SKILL_SCRIPT_REF)
  if (refs !== null) {
    for (const ref of refs) {
      const trimmed = ref.replace(/[.-]+$/, '')
      if (isFile(path.join(skillDir, ref)) || isFile(path.join(skillDir, trimmed))) continue
      return '引用的脚本不在技能目录内'
    }
  }
  return ''
}

/**
 * 列出内置插件里**自包含**的技能（只读磁盘，不写任何状态）。
 *
 * 遍历 `builtin-plugins/<插件>/skills/<技能>/SKILL.md`，用 pluginSkillReason() 过滤：
 *  - 通过者返回 `origin: 'plugin'` 的条目（`plugin` 是所属插件目录名）；
 *  - 被排除者收集成 `{ plugin, dir, reason }`，**不参与安装**，只给接口展示原因。
 *
 * 这里的 `dir` 是**技能源目录名**（未做落盘净化、未与顶层内置技能去重），
 * 最终落盘目录名由 listBuiltinSkills() 统一分配。
 * @returns {{ items: Array<{ dir: string, name: string, description: string, sourceDir: string, fileCount: number, bytes: number, origin: 'plugin', plugin: string }>, excluded: Array<{ plugin: string, dir: string, reason: string }> }} 插件技能清单与被排除原因
 */
function listPluginBuiltinSkills() {
  /** @type {Array<{ dir: string, name: string, description: string, sourceDir: string, fileCount: number, bytes: number, origin: 'plugin', plugin: string }>} */
  const items = []
  /** @type {Array<{ plugin: string, dir: string, reason: string }>} */
  const excluded = []
  const root = builtinPluginsRoot()
  if (!isDir(root)) return { items, excluded }
  let plugins
  try {
    plugins = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return { items, excluded }
  }
  /** @type {Set<string>} */
  const taken = new Set()
  for (const plugin of plugins) {
    if (!plugin.isDirectory() || plugin.name.startsWith('.')) continue
    const skillsRoot = path.join(root, plugin.name, 'skills')
    if (!isDir(skillsRoot)) continue
    let entries
    try {
      entries = fs.readdirSync(skillsRoot, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const sourceDir = path.join(skillsRoot, entry.name)
      const reason = pluginSkillReason(sourceDir)
      if (reason !== '') {
        excluded.push({ plugin: plugin.name, dir: entry.name, reason })
        continue
      }
      const meta = readSkillMeta(sourceDir)
      const name = meta !== null && meta.name !== '' ? meta.name : entry.name
      const description = meta !== null ? meta.description : ''
      const stats = treeStats(sourceDir)
      // 复制上限（单技能 ≤ 400 文件 / 40MB）过不去的话装也装不上，提前排除更诚实。
      if (stats.fileCount > BUILTIN_MAX_FILES || stats.bytes > BUILTIN_MAX_TOTAL_BYTES) {
        excluded.push({ plugin: plugin.name, dir: entry.name, reason: '体积超过复制上限' })
        continue
      }
      const base = skillDirNameOf(name) || skillDirNameOf(entry.name) || entry.name
      let dir = base
      let suffix = 2
      while (taken.has(dir)) {
        dir = base + '-' + String(suffix)
        suffix += 1
      }
      taken.add(dir)
      items.push({
        dir,
        name,
        description,
        sourceDir,
        fileCount: stats.fileCount,
        bytes: stats.bytes,
        origin: 'plugin',
        plugin: plugin.name,
      })
    }
  }
  items.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
  excluded.sort((a, b) => {
    if (a.plugin !== b.plugin) return a.plugin < b.plugin ? -1 : 1
    return a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0
  })
  return { items, excluded }
}

/**
 * 列出全部内置技能（两个来源合并后，只读磁盘，不写任何状态）。
 *
 * 来源一：`builtin/<platform>/skills/*`（随包发布的独立技能，`origin: 'skills'`）；
 * 来源二：`builtin/<platform>/builtin-plugins/<插件>/skills/*` 里**自包含**的技能
 * （`origin: 'plugin'`，见 pluginSkillReason）；依赖插件运行时的一律排除，
 * 但原因会跟着 `excluded` 一起返回，设置弹窗用它解释「为什么少了这些」。
 *
 * 判定规则：
 *  - 只认含 `SKILL.md` 的子目录（插件来源多一道自包含过滤），隐藏目录（`.` 开头）跳过；
 *  - `name` 取 frontmatter name，为空回落目录名；
 *  - 落地目录名用 `skillDirNameOf(name) || 目录名` —— 这是 `sites`（frontmatter
 *    name 是中文「发布为应用」）的兜底，净化后不能为空；
 *  - 结果目录名保证唯一：顶层先占坑，插件来源重名时追加 `-2`、`-3`；
 *    `dir` 相同的以顶层为准（顶层覆盖插件来源）。
 *
 * 目录不存在或为空时返回空清单，不报错（`builtin/linux` 暂为空就是这样）。
 * @returns {{ items: Array<{ dir: string, name: string, description: string, sourceDir: string, fileCount: number, bytes: number, origin: 'skills'|'plugin', plugin: string }>, excluded: Array<{ plugin: string, dir: string, reason: string }> }} 合并后的内置技能清单与被排除的插件技能原因
 */
function listBuiltinSkills() {
  /** @type {Array<{ dir: string, name: string, description: string, sourceDir: string, fileCount: number, bytes: number, origin: 'skills'|'plugin', plugin: string }>} */
  const items = []
  /** @type {Set<string>} */
  const taken = new Set()
  const root = builtinSkillsRoot()
  if (isDir(root)) {
    let entries = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const sourceDir = path.join(root, entry.name)
      if (!isFile(path.join(sourceDir, 'SKILL.md'))) continue
      const meta = readSkillMeta(sourceDir)
      const name = meta !== null ? meta.name : entry.name
      const description = meta !== null ? meta.description : ''
      const base = skillDirNameOf(name) || skillDirNameOf(entry.name) || entry.name
      let dir = base
      let suffix = 2
      while (taken.has(dir)) {
        dir = base + '-' + String(suffix)
        suffix += 1
      }
      taken.add(dir)
      const stats = treeStats(sourceDir)
      items.push({
        dir,
        name: name === '' ? entry.name : name,
        description,
        sourceDir,
        fileCount: stats.fileCount,
        bytes: stats.bytes,
        origin: 'skills',
        plugin: '',
      })
    }
  }
  const plugins = listPluginBuiltinSkills()
  for (const skill of plugins.items) {
    // 顶层先占坑：插件来源撞名就换后缀（顶层 origin 保持 'skills'）。
    let dir = skill.dir
    let suffix = 2
    while (taken.has(dir)) {
      dir = skill.dir + '-' + String(suffix)
      suffix += 1
    }
    taken.add(dir)
    items.push({
      dir,
      name: skill.name,
      description: skill.description,
      sourceDir: skill.sourceDir,
      fileCount: skill.fileCount,
      bytes: skill.bytes,
      origin: 'plugin',
      plugin: skill.plugin,
    })
  }
  items.sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
  return { items, excluded: plugins.excluded }
}

/**
 * 内置技能的数量概览（`total` = 可用总数、`plugin` = 来自内置插件的数量、
 * `excluded` = 因依赖插件运行时被排除的数量）。
 *
 * 只在服务端扫一次磁盘，供 `GET /settings` 与 `GET /builtin/skills` 共用，
 * 避免「设置文案里的数字」与「接口里的列表」各算一次而漂移。
 * @returns {{ total: number, plugin: number, excluded: number }} 数量概览
 */
function builtinSkillSummary() {
  const { items, excluded } = listBuiltinSkills()
  return {
    total: items.length,
    plugin: items.filter((item) => item.origin === 'plugin').length,
    excluded: excluded.length,
  }
}

/**
 * 内置开关装过的技能目录名集合（用户界面**不可见**的那批）。
 *
 * 判据是落盘标记文件 `$DSH_HOME/skills/<dir>/.builtin-skill.json`：
 * 只有 installAllBuiltinSkills() 会写它，因此用户自己的同名技能永远不会被误判。
 * `skills/` 与 `skills-disabled/` 都扫，避免「用户手动关闭内置技能」后又在列表里冒出来。
 * @returns {Set<string>} 目录名集合
 */
function hiddenSkillDirs() {
  /** @type {Set<string>} */
  const hidden = new Set()
  for (const root of [SKILLS_INSTALL_DIR, SKILLS_DISABLED_DIR]) {
    for (const dir of listSkillDirs(root)) {
      if (isFile(path.join(root, dir, BUILTIN_MARKER))) hidden.add(dir)
    }
  }
  return hidden
}

/**
 * 统计内置技能在本地的安装数（只数带标记的目录）。
 * @returns {number} 已安装数量
 */
function countBuiltinInstalled() {
  return hiddenSkillDirs().size
}

/**
 * 把全部内置技能整树安装到 `$DSH_HOME/skills/<dir>`。
 *
 * 幂等语义：
 *  - 目标已存在且含内置标记 → 覆盖（版本升级），计入 `updated`；
 *  - 目标已存在但**没有**标记（用户自己的同名技能）→ 跳过并记 `skipped`，
 *    绝不覆盖用户文件；
 *  - `skills-disabled/<dir>` 同理（带标记的视为自己的残留，先清再装回 `skills/`）。
 *
 * 复制过程中任一文件超限 → 该技能整体失败、清理半成品目录、记入 `skipped`，不影响其它技能。
 * @returns {{ ok: boolean, platform: 'windows'|'linux', total: number, installed: number, updated: number, skipped: Array<{ dir: string, reason: string }> }} 安装结果
 */
function installAllBuiltinSkills() {
  const platform = builtinPlatform()
  // 只装 items：excluded（依赖插件运行时）永远不进本地技能库。
  const list = listBuiltinSkills().items
  /** @type {Array<{ dir: string, reason: string }>} */
  const skipped = []
  let installed = 0
  let updated = 0
  if (list.length === 0) {
    return { ok: true, platform, total: 0, installed: 0, updated: 0, skipped }
  }
  try {
    fs.mkdirSync(SKILLS_INSTALL_DIR, { recursive: true })
  } catch (error) {
    return {
      ok: false,
      platform,
      total: list.length,
      installed: 0,
      updated: 0,
      skipped: [{ dir: '', reason: '技能库目录创建失败：' + humanError(error) }],
    }
  }
  const installedAt = new Date().toISOString()
  for (const skill of list) {
    const targetDir = path.join(SKILLS_INSTALL_DIR, skill.dir)
    const disabledDir = path.join(SKILLS_DISABLED_DIR, skill.dir)
    let replaced = false
    try {
      if (isDir(targetDir)) {
        if (!isFile(path.join(targetDir, BUILTIN_MARKER))) {
          skipped.push({ dir: skill.dir, reason: '同名技能已存在，未覆盖' })
          continue
        }
        // 带标记 = 自己上一版装的：整目录删掉重装，保证删掉的文件不残留。
        fs.rmSync(targetDir, { recursive: true, force: true })
        replaced = true
      }
      if (isDir(disabledDir)) {
        if (!isFile(path.join(disabledDir, BUILTIN_MARKER))) {
          skipped.push({ dir: skill.dir, reason: '同名技能已存在，未覆盖' })
          continue
        }
        fs.rmSync(disabledDir, { recursive: true, force: true })
        replaced = true
      }
    } catch (error) {
      skipped.push({ dir: skill.dir, reason: '旧目录清理失败：' + humanError(error) })
      continue
    }

    const copied = copyBuiltinSkillTree(skill.sourceDir, targetDir)
    if (copied.ok !== true) {
      try { fs.rmSync(targetDir, { recursive: true, force: true }) } catch { /* 清理失败忽略 */ }
      skipped.push({ dir: skill.dir, reason: copied.error })
      continue
    }
    try {
      fs.writeFileSync(
        path.join(targetDir, BUILTIN_MARKER),
        JSON.stringify({
          from: 'builtin',
          platform,
          sourceDir: skill.sourceDir,
          // origin / plugin 只是排障用（'skills' 或 'plugin' + 所属插件目录名）。
          origin: skill.origin,
          plugin: skill.plugin,
          installedAt,
        }, null, 2),
        'utf8',
      )
    } catch (error) {
      skipped.push({ dir: skill.dir, reason: '内置标记写入失败：' + humanError(error) })
      continue
    }
    if (replaced) updated += 1
    else installed += 1
  }
  return { ok: true, platform, total: list.length, installed, updated, skipped }
}

/**
 * 移除全部由内置开关装进来的技能目录（只删含标记的）。
 *
 * 没有标记的目录一律不动 —— 用户自己安装 / 手写的同名技能必须保留。
 * @returns {{ ok: boolean, removed: string[] }} 移除结果（removed 为目录名列表）
 */
function removeBuiltinSkills() {
  /** @type {string[]} */
  const removed = []
  for (const root of [SKILLS_INSTALL_DIR, SKILLS_DISABLED_DIR]) {
    for (const dir of listSkillDirs(root)) {
      const abs = path.join(root, dir)
      if (!isFile(path.join(abs, BUILTIN_MARKER))) continue
      try {
        fs.rmSync(abs, { recursive: true, force: true })
        removed.push(dir)
      } catch (error) {
        state.warnings.push('内置技能移除失败（' + dir + '）：' + humanError(error))
      }
    }
  }
  return { ok: true, removed }
}

/**
 * `GET /builtin/skills`：内置技能总开关与数量概览。
 *
 * 这个接口**只给设置弹窗显示数量用**，不是给用户浏览内置技能列表的 ——
 * 内置技能装完后在界面上完全不可见（见 hiddenSkillDirs）。
 *
 * `available` 是真正可安装的那批（顶层 + 内置插件里自包含的）；
 * `excluded` 是内置插件里**因依赖插件运行时未纳入**的技能及原因，只展示、不安装。
 * @returns {Record<string, any>} 响应载荷
 */
function handleBuiltinSkillsGet() {
  const platform = builtinPlatform()
  const { items, excluded } = listBuiltinSkills()
  const installedSet = hiddenSkillDirs()
  // 不用 `installed: installedSet.has(...)`，用户手装的同名技能也算安装；
  // 这里只报告「内置开关自己装的那批」，与关闭时的移除数量对得上。
  const available = items.map((skill) => ({
    dir: skill.dir,
    name: skill.name,
    description: skill.description,
    installed: installedSet.has(skill.dir),
    origin: skill.origin,
    plugin: skill.plugin,
  }))
  // 排除明细只做「解释用」，条数封顶 30，超出用 excludedTruncated 标明。
  const EXCLUDED_LIMIT = 30
  const excludedRows = excluded.slice(0, EXCLUDED_LIMIT).map((row) => ({
    plugin: row.plugin,
    dir: row.dir,
    reason: row.reason,
  }))
  return {
    ok: true,
    platform,
    enabled: state.settings.builtinSkills === true,
    root: builtinSkillsRoot(),
    pluginsRoot: builtinPluginsRoot(),
    available,
    excluded: excludedRows,
    excludedTruncated: excluded.length > EXCLUDED_LIMIT,
    counts: {
      available: available.length,
      installed: available.filter((item) => item.installed).length,
      plugin: available.filter((item) => item.origin === 'plugin').length,
      excluded: excluded.length,
    },
  }
}

/**
 * `POST /builtin/skills/toggle`：内置技能总开关。
 *
 * 开启 → 全量安装（幂等，重复开启等于版本升级）；关闭 → 只删自己装的那些。
 * `enabled` 必须是布尔值，非布尔直接 400（不猜用户意图）。
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {Promise<Record<string, any>>} 响应载荷；ok === false 时由路由层回 400
 */
async function handleBuiltinSkillsToggle(req) {
  let payload
  try {
    const raw = await readRawBody(req, 64 * 1024)
    payload = JSON.parse(raw.toString('utf8'))
  } catch (error) {
    return { ok: false, error: '请求体不合法：' + humanError(error) }
  }
  if (payload === null || typeof payload !== 'object' || typeof payload.enabled !== 'boolean') {
    return { ok: false, error: '参数 enabled 必须是布尔值（true 开启 / false 关闭）' }
  }
  const platform = builtinPlatform()
  const enabled = payload.enabled
  /** @type {Record<string, any>} */
  const action = {}
  if (enabled) {
    const result = installAllBuiltinSkills()
    if (result.ok !== true) {
      return { ok: false, error: '内置技能安装失败：' + String((result.skipped[0] && result.skipped[0].reason) || '未知原因') }
    }
    action.total = result.total
    action.installed = result.installed
    action.updated = result.updated
    action.skipped = result.skipped
    state.settings.builtinSkills = true
  } else {
    const result = removeBuiltinSkills()
    action.removed = result.removed
    state.settings.builtinSkills = false
  }
  persistState()
  // available 语义不变：可用（可安装）总数，现在含内置插件的自包含技能。
  const available = listBuiltinSkills().items.length
  return Object.assign({
    ok: true,
    platform,
    enabled: state.settings.builtinSkills === true,
    counts: { available, installed: countBuiltinInstalled() },
  }, action)
}

/**
 * `GET /skills/installed`：已安装技能清单（含被关闭的，带 enabled 标记）。
 * @returns {Record<string, any>} 响应体
 */
function handleInstalledSkills() {
  const items = []
  /* 内置开关装进来的技能对用户**不可见**（用户明确要求）：这里直接过滤掉。
     宿主仍会原生扫描 `~/.dsh/skills` 正常加载它们，只是不在插件界面列出。 */
  const hidden = hiddenSkillDirs()
  const collect = (dir, enabled) => {
    if (hidden.has(dir)) return
    const abs = path.join(enabled ? SKILLS_INSTALL_DIR : SKILLS_DISABLED_DIR, dir)
    const meta = readSkillMeta(abs)
    if (meta === null) return
    const saved = state.installedSkills[dir]
    // `_meta.json` 是 SkillHub 落盘产物，作为来源的唯一权威依据：
    // 即使 state 被旧逻辑误写成 local，这里也会自愈为 market（分组与「市场」标签不变）。
    const marketMeta = readJsonSafe(path.join(abs, '_meta.json'))
    items.push({
      dir,
      name: meta.name,
      description: meta.description,
      source: marketMeta !== null ? 'market' : (saved !== undefined ? saved.source : 'local'),
      enabled,
      slug: marketMeta !== null && typeof marketMeta.slug === 'string' ? marketMeta.slug : '',
      installedAt: saved !== undefined ? saved.installedAt : 0,
      path: path.join(abs, 'SKILL.md'),
    })
  }
  for (const dir of listSkillDirs(SKILLS_INSTALL_DIR)) collect(dir, true)
  for (const dir of listSkillDirs(SKILLS_DISABLED_DIR)) collect(dir, false)
  items.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return {
    ok: true,
    dir: SKILLS_INSTALL_DIR,
    items,
    total: items.length,
    enabledCount: items.filter((item) => item.enabled).length,
  }
}

/**
 * `POST /skills/install`：把仓库技能复制进本地技能库。
 *
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {Promise<Record<string, any>>} 响应体
 */
async function handleInstallRepoSkill(req) {
  let payload
  try {
    const raw = await readRawBody(req, 64 * 1024)
    payload = JSON.parse(raw.toString('utf8'))
  } catch (error) {
    return { ok: false, error: '请求体不合法：' + humanError(error) }
  }
  const id = payload !== null && typeof payload === 'object' && typeof payload.id === 'string' ? payload.id.trim() : ''
  if (id === '') return { ok: false, error: '缺少技能 id' }

  const sourceDir = safeRepoDir(id)
  if (sourceDir === null || !isFile(path.join(sourceDir, 'SKILL.md'))) {
    return { ok: false, error: '仓库里找不到该技能目录：' + id }
  }
  const meta = readSkillMeta(sourceDir)
  const dirName = skillDirNameOf(meta !== null ? meta.name : path.basename(sourceDir)) || skillDirNameOf(path.basename(sourceDir))
  if (dirName === '') return { ok: false, error: '技能名无法生成合法目录名' }

  const targetDir = path.join(SKILLS_INSTALL_DIR, dirName)
  const disabledDir = path.join(SKILLS_DISABLED_DIR, dirName)
  if (isDir(targetDir) || isDir(disabledDir)) {
    // 幂等：已经装过（含被关闭的）就直接返回，不覆盖用户可能改过的文件。
    if (state.installedSkills[dirName] === undefined) {
      state.installedSkills[dirName] = {
        enabled: isDir(targetDir),
        source: 'repo',
        installedAt: Date.now(),
      }
      persistState()
    }
    return { ok: true, already: true, dir: dirName, name: meta !== null ? meta.name : dirName, restartRequired: false }
  }

  const warnings = []
  try {
    fs.mkdirSync(targetDir, { recursive: true })
  } catch (error) {
    return { ok: false, error: '创建目录失败：' + humanError(error) }
  }
  const copied = copyDirFiles(sourceDir, targetDir, warnings, '技能')
  if (copied === 0) {
    try { fs.rmSync(targetDir, { recursive: true, force: true }) } catch { /* 清理失败忽略 */ }
    return { ok: false, error: '复制技能文件失败' + (warnings.length > 0 ? '：' + warnings[0] : '') }
  }

  state.installedSkills[dirName] = { enabled: true, source: 'repo', installedAt: Date.now() }
  persistState()
  return {
    ok: true,
    already: false,
    dir: dirName,
    name: meta !== null ? meta.name : dirName,
    fileCount: copied,
    // 插件每次请求实时扫描技能目录，装完即可引用（无需重启）。
    restartRequired: false,
  }
}

/**
 * 推断已安装技能的来源，供开关写 state 时使用。
 *
 * 优先级与 `handleInstalledSkills().collect()` 保持一致：
 *   1. `_meta.json`（SkillHub 落盘产物）是权威依据 → market；
 *      即使 state.source 被旧逻辑写脏成 local，也在这里自愈并写回 market；
 *   2. 否则沿用 state 里已有的 source（仓库安装写入 'repo'）→ 不互相漂移；
 *   3. 都没有 → 本地自定义 local。
 *
 * @param {string} dir 技能目录名
 * @param {string} abs 实际存在的技能目录绝对路径（skills/ 或 skills-disabled/）
 * @returns {string} 来源标识：'market'|'repo'|'local'
 */
function resolveSkillSource(dir, abs) {
  // `_meta.json` 是 SkillHub 落盘产物，权威；优先于可能被旧逻辑写脏的 state.source
  if (readJsonSafe(path.join(abs, '_meta.json')) !== null) return 'market'
  const saved = state.installedSkills[dir]
  if (saved !== undefined && typeof saved.source === 'string' && saved.source !== '') {
    return saved.source
  }
  return 'local'
}

/**
 * `POST /skills/toggle`：开启 / 关闭已安装技能。
 *
 * 关闭 = 目录从 `skills/` 挪到 `skills-disabled/`（宿主扫不到即不加载）。
 * 写 state 时只更新 `enabled`，来源由 `resolveSkillSource()` 推断，
 * 绝不把 SkillHub 技能凭空改写成 local。
 *
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {Promise<Record<string, any>>} 响应体
 */
async function handleToggleSkill(req) {
  let payload
  try {
    const raw = await readRawBody(req, 64 * 1024)
    payload = JSON.parse(raw.toString('utf8'))
  } catch (error) {
    return { ok: false, error: '请求体不合法：' + humanError(error) }
  }
  const dir = payload !== null && typeof payload === 'object' && typeof payload.dir === 'string' ? payload.dir.trim() : ''
  const enabled = payload !== null && typeof payload === 'object' && payload.enabled !== false
  if (skillDirNameOf(dir) !== dir || dir === '') return { ok: false, error: '技能目录名不合法：' + dir }

  const from = path.join(enabled ? SKILLS_DISABLED_DIR : SKILLS_INSTALL_DIR, dir)
  const to = path.join(enabled ? SKILLS_INSTALL_DIR : SKILLS_DISABLED_DIR, dir)
  if (!isDir(from)) {
    if (isDir(to)) {
      // 状态已一致：只补写 state，避免前端因幂等操作报错。
      // 目录当前实际落在 `to`，读 `_meta.json` 必须用它而不是已不存在的 `from`。
      const actualDir = isDir(to) ? to : from
      const source = resolveSkillSource(dir, actualDir)
      state.installedSkills[dir] = Object.assign({ installedAt: 0 }, state.installedSkills[dir], { source, enabled })
      persistState()
      return { ok: true, dir, enabled, already: true, restartRequired: false }
    }
    return { ok: false, error: '找不到已安装技能目录：' + dir }
  }
  try {
    fs.mkdirSync(path.dirname(to), { recursive: true })
    fs.renameSync(from, to)
  } catch (error) {
    return { ok: false, error: (enabled ? '开启' : '关闭') + '失败：' + humanError(error) }
  }
  // 挪动完成后目录实际落在 `to`（开启=skills/，关闭=skills-disabled/），
  // 用实际存在的目录推断来源，SkillHub 技能带 `_meta.json` → 保持 market。
  const actualDir = isDir(to) ? to : from
  const source = resolveSkillSource(dir, actualDir)
  state.installedSkills[dir] = Object.assign({ installedAt: 0 }, state.installedSkills[dir], { source, enabled })
  persistState()
  return { ok: true, dir, enabled, restartRequired: false }
}

/**
 * `GET /connectors/connected`：已连接连接器 id 列表。
 * @returns {Record<string, any>} 响应体
 */
function handleConnectedConnectors() {
  return {
    ok: true,
    items: Object.entries(state.connectedConnectors).map(([id, meta]) => ({ id, connectedAt: meta.connectedAt })),
    ids: Object.keys(state.connectedConnectors),
  }
}

/**
 * `POST /connectors/connect` / `/connectors/disconnect`。
 *
 * **边界说明**：宿主的 MCP 客户端是「一插件实例一 server」的静态配置
 * （`@deepseek-ai/dsh-mcp-client`，配置在 profile 的 cordis 层），运行期没有
 * 动态挂载 MCP server 的公开接口。因此这里的「连接」= 在插件内登记连接状态，
 * 并把该连接器的 MCP 配置在**对话引用时**内联给模型；真正把 MCP 工具挂进
 * 宿主仍需在 profile 配置里加 `mcp-client` 实例（本插件不改用户配置文件）。
 *
 * **连接前置校验**：需要认证 / 参数的连接器必须先在卡片「+」弹窗里完成设置。
 * 前端提交 `params: { VAR: value }`，后端只校验「变量名齐全且非空」，
 * 校验通过后**立刻丢弃值**：不落盘、不写日志、不回显、不拼进 `<mcp-config>`，
 * 只把布尔连接状态（`connectedAt`）写进插件自己的 state.json。
 * OAuth / OneID 连接器另需 WorkBuddy 侧已完成登录，否则返回可读引导，绝不假装成功。
 *
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @param {boolean} connect true=连接，false=断开
 * @returns {Promise<Record<string, any>>} 响应体
 */
async function handleConnectorConnect(req, connect) {
  let payload
  try {
    const raw = await readRawBody(req, 64 * 1024)
    payload = JSON.parse(raw.toString('utf8'))
  } catch (error) {
    return { ok: false, error: '请求体不合法：' + humanError(error) }
  }
  const id = payload !== null && typeof payload === 'object' && typeof payload.id === 'string' ? payload.id.trim() : ''
  if (id === '') return { ok: false, error: '缺少连接器 id' }
  if (requireIndex() === null) return busyPayload()
  const item = findConnectorItem(id)
  if (item === undefined) return { ok: false, error: '未找到该连接器：' + id }

  if (!connect) {
    delete state.connectedConnectors[id]
    persistState()
    return { ok: true, id, connected: false }
  }

  /* 不可连接的条目（cli / sse / 占位符地址）在连接入口也拦住：
     它们要么没有 MCP 配置，要么写出来的 url 在宿主里跑不起来。 */
  if (item.connectable === false) {
    return {
      ok: false,
      error: '该连接器不可在面板内安装或连接：' + (item.unsupportedReason || '传输方式不受支持'),
    }
  }

  // 已经连接过的连接器：/attach 常驻流程会对账式再登记一次，属于幂等请求，
  // 不应要求用户重新填一遍参数（值本来就没被保存）。仅首次连接做前置校验。
  const alreadyConnected = state.connectedConnectors[id] !== undefined && state.connectedConnectors[id] !== null

  // 只从请求里读「已知变量名」对应的值做非空校验；未知键一律忽略。
  // 任何值都不会进入响应体、state.json、日志或 system prompt。
  const requiredParams = normalizeRequiredParams(item.requiredParams)
  const authMode = normalizeAuthMode(item.authMode)
  const rawParams = payload !== null && typeof payload === 'object' && payload.params !== null &&
    typeof payload.params === 'object' && !Array.isArray(payload.params) ? payload.params : {}
  /** @type {string[]} */
  const missing = []
  for (const name of requiredParams) {
    const value = rawParams[name]
    if (typeof value !== 'string' || value.trim() === '') missing.push(name)
  }
  if (alreadyConnected === false && missing.length > 0) {
    return { ok: false, error: '缺少连接参数：' + missing.join('、') + '，请填写完整后再连接' }
  }
  if (alreadyConnected === false && isOAuthMode(authMode) && workbuddyOAuthReady(id) === false) {
    return { ok: false, error: '此连接器需在 WorkBuddy 里完成登录，请先在 WorkBuddy 连接后再回来' }
  }

  state.connectedConnectors[id] = { connectedAt: Date.now() }
  persistState()
  return {
    ok: true,
    id,
    connected: true,
    hasConfig: item.config !== null && item.config !== undefined &&
      typeof item.config === 'object' && Object.keys(item.config).length > 0,
    needsSetup: item.needsSetup === true,
    authMode,
    // 提示前端：MCP 工具要真正出现在宿主里，需要在 profile 配置中挂 mcp-client 实例。
    hostConfigRequired: true,
  }
}

/**
 * `GET /connectors/provision/preview?id=<id>`：生成连接前的确认预览。
 *
 * **只读**：不写 profile、不设置环境变量、不登记连接状态。片段里只有
 * `process.env.<VAR>` 变量名，绝不含凭据明文，可安全展示给用户确认。
 *
 * @param {URLSearchParams} query 查询参数
 * @returns {Record<string, any>} 预览结果
 */
function handleConnectorProvisionPreview(query) {
  const id = query !== null && typeof query.get === 'function' ? String(query.get('id') || '').trim() : ''
  if (id === '') return { ok: false, error: '缺少连接器 id' }
  if (requireIndex() === null) return busyPayload()
  const item = findConnectorItem(id)
  if (item === undefined) return { ok: false, error: '未找到该连接器：' + id }
  // 预览与真正写入必须同一口径：宿主装载不了的条目连预览都不该给，否则用户看到的是一份跑不起来的配置。
  if (item.connectable === false) {
    return { ok: false, error: '该连接器不可在面板内安装或连接：' + (item.unsupportedReason || '传输方式不受支持') }
  }
  return previewProvision(item, DSH_HOME, undefined, BASE_DIR)
}

/**
 * `POST /connectors/provision`：连接时自动写入宿主 mcp-client 配置。
 *
 * 请求体 `{ id, params: {VAR: value}, confirm: true }`。`confirm` 必须为 true，
 * 因为写入各 profile 的 cordis 补丁文件属于修改用户系统配置。
 * 值只用于写入本地加密文件（credentials.enc），绝不进入响应、state.json、日志或 prompt。
 *
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {Promise<Record<string, any>>} 响应体
 */
async function handleConnectorProvision(req) {
  let payload
  try {
    const raw = await readRawBody(req, 64 * 1024)
    payload = JSON.parse(raw.toString('utf8'))
  } catch (error) {
    return { ok: false, error: '请求体不合法：' + humanError(error) }
  }
  const id = payload !== null && typeof payload === 'object' && typeof payload.id === 'string' ? payload.id.trim() : ''
  if (id === '') return { ok: false, error: '缺少连接器 id' }
  if (payload.confirm !== true) return { ok: false, error: '需要确认后才能写入宿主 profile 配置' }

  if (requireIndex() === null) return busyPayload()
  const item = findConnectorItem(id)
  if (item === undefined) return { ok: false, error: '未找到该连接器：' + id }

  /* 不可连接的条目（cli / sse / 占位符地址）在 provision 入口也要拦住：
     写 profile 等于把宿主的 mcp-client 配置改脏 —— sse 端点会被伪造成 streamable-http、
     占位符 url 会原样写进宿主配置。放在参数校验之前，免得先报「缺少连接参数」误导用户。 */
  if (item.connectable === false) {
    return {
      ok: false,
      error: '该连接器不可在面板内安装或连接：' + (item.unsupportedReason || '传输方式不受支持'),
    }
  }

  const rawParams = payload.params !== null && typeof payload.params === 'object' &&
    !Array.isArray(payload.params) ? payload.params : {}
  const requiredParams = normalizeRequiredParams(item.requiredParams)
  /** @type {string[]} */
  const missing = []
  for (const name of requiredParams) {
    const value = rawParams[name]
    if (typeof value !== 'string' || value.trim() === '') missing.push(name)
  }
  if (missing.length > 0) return { ok: false, error: '缺少连接参数：' + missing.join('、') + '，请填写完整后再连接' }
  const authMode = normalizeAuthMode(item.authMode)
  if (isOAuthMode(authMode) && workbuddyOAuthReady(id) === false) {
    return { ok: false, error: '此连接器需在 WorkBuddy 里完成登录，请先在 WorkBuddy 连接后再回来' }
  }

  const result = provisionConnector({ item, params: rawParams, dshHome: DSH_HOME, secretDir: BASE_DIR })
  if (result.ok !== true) return result
  state.connectedConnectors[id] = { connectedAt: Date.now(), provisioned: true }
  persistState()
  return Object.assign({}, result, { connected: true, hostConfigRequired: false })
}

/**
 * 把本地已导入的专家合并到索引列表前面。
 *
 * 同一个 id 在两边都存在时做**字段级合并**，而不是整条覆盖：
 * 本地包只带 display_name / description / role.md，标签、快捷提示、职业、分类
 * 都只有仓库条目才有，直接覆盖会让卡片信息大幅降级。
 *
 * @param {Array<Record<string, any>>} indexed 索引里的条目
 * @param {'agent'|'team'} wanted 目标类型
 * @returns {Array<Record<string, any>>} 合并后的列表（本地在前）
 */
function mergeLocalExperts(indexed, wanted) {
  const local = listLocalExperts().filter((item) => item.type === wanted)
  if (local.length === 0) return indexed

  const byId = new Map(indexed.map((item) => [item.id, item]))
  const merged = local.map((entry) => {
    const base = byId.get(entry.id)
    if (base === undefined) {
      // 纯本地专家：仓库里没有同 id 条目。
      // dsh 专家包格式不存 profession，这里**保持空串**，绝不填「本地专家」这类
      // 兜底假职业——它会被前端当称号显示在标题 / 常驻 chip 上，与「本地已导入」
      // 副标题组成「本地专家 / 本地已导入」这种自相矛盾的文案。
      // 真实名字在 displayName（如「资深全栈开发工程师」），前端无称号时回落它即可。
      return Object.assign({}, entry, {
        profession: entry.profession,
      })
    }
    byId.delete(entry.id)
    const pickName =
      entry.displayName !== '' && entry.displayName !== entry.id ? entry.displayName : base.displayName
    return Object.assign({}, base, {
      // —— 只有本地包真正拥有的字段才覆盖 ——
      id: entry.id,
      type: entry.type,
      local: true,
      source: 'local',
      order: entry.order,
      // —— 其余字段：本地为空就回落仓库条目 ——
      displayName: pickName,
      displayNameEn: base.displayNameEn || entry.displayNameEn,
      profession: base.profession || entry.profession,
      description: entry.description !== '' ? entry.description : base.description,
      tags: entry.tags.length > 0 ? entry.tags : base.tags,
      quickPrompts: entry.quickPrompts.length > 0 ? entry.quickPrompts : base.quickPrompts,
      defaultInitPrompt: entry.defaultInitPrompt !== '' ? entry.defaultInitPrompt : base.defaultInitPrompt,
      categoryId: entry.categoryId !== '' ? entry.categoryId : base.categoryId,
      avatar: entry.avatar !== null ? entry.avatar : base.avatar,
      // 技能以仓库条目为准：本地 `.expert-source.json` 只存技能名（无 `./skills/` 前缀），
      // 用它会让详情抽屉里的技能路径退化。
      skills: base.skills.length > 0 ? base.skills : entry.skills,
      members: entry.members.length > 0 ? entry.members : base.members,
      teamInfo: entry.teamInfo !== null ? entry.teamInfo : base.teamInfo,
      version: base.version || entry.version,
      agentName: base.agentName || entry.agentName,
      searchText: base.searchText + ' ' + entry.searchText,
    })
  })

  return merged.concat(indexed.filter((item) => byId.has(item.id)))
}

/**
 * `/experts` 与 `/teams` 共用实现。
 * @param {URLSearchParams} query 查询参数
 * @param {'agent'|'team'} wantedType 目标类型
 * @returns {Record<string, any>} 响应载荷
 */
function handleExpertList(query, wantedType) {
  const index = requireIndex()
  if (index === null) return busyPayload()
  const wanted = wantedType === 'team' ? 'team' : 'agent'
  const keyword = normalizeQuery(query.get('q'))
  const category = normalizeQuery(query.get('category'))
  const limit = intParam(query.get('limit'), 200, 1, MAX_LIMIT)
  const offset = intParam(query.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER)

  const typed = mergeLocalExperts(index.experts.filter((item) => item.type === wanted), wanted)
  let filtered = filterByQuery(typed, keyword)
  if (category !== '') filtered = filtered.filter((item) => String(item.categoryId).toLowerCase() === category)

  return {
    ok: true,
    total: filtered.length,
    localCount: filtered.filter((item) => item.local === true).length,
    items: paginate(filtered, limit, offset).map(publicExpert),
  }
}

/**
 * `/categories`：专家分类聚合。
 * @returns {Record<string, any>} 响应载荷
 */
function handleCategories() {
  const index = requireIndex()
  if (index === null) return busyPayload()
  /** @type {Map<string, number>} */
  const buckets = new Map()
  for (const item of index.experts) {
    const id = typeof item.categoryId === 'string' && item.categoryId !== '' ? item.categoryId : 'unknown'
    buckets.set(id, (buckets.get(id) || 0) + 1)
  }
  const items = Array.from(buckets.entries())
    .map(([id, count]) => ({ id, count, label: CATEGORY_LABELS[id] || id }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  return { ok: true, items }
}

/**
 * `/skills`：技能查询，附带集合聚合。
 * @param {URLSearchParams} query 查询参数
 * @returns {Record<string, any>} 响应载荷
 */
function handleSkills(query) {
  const index = requireIndex()
  if (index === null) return busyPayload()
  if (index.hasSkills !== true) {
    return {
      ok: false,
      code: CODE_SKILLS_MISSING,
      error: '技能数据尚未同步，请点击刷新',
      total: 0,
      items: [],
      collections: [],
    }
  }
  const keyword = normalizeQuery(query.get('q'))
  const collection = String(query.get('collection') || '').trim()
  const limit = intParam(query.get('limit'), 60, 1, MAX_LIMIT)
  const offset = intParam(query.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER)

  let scoped = index.skills
  if (collection !== '') scoped = scoped.filter((item) => item.collection === collection)
  const filtered = keyword === '' ? scoped : scoped.filter((item) => matchSkill(item, keyword))

  // 集合计数按「当前过滤结果」重算，否则搜 `pdf` 时组头会显示该集合的全量数量，误导用户。
  /** @type {Map<string, number>} */
  const buckets = new Map()
  for (const item of filtered) buckets.set(item.collection, (buckets.get(item.collection) || 0) + 1)
  const collections = Array.from(buckets.entries())
    .map(([id, count]) => ({ id, count }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))

  return {
    ok: true,
    total: filtered.length,
    items: paginate(filtered, limit, offset).map(publicSkill),
    collections,
  }
}

/**
 * `GET /connectors`：连接器列表（云端仓库 + 本地已安装，按 id 合并）。
 *
 * `origin` 取值：
 *   - `all`（默认）：两个来源合并，同 id 按 local > cloud 覆盖
 *   - `installed`：只看本地已安装
 *   - `cloud`：只看资源仓库 `repo/connectors/connectors.json`
 * 历史值 `market` 已随市场概念一起删除，非法值一律按 `all` 处理。
 *
 * 每条条目同时带两层来源标记：`origin`（当前在哪被扫到）与 `source`
 * （定义从哪来：manual / cloud，装到本地后依然保留）。
 *
 * 云端 / 本地定义每次请求实时扫描，安装或卸载后立即生效，无需失效索引缓存。
 *
 * @param {URLSearchParams} query 查询参数
 * @returns {Record<string, any>} 响应载荷
 */
function handleConnectors(query) {
  if (requireIndex() === null) return busyPayload()
  const keyword = normalizeQuery(query.get('q'))
  const limit = intParam(query.get('limit'), 400, 1, MAX_LIMIT)
  const offset = intParam(query.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER)
  const origin = ['installed', 'cloud'].includes(String(query.get('origin') || '').toLowerCase())
    ? String(query.get('origin')).toLowerCase()
    : 'all'
  /* 两源合并只算一次：counts 与列表共用同一份数据，避免两套合并逻辑漂移。 */
  const merged = mergedConnectors()
  const scoped = origin === 'installed'
    ? merged.filter((item) => item.installed === true)
    : origin === 'cloud'
      ? merged.filter((item) => item.origin === 'cloud')
      : merged
  const filtered = filterByQuery(scoped, keyword)
  return {
    ok: true,
    origin,
    total: filtered.length,
    items: paginate(filtered, limit, offset).map(publicConnector),
    counts: countConnectorSources(merged),
  }
}

/**
 * 把「已扫好的云端结果」与本地定义合并成对外条目。
 *
 * 单独抽出来是为了让 `/status` 只解析一次仓库 JSON：它既要条数又要被跳过的清单，
 * 若分别调用 `mergedConnectors()` 和 `listCloudDefinitionsWithSkipped()` 会把
 * 同一份（约 500KB）文件解析两遍。
 *
 * @param {{ defs: Array<Record<string, any>>, skipped: Array<Record<string, string>> }} cloudScan 云端扫描结果
 * @returns {Array<Record<string, any>>} 条目列表
 */
function mergeConnectorItems(cloudScan) {
  const merged = mergeConnectorSources(
    listLocalDefinitions(BASE_DIR),
    cloudScan.defs,
    new Set(Object.keys(state.connectedConnectors)),
  )
  const readyIds = readWorkbuddyReadyIds()
  return merged.map((item) => Object.assign(item, {
    oauthReady: item.needsSetup === true && isOAuthMode(item.authMode)
      ? workbuddyOAuthReady(item.id, readyIds)
      : false,
  }))
}

/**
 * 本地资料库模式下的连接器条目：只取导出包里的快照，绝不扫旧数据根。
 *
 * 导出包是 `publicConnector()` 的产物，字段形状与合并结果一致；这里补齐
 * `searchText` / `connectable` / `oauthReady` 等运行时字段，让 `/connectors`、
 * `/status`、`/detail`、`/export` 四处口径完全统一。
 * 连接状态是本机概念，按 id 从 `state.connectedConnectors` 现算，不信包里的值。
 *
 * @returns {Array<Record<string, any>>} 条目列表
 */
function libraryConnectorItems() {
  const index = state.index !== null ? state.index : loadIndexCache()
  const snapshot = index !== null && Array.isArray(index.libraryConnectors)
    ? index.libraryConnectors
    : []
  const connected = new Set(Object.keys(state.connectedConnectors))
  const readyIds = readWorkbuddyReadyIds()
  return snapshot.map((raw) => {
    const item = Object.assign({}, raw)
    item.searchText = [item.id, item.name, item.description, item.author]
      .filter((part) => typeof part === 'string')
      .join(' ')
      .toLowerCase()
    item.connectable = item.connectable !== false
    item.unsupportedReason = typeof item.unsupportedReason === 'string' ? item.unsupportedReason : ''
    item.installed = item.installed === true
    item.origin = typeof item.origin === 'string' && item.origin !== '' ? item.origin : 'cloud'
    item.source = typeof item.source === 'string' && item.source !== '' ? item.source : 'cloud'
    item.connected = connected.has(item.id)
    item.oauthReady = item.needsSetup === true && isOAuthMode(item.authMode)
      ? workbuddyOAuthReady(item.id, readyIds)
      : false
    return item
  })
}

/**
 * 当前合并后的连接器条目。
 *
 * 常规模式：云端仓库 + 本地已安装，两源实时扫盘，不走索引。
 * 本地资料库模式：改用 bundle 快照（见 {@link libraryConnectorItems}），
 * 避免「专家来自 bundle、连接器来自旧仓库」的新旧混算。
 *
 * `oauthReady` 按本机 WorkBuddy 的布尔登录态现算（只读 bound / everConnected，
 * 不碰任何凭据文件），云端条目与本地条目一视同仁。
 *
 * @returns {Array<Record<string, any>>} 条目列表
 */
function mergedConnectors() {
  if (state.library !== null) return libraryConnectorItems()
  const root = dataRoot()
  return mergeConnectorItems(listCloudDefinitionsWithSkipped(root === null ? '' : root))
}

/**
 * 按 id 取连接器条目：**必须查两源合并结果**，不能只查索引。
 *
 * 索引里已经没有连接器数据；手动新增（manual）与从云端安装（cloud）的连接器只存在于
 * 本地定义目录，云端条目只存在于资源仓库清单里，只查索引会让它们「详情显示未安装、点连接报未找到」。
 *
 * @param {string} id 连接器 id
 * @returns {Record<string, any>|undefined} 条目（带 origin / source / installed / file）
 */
function findConnectorItem(id) {
  return mergedConnectors().find((item) => item.id === id)
}

/**
 * `POST /connectors/install`：把资源仓库里的连接器定义安装到本地。
 *
 * 只保存定义（不写 profile、不保存凭据）；连接是后续独立一步。
 *
 * 安全：`id` 在这里只做「非空 / 长度 / 无 NUL」的轻校验 —— 它可以是云端定义文件
 * 自报的任意 id（历史数据里存在 `../escaped-one` 这种脏值）。
 * **真正拦住路径穿越的是存储层**：{@link saveLocalDefinition} 用 `diskNameOfId()`
 * 把 id 净化为单段目录名并校验最终路径在 `connectors/` 之内，
 * 所以脏 id 只会得到一个合法目录名，条目依然会被扫描到、不会「装完就消失」。
 *
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {Promise<Record<string, any>>} 响应体
 */
async function handleConnectorInstall(req) {
  let payload
  try {
    const raw = await readRawBody(req, 64 * 1024)
    payload = JSON.parse(raw.toString('utf8'))
  } catch (error) {
    return { ok: false, error: '请求体不合法：' + humanError(error) }
  }
  const id = payload !== null && typeof payload === 'object' && typeof payload.id === 'string' ? payload.id.trim() : ''
  if (id === '') return { ok: false, error: '缺少连接器 id' }
  if (id.length > 200 || id.includes('\0')) return { ok: false, error: '非法的连接器 id：' + id }
  const index = requireIndex()
  if (index === null) return busyPayload()

  const found = mergedConnectors().find((item) => item.id === id)
  if (found === undefined) return { ok: false, error: '未找到该连接器：' + id }
  if (found.installed === true) return { ok: true, id, installed: true, already: true }
  /* 列表是全量的（cli / sse / 占位符地址也在里面），但这些条目装到本地也用不了，
     必须在入口就拦住并说明原因，不能让它落到「装成功但一点连接就报错」。 */
  if (found.connectable === false) {
    return {
      ok: false,
      error: '该连接器不可在面板内安装或连接：' + (found.unsupportedReason || '传输方式不受支持'),
    }
  }

  /* 能安装的条目只可能来自云端（未安装 ⇒ origin=cloud），来源固定写 cloud。 */
  const defResult = definitionFromItem(found, 'cloud')
  if (defResult.ok !== true) return { ok: false, error: defResult.error }
  const saved = saveLocalDefinition(BASE_DIR, defResult.def)
  if (saved.ok !== true) return { ok: false, error: saved.error }
  return {
    ok: true,
    id,
    installed: true,
    file: saved.file,
    item: publicConnector(definitionToItem(defResult.def)),
  }
}

/**
 * `POST /connectors/create`：手动新增一个连接器（保存为本地安装）。
 *
 * 入参即定义：`{ name, description?, transport, url? | command?/args?/env?, headers?, requiredParams? }`。
 * id 由名称派生，冲突时自动加序号。只做格式校验，不发起任何网络请求。
 *
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {Promise<Record<string, any>>} 响应体
 */
async function handleConnectorCreate(req) {
  let payload
  try {
    const raw = await readRawBody(req, 128 * 1024)
    payload = JSON.parse(raw.toString('utf8'))
  } catch (error) {
    return { ok: false, error: '请求体不合法：' + humanError(error) }
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { ok: false, error: '请求体必须是对象' }
  }
  const index = requireIndex()
  if (index === null) return busyPayload()
  const existing = mergedConnectors().map((item) => item.id)
  const id = makeIdFromName(String(payload.name || ''), existing)
  const result = normalizeDefinition(payload, { id, source: 'manual', origin: '' })
  if (result.ok !== true) return { ok: false, error: result.error }
  const saved = saveLocalDefinition(BASE_DIR, result.def)
  if (saved.ok !== true) return { ok: false, error: saved.error }
  return {
    ok: true,
    id: result.def.id,
    installed: true,
    file: saved.file,
    item: publicConnector(definitionToItem(result.def)),
  }
}

/**
 * `POST /connectors/uninstall`：卸载本地定义，并断开该连接器的连接登记。
 *
 * 不会自动改用户 profile：已写入的 `mcp-client` 条目需要用户自行删除，
 * 或重新连接时覆盖（响应里给出提示）。
 *
 * 定义删除成功后还会按具体 id 清掉所有会话中该连接器的挂载与注入的 system prompt
 * （`detachConnectorEverywhere`），避免「卸载完上下文还在」；`detachedSessions`
 * 回报实际清理的会话数，`detachNote` 给出中文说明。
 *
 * 安全：`id` 必须通过 {@link safeId} 白名单（与 `/attach`、`/icon` 同一套规则），
 * 否则 400 拒绝 —— 历史上 `id: "../../victim"` 能删掉 `$DSH_HOME` 下的任意目录。
 *
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {Promise<Record<string, any>>} 响应体
 */
async function handleConnectorUninstall(req) {
  let payload
  try {
    const raw = await readRawBody(req, 64 * 1024)
    payload = JSON.parse(raw.toString('utf8'))
  } catch (error) {
    return { ok: false, error: '请求体不合法：' + humanError(error) }
  }
  const rawId = payload !== null && typeof payload === 'object' && typeof payload.id === 'string' ? payload.id.trim() : ''
  if (rawId === '') return { ok: false, error: '缺少连接器 id' }
  const id = safeId(rawId)
  if (id === null) return { ok: false, error: '非法的连接器 id：' + rawId }
  const removed = removeLocalDefinition(BASE_DIR, id)
  if (removed.ok !== true) return { ok: false, error: removed.error }
  // 定义已删除：所有会话里该连接器注入的 system prompt 区块必须同步撤掉，
  // 否则面板卸载后对话上下文仍残留（用户报的核心症状）。只按具体 id 拆，不动其它连接器。
  const detachedSessions = detachConnectorEverywhere(id)
  const wasConnected = state.connectedConnectors[id] !== undefined
  if (wasConnected) {
    delete state.connectedConnectors[id]
    persistState()
  }
  return {
    ok: true,
    id,
    installed: false,
    removed: removed.removed,
    disconnected: wasConnected,
    detachedSessions,
    detachNote: detachedSessions > 0
      ? '已清理 ' + String(detachedSessions) + ' 个会话中该连接器注入的上下文'
      : '该连接器当前没有会话挂载，无需清理上下文',
    note: wasConnected ? '已断开连接登记；宿主 profile 里的 mcp-client 条目未自动删除，需手动移除或重新连接覆盖' : '',
  }
}

/**
 * `/pick`：给 composer 选择器用的轻量候选列表。
 *
 * 与 `/experts` `/skills` 等列表接口的区别：
 *  - 四类分组一次性返回，前端不用并发打 4 个请求；
 *  - 每组只给少量条目（空查询 8 条 / 有查询 20 条），技能有数千条，过滤必须在服务端做；
 *  - 必须走索引缓存，键盘每敲一下就重建索引是不可接受的。
 *
 * @param {URLSearchParams} query 查询参数
 * @returns {Record<string, any>} 响应载荷
 */
function handlePick(query) {
  const index = requireIndex()
  if (index === null) return busyPayload()
  const keyword = normalizeQuery(query.get('q'))
  const fallbackLimit = keyword === '' ? PICK_LIMIT_IDLE : PICK_LIMIT_QUERY
  const limit = intParam(query.get('limit'), fallbackLimit, 1, 50)
  /* 选择器从「专家按钮」进入时只要已安装的东西：`installed=1`（`scope=installed` 等价写法）。
     过滤在服务端做 —— 技能有数千条，前端过滤既慢又多一次全量下发。 */
  const installedOnly = query.get('installed') === '1' || query.get('scope') === 'installed'

  /**
   * 专家 / 团队的展示名：与详情标题一致（职业在前、人名在后）。
   * @param {Record<string, any>} item 条目
   * @returns {string} 展示名
   */
  const expertName = (item) => {
    const name = tidy(item.displayName || item.name || item.id, 80) || tidy(item.id, 80)
    const profession = tidy(item.profession || '', 60)
    if (profession === '' || profession === name) return name
    if (profession === '本地专家' || profession === '本地已导入') return name
    return profession + ' | ' + name
  }

  /**
   * 组装单个分组。
   * 头像：仓库专家返回索引里的相对路径；本地已导入专家用 `local:<id>`
   * 走 /local-avatar 资产链；没有头像资产时返回空串，由前端按名字 hash
   * 生成确定性彩色字母圆（不伪造品牌图标）。
   * @param {'agent'|'team'|'skill'|'connector'} kind 类型
   * @param {string} title 分组标题
   * @param {Array<Record<string, any>>} filtered 已过滤的全量条目
   * @param {(item: Record<string, any>) => string} nameOf 取名字
   * @param {(item: Record<string, any>) => string} descOf 取描述
   * @returns {Record<string, any>} 分组
   */
  const group = (kind, title, filtered, nameOf, descOf) => ({
    kind,
    title,
    total: filtered.length,
    items: filtered.slice(0, limit).map((item) => {
      const base = {
        id: item.id,
        name: nameOf(item),
        desc: clipText(descOf(item), PICK_DESC_LIMIT),
        avatar: kind === 'agent' || kind === 'team' ? expertAvatarOf(item) : '',
        profession: kind === 'agent' || kind === 'team' ? expertProfessionOf(item) : '',
      }
      /* 技能条目额外下发 dir / enabled：前端 `choose()` 直接用 dir 作宿主原生技能名，
         不必再拉一次 /skills/installed 二次解析（老响应没有这两个字段时前端仍有兜底）。 */
      if (kind === 'skill') {
        return Object.assign(base, {
          dir: typeof item.dir === 'string' ? item.dir : '',
          enabled: item.enabled !== false,
        })
      }
      if (kind !== 'connector') return base
      // 选择器与列表页共用一套连接状态机：把判定字段与「是否已连接」一并下发，
      // 前端无需再发额外请求，也不会在需认证连接器上误走 /attach。
      return Object.assign(base, {
        needsSetup: item.needsSetup === true,
        authMode: normalizeAuthMode(item.authMode),
        requiredParams: normalizeRequiredParams(item.requiredParams),
        optionalParams: normalizeRequiredParams(item.optionalParams),
        paramFields: normalizeParamFields(
          item.paramFields,
          normalizeRequiredParams(item.requiredParams),
          normalizeRequiredParams(item.optionalParams),
        ),
        setupSchema: item.setupSchema !== null && typeof item.setupSchema === 'object'
          ? normalizeSetupSchema(item.setupSchema) : null,
        oauthReady: item.oauthReady === true,
        connected: state.connectedConnectors[item.id] !== undefined,
      })
    }),
  })

  /**
   * 专家 / 团队条目是否已安装（本地导入）。
   * mergeLocalExperts 会给本地条目打 `local: true`；兼容旧数据里的 `source === 'local'`。
   * @param {Record<string, any>} item 条目
   * @returns {boolean} 是否已安装
   */
  const isInstalledExpert = (item) => item.local === true || item.source === 'local'

  /**
   * 连接器条目是否已安装：本地定义 `origin === 'local'`，或条目自带 `installed === true`。
   * @param {Record<string, any>} item 条目
   * @returns {boolean} 是否已安装
   */
  const isInstalledConnector = (item) => item.origin === 'local' || item.installed === true

  /**
   * 构造「已安装技能」索引（小写键 → 命中记录）。
   *
   * 数据源与 handleInstalledSkills 完全一致（listSkillDirs + readSkillMeta），
   * 因此面板看到的「已安装」与「已安装技能」页永远一致；内置开关装进来的那批
   * 由 hiddenSkillDirs 排除 —— 用户界面不可见，面板里也不该能选到。
   * @returns {Map<string, { dir: string, enabled: boolean }>} 索引
   */
  const buildInstalledSkillIndex = () => {
    /** @type {Map<string, { dir: string, enabled: boolean }>} */
    const map = new Map()
    const hidden = hiddenSkillDirs()
    for (const enabled of [true, false]) {
      const root = enabled ? SKILLS_INSTALL_DIR : SKILLS_DISABLED_DIR
      for (const dir of listSkillDirs(root)) {
        if (hidden.has(dir)) continue
        const abs = path.join(root, dir)
        const meta = readSkillMeta(abs)
        if (meta === null) continue
        const record = { dir, enabled }
        // 先扫 skills/ 再扫 skills-disabled/：同名冲突时以「开启中」的那条为准。
        if (!map.has(dir.toLowerCase())) map.set(dir.toLowerCase(), record)
        if (!map.has(meta.name.toLowerCase())) map.set(meta.name.toLowerCase(), record)
        const marketMeta = readJsonSafe(path.join(abs, '_meta.json'))
        const slug = marketMeta !== null && typeof marketMeta.slug === 'string'
          ? marketMeta.slug.trim().toLowerCase() : ''
        if (slug !== '' && !map.has(slug)) map.set(slug, record)
      }
    }
    return map
  }

  /**
   * 取仓库技能条目在本地技能库里的命中记录。
   *
   * 仓库技能条目只有 `id`（相对路径）/ `name` / `slug`，没有本地目录名，因此按
   * **落地目录名 / frontmatter name / SkillHub slug**，外加 `id` 末段（仓库目录名）
   * 四个键做大小写不敏感匹配 —— 任一命中即视为已安装。
   * @param {Map<string, { dir: string, enabled: boolean }>} map 已安装技能索引
   * @param {Record<string, any>} item 仓库技能条目
   * @returns {{ dir: string, enabled: boolean }|null} 命中记录；未安装返回 null
   */
  const installedSkillHit = (map, item) => {
    const keys = []
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    keys.push(id)
    if (id !== '') {
      const segments = id.split(/[\\/]+/).filter((seg) => seg !== '')
      if (segments.length > 0) keys.push(segments[segments.length - 1])
    }
    if (typeof item.name === 'string') keys.push(item.name.trim())
    if (typeof item.slug === 'string') keys.push(item.slug.trim())
    if (typeof item.dir === 'string') keys.push(item.dir.trim())
    for (const key of keys) {
      if (key === '') continue
      const hit = map.get(key.toLowerCase())
      if (hit !== undefined) return hit
    }
    return null
  }

  /* 已安装过滤用到的三套判据（只在 installedOnly 时计算，避免多余 IO）：
     专家/团队看 `local === true || source === 'local'`（mergeLocalExperts 会给本地条目打 local）；
     连接器看 `origin === 'local' || installed === true`；
     技能看本地技能库目录（与 /skills/installed 同一套，且排除内置开关装的那批）。 */
  const installedSkillMap = installedOnly ? buildInstalledSkillIndex() : new Map()

  const agents = mergeLocalExperts(index.experts.filter((item) => item.type !== 'team'), 'agent')
  const teams = mergeLocalExperts(index.experts.filter((item) => item.type === 'team'), 'team')
  const agentsVisible = installedOnly ? agents.filter(isInstalledExpert) : agents
  const teamsVisible = installedOnly ? teams.filter(isInstalledExpert) : teams
  const skills = index.hasSkills === true ? index.skills : []
  /* 技能先按「已安装」筛，再按关键词筛；过滤后逐条挂上 dir / enabled
     （未安装的条目在 installedOnly 下已不存在，这里只服务已安装的那些）。 */
  const skillsScoped = []
  for (const item of skills) {
    if (!installedOnly) {
      skillsScoped.push(item)
      continue
    }
    const hit = installedSkillHit(installedSkillMap, item)
    if (hit === null) continue
    skillsScoped.push(Object.assign({}, item, { dir: hit.dir, enabled: hit.enabled }))
  }
  const skillsFiltered = keyword === '' ? skillsScoped : skillsScoped.filter((item) => matchSkill(item, keyword))
  const connectorsAll = mergedConnectors()
  const connectorsVisible = installedOnly ? connectorsAll.filter(isInstalledConnector) : connectorsAll

  return {
    ok: true,
    keyword,
    installedOnly,
    groups: [
      group('agent', '专家', filterByQuery(agentsVisible, keyword), expertName, (item) => tidy(item.description || '', 600)),
      group('team', '专家团', filterByQuery(teamsVisible, keyword), expertName, (item) => tidy(item.description || '', 600)),
      group('skill', '技能', skillsFiltered, (item) => tidy(item.name || item.id, 80), (item) => tidy(item.description || '', 600)),
      group('connector', '连接器', filterByQuery(connectorsVisible, keyword), (item) => tidy(item.name || item.id, 80), (item) => tidy(item.description || '', 600)),
    ],
  }
}

/**
 * 读取专家正文：优先 agent markdown，再回落 README.md。
 * @param {string} expertId 专家目录名
 * @returns {string} 截断后的正文
 */
function readExpertReadme(expertId) {
  const base = dataRoot()
  if (base === null) return ''
  const expertDir = path.join(base, 'experts', expertId)
  const plugin = readJsonSafe(path.join(expertDir, '.codebuddy-plugin', 'plugin.json'))
  /** @type {string[]} */
  const candidates = []
  if (plugin !== null && Array.isArray(plugin.agents)) {
    for (const rel of plugin.agents) {
      if (typeof rel === 'string' && rel.trim() !== '') candidates.push(rel)
    }
  }
  candidates.push('README.md')

  for (const rel of candidates) {
    const absolute = path.resolve(expertDir, rel)
    const prefix = path.resolve(expertDir) + path.sep
    if (!absolute.startsWith(prefix)) continue
    const text = readTextSafe(absolute)
    if (text !== null) return stripFrontmatter(text).trim().slice(0, README_LIMIT)
  }
  return ''
}

/**
 * 取路径最后一段（兼容 / 与 \ 分隔，自动去尾部斜杠）。
 * @param {string} value 路径或引用
 * @returns {string} 最后一段
 */
function lastPathSegment(value) {
  return String(value).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
}

/**
 * 实时解析专家声明的技能引用（`/detail` 请求时计算，不进缓存 ——
 * 因为「从仓库获取」落盘后状态会从 repo 变 local，缓存会让状态失真）。
 *
 * 每条 ref 独立判定，优先级 local > repo > missing：
 *  1. local：`~/.dsh/experts/<id>/<ref>/SKILL.md` 存在（必须含 SKILL.md）；
 *  2. repo：技能索引里按 basename（大小写不敏感）命中任一条目，取第一个；
 *  3. 都没有 → missing。library 模式本地目录不存在，统一走 repo 匹配。
 *
 * @param {Record<string, any>} item 专家 / 团队条目
 * @param {any} index 当前索引
 * @returns {Array<Record<string, any>>} skillDetails 数组
 */
function resolveSkillDetails(item, index) {
  const refs = Array.isArray(item.skills) ? item.skills : []
  /** @type {Array<Record<string, any>>} */
  const out = []
  if (refs.length === 0) return out
  const localDir = path.resolve(LOCAL_EXPERTS_DIR, item.id)
  const skills = Array.isArray(index.skills) ? index.skills : []
  for (const raw of refs) {
    const ref = String(raw).trim()
    if (ref === '') continue
    const base = lastPathSegment(ref).toLowerCase()
    /** @type {Record<string, any>} */
    const detail = { ref, name: lastPathSegment(ref), status: 'missing' }
    // 1) local：防目录穿越后检查 SKILL.md。
    //    团队型专家的 skills 是裸名（如 forge-orchestrator，无 ./skills/ 前缀），
    //    需要同时试 localDir/<ref> 与 localDir/skills/<ref>，否则团队技能永远灰。
    /** @type {string[]} */
    const localCandidates = [path.resolve(localDir, ref)]
    if (!ref.includes('/') && !ref.includes('\\')) {
      localCandidates.push(path.resolve(localDir, 'skills', ref))
    }
    for (const localSkillDir of localCandidates) {
      if (localSkillDir === localDir || !localSkillDir.startsWith(localDir + path.sep)) continue
      const localSkillFile = path.join(localSkillDir, 'SKILL.md')
      if (isFile(localSkillFile)) {
        detail.status = 'local'
        detail.localPath = localSkillFile
        break
      }
    }
    if (detail.status === 'local') {
      out.push(detail)
      continue
    }
    // 2) repo：按 basename 大小写不敏感匹配，取第一个命中
    let matched = null
    for (const entry of skills) {
      if (lastPathSegment(entry.id).toLowerCase() === base) {
        matched = entry
        break
      }
    }
    if (matched !== null) {
      detail.status = 'repo'
      detail.repoId = lastPathSegment(matched.id)
      detail.repoCollection = typeof matched.collection === 'string' ? matched.collection : ''
      detail.repoPath = typeof matched.path === 'string' ? matched.path : ''
    }
    out.push(detail)
  }
  return out
}

/**
 * `/skills/fetch`：把专家声明的仓库技能落盘到专家本地目录。
 * body: { expertId, ref }
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {Promise<Record<string, any>>} 响应载荷
 */
async function handleSkillFetch(req) {
  const index = requireIndex()
  if (index === null) return busyPayload()

  let payload
  try {
    const raw = await readRequestBody(req)
    payload = JSON.parse(raw === '' ? '{}' : raw)
  } catch {
    return { ok: false, error: '请求体不是合法 JSON' }
  }
  if (payload === null || typeof payload !== 'object') return { ok: false, error: '请求体格式错误' }

  const id = safeId(typeof payload.expertId === 'string' ? payload.expertId : '')
  if (id === null) return { ok: false, error: '非法专家 id' }
  const ref = String(payload.ref || '').trim()
  if (ref === '') return { ok: false, error: '缺少 ref 参数' }

  let item = mergeLocalExperts(index.experts, 'agent').find((entry) => entry.id === id)
  if (item === undefined) item = mergeLocalExperts(index.experts, 'team').find((entry) => entry.id === id)
  if (item === undefined) return { ok: false, error: '未找到该专家：' + id }

  const declared = Array.isArray(item.skills) ? item.skills.map((value) => String(value).trim()) : []
  if (!declared.includes(ref)) return { ok: false, error: '该专家未声明此技能引用：' + ref }

  const entry = resolveSkillDetails(item, index).find((detail) => detail.ref === ref)
  if (entry === undefined) return { ok: false, error: '该专家未声明此技能引用：' + ref }
  if (entry.status === 'missing') return { ok: false, error: '仓库中找不到该技能：' + ref }
  if (entry.status === 'local') return { ok: true, localPath: entry.localPath, already: true }

  if (index.hasSkills !== true || !Array.isArray(index.skills) || index.skills.length === 0) {
    return { ok: false, error: '技能仓库未同步，请先在技能页同步' }
  }
  const source = safeRepoPath(entry.repoPath)
  if (source === null) return { ok: false, error: '仓库中找不到该技能：' + ref }
  const text = readTextSafe(source)
  if (text === null) return { ok: false, error: '仓库中找不到该技能：' + ref }

  const targetDir = path.resolve(LOCAL_EXPERTS_DIR, id)
  const skillDir = path.resolve(targetDir, ref)
  if (skillDir !== targetDir && !skillDir.startsWith(targetDir + path.sep)) {
    return { ok: false, error: '非法的技能引用路径' }
  }
  try {
    fs.mkdirSync(skillDir, { recursive: true })
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), text, 'utf8')
  } catch (error) {
    return { ok: false, error: '写入本地技能目录失败：' + humanError(error) }
  }
    return { ok: true, localPath: path.join(skillDir, 'SKILL.md') }
}

// ---------------------------------------------------------------------------
// 专家技能按需挂载（原生 runtime skill，agent 作用域渐进式披露）
// ---------------------------------------------------------------------------

/** 已挂载的专家技能：sessionId -> Map<expertId, { name, dispose, promptDispose, meta }>。 */
const attachedExperts = new Map()

/**
 * 已挂载的连接器：sessionId -> Map<connectorId, { name, dispose, meta }>。
 * 与专家注册表完全独立：挂/拆连接器不得清专家，也不得清其他连接器（可多选）。
 */
const attachedConnectors = new Map()

/** agent 尚未创建时的待挂载：sessionId -> Map<expertId, true>。 */
const pendingAttaches = new Map()

/** agent 尚未创建时的待挂连接器：sessionId -> Map<connectorId, { name, meta, item }>。 */
const pendingConnectors = new Map()

/** 当前插件宿主上下文（apply 时捕获，供 attach/detach 取 agents/skills 服务）。 */
let hostCtx = null

/** sessionId 合法格式（防任意字符串写全局注册表）。 */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

/**
 * 专家头像资产路径：仓库相对路径优先，本地已导入回落 `local:<id>`，
 * 都没有返回空串（由前端显示统一中性占位，不按名字生成图标）。
 * @param {Record<string, any>} item 专家条目
 * @returns {string} 头像路径或空串
 */
function expertAvatarOf(item) {
  if (typeof item.avatar === 'string' && item.avatar !== '') return item.avatar
  return item.local === true ? 'local:' + item.id : ''
}

/** 历史兜底假职业：不是真实称号，绝不能当标题/常驻 chip 文案。 */
const FAKE_PROFESSION_VALUES = new Set(['本地专家', '本地已导入', '未分类', 'unknown', 'agent', 'team'])

/**
 * 专家称号（职业）：占位值、空值一律返回空串，由前端回落到真实名字。
 * @param {Record<string, any>} item 专家条目
 * @returns {string} 称号
 */
function expertProfessionOf(item) {
  const value = tidy(typeof item.profession === 'string' ? item.profession : '', 60)
  if (value === '' || FAKE_PROFESSION_VALUES.has(value.toLowerCase())) return ''
  return value
}

/**
 * 软取宿主服务；缺失（未加载对应插件）返回 null，绝不让插件崩溃。
 * @param {string} name 服务名（agents / skills）
 * @returns {any|null} 服务实例或 null
 */
function hostService(name) {
  if (hostCtx === null) return null
  try {
    const svc = hostCtx[name]
    return svc === undefined || svc === null ? null : svc
  } catch {
    return null
  }
}

/**
 * 把专家 id 变成 kebab-case ASCII slug（宿主技能名语法 [a-z0-9-]+）。
 * @param {string} id 专家 id
 * @returns {string} slug；全非法字符时回落 'expert'
 */
function slugifyExpertId(id) {
  const slug = String(id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  return slug === '' ? 'expert' : slug
}

/**
 * 组装一个专家的 runtime skill 定义（一个专家一条，不按技能拆）。
 * @param {Record<string, any>} item 专家 / 团队条目
 * @param {string} skillName 已消解冲突的技能名
 * @returns {{ def: Record<string, any>, dir: string }|null} 定义与资源目录；专家目录不存在返回 null
 */
function expertSkillDef(item, skillName) {
  const displayName = tidy(item.displayName || item.name || item.id, 80) || item.id
  const localDir = path.join(LOCAL_EXPERTS_DIR, item.id)
  const repoDir = dataRoot() === null ? null : path.join(dataRoot(), 'experts', item.id)
  const dir = isDir(localDir) ? localDir : repoDir !== null && isDir(repoDir) ? repoDir : null
  if (dir === null) return null
  const description = tidy(displayName + '。' + (item.description || ''), 500)
  return {
    def: {
      name: skillName,
      description: description.length > 500 ? description.slice(0, 500) : description,
      // 指针式 content：宿主不校验正文；模型按需读取目录内资源。
      // 文案不点名具体文件——本地单专家（role.md）、本地团队（role.md + members/）、
      // 仓库源（agents/*.md，无 role.md）三种布局并存，点名任何一种都会对另两种失真；
      // 让模型先 glob 实际结构再按需读取，代价是一次几毫秒的工具调用。
      content:
        '这是专家「' + displayName + '」的资料目录，包含角色说明、成员说明与技能。先列出目录实际结构（glob 或 ls），再按需读取相关文件，不要一次全读，也不要假设某个文件一定存在。',
      resourceBase: { kind: 'directory', path: dir },
      source: 'dsh-buddy-expert-hub',
      invocation: { modelInvocable: true, userInvocable: true },
    },
    dir,
  }
}

/**
 * 在指定 agent 上注册专家技能（agent 作用域 runtime skill）。
 *
 * 跨 layer 解析是「最近作用域无条件赢」（collectFresh 逐层 merged.set 后写覆盖），
 * 我们会静默遮蔽用户的项目级同名技能 —— 所以注册前必须查重：
 * 目标名已被任何来源占用（用户技能/宿主技能/其他专家）→ 自动加 -2/-3 后缀，
 * 绝不覆盖，并在响应里注明改名。同层 first-wins 静默忽略没有返回信号，
 * 注册后再复核一次，被忽略时以 warning 回报（不静默）。
 *
 * skills 服务用运行时 agent.ctx.inject 软取：未装 dsh-skill 的环境注入失败 → 501。
 * @param {any} agent 宿主 agent（须带 agent.ctx）
 * @param {Record<string, any>} def 技能定义
 * @returns {Promise<{ ok: boolean, name?: string, warning?: string, dispose?: Function, error?: string }>}
 */
function registerOnAgent(agent, def) {
  return new Promise((resolve) => {
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const timer = setTimeout(() => done({ ok: false, error: '技能服务注入超时' }), 8000)
    const finish = (value) => {
      clearTimeout(timer)
      done(value)
    }
    let fiber
    try {
      fiber = agent.ctx.inject(['skills'], async (scope) => {
        try {
          // 注册前查重：agent 视角（global + agent 链）里任何来源占用目标名都不覆盖。
          let name = def.name
          let renamed = false
          try {
            const existing = await scope.skills.list({ scope: agent })
            const taken = new Set(existing.map((entry) => entry.name))
            if (taken.has(name)) {
              const base = name
              for (let n = 2; taken.has(name); n += 1) name = base + '-' + String(n)
              renamed = true
            }
          } catch {
            // 查重失败不阻断注册（宿主 list 异常时退化为直接注册）
          }
          const regDispose = scope.skills.register(Object.assign({}, def, { name }))
          // 注册后复核：被宿主 first-wins 静默忽略时目录里不会有我们的条目。
          let ignored = false
          try {
            const after = await scope.skills.list({ scope: agent })
            ignored = !after.some((entry) => entry.name === name)
          } catch {
            // 复核失败视为未忽略
          }
          if (ignored) {
            finish({ ok: true, name, warning: '同名技能已存在，本次注册被宿主忽略（dsh-buddy-expert-hub 未生效）' })
            return
          }
          finish({
            ok: true,
            name,
            warning: renamed ? '与现有技能重名，已改用 ' + name : undefined,
            dispose: () => {
              try {
                regDispose()
              } catch {
                // 已被 agent disposal 回收
              }
              try {
                fiber.dispose()
              } catch {
                // 同上
              }
            },
          })
        } catch (error) {
          finish({ ok: false, error: humanError(error) })
        }
      })
    } catch (error) {
      finish({ ok: false, error: humanError(error) })
    }
  })
}

/**
 * 组装专家会话常驻的 system prompt 区块（服务端构造，客户端不再拼文本）。
 *
 * 身份（README ≤6000 字）常驻 system prompt，每轮自动生效、用户不可见；
 * 技能正文不进 prompt，继续走 runtime skill 按需加载（两层分工）。
 * @param {Record<string, any>} item 专家条目
 * @param {string} skillName 实际注册的 runtime skill 名（可能带 -2 后缀）
 * @returns {string} 区块文本
 */
function expertPromptBlock(item, skillName) {
  const displayName = tidy(item.displayName || item.name || item.id, 80) || item.id
  const description = tidy(item.description || '', 300)
  let readme = ''
  try {
    readme = item.local === true ? readTextSafe(path.join(LOCAL_EXPERTS_DIR, item.id, 'role.md')) || '' : readExpertFullReadme(item.id)
    readme = stripFrontmatter(readme).trim()
  } catch {
    readme = ''
  }
  const skillsDir = (() => {
    // 索引条目不带 skillsDir（/detail 侧才计算）——这里按同一探测口径现算，
    // 三分支都有 isDir，目录不存在时返回空（指针行不输出，绝不指到不存在路径）。
    if (typeof item.skillsDir === 'string' && item.skillsDir !== '') return item.skillsDir
    const localSkills = path.join(LOCAL_EXPERTS_DIR, item.id, 'skills')
    const repoSkills = dataRoot() === null ? null : path.join(dataRoot(), 'experts', item.id, 'skills')
    if (isDir(localSkills)) return localSkills
    if (repoSkills !== null && isDir(repoSkills)) return repoSkills
    return ''
  })()
  let block = '<dsh-buddy-expert-hub type="' + (item.type === 'team' ? 'team' : 'agent') + '" id="' + item.id + '" name="' + displayName + '">\n'
  if (description !== '') block += '<description>' + description + '</description>\n'
  block += '<instructions>\n' + readme.slice(0, 6000) + '\n</instructions>\n'
  block += '你是该专家本体：请以「' + displayName + '」的角色与口吻回答，并遵循上述说明；本设定对本会话每条消息生效。\n'
  if (skillsDir !== '') {
    block += '<skills location="' + skillsDir + '">\n'
    block += '该专家的技能在此目录；需要时先列出目录结构，再用 read / glob 读取对应技能的 SKILL.md，不要凭猜测使用。\n'
    block += '</skills>\n'
  }
  block += '已为本会话注册专家技能 ' + skillName + '；需要时模型会通过 skill 工具加载角色与技能。\n'
  block += '</dsh-buddy-expert-hub>'
  return block
}

/**
 * 组装连接器会话常驻的 system prompt 区块（服务端构造）。
 *
 * 与专家一致：身份与 MCP 配置常驻 system prompt，每轮自动生效、用户不可见；
 * 语义独立——`<mcp-config>` 只放该连接器自身配置，config 为空时整段省略，
 * 绝不输出 `{}` 这类无意义占位（CLI 连接器常见 config=null）。
 * @param {Record<string, any>} item 连接器索引条目
 * @returns {string} 区块文本
 */
function connectorPromptBlock(item) {
  const id = String(item.id || '')
  const displayName = tidy(item.displayName || item.name || id, 80) || id
  const rawDescription = tidy(item.description || '', 300)
  // YAML 块标符残留（| / >- / >）说明描述解析失败，与前端口径一致当空处理。
  const description = /^[|>][-+]?\d*$/.test(rawDescription) ? '' : rawDescription
  let block = '<dsh-buddy-expert-hub type="connector" id="' + id + '" name="' + displayName + '">\n'
  if (description !== '') block += '<description>' + description + '</description>\n'
  const config = item.config
  let jsonText = ''
  if (config !== null && config !== undefined) {
    try {
      jsonText = typeof config === 'string' ? config.trim() : JSON.stringify(config, null, 2)
    } catch {
      jsonText = ''
    }
  }
  // 空对象 / 空数组 / null / 空串一律不输出，避免把 {} 塞进 system prompt。
  if (jsonText !== '' && jsonText !== '{}' && jsonText !== '[]' && jsonText !== 'null') {
    block += '<mcp-config>' + jsonText.slice(0, 6000) + '</mcp-config>\n'
    block += '如需使用该连接器，请按上述 MCP 配置调用；本设定对本会话每条消息生效。\n'
  }
  block += '</dsh-buddy-expert-hub>'
  return block
}

/**
 * 在 agent 作用域注册会话常驻的 system prompt 区块。
 *
 * 宿主先例：dsh-file-reference-local —— `agent.ctx.inject(['systemPrompt'], …)`。
 * 挂在 agent.ctx 上 = 会话级，agent 销毁自动 unwind；服务缺失时静默降级
 * （runtime skill 仍然生效，只是没有常驻身份区块）。
 *
 * 宿主 section 注册可能返回独立 disposer，不能只依赖 fiber.unwind：
 * 同文件的 `registerOnAgent()` 就保存了 `scope.skills.register()` 的 `regDispose`，
 * dispose 时先 `regDispose()` 再 `fiber.dispose()`。这里对齐该范式，兼容三种返回形态
 * （函数 / 带 dispose 等方法的对象 / void），否则 dock 里点 × 删除条目后
 * 注入的 system prompt 区块会一直残留在本会话上下文里。
 * @param {any} agent 宿主 agent（须带 ctx）
 * @param {string} expertId 专家 id（做区块唯一名）
 * @param {string} block 区块文本
 * @returns {(() => void)|null} disposer；服务不可用返回 null
 */
function registerPromptSection(agent, expertId, block) {
  try {
    if (agent === null || agent === undefined || agent.ctx === undefined || agent.ctx === null) return null
    let lastError = null
    // section() 的返回值必须留存：宿主可能只认这个独立 disposer，不认 fiber.unwind。
    let registration = undefined
    const fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
      try {
        registration = scope.systemPrompt.section({
          name: 'dsh-buddy-expert-hub:' + expertId,
          // DEPLOYMENT_PERSONA_PREFIX(0) 之后、策略区之前：身份先于行为约束。
          order: scope.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1,
          text: () => block,
        })
        // 宿主可能直接返回 rejected Promise / thenable：必须在注册阶段同步挂上
        // rejection handler，否则 attach 到 detach 之间会产生 unhandledRejection
        // 与 PromiseRejectionHandledWarning。函数 disposer / 普通对象 / void 不受影响，
        // 也不会被当成 disposer 调用（它们没有 catch / then）。
        try {
          if (registration !== null && registration !== undefined) {
            if (typeof registration.catch === 'function') registration.catch(() => { /* 注册失败不传播 */ })
            else if (typeof registration.then === 'function') registration.then(() => {}, () => {})
          }
        } catch {
          // 宿主 thenable 行为异常，不影响注册结果
        }
      } catch (error) {
        lastError = error
      }
    })

    /**
     * 撤销 section 注册；函数 / 对象 / void / Promise 四种形态都安全吞异常。
     * 宿主可能已在 agent disposal 中回收该注册，任何一步失败都不能打断 detach 清理循环。
     * @returns {void}
     */
    const disposeRegistration = () => {
      if (registration === undefined || registration === null) return
      let task = null
      try {
        if (typeof registration === 'function') {
          task = registration()
        } else if (typeof registration === 'object') {
          for (const key of ['dispose', 'remove', 'unsubscribe', 'close']) {
            if (typeof registration[key] === 'function') {
              task = registration[key]()
              break
            }
          }
        }
      } catch {
        // 已被 agent disposal 回收
      }
      // 返回值或注册对象本身可能是 Promise：吞掉 rejection，绝不向外抛。
      const pending = task !== null && task !== undefined ? task : registration
      try {
        if (pending !== null && pending !== undefined && typeof pending.catch === 'function') {
          pending.catch(() => { /* dispose 失败不传播 */ })
        }
      } catch {
        // 同上
      }
    }

    /** 撤销 inject fiber（顺序在 registration 之后，与 registerOnAgent 一致）。 @returns {void} */
    const disposeFiber = () => {
      try {
        const task = fiber.dispose()
        if (task !== null && task !== undefined && typeof task.catch === 'function') {
          task.catch(() => { /* dispose 失败不传播 */ })
        }
      } catch {
        // 已被 agent disposal 回收
      }
    }

    if (lastError !== null) {
      // 注册抛错时也可能已经产生了半注册，仍按「先撤注册、再撤 fiber」清理。
      disposeRegistration()
      disposeFiber()
      return null
    }
    return () => {
      disposeRegistration()
      disposeFiber()
    }
  } catch {
    return null
  }
}

/**
 * 立即（或排队）把专家技能挂载到一个会话。
 * @param {string} sessionId 会话 id
 * @param {string} expertId 专家 id
 * @param {Record<string, any>} item 专家条目
 * @returns {{ ok: boolean, name?: string, pending?: boolean, error?: string, __status?: number }}
 */
async function attachExpert(sessionId, expertId, item) {
  const agents = hostService('agents')
  if (agents === null) {
    return { ok: false, error: '宿主 agents 服务不可用，无法按需挂载技能', __status: 501 }
  }
  // 幂等：同专家重复 attach 先拆旧的再挂新的。
  detachExpert(sessionId, expertId)

  let perSession = attachedExperts.get(sessionId)
  if (perSession === undefined) {
    perSession = new Map()
    attachedExperts.set(sessionId, perSession)
  }
  // 同会话内不同专家 slug 撞名 → 追加 -2/-3…（宿主 first-wins 会静默忽略同名，必须避开）。
  const base = slugifyExpertId(expertId)
  const usedNames = new Set(Array.from(perSession.values(), (entry) => entry.name))
  let skillName = 'expert-' + base
  for (let n = 2; usedNames.has(skillName); n += 1) skillName = 'expert-' + base + '-' + String(n)

  const built = expertSkillDef(item, skillName)
  if (built === null) {
    perSession.delete(skillName)
    return { ok: false, error: '专家目录不存在：' + expertId, __status: 400 }
  }

  const agent = agents.get(sessionId)
  if (agent !== undefined && agent !== null) {
    const registered = await registerOnAgent(agent, built.def)
    if (registered.ok !== true) {
      perSession.delete(skillName)
      return { ok: false, error: registered.error, __status: 501 }
    }
    // 会话常驻身份：system prompt 区块（agent 作用域，agent 销毁自动 unwind）。
    // 与 runtime skill 双层分工：身份常驻每轮生效，技能正文按需加载。
    const block = expertPromptBlock(item, registered.name)
    const promptDispose = registerPromptSection(agent, expertId, block)
    // 记录实际生效的 name（查重后可能带 -2/-3 后缀），不能记原始 slug。
    perSession.set(expertId, {
      name: registered.name,
      dispose: registered.dispose,
      promptDispose,
      meta: {
        type: item.type === 'team' ? 'team' : 'agent',
        displayName: tidy(item.displayName || item.name || expertId, 80) || expertId,
        profession: expertProfessionOf(item),
        avatar: expertAvatarOf(item),
      },
    })
    return registered.warning === undefined
      ? { ok: true, name: registered.name }
      : { ok: true, name: registered.name, warning: registered.warning }
  }

  // agent 未创建（消息还没提交）：记 pending，agent/created 时补挂。
  let pending = pendingAttaches.get(sessionId)
  if (pending === undefined) {
    pending = new Map()
    pendingAttaches.set(sessionId, pending)
  }
  pending.set(expertId, {
    skillName,
    meta: {
      type: item.type === 'team' ? 'team' : 'agent',
      displayName: tidy(item.displayName || item.name || expertId, 80) || expertId,
      profession: expertProfessionOf(item),
      avatar: expertAvatarOf(item),
    },
  })
  return { ok: true, name: skillName, pending: true }
}

/**
 * 拆掉一个会话的专家技能挂载（可选只拆某个专家）。
 * @param {string} sessionId 会话 id
 * @param {string|null} expertId 专家 id（null 拆全部）
 * @returns {{ ok: boolean, removed: number }}
 */
function detachExpert(sessionId, expertId) {
  let removed = 0
  const perSession = attachedExperts.get(sessionId)
  if (perSession !== undefined) {
    const ids = expertId === null ? [...perSession.keys()] : [expertId]
    for (const id of ids) {
      const entry = perSession.get(id)
      if (entry === undefined) continue
      try {
        entry.dispose()
      } catch {
        // dispose 失败不影响清理流程
      }
      if (typeof entry.promptDispose === 'function') {
        try {
          entry.promptDispose()
        } catch {
          // 同上
        }
      }
      perSession.delete(id)
      removed += 1
    }
    if (perSession.size === 0) attachedExperts.delete(sessionId)
  }
  const pending = pendingAttaches.get(sessionId)
  if (pending !== undefined) {
    if (expertId === null) pending.clear()
    else pending.delete(expertId)
    if (pending.size === 0) pendingAttaches.delete(sessionId)
  }
  return { ok: true, removed }
}

/**
 * 立即（或排队）把一个连接器挂到会话的 system prompt 上。
 *
 * 与专家单选的关键差别：只 dispose 同一 connectorId 的旧 section，绝不调用
 * detachExpert，也绝不拆其他 connector —— 连接器可多选且不影响专家。
 * section 唯一名用 'connector:' + id 前缀（最终 dsh-buddy-expert-hub:connector:<id>），
 * 与专家的 dsh-buddy-expert-hub:<expertId> 命名空间天然隔离。
 * @param {string} sessionId 会话 id
 * @param {string} connectorId 连接器 id
 * @param {Record<string, any>} item 连接器索引条目
 * @returns {Promise<Record<string, any>>} { ok, name?, pending?, warning?, error?, __status? }
 */
async function attachConnector(sessionId, connectorId, item) {
  const agents = hostService('agents')
  if (agents === null) {
    return { ok: false, error: '宿主 agents 服务不可用，无法把连接器挂到会话', __status: 501 }
  }
  // 幂等：同一 connector 重复 attach 先拆旧 section（只拆它自己）。
  detachConnector(sessionId, connectorId)

  const sectionKey = 'connector:' + connectorId
  const block = connectorPromptBlock(item)
  const meta = {
    type: 'connector',
    displayName: tidy(item.displayName || item.name || connectorId, 80) || connectorId,
    skillName: sectionKey,
  }

  const agent = agents.get(sessionId)
  if (agent !== undefined && agent !== null) {
    const promptDispose = registerPromptSection(agent, sectionKey, block)
    let perSession = attachedConnectors.get(sessionId)
    if (perSession === undefined) {
      perSession = new Map()
      attachedConnectors.set(sessionId, perSession)
    }
    perSession.set(connectorId, { name: sectionKey, dispose: promptDispose, meta })
    return promptDispose === null
      ? { ok: true, name: sectionKey, warning: '宿主 systemPrompt 服务不可用，本会话提示未写入' }
      : { ok: true, name: sectionKey }
  }

  // agent 未创建（消息还没提交）：记 pending，agent/created 时补挂；item 一起存，
  // 补挂时不必再依赖索引缓存（缓存可能正忙）。
  let pending = pendingConnectors.get(sessionId)
  if (pending === undefined) {
    pending = new Map()
    pendingConnectors.set(sessionId, pending)
  }
  pending.set(connectorId, { name: sectionKey, meta, item })
  return { ok: true, name: sectionKey, pending: true }
}

/**
 * 拆掉一个会话的连接器挂载（可选只拆某个连接器）。
 * 只动 attachedConnectors / pendingConnectors，绝不动 attachedExperts。
 * @param {string} sessionId 会话 id
 * @param {string|null} connectorId 连接器 id（null 拆全部）
 * @returns {{ ok: boolean, removed: number }}
 */
function detachConnector(sessionId, connectorId) {
  let removed = 0
  const perSession = attachedConnectors.get(sessionId)
  if (perSession !== undefined) {
    const ids = connectorId === null ? [...perSession.keys()] : [connectorId]
    for (const id of ids) {
      const entry = perSession.get(id)
      if (entry === undefined) continue
      if (typeof entry.dispose === 'function') {
        try {
          entry.dispose()
        } catch {
          // dispose 失败不影响清理流程
        }
      }
      perSession.delete(id)
      removed += 1
    }
    if (perSession.size === 0) attachedConnectors.delete(sessionId)
  }
  const pending = pendingConnectors.get(sessionId)
  if (pending !== undefined) {
    if (connectorId === null) pending.clear()
    else pending.delete(connectorId)
    if (pending.size === 0) pendingConnectors.delete(sessionId)
  }
  return { ok: true, removed }
}

/**
 * 卸载 / 删除连接器定义时，清掉**所有会话**里该连接器的挂载（含 pending）。
 *
 * 必须传具体 id 调 detachConnector，绝不能用 null —— null 是「拆该会话全部连接器」，
 * 会误清用户挂载的其它连接器。注册表是内存态，跨会话遍历在这里做。
 * @param {string} connectorId 连接器 id
 * @returns {number} 被清理的会话数（含只有 pending 的会话）
 */
function detachConnectorEverywhere(connectorId) {
  const sessions = new Set()
  for (const [sessionId, perSession] of attachedConnectors) {
    if (perSession instanceof Map && perSession.has(connectorId)) sessions.add(sessionId)
  }
  for (const [sessionId, perSession] of pendingConnectors) {
    if (perSession instanceof Map && perSession.has(connectorId)) sessions.add(sessionId)
  }
  for (const sessionId of sessions) detachConnector(sessionId, connectorId)
  return sessions.size
}

/**
 * 删除专家条目时，清掉**所有会话**里该专家的挂载（含 pending）。
 *
 * 同样必须传具体 id；专家是单选语义，但这里仍只清指定条目，避免误伤 pending 队列。
 * @param {string} expertId 专家 id
 * @returns {number} 被清理的会话数
 */
function detachExpertEverywhere(expertId) {
  const sessions = new Set()
  for (const [sessionId, perSession] of attachedExperts) {
    if (perSession instanceof Map && perSession.has(expertId)) sessions.add(sessionId)
  }
  for (const [sessionId, perSession] of pendingAttaches) {
    if (perSession instanceof Map && perSession.has(expertId)) sessions.add(sessionId)
  }
  for (const sessionId of sessions) detachExpert(sessionId, expertId)
  return sessions.size
}

/**
 * 自愈用：当前仍然存在的专家 id 集合（索引缓存 + 本地已导入专家）。
 *
 * 只走已有的 mergeLocalExperts 合并口径，不重建索引、不碰数据源配置。
 * @param {any} index 可用的索引缓存
 * @returns {Set<string>} 存在的专家 id
 */
function existingExpertIds(index) {
  const ids = new Set()
  for (const wanted of ['agent', 'team']) {
    for (const item of mergeLocalExperts(index.experts, wanted)) {
      if (item !== null && typeof item === 'object' && typeof item.id === 'string') ids.add(item.id)
    }
  }
  return ids
}

/**
 * 自愈用：判断某个已挂载专家的源是否还在。
 *
 * 索引合并列表里能找到，或本地导入目录仍存在，都算存在；两者皆无才允许清挂载。
 * @param {Set<string>} existingIds 见 {@link existingExpertIds}
 * @param {string} expertId 专家 id
 * @returns {boolean} 源仍存在
 */
function expertSourceExists(existingIds, expertId) {
  if (existingIds.has(expertId)) return true
  const safe = safeId(expertId)
  return safe !== null && isDir(path.join(LOCAL_EXPERTS_DIR, safe))
}

/**
 * agent/created 生命周期回调：把该会话 pending 的连接器补挂上。
 * @param {any} agent 新创建的 agent（须带 id 与 agent.ctx）
 * @returns {Promise<void>}
 */
async function flushPendingConnectors(agent) {
  const pending = pendingConnectors.get(agent.id)
  if (pending === undefined || pending.size === 0) return
  for (const [connectorId, entry] of pending) {
    pending.delete(connectorId)
    let item = entry !== null && typeof entry === 'object' ? entry.item : undefined
    if (item === undefined || item === null) {
      /* 兜底也要查三源合并：手动新增 / 云端安装的连接器不在索引里。 */
      item = findConnectorItem(connectorId)
    }
    if (item === undefined || item === null) continue
    await attachConnector(agent.id, connectorId, item)
  }
  if (pending.size === 0) pendingConnectors.delete(agent.id)
}

/**
 * agent/created 生命周期回调：把该会话的 pending 挂载补上。
 * @param {any} agent 新创建的 agent（须带 id 与 agent.ctx）
 * @returns {void}
 */
async function flushPendingAttaches(agent) {
  const pending = pendingAttaches.get(agent.id)
  if (pending === undefined || pending.size === 0) return
  const index = loadIndexCache()
  for (const [expertId] of pending) {
    pending.delete(expertId)
    const item =
      index === null
        ? undefined
        : mergeLocalExperts(index.experts, 'agent').find((entry) => entry.id === expertId) ??
          mergeLocalExperts(index.experts, 'team').find((entry) => entry.id === expertId)
    if (item === undefined) continue
    await attachExpert(agent.id, expertId, item)
  }
  if (pending.size === 0) pendingAttaches.delete(agent.id)
}

/**
 * `POST /attach`：把引用的专家技能挂载为 agent 作用域 runtime skill。
 * body: { sessionId, type, id }
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {Promise<Record<string, any>>} 响应载荷
 */
async function handleAttach(req) {
  let payload
  try {
    const raw = await readRequestBody(req)
    payload = JSON.parse(raw === '' ? '{}' : raw)
  } catch {
    return { ok: false, error: '请求体不是合法 JSON' }
  }
  if (payload === null || typeof payload !== 'object') return { ok: false, error: '请求体格式错误' }

  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
  if (!SESSION_ID_RE.test(sessionId)) return { ok: false, error: '非法 sessionId' }

  // 连接器：独立分支，**不**走下面的专家单选清理。
  // 挂连接器既不能清掉专家，也不能清掉其他连接器（用户可同时选多个）。
  if (payload.type === 'connector') {
    const connectorId = safeId(typeof payload.id === 'string' ? payload.id : '')
    if (connectorId === null) return { ok: false, error: '非法连接器 id' }
    if (requireIndex() === null) return busyPayload()
    const connector = findConnectorItem(connectorId)
    if (connector === undefined) return { ok: false, error: '连接器不存在：' + connectorId, __status: 400 }
    return await attachConnector(sessionId, connectorId, connector)
  }

  const type = payload.type === 'team' ? 'team' : payload.type === 'expert' || payload.type === 'agent' ? 'agent' : null
  if (type === null) return { ok: false, error: 'type 必须是 agent 或 team 或 connector' }
  const id = safeId(typeof payload.id === 'string' ? payload.id : '')
  if (id === null) return { ok: false, error: '非法专家 id' }

  const index = requireIndex()
  if (index === null) return busyPayload()
  const item =
    mergeLocalExperts(index.experts, 'agent').find((entry) => entry.id === id) ??
    mergeLocalExperts(index.experts, 'team').find((entry) => entry.id === id)
  if (item === undefined) return { ok: false, error: '专家不存在：' + id, __status: 400 }

  // 专家/专家团「只能选一个」：attach 前先清掉该会话已有的所有挂载
  // （detachExpert 双 dispose：runtime skill + systemPrompt section；同时清 pending）。
  // 挂的是新专家时旧条目一并消失，选中另一个时 chip 直接替换，不叠加。
  const existing = attachedExperts.get(sessionId)
  const previousIds = existing === undefined ? [] : [...existing.keys()]
  const replaced = previousIds.length > 0 ? previousIds[0] : null
  if (previousIds.length > 0) detachExpert(sessionId, null)
  const out = await attachExpert(sessionId, id, item)
  return Object.assign({}, out, { replaced })
}

/**
 * `POST /detach`：拆掉会话的专家技能挂载。body: { sessionId, id? }
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {Promise<Record<string, any>>} 响应载荷
 */
async function handleDetach(req) {
  let payload
  try {
    const raw = await readRequestBody(req)
    payload = JSON.parse(raw === '' ? '{}' : raw)
  } catch {
    return { ok: false, error: '请求体不是合法 JSON' }
  }
  if (payload === null || typeof payload !== 'object') return { ok: false, error: '请求体格式错误' }
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
  if (!SESSION_ID_RE.test(sessionId)) return { ok: false, error: '非法 sessionId' }
  const id = payload.id === undefined || payload.id === null ? null : safeId(String(payload.id))
  const rawType = typeof payload.type === 'string' ? payload.type : ''
  if (rawType === 'connector') {
    // 显式传了 id 但非法时报错，避免把「非法 id」误当成「拆掉全部连接器」。
    if (payload.id !== undefined && payload.id !== null && id === null) {
      return { ok: false, error: '非法连接器 id' }
    }
    // 给定 id 只拆该连接器；不给 id 拆该会话全部连接器。两者都不动 attachedExperts。
    return detachConnector(sessionId, id)
  }
  // 无 type / type 为 agent|team：保持原来的专家单选 detach 行为。
  return detachExpert(sessionId, id)
}

/**
 * GET /attachments?sessionId=：会话当前挂载的专家列表（dock 渲染用）。
 *
 * 内存态：服务重启后丢失，dock 相应消失——挂载本身就是会话级语义，可接受。
 *
 * 自愈（全表）：索引缓存可用时，一次算好当前仍存在的专家 id 集合与连接器 id
 * 集合，然后遍历 attachedExperts / pendingAttaches / attachedConnectors /
 * pendingConnectors 全表，对源已消失的 id 调 detachExpertEverywhere 或
 * detachConnectorEverywhere，真正 dispose 掉所有会话（含非活跃会话）注入的
 * system prompt 与注册表条目；最后才按当前 sessionId 组装返回 items。
 * 专家与连接器分属两张表、各自收集各自的 stale id，即使 id 撞名也互不干扰；
 * 清理发生在组装之前，同一状态连续两次调用结果一致，不会「闪回」。
 *
 * 安全阀：索引不可用（loadIndexCache 返回 null，即 requireIndex 会 busy /
 * 首次启动 / 同步中途）或 state.busy 为 true 时整段跳过，零 dispose、原样返回，
 * 否则会把用户所有挂载误清。这里只读已有缓存，绝不重建索引、不触发同步。
 * 已知边界：手动删仓库专家目录但索引缓存未重建时，源判定仍按旧索引，不清，
 * 需点「刷新」重建索引后才自愈；切到 git 且 indexSwitchPending 时旧索引保留，
 * 自愈不检查该标志。
 *
 * 性能：连接器源集合由一次 mergedConnectors 扫盘构建，专家源集合由一次
 * existingExpertIds 构建，全表复用；不随挂载条目数逐条扫盘。
 *
 * sessionId 校验与 /attach 一致，统一用 SESSION_ID_RE（允许冒号等宿主格式）。
 * @param {URLSearchParams} query 查询参数
 * @returns {Record<string, any>} 响应载荷
 */
function handleAttachments(query) {
  const sessionId = query.get('sessionId') || ''
  // 与 /attach 保持同一口径：宿主 sessionId 可能含冒号，不能用 safeId 误拒。
  if (!SESSION_ID_RE.test(sessionId)) return { ok: false, error: '非法 sessionId' }
  // 安全阀：索引不可用 / 正在同步时跳过自愈，宁可留着旧 chip，也不能误清用户挂载。
  const index = loadIndexCache()
  const canPrune = index !== null && Array.isArray(index.experts) && state.busy !== true
  if (canPrune) {
    try {
      // 一次算好两个源集合，全表复用：避免每条挂载都扫一次盘。
      const knownExpertIds = existingExpertIds(index)
      const knownConnectorIds = new Set()
      for (const item of mergedConnectors()) {
        if (item !== null && typeof item === 'object' && typeof item.id === 'string') knownConnectorIds.add(item.id)
      }
      // 先收集 stale id 再统一 dispose：遍历 Map 期间不能改动它。
      // 专家与连接器分开收集，id 撞名时不会串台（复合语义由两张表天然保证）。
      const staleExpertIds = new Set()
      for (const perSession of attachedExperts.values()) {
        for (const expertId of perSession.keys()) {
          if (!expertSourceExists(knownExpertIds, expertId)) staleExpertIds.add(expertId)
        }
      }
      for (const perSession of pendingAttaches.values()) {
        for (const expertId of perSession.keys()) {
          if (!expertSourceExists(knownExpertIds, expertId)) staleExpertIds.add(expertId)
        }
      }
      for (const expertId of staleExpertIds) detachExpertEverywhere(expertId)

      const staleConnectorIds = new Set()
      for (const perSession of attachedConnectors.values()) {
        for (const connectorId of perSession.keys()) {
          if (!knownConnectorIds.has(connectorId)) staleConnectorIds.add(connectorId)
        }
      }
      for (const perSession of pendingConnectors.values()) {
        for (const connectorId of perSession.keys()) {
          if (!knownConnectorIds.has(connectorId)) staleConnectorIds.add(connectorId)
        }
      }
      for (const connectorId of staleConnectorIds) detachConnectorEverywhere(connectorId)
    } catch {
      // 源探测异常时宁可不清也不误清：不 dispose 任何条目，继续按现有注册表返回。
    }
  }
  const items = []
  const perSession = attachedExperts.get(sessionId)
  if (perSession !== undefined) {
    for (const [expertId, entry] of perSession) {
      items.push({
        id: expertId,
        type: entry.meta !== undefined && entry.meta !== null ? entry.meta.type : 'agent',
        displayName: entry.meta !== undefined && entry.meta !== null ? entry.meta.displayName : expertId,
        profession: entry.meta !== undefined && entry.meta !== null ? (entry.meta.profession || '') : '',
        avatar: entry.meta !== undefined && entry.meta !== null ? (entry.meta.avatar || '') : '',
        skillName: entry.name,
        pending: false,
      })
    }
  }
  const pending = pendingAttaches.get(sessionId)
  if (pending !== undefined) {
    for (const [expertId, entry] of pending) {
      const meta = entry !== null && typeof entry === 'object' ? entry.meta : null
      items.push({
        id: expertId,
        type: meta !== null && meta !== undefined ? meta.type : 'agent',
        displayName: meta !== null && meta !== undefined ? meta.displayName : expertId,
        profession: meta !== null && meta !== undefined ? (meta.profession || '') : '',
        avatar: meta !== null && meta !== undefined ? (meta.avatar || '') : '',
        skillName: entry !== null && typeof entry === 'object' ? entry.skillName : entry,
        pending: true,
      })
    }
  }
  // 连接器：与专家同列表返回，type='connector' 供 dock 分组渲染（可多条，含 pending）。
  const connPerSession = attachedConnectors.get(sessionId)
  if (connPerSession !== undefined) {
    for (const [connectorId, entry] of connPerSession) {
      const meta = entry !== null && typeof entry === 'object' ? entry.meta : null
      items.push({
        id: connectorId,
        type: 'connector',
        displayName: meta !== null && meta !== undefined ? (meta.displayName || connectorId) : connectorId,
        skillName: entry !== null && typeof entry === 'object' ? entry.name : 'connector:' + connectorId,
        pending: false,
      })
    }
  }
  const connPending = pendingConnectors.get(sessionId)
  if (connPending !== undefined) {
    for (const [connectorId, entry] of connPending) {
      const meta = entry !== null && typeof entry === 'object' ? entry.meta : null
      items.push({
        id: connectorId,
        type: 'connector',
        displayName: meta !== null && meta !== undefined ? (meta.displayName || connectorId) : connectorId,
        skillName: entry !== null && typeof entry === 'object' ? entry.name : 'connector:' + connectorId,
        pending: true,
      })
    }
  }
  // 自愈已在组装之前按全表完成：这里只按当前 sessionId 倒出剩余挂载，
  // 不再按 id 过滤（专家 / 连接器撞名时也不会误剔除对方条目）。
  return { ok: true, items }
}

/**
 * `/detail`：单项详情。专家优先查本地已导入目录，再查索引。
 * @param {URLSearchParams} query 查询参数
 * @returns {Record<string, any>} 响应载荷
 */
function handleDetail(query) {
  const index = requireIndex()
  if (index === null) return busyPayload()
  const type = String(query.get('type') || '').trim()
  const id = String(query.get('id') || '').trim()
  if (id === '') return { ok: false, error: '缺少 id 参数' }

  if (type === 'expert' || type === 'team') {
    // 详情必须与列表同源：都走「索引 + 本地」的字段级合并，
    // 否则本地已导入的专家点开抽屉会丢掉职业、分类、标签、快捷提示、版本。
    const preferred = type === 'team' ? 'team' : 'agent'
    let item = mergeLocalExperts(index.experts, preferred).find((entry) => entry.id === id)
    if (item === undefined) {
      const other = preferred === 'team' ? 'agent' : 'team'
      item = mergeLocalExperts(index.experts, other).find((entry) => entry.id === id)
    }
    if (item === undefined) return { ok: false, error: '未找到该专家：' + id }
    // library 模式正文来自 bundle；本地包以 role.md 为准，远端条目回到仓库里的 agent markdown。
    const bundled = libraryContent('expert', id)
    const readme =
      bundled !== null ? bundled.slice(0, README_LIMIT) : item.local === true ? readLocalRole(id) : readExpertReadme(id)
    // skillDetails 请求时实时算（fetch 落盘后状态会变，不能进缓存）。
    const publicItem = publicExpert(item)
    publicItem.skillDetails = resolveSkillDetails(item, index)
    // skillsDir：专家技能目录的绝对路径（serialize 的 <skills> 段指针用）。
    // 优先已导入落盘目录，其次数据仓库源目录；都不存在则为 null（前端省略 <skills> 段）。
    const localSkillsDir = path.join(LOCAL_EXPERTS_DIR, id, 'skills')
    const repoSkillsDir = dataRoot() === null ? null : path.join(dataRoot(), 'experts', id, 'skills')
    publicItem.skillsDir =
      state.library !== null
        ? null
        : isDir(localSkillsDir)
          ? localSkillsDir
          : repoSkillsDir !== null && isDir(repoSkillsDir)
            ? repoSkillsDir
            : null
    return { ok: true, type: item.type, item: publicItem, readme }
  }

  if (type === 'skill') {
    let item = index.skills.find((entry) => entry.id === id)
    if (item === undefined) {
      /* 已安装技能（SkillHub 下载 / 用户手工放置）不在仓库索引里：
         回退到本地技能库，按目录名（或 SkillHub slug）匹配，让对话引用也能取到正文。 */
      const installed = resolveInstalledSkill(id)
      if (installed === null) return { ok: false, error: '未找到该技能：' + id }
      if (installed.enabled === false) {
        return { ok: false, error: '该技能已关闭：' + installed.name + '（到「已安装」里开启后再引用）' }
      }
      const text = readTextSafe(path.join(installed.abs, 'SKILL.md'))
      return {
        ok: true,
        type: 'skill',
        item: {
          id,
          name: installed.name,
          description: installed.description,
          collection: '已安装',
          path: toPosix(path.join('skills', installed.dir, 'SKILL.md')),
          skillsDir: installed.abs,
          installed: true,
        },
        readme: text === null ? '' : stripFrontmatter(text).trim().slice(0, README_LIMIT),
      }
    }
    // library 模式正文来自 bundle，否则按仓库相对路径读 SKILL.md。
    const bundled = libraryContent('skill', id)
    if (bundled !== null) {
      return { ok: true, type: 'skill', item: publicSkill(item), readme: bundled.slice(0, README_LIMIT) }
    }
    const absolute = safeRepoPath(item.path)
    const text = absolute === null ? null : readTextSafe(absolute)
    const readme = text === null ? '' : stripFrontmatter(text).trim().slice(0, README_LIMIT)
    return { ok: true, type: 'skill', item: publicSkill(item), readme }
  }

  if (type === 'connector') {
    const item = findConnectorItem(id)
    if (item === undefined) return { ok: false, error: '未找到该连接器：' + id }
    return { ok: true, type: 'connector', item: publicConnector(item) }
  }

  return { ok: false, error: '不支持的详情类型：' + type }
}

/**
 * `/asset`：仓库内图片资源。
 * @param {import('node:http').ServerResponse} res 响应对象
 * @param {URLSearchParams} query 查询参数
 * @returns {void}
 */
function handleAsset(res, query) {
  const absolute = safeRepoPath(query.get('path'))
  if (absolute === null) {
    send(res, { ok: false, error: '资源不存在或路径非法' }, 404)
    return
  }
  sendImage(res, absolute)
}

/**
 * `/icon`：连接器图标。
 * @param {import('node:http').ServerResponse} res 响应对象
 * @param {URLSearchParams} query 查询参数
 * @returns {void}
 */
function handleIcon(res, query) {
  const absolute = resolveConnectorIcon(query.get('id'))
  if (absolute === null) {
    send(res, { ok: false, error: '图标不存在' }, 404)
    return
  }
  sendImage(res, absolute)
}

/**
 * `/import`：按 DSH 原生专家格式落盘到 `$DSH_HOME/experts/<id>/`。
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {Promise<Record<string, any>>} 响应载荷
 */
async function handleImport(req) {
  const raw = await readRequestBody(req)
  let payload
  try {
    payload = JSON.parse(raw === '' ? '{}' : raw)
  } catch {
    return { ok: false, error: '请求体不是合法 JSON' }
  }
  if (payload === null || typeof payload !== 'object') return { ok: false, error: '请求体格式错误' }

  const id = safeId(payload.id)
  if (id === null) return { ok: false, error: '非法专家 id' }

  // 外部约定用 type:'expert'|'team'，内部索引里用 'agent'|'team'，这里做一次归一。
  const requestedType =
    payload.type === 'team' ? 'team' : payload.type === 'expert' || payload.type === 'agent' ? 'agent' : null

  const index = requireIndex()
  if (index === null) return busyPayload()

  const targetDir = path.join(LOCAL_EXPERTS_DIR, id)
  // 幂等判断看 DSH 专家目录：已存在就不覆盖 —— 用户可能已经手动改过。
  if (isDir(targetDir)) {
    const known = listLocalExperts().find((entry) => entry.id === id)
    if (!state.importedIds.includes(id)) {
      state.importedIds.push(id)
      persistState()
    }
    return {
      ok: true,
      already: true,
      id,
      type: known === undefined ? (requestedType === null ? 'agent' : requestedType) : known.type,
      path: targetDir,
    }
  }

  const item = index.experts.find((entry) => entry.id === id)
  if (item === undefined) return { ok: false, error: '未找到该专家：' + id }
  if (requestedType !== null && requestedType !== item.type) {
    return { ok: false, error: '专家类型不匹配：' + id + ' 实际是 ' + item.type }
  }

  const root = dataRoot()
  if (root === null) return { ok: false, error: '没有可用的数据源' }

  const pluginFile = path.join(root, 'experts', id, '.codebuddy-plugin', 'plugin.json')
  const plugin = readJsonSafe(pluginFile)
  if (plugin === null || typeof plugin !== 'object') {
    return { ok: false, error: '源专家缺少可解析的 plugin.json' }
  }
  plugin.__dirName = id

  // 1) 写 DSH 原生专家包（这是能让 dsh 真正识别的部分）
  const written = writeDshExpertPackage(root, plugin)
  if (written.ok !== true) return { ok: false, error: written.error || '写入 DSH 专家目录失败' }

  // 2) 额外保留 WorkBuddy 原始目录包（溯源 + skills 依赖）
  const bundle = writeSourceBundle(root, id)
  if (bundle.ok !== true) {
    state.warnings.push('保留原始目录包失败：' + humanError({ message: bundle.error || '' }))
  }

  if (!state.importedIds.includes(id)) {
    state.importedIds.push(id)
    persistState()
  }

  // 3) 把专家包自带的 skills/ 引用目录一并复制，落盘后技能引用才真正可用。
  const skillsCopied = copyExpertSkills(path.join(root, 'experts', id), targetDir, id)

  return {
    ok: true,
    already: false,
    id,
    type: item.type,
    path: targetDir,
    files: written.files || [],
    bundle: bundle.ok === true ? bundle.path : null,
    skillsCopied,
  }
}

/**
 * 递归复制目录（每个文件独立容错，失败记入 warnings 不中断）。
 * @param {string} srcDir 源目录
 * @param {string} destDir 目标目录
 * @param {string[]} warnings 告警收集
 * @param {string} label 告警前缀
 * @returns {number} 成功复制的文件数
 */
function copyDirFiles(srcDir, destDir, warnings, label) {
  let entries
  try {
    entries = fs.readdirSync(srcDir, { withFileTypes: true })
  } catch (error) {
    warnings.push(label + '目录读取失败：' + humanError(error))
    return 0
  }
  try {
    fs.mkdirSync(destDir, { recursive: true })
  } catch (error) {
    warnings.push(label + '目录创建失败：' + humanError(error))
    return 0
  }
  let copied = 0
  for (const entry of entries) {
    const from = path.join(srcDir, entry.name)
    const to = path.join(destDir, entry.name)
    if (entry.isDirectory()) {
      copied += copyDirFiles(from, to, warnings, label)
    } else if (entry.isFile()) {
      try {
        fs.copyFileSync(from, to)
        copied += 1
      } catch {
        warnings.push(label + '文件复制失败：' + entry.name)
      }
    }
  }
  return copied
}

/**
 * 导入专家时把源包目录下的 skills/ 递归复制到落盘目录。
 * 来源可以是资源仓库检出，也可以是任何含 experts/<id>/skills 的市场目录 ——
 * 只要给到对应的源专家目录即可。
 * @param {string} sourceExpertDir 源专家目录（如 <数据根>/experts/<id>）
 * @param {string} targetDir 落盘目录（~/.dsh/experts/<id>）
 * @param {string} expertId 专家 id（告警定位用）
 * @returns {number} 复制的文件数；源目录无 skills/ 时返回 0
 */
function copyExpertSkills(sourceExpertDir, targetDir, expertId) {
  const src = path.join(sourceExpertDir, 'skills')
  if (!isDir(src)) return 0
  /** @type {string[]} */
  const warnings = []
  const copied = copyDirFiles(src, path.join(targetDir, 'skills'), warnings, '专家 ' + expertId + ' 技能 ')
  for (const warning of warnings) state.warnings.push(warning)
  return copied
}

/**
 * `/imported`：已导入专家列表。
 * 权威来源是 `$DSH_HOME/experts/` 下含 expert.yml 的目录，再与 state.json 记录合并去重。
 * @returns {Record<string, any>} 响应载荷
 */
function handleImported() {
  const items = listLocalExperts().map((item) => ({
    id: item.id,
    type: item.type,
    displayName: item.displayName,
    description: item.description,
    avatar: item.avatar,
  }))
  const scanned = items.map((entry) => entry.id)
  const merged = Array.from(new Set(state.importedIds.concat(scanned))).sort()
  state.importedIds = merged
  persistState()
  return {
    ok: true,
    ids: merged,
    items,
    dir: LOCAL_EXPERTS_DIR,
  }
}

// ---------------------------------------------------------------------------
// 整包导出 / 导入 / 切回（本地资料库）
// ---------------------------------------------------------------------------

/** 导出进行中标记（防重复触发；导出是同步重活，进行中再点直接忽略）。 */
let exportBusy = false

/**
 * 以 data URI 形式读取一张图片；失败返回 null（不中断整包导出）。
 * @param {string|null} relativePath 数据根内相对路径
 * @returns {string|null} data URI 或 null
 */
function imageAsDataUri(relativePath) {
  const absolute = safeRepoPath(relativePath)
  if (absolute === null) return null
  try {
    const buf = fs.readFileSync(absolute)
    return 'data:' + sniffImageMime(buf, 'image/png') + ';base64,' + buf.toString('base64')
  } catch {
    return null
  }
}

/**
 * 组装导出包（以当前索引为准 = 面板此刻显示的内容）。
 *
 * 专家 / 团队列表用「索引 + 本地」合并结果；正文全文导出（不截断）；
 * 单条读取失败记入 warnings，不中断整包。
 *
 * @returns {{ bundle: Record<string, any>, warnings: string[] }} 导出包与告警
 */
function buildExportBundle() {
  const index = requireIndex()
  if (index === null) throw new Error('索引尚未就绪，请稍后再导出')
  /** @type {string[]} */
  const warnings = []

  const expertItems = mergeLocalExperts(index.experts.filter((item) => item.type !== 'team'), 'agent')
  const teamItems = mergeLocalExperts(index.experts.filter((item) => item.type === 'team'), 'team')

  /**
   * 导出单个专家 / 团队：全文正文 + 内联头像。
   * @param {Record<string, any>} item 索引条目
   * @returns {Record<string, any>} 导出条目
   */
  const exportExpert = (item) => {
    const entry = publicExpert(item)
    let readme = ''
    try {
      readme = item.local === true ? readTextSafe(path.join(LOCAL_EXPERTS_DIR, item.id, 'role.md')) || '' : readExpertFullReadme(item.id)
      readme = stripFrontmatter(readme).trim()
    } catch {
      warnings.push('专家正文读取失败：' + item.id)
    }
    entry.readme = readme
    let avatarB64 = null
    if (item.local === true) {
      const avatarFile = findLocalAvatar(path.join(LOCAL_EXPERTS_DIR, item.id))
      if (avatarFile !== null) {
        try {
          const buf = fs.readFileSync(avatarFile)
          avatarB64 = 'data:' + sniffImageMime(buf, 'image/png') + ';base64,' + buf.toString('base64')
        } catch {
          warnings.push('专家头像读取失败：' + item.id)
        }
      }
    } else if (typeof item.avatar === 'string' && item.avatar !== '') {
      avatarB64 = imageAsDataUri(item.avatar)
    }
    entry.avatarB64 = avatarB64
    delete entry.avatar
    // 成员头像同样内联，导入方不依赖任何本机文件。
    if (Array.isArray(entry.members)) {
      entry.members = entry.members.map((member) => {
        const copy = Object.assign({}, member)
        if (typeof copy.avatar === 'string' && copy.avatar !== '') {
          const inlined = imageAsDataUri(copy.avatar)
          if (inlined !== null) copy.avatar = inlined
          else delete copy.avatar
        }
        return copy
      })
    }
    return entry
  }

  /**
   * 导出单个技能：SKILL.md 全文。
   * @param {Record<string, any>} item 索引条目
   * @returns {Record<string, any>} 导出条目
   */
  const exportSkill = (item) => {
    const entry = publicSkill(item)
    let content = ''
    const absolute = safeRepoPath(item.path)
    if (absolute === null) warnings.push('技能正文读取失败：' + item.id)
    else {
      const text = readTextSafe(absolute)
      if (text === null) warnings.push('技能正文读取失败：' + item.id)
      else content = stripFrontmatter(text).trim()
    }
    entry.content = content
    return entry
  }

  const experts = expertItems.map(exportExpert)
  const teams = teamItems.map(exportExpert)
  const skills = index.skills.map(exportSkill)
  /* 连接器不在索引里，导出时按当前「云端 + 本地」合并结果取一份快照，供外部工具使用。
     导出包会被分享出去，所以这里额外剥掉 `file`（本机绝对路径，含用户名与目录结构）；
     接口列表 / 详情里的 `file` 保持原样，那是本机自查用的。 */
  const connectors = mergedConnectors().map((item) => {
    const copy = publicConnector(item)
    delete copy.file
    return copy
  })

  return {
    bundle: {
      formatVersion: EXPORT_FORMAT_VERSION,
      kind: EXPORT_KIND,
      exportedAt: new Date().toISOString(),
      source: {
        dataRoot: state.library !== null ? state.library.dir : dataRoot(),
        counts: {
          agent: experts.length,
          team: teams.length,
          skill: skills.length,
          connector: connectors.length,
        },
      },
      experts: experts.concat(teams),
      skills,
      connectors,
    },
    warnings,
  }
}

/**
 * 读取专家全文正文（agent markdown 优先，回落 README.md；不截断）。
 * @param {string} expertId 专家目录名
 * @returns {string} 正文
 */
function readExpertFullReadme(expertId) {
  const base = dataRoot()
  if (base === null) return ''
  const expertDir = path.join(base, 'experts', expertId)
  const plugin = readJsonSafe(path.join(expertDir, '.codebuddy-plugin', 'plugin.json'))
  /** @type {string[]} */
  const candidates = []
  if (plugin !== null && Array.isArray(plugin.agents)) {
    for (const rel of plugin.agents) {
      if (typeof rel === 'string' && rel.trim() !== '') candidates.push(rel)
    }
  }
  candidates.push('README.md')
  for (const rel of candidates) {
    const absolute = path.resolve(expertDir, rel)
    if (!absolute.startsWith(path.resolve(expertDir) + path.sep)) continue
    const text = readTextSafe(absolute)
    if (text !== null) return stripFrontmatter(text).trim()
  }
  return ''
}

/**
 * `GET /export`：打包当前面板数据并以 gzip 附件下发。
 * @param {import('node:http').ServerResponse} res 响应对象
 * @returns {void}
 */
// ---------------------------------------------------------------------------
// 单条目导出 / 导入（一个专家、一个专家团或一个技能 = 一个文件）
// ---------------------------------------------------------------------------
//
// 用户要求把「整包 46MB 导出/导入」（替换整个数据源）改成按条目走：
//   GET  /export/item?type=expert|team|skill&id=xxx → 下载单条目 .json.gz
//   POST /import/item                              → 上传单条目包，只新增这一个条目（接口保留）
//   POST /import/folder                            → 浏览器选文件夹导入，见下方「文件夹导入」段落
//
// 包内是**原始目录树的文件快照**（相对路径 + 文本/base64），因此导入方
// 不需要有同名仓库条目，也不依赖网络。

/** 单条目包格式标识。 */
const ITEM_ARCHIVE_FORMAT = 'dsh-buddy-expert-hub-item'

/** 包内单文件大小上限（字节）。 */
const ITEM_FILE_LIMIT = 4 * 1024 * 1024

/** 包内文件数量上限。 */
const ITEM_FILES_LIMIT = 400

/** 按扩展名判断是否文本（文本按 utf8 存，便于人工查看与 diff）。 */
const ITEM_TEXT_RE = /\.(md|markdown|txt|json|ya?ml|js|mjs|cjs|ts|tsx|jsx|py|sh|ps1|css|html?|toml|ini|svg)$/i

/**
 * 递归收集目录下全部文件（相对 posix 路径 + 内容）。
 * @param {string} absDir 绝对目录
 * @param {string[]} warnings 告警收集
 * @returns {Array<{ path: string, encoding: string, data: string }>} 文件列表
 */
function collectDirFiles(absDir, warnings) {
  const out = []
  const walk = (dir, rel) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const abs = path.join(dir, entry.name)
      const relPath = rel === '' ? entry.name : rel + '/' + entry.name
      if (entry.isDirectory()) {
        walk(abs, relPath)
        continue
      }
      if (!entry.isFile()) continue
      if (out.length >= ITEM_FILES_LIMIT) {
        if (warnings.indexOf('文件数超过上限，后续文件已跳过') < 0) warnings.push('文件数超过上限，后续文件已跳过')
        continue
      }
      let stat
      try {
        stat = fs.statSync(abs)
      } catch {
        continue
      }
      if (stat.size > ITEM_FILE_LIMIT) {
        warnings.push('跳过超大文件：' + relPath)
        continue
      }
      let buf
      try {
        buf = fs.readFileSync(abs)
      } catch {
        warnings.push('读取失败：' + relPath)
        continue
      }
      if (ITEM_TEXT_RE.test(relPath)) {
        out.push({ path: relPath, encoding: 'utf8', data: buf.toString('utf8') })
      } else {
        out.push({ path: relPath, encoding: 'base64', data: buf.toString('base64') })
      }
    }
  }
  walk(absDir, '')
  return out
}

/**
 * `GET /export/item`：导出单个专家 / 专家团 / 技能为 `.json.gz`。
 *
 * 安全：专家 / 专家团的 `id` 先过 `safeId()` 单段目录名白名单，再用
 * `safeRepoDirReal()` 做「词法前缀 + realpath」双重校验，确保只读数据根内的目录；
 * 技能 id 是相对路径形式，保留 `index.skills.find` + `safeRepoPath` 的既有链路。
 * 错误文案只回显 id，不回显任何绝对路径。
 *
 * @param {import('node:http').ServerResponse} res 响应对象
 * @param {URLSearchParams} query 查询参数（type / id）
 * @returns {void}
 */
function handleExportItem(res, query) {
  const type = tidy(query.get('type') || '', 20)
  const id = tidy(query.get('id') || '', 200)
  if (['expert', 'team', 'skill'].indexOf(type) < 0) {
    send(res, { ok: false, error: '仅支持导出专家、专家团或技能' }, 400)
    return
  }
  if (id === '') {
    send(res, { ok: false, error: '缺少条目 id' }, 400)
    return
  }
  const index = requireIndex()
  if (index === null) {
    send(res, busyPayload(), 409)
    return
  }
  const root = dataRoot()
  if (root === null) {
    send(res, { ok: false, error: '没有可用的数据源' }, 409)
    return
  }

  const warnings = []
  let absDir = ''
  let relDir = ''
  let name = id
  let outType = type

  if (type === 'skill') {
    const item = index.skills.find((entry) => entry.id === id)
    if (item === undefined) {
      send(res, { ok: false, error: '未找到该技能：' + id }, 404)
      return
    }
    const skillFile = safeRepoPath(item.path)
    if (skillFile === null) {
      send(res, { ok: false, error: '技能路径非法或不可读：' + id }, 404)
      return
    }
    absDir = path.dirname(skillFile)
    relDir = toPosix(path.relative(root, absDir))
    name = tidy(item.name || item.id, 120) || id
  } else {
    /* 专家 / 专家团：id 必须是单段目录名。技能 id 是 `skills/<集合>/<名字>`
       形式的相对路径，不能套用 safeId，所以白名单只加在 expert / team 分支。
       旧实现只有 tidy（截断空白），`id=../../../..` 会让 path.join 逃出数据根，
       collectDirFiles 把整个盘符的文件读进下载包 —— 这里从源头堵住。 */
    const safe = safeId(id)
    if (safe === null) {
      send(res, { ok: false, error: '非法条目 id' }, 400)
      return
    }
    // 词法前缀 + realpath 双重校验：目录穿越与指向数据根外的符号链接都拒。
    const dir = safeRepoDirReal(path.join('experts', safe))
    if (dir === null) {
      send(res, { ok: false, error: '未找到该专家的源目录：' + safe + '（本地已导入但仓库里没有源目录的专家无法导出）' }, 404)
      return
    }
    // 专家 / 专家团：取仓库里的专家目录（含 plugin.json、role.md、skills/）
    absDir = dir
    relDir = toPosix(path.join('experts', safe))
    const meta = readJsonSafe(path.join(absDir, '.codebuddy-plugin', 'plugin.json'))
    name = meta !== null && typeof meta === 'object'
      ? (tidy(meta.expertName || meta.name || id, 120) || id)
      : id
    outType = meta !== null && typeof meta === 'object' && meta.expertType === 'team' ? 'team' : 'expert'
  }

  const files = collectDirFiles(absDir, warnings)
  if (files.length === 0) {
    send(res, { ok: false, error: '该条目没有可导出的文件' }, 422)
    return
  }

  const archive = {
    format: ITEM_ARCHIVE_FORMAT,
    version: 1,
    exportedAt: new Date().toISOString(),
    type: outType,
    id,
    name,
    dir: relDir,
    files,
    warnings,
  }
  let gzip
  try {
    gzip = zlib.gzipSync(Buffer.from(JSON.stringify(archive), 'utf8'))
  } catch (error) {
    send(res, { ok: false, error: '打包失败：' + humanError(error) }, 500)
    return
  }
  const safeFileName = (outType === 'skill' ? 'skill-' : outType === 'team' ? 'team-' : 'expert-') +
    String(id).replace(/[^A-Za-z0-9._-]+/g, '-')
  res.writeHead(200, {
    'Content-Type': 'application/gzip',
    'Content-Disposition': 'attachment; filename="' + safeFileName + '.json.gz"',
    'Content-Length': String(gzip.length),
  })
  res.end(gzip)
}

/**
 * `POST /import/item`：导入单条目包，只新增这一个条目。
 *
 * - 专家 / 专家团 → 先还原到临时 staging 目录，再复用 `writeDshExpertPackage`
 *   落盘到 `$DSH_HOME/experts/<id>/`（与仓库导入同一条链路）；
 * - 技能 → 落盘到 `$DSH_HOME/skills/<名字>/`（与 SkillHub 安装同目录，宿主启动时扫描）。
 *
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {Promise<Record<string, any>>} 响应载荷
 */
async function handleImportItem(req) {
  let raw
  try {
    raw = await readRawBody(req)
  } catch (error) {
    return { ok: false, error: humanError(error) }
  }
  if (raw.length === 0) return { ok: false, error: '未收到文件内容' }

  // gzip 魔数 0x1f8b → 解压，否则按明文 JSON。
  let text
  if (raw.length > 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    try {
      text = zlib.gunzipSync(raw).toString('utf8')
    } catch {
      return { ok: false, error: '文件解压失败（不是有效的 .json.gz）' }
    }
  } else {
    text = raw.toString('utf8')
  }

  let archive
  try {
    archive = JSON.parse(text)
  } catch {
    return { ok: false, error: '文件内容不是合法 JSON' }
  }
  if (archive === null || typeof archive !== 'object') return { ok: false, error: '包格式错误' }
  if (archive.format !== ITEM_ARCHIVE_FORMAT) {
    return { ok: false, error: '不是单个条目包（请用条目详情里的「导出」生成）' }
  }
  if (!Array.isArray(archive.files) || archive.files.length === 0) {
    return { ok: false, error: '包内没有文件' }
  }
  const type = archive.type === 'team' ? 'team' : archive.type === 'skill' ? 'skill' : 'expert'
  const id = tidy(archive.id || '', 120)
  if (safeId(id) === null) return { ok: false, error: '包内条目 id 非法' }
  if (archive.files.length > ITEM_FILES_LIMIT) return { ok: false, error: '包内文件过多' }

  /**
   * 写单个文件（含路径穿越防护）。
   * @param {string} baseDir 目标根
   * @param {Record<string, any>} file 文件条目
   * @returns {boolean} 是否写入成功
   */
  const writeOne = (baseDir, file) => {
    const relPath = tidy(String((file && file.path) || ''), 300)
    if (relPath === '' || relPath.split('/').indexOf('..') >= 0 || relPath.startsWith('/') || /^[a-zA-Z]:/.test(relPath)) {
      return false
    }
    const dest = path.join(baseDir, relPath)
    const rel = path.relative(baseDir, dest)
    if (rel.startsWith('..') || path.isAbsolute(rel)) return false
    const data = file.encoding === 'base64'
      ? Buffer.from(String(file.data || ''), 'base64')
      : Buffer.from(String(file.data || ''), 'utf8')
    if (data.length > ITEM_FILE_LIMIT) return false
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, data)
    return true
  }

  const name = tidy(archive.name || id, 120) || id

  // ---- 技能：直接落 $DSH_HOME/skills/<name>/ -----------------------------
  if (type === 'skill') {
    const dirName = id.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'imported-skill'
    const targetDir = path.join(SKILLS_INSTALL_DIR, dirName)
    // 技能包里的路径是相对技能目录的（archive.dir 的 basename 之下），统一平铺写入。
    const prefix = typeof archive.dir === 'string' ? archive.dir + '/' : ''
    let written = 0
    for (const file of archive.files) {
      const relPath = String((file && file.path) || '')
      const stripped = prefix !== '' && relPath.startsWith(prefix) ? relPath.slice(prefix.length) : relPath
      if (writeOne(targetDir, { path: stripped, encoding: file.encoding, data: file.data })) written += 1
    }
    if (written === 0) return { ok: false, error: '技能文件写入失败（路径非法或为空）' }
    if (!isFile(path.join(targetDir, 'SKILL.md'))) {
      return { ok: false, error: '包内缺少 SKILL.md，不是有效技能' }
    }
    return { ok: true, type: 'skill', id, name, dir: targetDir, fileCount: written, restartRequired: false }
  }

  // ---- 专家 / 专家团：staging → writeDshExpertPackage --------------------
  const stagingRoot = path.join(BASE_DIR, 'imported', '_staging-' + Date.now().toString(36))
  const stagingDir = path.join(stagingRoot, 'experts', id)
  try {
    fs.mkdirSync(stagingDir, { recursive: true })
    let written = 0
    // 包内路径形如 experts/<id>/role.md，去掉 `experts/<id>/` 前缀后落到 stagingDir。
    const prefix = typeof archive.dir === 'string' && archive.dir !== '' ? archive.dir + '/' : 'experts/' + id + '/'
    for (const file of archive.files) {
      const relPath = String((file && file.path) || '')
      const stripped = relPath.startsWith(prefix) ? relPath.slice(prefix.length) : relPath
      if (writeOne(stagingDir, { path: stripped, encoding: file.encoding, data: file.data })) written += 1
    }
    if (written === 0) throw new Error('包内文件路径非法')

    const plugin = readJsonSafe(path.join(stagingDir, '.codebuddy-plugin', 'plugin.json'))
    if (plugin === null || typeof plugin !== 'object') {
      throw new Error('包内缺少 .codebuddy-plugin/plugin.json，不是有效专家包')
    }
    plugin.__dirName = id

    const writtenPkg = writeDshExpertPackage(stagingRoot, plugin)
    if (writtenPkg.ok !== true) throw new Error(writtenPkg.error || '写入 DSH 专家目录失败')

    const targetDir = path.join(LOCAL_EXPERTS_DIR, id)
    const skillsCopied = copyExpertSkills(stagingDir, targetDir, id)

    if (state.importedIds.indexOf(id) < 0) {
      state.importedIds.push(id)
      persistState()
    }
    return {
      ok: true,
      type: type === 'team' ? 'team' : 'expert',
      id,
      name,
      dir: targetDir,
      files: writtenPkg.files || [],
      skillsCopied,
      restartRequired: false,
    }
  } catch (error) {
    return { ok: false, error: '导入失败：' + humanError(error) }
  } finally {
    // staging 只是一次性中转，尽力清理（Windows 文件锁失败忽略）。
    try {
      fs.rmSync(stagingRoot, { recursive: true, force: true })
    } catch {
      // 忽略
    }
  }
}

// ---------------------------------------------------------------------------
// 文件夹导入（POST /import/folder）：技能 / 专家 / 专家团
//
// 前端把所选目录里的文件（相对路径 + utf8/base64 内容）一次性 POST 过来：
//   1. 先按「所选目录本身就是一个条目」校验；
//   2. 不通过则按「一级子目录各是一个条目」批量校验（只看第一层，不递归）。
// 三种类型校验规则不同，已存在的目录一律不覆盖。
// ---------------------------------------------------------------------------

/** 文件夹导入：单文件上限（2MB）。 */
const FOLDER_FILE_LIMIT = 2 * 1024 * 1024

/** 文件夹导入：文件数量上限。 */
const FOLDER_FILES_LIMIT = 200

/** 文件夹导入：解码后总字节上限（20MB）。 */
const FOLDER_TOTAL_LIMIT = 20 * 1024 * 1024

/** 文件夹导入：HTTP 请求体上限（base64 膨胀后仍需留足余量）。 */
const FOLDER_BODY_LIMIT = 32 * 1024 * 1024

/**
 * 规整前端传来的相对路径：剥掉所选目录名这一层，并做路径穿越防护。
 * 拒绝空路径、绝对路径、Windows 盘符、反斜杠、.. 片段与 Windows 保留字符。
 * @param {any} raw 原始相对路径（通常来自 webkitRelativePath）
 * @param {string} rootName 所选目录名
 * @returns {string|null} 安全的 POSIX 相对路径；非法时返回 null
 */
function safeFolderPath(raw, rootName) {
  const text = String(raw === null || raw === undefined ? '' : raw)
  if (text === '' || text.length > 300) return null
  if (text.indexOf('\\') >= 0 || text.indexOf('\0') >= 0) return null
  if (text.startsWith('/') || /^[a-zA-Z]:/.test(text)) return null
  let parts = text.split('/')
  if (rootName !== '' && parts[0] === rootName) parts = parts.slice(1)
  parts = parts.filter((part) => part !== '' && part !== '.')
  if (parts.length === 0) return null
  for (const part of parts) {
    if (part === '..' || /[<>:"|?*]/.test(part)) return null
  }
  const rel = parts.join('/')
  return rel.length <= 300 ? rel : null
}

/**
 * 把文件夹条目里的 data 还原成字节。
 * @param {{ data?: any, encoding?: any }} file 文件条目
 * @returns {Buffer} 文件字节
 */
function folderFileBytes(file) {
  const raw = typeof file.data === 'string' ? file.data : ''
  return file.encoding === 'base64' ? Buffer.from(raw, 'base64') : Buffer.from(raw, 'utf8')
}

/**
 * 校验一个候选条目目录是否满足指定类型的格式要求。
 *
 * 三种类型互不相同：
 *   - skill：必须有 SKILL.md；frontmatter 解析不出 name 时用目录名兜底并标注；
 *   - expert：必须有 expert.yml + role.md（expert.yml 至少含 id / display_name），
 *     或可解析且含 name / displayName 的 .codebuddy-plugin/plugin.json；
 *   - team：在 expert 基础上还必须有 team.json（含 teamInfo 或 members 数组），
 *     或 plugin.json 里带团队信息。
 *
 * @param {'skill'|'expert'|'team'} type 条目类型
 * @param {Array<{ path: string, data: string, encoding: string }>} files 该目录下的文件
 * @param {string} dirName 目录名（技能名 / 专家 id 的兜底值）
 * @returns {{ ok: boolean, id: string, name: string, reasons: string[], notes: string[], pluginForm: boolean }} 校验结果
 */
function validateFolderEntry(type, files, dirName) {
  /** @type {string[]} */
  const reasons = []
  /** @type {string[]} */
  const notes = []
  const byPath = new Map()
  for (const file of files) byPath.set(file.path, file)

  /** @param {string} rel 相对路径 @returns {string|null} 文本内容 */
  const textOf = (rel) => {
    const file = byPath.get(rel)
    return file === undefined ? null : folderFileBytes(file).toString('utf8')
  }
  /** @param {string} rel 相对路径 @returns {Record<string, any>|null} 解析后的对象 */
  const jsonOf = (rel) => {
    const text = textOf(rel)
    if (text === null) return null
    try {
      const parsed = JSON.parse(text)
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  const skillMd = textOf('SKILL.md')
  const expertYml = textOf('expert.yml')
  const roleMd = textOf('role.md')
  const teamJson = jsonOf('team.json')
  const plugin = jsonOf('.codebuddy-plugin/plugin.json')
  const pluginReadable = plugin !== null &&
    ((typeof plugin.name === 'string' && plugin.name !== '') ||
      (typeof plugin.displayName === 'string' && plugin.displayName !== ''))

  // ---- 技能 ---------------------------------------------------------------
  if (type === 'skill') {
    if (skillMd === null) reasons.push('缺少 SKILL.md')
    let name = tidy(dirName, 120)
    if (skillMd !== null) {
      let front = null
      try {
        front = parseFrontmatter(skillMd)
      } catch {
        front = null
      }
      const fromFront = front !== null && typeof front.name === 'string' ? tidy(unquote(front.name), 120) : ''
      if (fromFront !== '') name = fromFront
      else notes.push('SKILL.md 未解析出 name，已用目录名「' + dirName + '」兜底')
    }
    const id = skillDirNameOf(name)
    if (id === '') reasons.push('技能名无法转成安全目录名')
    return { ok: reasons.length === 0, id, name, reasons, notes, pluginForm: false }
  }

  // ---- 专家 / 专家团 ------------------------------------------------------
  const nativeForm = expertYml !== null && roleMd !== null
  let id = tidy(dirName, 120)
  let name = tidy(dirName, 120)
  if (nativeForm) {
    const meta = parseFlatYaml(expertYml)
    if (typeof meta.id !== 'string' || meta.id === '') reasons.push('expert.yml 缺少 id')
    else id = tidy(meta.id, 120)
    if (typeof meta.display_name !== 'string' || meta.display_name === '') reasons.push('expert.yml 缺少 display_name')
    else name = tidy(meta.display_name, 120)
  } else if (pluginReadable) {
    id = tidy(typeof plugin.name === 'string' && plugin.name !== '' ? plugin.name : plugin.displayName, 120)
    name = tidy(typeof plugin.displayName === 'string' && plugin.displayName !== '' ? plugin.displayName : plugin.name, 120)
    notes.push('按 .codebuddy-plugin/plugin.json 兼容格式导入')
    if (roleMd === null) notes.push('缺少 role.md，已按清单描述生成')
  } else {
    reasons.push('缺少 expert.yml + role.md，也没有含 name / displayName 的 .codebuddy-plugin/plugin.json')
  }
  if (safeId(id) === null) {
    reasons.push('条目 id「' + id + '」非法（只允许字母数字开头，且仅含字母数字、点、下划线、连字符）')
  }
  if (type === 'team') {
    const teamOk = teamJson !== null &&
      (Array.isArray(teamJson.members) || (teamJson.teamInfo !== null && typeof teamJson.teamInfo === 'object'))
    const pluginTeamOk = pluginReadable &&
      (plugin.expertType === 'team' || Array.isArray(plugin.members) ||
        (plugin.teamInfo !== null && typeof plugin.teamInfo === 'object'))
    if (!teamOk && !pluginTeamOk) {
      reasons.push('缺少 team.json（需含 teamInfo 或 members 数组），plugin.json 里也没有团队信息')
    } else if (!teamOk && pluginTeamOk) {
      notes.push('团队信息来自 plugin.json，导入时会生成 team.json')
    }
  }
  return { ok: reasons.length === 0, id, name, reasons, notes, pluginForm: pluginReadable && !nativeForm }
}

/**
 * 检查落盘路径上是否已经存在符号链接，避免借符号链接写到目标目录之外。
 * @param {string} root 目标根目录
 * @param {string} relPath 相对路径
 * @returns {boolean} 是否发现符号链接
 */
function folderHasSymlink(root, relPath) {
  const parts = relPath.split('/')
  let current = root
  for (let i = 0; i < parts.length; i += 1) {
    current = path.join(current, parts[i])
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true
    } catch {
      // 路径还不存在，后续会由 mkdirSync 创建，视为无符号链接。
      return false
    }
  }
  return false
}

/**
 * 把一组文件写到目标目录（含符号链接检查与 path.relative 二次校验）。
 * @param {string} targetDir 目标目录
 * @param {Array<{ path: string, data: string, encoding: string }>} files 文件列表
 * @returns {boolean} 是否全部写入成功
 */
function writeFolderFiles(targetDir, files) {
  try {
    if (fs.lstatSync(targetDir).isSymbolicLink()) return false
  } catch {
    // 目标目录尚不存在，属于正常情况。
  }
  for (const file of files) {
    const dest = path.join(targetDir, file.path)
    const rel = path.relative(targetDir, dest)
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false
    if (folderHasSymlink(targetDir, file.path)) return false
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.writeFileSync(dest, folderFileBytes(file))
  }
  return true
}

/**
 * 导入一个已通过格式校验的候选条目；已存在目录绝不覆盖，直接返回 already:true。
 * @param {'skill'|'expert'|'team'} type 条目类型
 * @param {{ ok: boolean, id: string, name: string, reasons: string[], notes: string[], pluginForm: boolean }} entry 校验结果
 * @param {Array<{ path: string, data: string, encoding: string }>} files 该条目下的文件
 * @returns {{ ok: boolean, id: string, name: string, type: string, dir: string, already?: boolean, notes?: string[], error?: string }} 导入结果
 */
function importFolderEntry(type, entry, files) {
  const targetDir = type === 'skill'
    ? path.join(SKILLS_INSTALL_DIR, entry.id)
    : path.join(LOCAL_EXPERTS_DIR, entry.id)
  if (isDir(targetDir)) {
    return { ok: true, id: entry.id, name: entry.name, type, dir: targetDir, already: true, notes: entry.notes }
  }

  if (type === 'skill') {
    if (!writeFolderFiles(targetDir, files)) {
      return { ok: false, id: entry.id, name: entry.name, type, dir: targetDir, error: '技能文件写入失败（路径非法或存在符号链接）' }
    }
    return { ok: true, id: entry.id, name: entry.name, type, dir: targetDir, notes: entry.notes }
  }

  // 专家 / 专家团：原生格式直接落盘；plugin.json 形式先 staging 再复用转换逻辑。
  if (!entry.pluginForm) {
    if (!writeFolderFiles(targetDir, files)) {
      return { ok: false, id: entry.id, name: entry.name, type, dir: targetDir, error: '专家文件写入失败（路径非法或存在符号链接）' }
    }
    const source = {
      sourcePath: 'folder-import',
      pluginDir: entry.id,
      fingerprint: createHash('sha256')
        .update(files.map((file) => file.path + ':' + String(file.data)).join('\n'), 'utf8')
        .digest('hex'),
      importedAt: new Date().toISOString(),
      expertType: type === 'team' ? 'team' : 'agent',
      leadAgent: '',
      memberAgents: [],
      memberCount: 0,
      skills: [],
    }
    fs.writeFileSync(path.join(targetDir, '.expert-source.json'), JSON.stringify(source, null, 2), 'utf8')
  } else {
    const stamp = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
    const stagingRoot = path.join(BASE_DIR, 'imported', '_folder-' + stamp)
    const stagingDir = path.join(stagingRoot, 'experts', entry.id)
    try {
      if (!writeFolderFiles(stagingDir, files)) {
        return { ok: false, id: entry.id, name: entry.name, type, dir: targetDir, error: '专家文件写入失败（路径非法或存在符号链接）' }
      }
      const plugin = readJsonSafe(path.join(stagingDir, '.codebuddy-plugin', 'plugin.json'))
      if (plugin === null || typeof plugin !== 'object') {
        return { ok: false, id: entry.id, name: entry.name, type, dir: targetDir, error: '兼容格式缺少可解析的 plugin.json' }
      }
      plugin.__dirName = entry.id
      const roleText = files.find((file) => file.path === 'role.md')
      const desc = zhOnly(plugin.displayDescription) ||
        tidy(plugin.description_zh || '', 4000) ||
        tidy(plugin.description || '', 4000) ||
        enOnly(plugin.displayDescription)
      const roleBody = roleText === undefined ? '' : folderFileBytes(roleText).toString('utf8')
      if (!isFile(path.join(stagingDir, 'README.md'))) {
        fs.writeFileSync(path.join(stagingDir, 'README.md'),
          '# ' + entry.name + '\n\n' + (desc !== '' ? desc : roleBody), 'utf8')
      }
      if (!Array.isArray(plugin.agents) || plugin.agents.length === 0) plugin.agents = ['README.md']
      const writtenPkg = writeDshExpertPackage(stagingRoot, plugin)
      if (writtenPkg.ok !== true) {
        return { ok: false, id: entry.id, name: entry.name, type, dir: targetDir, error: writtenPkg.error || '写入 DSH 专家目录失败' }
      }
      copyExpertSkills(stagingDir, targetDir, entry.id)
    } catch (error) {
      return { ok: false, id: entry.id, name: entry.name, type, dir: targetDir, error: '导入失败：' + humanError(error) }
    } finally {
      try {
        fs.rmSync(stagingRoot, { recursive: true, force: true })
      } catch {
        // Windows 文件锁导致的清理失败忽略。
      }
    }
  }

  if (state.importedIds.indexOf(entry.id) < 0) {
    state.importedIds.push(entry.id)
    persistState()
  }
  return { ok: true, id: entry.id, name: entry.name, type, dir: targetDir, notes: entry.notes }
}

/**
 * `POST /import/folder`：从浏览器选择的文件夹导入技能 / 专家 / 专家团。
 *
 * 请求体：`{ type, rootName, files: [{ path, data, encoding }] }`。
 * 先按单条目模式校验，失败再按一级子目录批量导入；全部失败时 ok:false
 * 并给出可读的中文汇总。已存在目录不覆盖（幂等）。
 *
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {Promise<Record<string, any>>} 响应载荷
 */
async function handleImportFolder(req) {
  let raw
  try {
    raw = await readRawBody(req, FOLDER_BODY_LIMIT)
  } catch {
    return { ok: false, error: '请求体读取失败或过大（单文件 ≤ 2MB、最多 200 个文件、总计 ≤ 20MB）' }
  }
  let payload
  try {
    payload = JSON.parse(raw.toString('utf8'))
  } catch {
    return { ok: false, error: '请求体不是合法 JSON' }
  }
  if (payload === null || typeof payload !== 'object') return { ok: false, error: '请求体格式错误' }
  const type = payload.type === 'team' ? 'team' : payload.type === 'expert' ? 'expert' : payload.type === 'skill' ? 'skill' : null
  if (type === null) return { ok: false, error: '未知的导入类型（只支持 skill / expert / team）' }
  const typeLabel = type === 'skill' ? '技能' : type === 'team' ? '专家团' : '专家'
  const rootName = tidy(payload.rootName || '', 120)
  const rawFiles = Array.isArray(payload.files) ? payload.files : []
  if (rawFiles.length === 0) return { ok: false, error: '所选目录里没有可导入的文件' }
  if (rawFiles.length > FOLDER_FILES_LIMIT) return { ok: false, error: '文件数量超过上限（最多 200 个）' }

  /** @type {Array<{ path: string, data: string, encoding: string }>} */
  const files = []
  let total = 0
  for (const rawFile of rawFiles) {
    const rel = safeFolderPath(rawFile === null || rawFile === undefined ? '' : rawFile.path, rootName)
    if (rel === null) {
      return { ok: false, error: '文件路径非法（含 .. / 绝对路径 / 盘符 / 反斜杠）：' + tidy(rawFile === null || rawFile === undefined ? '' : rawFile.path, 120) }
    }
    const encoding = rawFile.encoding === 'base64' ? 'base64' : 'utf8'
    const data = typeof rawFile.data === 'string' ? rawFile.data : ''
    const bytes = folderFileBytes({ data, encoding })
    if (bytes.length > FOLDER_FILE_LIMIT) return { ok: false, error: '单文件超过 2MB：' + rel }
    total += bytes.length
    if (total > FOLDER_TOTAL_LIMIT) return { ok: false, error: '文件总大小超过 20MB 上限' }
    files.push({ path: rel, data, encoding })
  }

  // ---- 模式一：所选目录本身就是一个条目 ----------------------------------
  const single = validateFolderEntry(type, files, rootName || 'import')
  if (single.ok === true) {
    const result = importFolderEntry(type, single, files)
    if (result.ok === true) return { ok: true, mode: 'single', imported: [result], skipped: [] }
    return {
      ok: false,
      mode: 'single',
      imported: [],
      skipped: [{ dir: rootName || 'import', reason: result.error || '写入失败' }],
      error: '所选目录符合' + typeLabel + '格式，但写入失败：' + (result.error || '未知原因'),
    }
  }

  // ---- 模式二：一级子目录各是一个条目（只取第一层，不递归） --------------
  /** @type {Map<string, Array<{ path: string, data: string, encoding: string }>>} */
  const groups = new Map()
  for (const file of files) {
    const parts = file.path.split('/')
    if (parts.length < 2) continue
    const dir = parts[0]
    if (!groups.has(dir)) groups.set(dir, [])
    groups.get(dir).push({ path: parts.slice(1).join('/'), data: file.data, encoding: file.encoding })
  }
  if (groups.size === 0) {
    const reason = single.reasons.join('；')
    return {
      ok: false,
      mode: 'batch',
      imported: [],
      skipped: [{ dir: rootName || 'import', reason }],
      error: '所选目录不符合' + typeLabel + '格式：' + reason + '；也不是批量目录：没有一级子目录',
    }
  }

  /** @type {Array<Record<string, any>>} */
  const imported = []
  /** @type {Array<Record<string, any>>} */
  const skipped = []
  for (const [dir, groupFiles] of groups) {
    const check = validateFolderEntry(type, groupFiles, dir)
    if (check.ok !== true) {
      skipped.push({ dir, reason: check.reasons.join('；') })
      continue
    }
    const result = importFolderEntry(type, check, groupFiles)
    if (result.ok === true) imported.push(result)
    else skipped.push({ dir, reason: result.error || '写入失败' })
  }
  if (imported.length === 0) {
    const detail = skipped.map((item) => item.dir + '：' + item.reason).join('；')
    return {
      ok: false,
      mode: 'batch',
      imported,
      skipped,
      error: '所选目录不符合' + typeLabel + '格式：' + single.reasons.join('；') +
        '；也不是批量目录：' + String(groups.size) + ' 个子目录均校验失败（' + detail + '）',
    }
  }
  return { ok: true, mode: 'batch', imported, skipped }
}

function handleExport(res) {
  if (exportBusy) {
    send(res, { ok: false, error: '导出正在进行中，请稍候' }, 409)
    return
  }
  exportBusy = true
  try {
    const { bundle, warnings } = buildExportBundle()
    bundle.warnings = warnings
    const gzip = zlib.gzipSync(Buffer.from(JSON.stringify(bundle), 'utf8'))
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-')
    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Disposition': 'attachment; filename="dsh-buddy-expert-hub-export-' + stamp + '.json.gz"',
      'Content-Length': String(gzip.length),
    })
    res.end(gzip)
  } finally {
    exportBusy = false
  }
}

/**
 * `POST /library/import`：接收整包字节 → 校验 → 原子落盘 → 切换数据源。
 *
 * 失败时绝不动现有 state.json；切换前先备份 state.json.bak。
 *
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {Promise<Record<string, any>>} 响应载荷
 */
async function handleLibraryImport(req) {
  let raw
  try {
    raw = await readRawBody(req)
  } catch (error) {
    return { ok: false, error: humanError(error) }
  }
  if (raw.length === 0) return { ok: false, error: '未收到文件内容' }

  // gzip 魔数 0x1f8b → 解压；否则按明文 JSON 处理。
  let text
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    try {
      text = zlib.gunzipSync(raw).toString('utf8')
    } catch {
      return { ok: false, error: '导入失败：文件已损坏，无法解压（期望 dsh-buddy-expert-hub 导出包）' }
    }
  } else {
    text = raw.toString('utf8')
  }

  let bundle
  try {
    bundle = JSON.parse(text)
  } catch {
    return { ok: false, error: '导入失败：文件格式不正确（期望 dsh-buddy-expert-hub 导出包）' }
  }
  if (bundle === null || typeof bundle !== 'object' || bundle.kind !== EXPORT_KIND || bundle.formatVersion !== EXPORT_FORMAT_VERSION) {
    return { ok: false, error: '导入失败：文件格式不正确（期望 dsh-buddy-expert-hub 导出包）' }
  }
  if (!Array.isArray(bundle.experts) || !Array.isArray(bundle.skills) || !Array.isArray(bundle.connectors)) {
    return { ok: false, error: '导入失败：导出包数据不完整' }
  }

  // 原子落盘：先写临时目录，成功后 rename 成正式目录。
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const targetDir = path.join(LIBRARY_DIR, stamp)
  const tmpDir = path.join(LIBRARY_DIR, '.tmp-' + stamp)
  try {
    fs.mkdirSync(tmpDir, { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'bundle.json'), JSON.stringify(bundle), 'utf8')
    fs.rmSync(targetDir, { recursive: true, force: true })
    fs.renameSync(tmpDir, targetDir)
  } catch (error) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响响应
    }
    return { ok: false, error: '导入失败：无法写入资料库目录（' + humanError(error) + '）' }
  }

  // 切换前备份 state.json，解析失败也不能留半截状态。
  try {
    if (isFile(STATE_FILE)) fs.copyFileSync(STATE_FILE, STATE_FILE + '.bak')
  } catch {
    // 备份失败不阻断导入（state 本身还没动）
  }

  state.library = {
    dir: targetDir,
    importedAt: new Date().toISOString(),
    previousDataRoot: dataRoot() === null ? '' : dataRoot(),
  }
  libraryBundleCache = { dir: null, bundle: null }
  state.index = null
  persistState()

  // 立即用 bundle 重建索引，让本次响应就能带回最新计数。
  const index = loadIndexCache() !== null ? state.index : buildIndex(dataRoot())
  saveIndex(index)
  state.index = index
  state.lastSync = index.builtAt
  persistState()

  return {
    ok: true,
    dir: targetDir,
    importedAt: state.library.importedAt,
    counts: {
      experts: index.counts.experts,
      teams: index.counts.teams,
      skills: index.counts.skills,
      connectors: countConnectorSources(mergedConnectors()).all,
    },
  }
}

/**
 * `POST /library/reset`：清掉 library 状态，恢复 previousDataRoot 并重建索引。
 * @returns {Record<string, any>} 响应载荷
 */
function handleLibraryReset() {
  if (state.library === null) {
    return { ok: false, error: '当前未处于本地资料库模式' }
  }
  const previous = state.library.previousDataRoot
  state.library = null
  libraryBundleCache = { dir: null, bundle: null }
  state.index = null
  // 恢复记录的数据根；目录已消失时清缓存走常规解析（可能触发重新克隆）。
  dataRootCache = previous !== '' && hasExpertsDir(previous) ? previous : null
  persistState()

  const index = loadIndexCache() !== null ? state.index : buildIndex(dataRoot())
  if (index !== null) {
    saveIndex(index)
    state.index = index
    state.lastSync = index.builtAt
    state.lastDataRoot = index.dataRoot === '' ? state.lastDataRoot : index.dataRoot
  } else {
    kickSync(false)
  }
  persistState()

  const root = dataRoot()
  return {
    ok: true,
    dataRoot: root,
    counts: index === null ? null : {
      experts: index.counts.experts,
      teams: index.counts.teams,
      skills: index.counts.skills,
      connectors: countConnectorSources(mergedConnectors()).all,
    },
  }
}

/**
 * 校验本地专家 id：只允许字母数字与 `._-`，并排除 `.` / `..`。
 * @param {string|null} value 原始值
 * @returns {string|null} 合法值或 null
 */
function safeLocalId(value) {
  if (typeof value !== 'string') return null
  if (!/^[A-Za-z0-9._-]+$/.test(value)) return null
  if (value === '.' || value === '..') return null
  return value
}

/**
 * `/local-avatar`：本地已导入专家的头像。
 * @param {import('node:http').ServerResponse} res 响应对象
 * @param {URLSearchParams} query 查询参数
 * @returns {void}
 */
function handleLocalAvatar(res, query) {
  const id = safeLocalId(query.get('id'))
  if (id === null || !isDir(LOCAL_EXPERTS_DIR)) {
    send(res, { ok: false, error: '头像不存在' }, 404)
    return
  }
  const absolute = findLocalAvatar(path.join(LOCAL_EXPERTS_DIR, id))
  if (absolute === null) {
    send(res, { ok: false, error: '头像不存在' }, 404)
    return
  }
  sendImage(res, absolute)
}

/**
 * `/refresh`：触发同步；始终保证 `dsh-buddy-expert-hub/repo` 就绪（技能只在那里）。
 * @param {URLSearchParams} query 查询参数（`wait=1` 时等待完成）
 * @returns {Promise<Record<string, any>>} 响应载荷
 */
async function handleRefresh(query) {
  // library 模式下同步针对的是仓库数据源，直接同步会把资料库切没 —— 拒绝并提示。
  if (state.library !== null) {
    return { ok: false, error: '当前为本地资料库，切回原数据源后可同步' }
  }
  const wait = query.get('wait') === '1'
  if (state.busy) {
    // busy 分支返回的是「正在进行的同步」状态：若那次同步已失败，ok 必须是 false，
    // 不能被 handleStatus() 的 ok:true 顶掉（QA 实测 wait=1 恒 true 的根因）。
    const status = handleStatus()
    return Object.assign(status, { ok: status.lastError === null, started: false })
  }
  state.index = null
  /* 触发前先删盘上的索引缓存：同步失败时它不会被 loadIndexCache() 重新装回内存，
     /status 不会用旧数据假装成功。成功路径由 runSync 重新写入。 */
  try {
    fs.rmSync(INDEX_FILE, { force: true })
  } catch {
    // 删除失败不阻断刷新
  }
  if (wait) {
    await runSync(true)
    // handleStatus() 自带 ok:true，必须放在前面，否则会把「同步失败」覆盖成成功。
    return Object.assign(handleStatus(), { ok: state.lastError === null, started: true })
  }
  void runSync(true)
  return Object.assign({ ok: true, started: true }, handleStatus())
}

// ---------------------------------------------------------------------------
// 路由分发
// ---------------------------------------------------------------------------

/** 允许访问本插件 HTTP 接口的本地主机名（小写、不含端口与方括号）。 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

/**
 * 从 `Host` 头解析主机名（去掉端口与 IPv6 方括号，统一小写）。
 *
 * 支持 `localhost:5173`、`127.0.0.1:5173`、`[::1]:5173`、`::1` 四种写法；
 * 解析不出主机名时返回空串，由调用方拒绝。
 *
 * @param {string} value Host 头原始值
 * @returns {string} 主机名（小写），不合法时为空串
 */
function hostNameOf(value) {
  const text = String(value === null || value === undefined ? '' : value).trim().toLowerCase()
  if (text === '') return ''
  if (text.startsWith('[')) {
    const end = text.indexOf(']')
    if (end < 1) return ''
    return text.slice(1, end)
  }
  const colons = (text.match(/:/g) || []).length
  if (colons === 1) {
    const cut = text.lastIndexOf(':')
    return /^\d*$/.test(text.slice(cut + 1)) ? text.slice(0, cut) : text
  }
  return text
}

/**
 * 从 `Origin` 头解析主机名；只接受 http(s) 绝对地址。
 *
 * `Origin: null`（沙箱 iframe / file 页面）与非法 URL 都返回空串。
 * Node 的 `URL.hostname` 对 IPv6 会保留方括号，这里一并剥掉。
 *
 * @param {string} value Origin 头原始值
 * @returns {string} 主机名（小写），不合法时为空串
 */
function originHostOf(value) {
  const text = String(value === null || value === undefined ? '' : value).trim()
  if (text === '' || text.toLowerCase() === 'null') return ''
  try {
    const parsed = new URL(text)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return ''
    let host = String(parsed.hostname || '').toLowerCase()
    if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
    return host
  } catch {
    return ''
  }
}

/**
 * 校验请求是否来自本机同源（防 DNS rebinding 与跨站 CSRF）。
 *
 * 纯函数，不读写任何全局状态，便于单测。规则：
 *  1. `Host` 只能是 `localhost` / `127.0.0.1` / `::1`（可带端口）；
 *  2. 带 `Origin` 时，其 host 必须是上述本地 host，且与 `Host` 一致；
 *  3. `Sec-Fetch-Site: cross-site` 一律拒；`cross-origin` 且 Origin 不同源时拒；
 *  4. **允许没有任何 Origin 的同源请求**：插件自己的 fetch、curl 与验收脚本
 *     都依赖这条，不强制非 GET 请求带自定义头；
 *  5. 三个头都缺失时视为本地直连，放行（真实 HTTP/1.1 一定有 Host，
 *     宿主会在到达这里之前保证；插件内嵌的极简请求对象也走这条）。
 *
 * @param {{ host?: string, origin?: string, secFetchSite?: string }} headers 归一化后的请求头
 * @returns {{ ok: boolean, reason: string }} 校验结果；reason 仅用于内部排查，不回传客户端
 */
export function localRequestGuard(headers) {
  const raw = headers !== null && typeof headers === 'object' ? headers : {}
  const hostHeader = typeof raw.host === 'string' ? raw.host.trim() : ''
  const originHeader = typeof raw.origin === 'string' ? raw.origin.trim() : ''
  const fetchSite = typeof raw.secFetchSite === 'string' ? raw.secFetchSite.trim().toLowerCase() : ''

  if (hostHeader === '' && originHeader === '' && fetchSite === '') return { ok: true, reason: '' }
  const host = hostHeader === '' ? '' : hostNameOf(hostHeader)
  if (hostHeader !== '' && !LOCAL_HOSTS.has(host)) return { ok: false, reason: '非法的 Host' }
  if (fetchSite === 'cross-site') return { ok: false, reason: '跨站请求被拒绝' }

  const originHost = originHeader === '' ? '' : originHostOf(originHeader)
  if (originHeader !== '' && !LOCAL_HOSTS.has(originHost)) return { ok: false, reason: 'Origin 不同源' }
  if (hostHeader !== '' && originHeader !== '' && originHost !== host) {
    return { ok: false, reason: 'Origin 与 Host 不同源' }
  }
  if (fetchSite === 'cross-origin' && (originHeader === '' || originHost !== host)) {
    return { ok: false, reason: '跨源请求被拒绝' }
  }
  return { ok: true, reason: '' }
}

/**
 * 取一个请求头的值；Node 里头名恒为小写，数组值取第一项。
 * @param {Record<string, any>} headers 请求头对象
 * @param {string} name 头名（小写）
 * @returns {string} 头值，缺失或非字符串时为空串
 */
function headerValue(headers, name) {
  const value = headers[name]
  if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : ''
  return typeof value === 'string' ? value : ''
}

/**
 * 统一路由分发器。
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @param {import('node:http').ServerResponse} res 响应对象
 * @returns {Promise<void>}
 */
async function dispatch(req, res) {
  const url = new URL(req.url === undefined || req.url === null ? '/' : req.url, 'http://x')
  const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'
  const query = url.searchParams
  const method = String(req.method || 'GET').toUpperCase()

  // 任何路由之前先挡住非本机来源：DNS rebinding 与跨站表单都到不了业务处理器。
  const reqHeaders = req.headers !== null && typeof req.headers === 'object' ? req.headers : {}
  const guard = localRequestGuard({
    host: headerValue(reqHeaders, 'host'),
    origin: headerValue(reqHeaders, 'origin'),
    secFetchSite: headerValue(reqHeaders, 'sec-fetch-site'),
  })
  if (guard.ok !== true) {
    send(res, { ok: false, error: '请求来源不被允许' }, 403)
    return
  }

  try {
    if (route === '/status') {
      send(res, handleStatus())
      return
    }
    if (route === '/refresh') {
      if (method !== 'POST' && method !== 'GET') {
        send(res, { ok: false, error: '仅支持 POST' }, 405)
        return
      }
      send(res, await handleRefresh(query))
      return
    }
    if (route === '/experts') {
      send(res, handleExpertList(query, 'agent'))
      return
    }
    if (route === '/teams') {
      send(res, handleExpertList(query, 'team'))
      return
    }
    if (route === '/categories') {
      send(res, handleCategories())
      return
    }
    if (route === '/skills') {
      send(res, handleSkills(query))
      return
    }
    if (route === '/connectors') {
      send(res, handleConnectors(query))
      return
    }
    if (route === '/connectors/install' || route === '/connectors/create' || route === '/connectors/uninstall') {
      if (method !== 'POST') {
        send(res, { ok: false, error: '仅支持 POST' }, 405)
        return
      }
      const out = route === '/connectors/install'
        ? await handleConnectorInstall(req)
        : route === '/connectors/create'
          ? await handleConnectorCreate(req)
          : await handleConnectorUninstall(req)
      send(res, out, out.ok === true ? 200 : 400)
      return
    }
    if (route === '/pick') {
      send(res, handlePick(query))
      return
    }
    if (route === '/detail') {
      send(res, handleDetail(query))
      return
    }
    if (route === '/asset') {
      handleAsset(res, query)
      return
    }
    if (route === '/icon') {
      handleIcon(res, query)
      return
    }
    if (route === '/local-avatar') {
      handleLocalAvatar(res, query)
      return
    }
    if (route === '/import') {
      if (method !== 'POST') {
        send(res, { ok: false, error: '仅支持 POST' }, 405)
        return
      }
      send(res, await handleImport(req))
      return
    }
    if (route === '/imported') {
      send(res, handleImported())
      return
    }
    if (route === '/skills/fetch') {
      if (method !== 'POST') {
        send(res, { ok: false, error: '仅支持 POST' }, 405)
        return
      }
      // 业务失败（未声明 / missing / 未同步）按 400 回，前端取 error 文案提示。
      const out = await handleSkillFetch(req)
      send(res, out, out.ok === false ? 400 : 200)
      return
    }
    if (route === '/attach') {
      if (method !== 'POST') {
        send(res, { ok: false, error: '仅支持 POST' }, 405)
        return
      }
      const out = await handleAttach(req)
      const status = typeof out.__status === 'number' ? out.__status : 200
      const body = Object.assign({}, out)
      delete body.__status
      send(res, body, status)
      return
    }
    if (route === '/detach') {
      if (method !== 'POST') {
        send(res, { ok: false, error: '仅支持 POST' }, 405)
        return
      }
      const out = await handleDetach(req)
      const status = typeof out.__status === 'number' ? out.__status : 200
      const body = Object.assign({}, out)
      delete body.__status
      send(res, body, status)
      return
    }
    if (route === '/attachments') {
      send(res, handleAttachments(query))
      return
    }
    if (route === '/export') {
      if (method !== 'GET') {
        send(res, { ok: false, error: '仅支持 GET' }, 405)
        return
      }
      handleExport(res)
      return
    }
    if (route === '/export/item') {
      if (method !== 'GET') {
        send(res, { ok: false, error: '仅支持 GET' }, 405)
        return
      }
      handleExportItem(res, query)
      return
    }
    if (route === '/import/item') {
      if (method !== 'POST') {
        send(res, { ok: false, error: '仅支持 POST' }, 405)
        return
      }
      send(res, await handleImportItem(req))
      return
    }
    if (route === '/import/folder') {
      if (method !== 'POST') {
        send(res, { ok: false, error: '仅支持 POST' }, 405)
        return
      }
      send(res, await handleImportFolder(req))
      return
    }
    if (route === '/library/import') {
      if (method !== 'POST') {
        send(res, { ok: false, error: '仅支持 POST' }, 405)
        return
      }
      send(res, await handleLibraryImport(req))
      return
    }
    if (route === '/library/reset') {
      if (method !== 'POST') {
        send(res, { ok: false, error: '仅支持 POST' }, 405)
        return
      }
      send(res, handleLibraryReset())
      return
    }
    if (route === '/settings') {
      if (method === 'GET') {
        send(res, handleSettingsGet())
        return
      }
      if (method !== 'POST') {
        send(res, { ok: false, error: '仅支持 GET / POST' }, 405)
        return
      }
      const out = await handleSettingsSave(req)
      send(res, out.body, out.status)
      return
    }
    if (route === '/settings/reset') {
      if (method !== 'POST') {
        send(res, { ok: false, error: '仅支持 POST' }, 405)
        return
      }
      const out = handleSettingsReset()
      send(res, out.body, out.status)
      return
    }
    if (route === '/skillhub/categories') {
      if (method !== 'GET') {
        send(res, { ok: false, error: '仅支持 GET' }, 405)
        return
      }
      send(res, await handleSkillhubCategories())
      return
    }
    if (route === '/skillhub/search') {
      if (method !== 'GET') {
        send(res, { ok: false, error: '仅支持 GET' }, 405)
        return
      }
      send(res, await handleSkillhubSearch(query))
      return
    }
    if (route === '/skillhub/installed') {
      if (method !== 'GET') {
        send(res, { ok: false, error: '仅支持 GET' }, 405)
        return
      }
      send(res, handleSkillhubInstalled())
      return
    }
    if (route === '/skillhub/detail') {
      if (method !== 'GET') {
        send(res, { ok: false, error: '仅支持 GET' }, 405)
        return
      }
      send(res, await handleSkillhubDetail(query))
      return
    }
    if (route === '/skills/installed') {
      if (method !== 'GET') {
        send(res, { ok: false, error: '仅支持 GET' }, 405)
        return
      }
      send(res, handleInstalledSkills())
      return
    }
    if (route === '/skills/install') {
      if (method !== 'POST') {
        send(res, { ok: false, error: '仅支持 POST' }, 405)
        return
      }
      const out = await handleInstallRepoSkill(req)
      send(res, out, out.ok === true ? 200 : 400)
      return
    }
    if (route === '/skills/toggle') {
      if (method !== 'POST') {
        send(res, { ok: false, error: '仅支持 POST' }, 405)
        return
      }
      const out = await handleToggleSkill(req)
      send(res, out, out.ok === true ? 200 : 400)
      return
    }
    if (route === '/builtin/skills') {
      if (method !== 'GET') {
        send(res, { ok: false, error: '仅支持 GET' }, 405)
        return
      }
      send(res, handleBuiltinSkillsGet())
      return
    }
    if (route === '/builtin/skills/toggle') {
      if (method !== 'POST') {
        send(res, { ok: false, error: '仅支持 POST' }, 405)
        return
      }
      const out = await handleBuiltinSkillsToggle(req)
      send(res, out, out.ok === true ? 200 : 400)
      return
    }
    if (route === '/connectors/connected') {
      if (method !== 'GET') {
        send(res, { ok: false, error: '仅支持 GET' }, 405)
        return
      }
      send(res, handleConnectedConnectors())
      return
    }
    if (route === '/connectors/provision/preview') {
      if (method !== 'GET') {
        send(res, { ok: false, error: '仅支持 GET' }, 405)
        return
      }
      send(res, handleConnectorProvisionPreview(query))
      return
    }
    if (route === '/connectors/provision') {
      if (method !== 'POST') {
        send(res, { ok: false, error: '仅支持 POST' }, 405)
        return
      }
      const out = await handleConnectorProvision(req)
      send(res, out, out.ok === true ? 200 : 400)
      return
    }
    if (route === '/connectors/connect' || route === '/connectors/disconnect') {
      if (method !== 'POST') {
        send(res, { ok: false, error: '仅支持 POST' }, 405)
        return
      }
      const out = await handleConnectorConnect(req, route === '/connectors/connect')
      send(res, out, out.ok === true ? 200 : 400)
      return
    }
    if (route === '/skillhub/install') {
      if (method !== 'POST') {
        send(res, { ok: false, error: '仅支持 POST' }, 405)
        return
      }
      const out = await handleSkillhubInstall(req)
      const status = typeof out.httpStatus === 'number' ? out.httpStatus : 200
      const body = Object.assign({}, out)
      delete body.httpStatus
      send(res, body, status)
      return
    }
    send(res, { ok: false, error: '未知接口：' + route }, 404)
  } catch (error) {
    send(res, fail(error), 500)
  }
}

// ---------------------------------------------------------------------------
// 插件导出
// ---------------------------------------------------------------------------

/** 插件名。 */
export const name = 'dsh-buddy-expert-hub'

/** 依赖的服务。 */
export const inject = ['webServer', 'agents']

/**
 * 插件入口。
 * @param {any} ctx cordis 上下文
 * @returns {void}
 */
export function apply(ctx) {
  try {
    restoreState()
    ensureDirsQuiet()
    // 预加载索引缓存，避免首个请求多一次 IO。
    loadIndexCache()

    // 供 /attach /detach 软取 agents / skills 服务（缺失时接口返回 501，不崩插件）。
    hostCtx = ctx

    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: (req, res) => {
            void dispatch(req, res).catch((error) => {
              try {
                send(res, fail(error), 500)
              } catch {
                // 响应已结束，忽略
              }
            })
          },
        }),
      'dsh-buddy-expert-hub: routes',
    )

    // agent 生命周期接线：created 时补挂 pending，disposed 时清理注册表
    // （agent 作用域的技能注册本身也会被宿主自动 unwind，这里只是清账）。
    if (typeof ctx.on === 'function') {
      ctx.on('agent/created', ({ agent }) => {
        void flushPendingAttaches(agent).catch((error) => {
          state.warnings.push('agent 技能挂载失败：' + humanError(error))
        })
        void flushPendingConnectors(agent).catch((error) => {
          state.warnings.push('agent 连接器挂载失败：' + humanError(error))
        })
      })
      ctx.on('agent/disposed', ({ agent }) => {
        try {
          detachExpert(agent.id, null)
        } catch {
          // 清理失败不影响宿主
        }
        try {
          // 清账：这里清连接器注册表（含 pending）；专家注册表已由上面的
          // detachExpert(agent.id, null) 清掉。两个注册表各自独立清理、都会被清。
          detachConnector(agent.id, null)
        } catch {
          // 同上：两个注册表各自独立清理，互不牵连
        }
      })
    }
  } catch (error) {
    // 绝不让插件异常阻断 dsh web 启动。
    // eslint-disable-next-line no-console
    console.error('[dsh-buddy-expert-hub] 初始化失败：', error)
  }
}
