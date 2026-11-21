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
import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
// frontmatter 解析只有一份实现，与 scripts/build-connectors.mjs 共用（块标量坑踩过两次）
import { parseFrontmatter, unquote } from './frontmatter.js'
// 插件自升级：查 npm 最新版 / 下载 / 校验 / 覆盖 / 回滚（零依赖，自带 tar 解析）
import { applyUpdate, checkUpdate, readSelfMeta, compareVersion } from './plugin-update.js'
// 私有 Git 仓库凭据：复用连接器那套 AES-256-GCM 本地加密文件，令牌不落 state.json、不回显
import { readSecrets, saveSecrets } from './connector-secret.js'
import { ZhiliaoWsClient } from './zhiliao-ws.js'
// 个人工作台：HTML 托管 + CSV 双向同步（CAS）+ 菜单声明解析
import {
  WORKBENCH_DIR, workbenchHtmlDir, safePath,
  listWorkbenches,
  localWorkbenchDirError,
  handleWorkbenchList,
  handleWorkbenchHtml,
  handleWorkbenchBridge,
  handleWorkbenchDataGet,
  handleWorkbenchDataPost,
  handleWorkbenchDataPostBody,
} from './workbench.js'
// 在线资料库：API 客户端 + 工作台「在线优先 / 本地兜底」适配层
import {
  KHUB_CLIENT_SECRET_KEY, KHUB_API_KEY_KEY, KHUB_DEFAULT_SETTINGS,
  configFromSettings, configReady, publicSettings, isValidBaseUrl,
} from './knowledge-hub.js'
import {
  getCatalog, handleKhubWorkbenchList, handleKhubWorkbenchHtml,
  handleKhubWorkbenchDataGet, handleKhubWorkbenchDataPost,
  handleKhubHtml, handleKhubRaw, handleKhubApi, handleKhubOfficeFrame,
  uploadLocalWorkbench,
} from './khub-workbench.js'
import { readCsv } from './csv.js'
// 外部数据定时摄入：批次校验 / 本地镜像 / 在线增量推送 / 待补推队列（dsh 自动化任务写入）
import {
  INGEST_DEFAULTS, applyBatch, processInbox, flushPending, ingestStatus,
  ensureIngestDirs, sendMirrorDataGet, writeMirrorFromPayload, onlineNodeIdOf,
} from './ingest.js'
// 智聊：三表状态 + dedupe + chatKey→sessionId + HMAC 验签 + 绑定解析（零依赖，JSON 落盘）
import {
  ZHILIAO_DEFAULT_SECRET, ZHILIAO_TEST_TOKEN,
  loadZhiliaState, saveZhiliaState, checkDedupe, markProcessing, markDone,
  markFailed, resetStaleProcessing, stableSessionId,
  withZhiliaState as withZhiliaStateTx, flushZhiliaState, zhiliaStateDiagnostics,
  listBindings, saveBinding, removeBinding, findBindingById, findBindingByUserId,
  getOrCreateChatSession, findChatSession, updateChatSession,
  savePendingReply, findPendingReply, listPendingReplies, removePendingReply,
  verifyWebhookSign, resolveBinding,
} from './zhiliao.js'
// 智聊阶段 3：分区串行队列 + 全局并发闸；闲时回收器（默认关闭）
import { ZhiliaoQueue } from './zhiliao-queue.js'
import { ZhiliaoRecycler } from './zhiliao-recycle.js'
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
// 远程配置：用户填 http URL 或上传 JSON，覆盖设置页参数（纯解析模块，语义校验由本文件注入）
import {
  DEFAULT_REMOTE_CONFIG_META, REMOTE_CONFIG_FIELD_DOCS,
  normalizeRemoteConfig, sampleConfigText, stripJsonComments,
} from './remote-config.js'
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

/* ---------------------------------------------------------------------------
 * 个人工作台 v2：常驻能力索引 / 创建技能 / 风格主题枚举
 * ------------------------------------------------------------------------- */

/** 工作台 id 形状（与菜单声明校验同一条规则）；左侧文件树排序按它白名单过滤。 */
const WORKBENCH_ID_SHAPE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** 单个内置技能文件的字节上限（防止误把大二进制塞进包）。 */
const BUILTIN_MAX_FILE_BYTES = 2 * 1024 * 1024

/** 单个内置技能的总体积上限。 */
const BUILTIN_MAX_TOTAL_BYTES = 40 * 1024 * 1024

/** 单个内置技能的文件数上限。 */
const BUILTIN_MAX_FILES = 400

/** 数据源仓库地址。 */
const SOURCE_URL = 'https://gitcode.com/zzx_2446/dsh-buddy-expert-hub-resource.git'
/** 私有资源仓库凭据在 credentials.enc 里的键名。 */
const SOURCE_AUTH_USER_KEY = 'DSH_SOURCE_GIT_USER'
const SOURCE_AUTH_TOKEN_KEY = 'DSH_SOURCE_GIT_TOKEN'
/** `/settings/branches` 返回的分支候选上限，避免超大仓库撑爆响应。 */
const MAX_BRANCH_OPTIONS = 10

/** 路由前缀，client 端所有请求都以它开头。 */
const ROUTE_PREFIX = '/dsh-buddy-expert-hub'

/** 远程配置：拉取超时（毫秒）与响应体上限，避免慢/大 URL 拖住插件。 */
const REMOTE_CONFIG_TIMEOUT_MS = 15000
const REMOTE_CONFIG_MAX_BYTES = 2 * 1024 * 1024
/* 远程下发 khub 密钥前，把本地原密钥备份到 credentials.enc 的这两个专用键；
   清除远程配置时读回还原。密钥明文绝不进 state.json 快照。 */
const REMOTE_BAK_CLIENT_SECRET = 'DSH_REMOTE_BAK_KHUB_CLIENT_SECRET'
const REMOTE_BAK_API_KEY = 'DSH_REMOTE_BAK_KHUB_API_KEY'

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

/** 智聊阶段 0：所有会话共用这个 cwd（决策 #8，全局固定）。 */
const ZHILIAO_WORK_DIR = path.join(BASE_DIR, 'zhiliao', 'work')
/** HuLa Server 回投 / paused / 注册接口的内部共享密钥（阶段 2 固定开发值）。 */
const ZHILIAO_INTERNAL_SECRET = 'zhiliao-internal-dev-secret'
/** 本机 IM 直连默认端口；settings/env 都为空时用它，避免默认落到网关 18760 触发 406。 */
const ZHILIAO_INTERNAL_BASE_DEFAULT = 'http://127.0.0.1:18778'
/** 群消息进 agent 前是否剥离 @mention（只在 prompt 层清洗，审计/回投保留原文）。 */
const ZHILIAO_STRIP_MENTION = true
/** 回投 HTTP 硬超时（毫秒）。 */
const ZHILIAO_REPLY_TIMEOUT_MS = 10000
/** 多实例写闸 503 的建议重试间隔（秒）；HuLa 阶段 4 的非阻塞退避会识别该头。 */
const ZHILIAO_MULTIHOST_RETRY_AFTER = 5
/** follow 等 turn/end 的硬超时，防止远程流一直挂着占住请求。 */
const ZHILIAO_FOLLOW_TIMEOUT_MS = 2 * 60 * 1000
/** 单条消息文本上限，防止误传超大 body 打爆会话。 */
const ZHILIAO_TEXT_MAX = 8000
/** msgId / requestId / sessionId 的合法形状。 */
const ZHILIAO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/
const ZHILIAO_CHAT_KEY_RE = /^[A-Za-z0-9._:-]{1,200}$/

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

/** SkillHub 下载目录的历史后缀（`skills/<slug>__skillhub/`）。去后缀脚本与 id 别名解析共用。 */
const SKILLHUB_DIR_SUFFIX = '__skillhub'

/** 技能目录下的中文名 / 版本元数据文件（存在才用它覆盖展示名）。 */
const SKILL_META_FILE = '_skillhub_meta.json'

/** 插件安装标记：只有带这个文件的本地目录才允许「更新覆盖 / 删除」，手工放置的不动。 */
const PLUGIN_INSTALL_MARKER = '.dsh-plugin-install.json'

/** 技能图标 `_icon.<ext>` 的探测顺序，扩展名必须在 IMAGE_MIME 里。 */
const SKILL_ICON_EXTS = ['.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico']

// ---------------------------------------------------------------------------
// 运行时状态（进程内缓存）
// ---------------------------------------------------------------------------

/** @type {{ busy: boolean, progress: string, lastError: string|null, lastErrorText: string|null, warnings: string[], lastSync: string|null, lastDataRoot: string|null, importedIds: string[], library: { dir: string, importedAt: string, previousDataRoot: string }|null, settings: { sourceUrl: string|null, sourceBranch: string|null, skillhubUrl: string|null, builtinSkills: boolean, workbenchDataDir: string|null, syncIntervalMs: number, workbench: { dataDir: string|null, syncMs: number, order: string[], autoSync: boolean, lastPrefs: object|null }, khub: { baseUrl: string, clientId: string, enabled: boolean, enabledRev: number } }, index: any }} */
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
  /* builtinSkills：内置技能总开关。只由用户显式 toggle 改变，启动时绝不自动安装。
     workbench：工作台设置的**写入权威**；workbenchDataDir / syncIntervalMs 是运行期
     读取用的旧扁平镜像，两者由收口函数保持恒等（v2 配置分层，旧字段不删不迁移）。 */
  /* remoteConfig：远程配置的元信息 + 覆盖前的本地快照，用于「清除远程配置」时恢复原值。
     snapshot 只在首次成功加载时抓取一次；重复加载刷新 meta 但不覆盖快照，避免叠加。 */
  settings: { sourceUrl: null, sourceBranch: null, skillhubUrl: null, builtinSkills: false, workbenchDataDir: null, syncIntervalMs: 2000, introSeenVersion: null, updateHistory: [], workbench: { dataDir: null, syncMs: 2000, order: [], autoSync: true, lastPrefs: null }, khub: { baseUrl: '', clientId: '', enabled: true, enabledRev: 2, uploadedWorkbenches: {}, autoUploadDone: false, autoUploadAt: 0 }, zhiliao: { webhookSecret: '', testMode: false, replyBaseUrl: '', enabled: true, internalSecret: '', queue: { maxConcurrent: 16, perKeyLimit: 20, globalLimit: 1000 }, recycle: { enabled: false, idleMinutes: 30 } }, about: { repoUrl: '', starUrl: '', feedbackUrl: '' }, remoteConfig: { source: '', url: '', filename: '', loadedAt: null, appliedFields: [], snapshot: null } },
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
 * @param {Object<string, string>} [extraHeaders] 额外响应头（如 Retry-After）
 * @returns {void}
 */
function send(res, body, status = 200, extraHeaders) {
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extraHeaders || {}))
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
 * 专家 / 专家团清单目录的候选名，**按优先级排列**。
 * 新资源仓库用 `.buddy-hub-plugin`，历史仓库仍是 `.codebuddy-plugin`；
 * 读取时先试新名，没有再回落旧名，两种目录都能被识别。
 */
const PLUGIN_DIR_NAMES = ['.buddy-hub-plugin', '.codebuddy-plugin']

/**
 * 在专家目录下解析出实际存在的清单文件（plugin.json）绝对路径。
 * 依次尝试 `.buddy-hub-plugin` → `.codebuddy-plugin`，返回第一个真实存在的；
 * 都不存在时返回「首选名」下的路径（调用方读不到会按缺失处理，错误文案仍指向首选名）。
 * @param {string} expertDir 专家 / 专家团目录（绝对路径）
 * @returns {string} plugin.json 的绝对路径（可能不存在）
 */
function pluginManifestPath(expertDir) {
  for (const name of PLUGIN_DIR_NAMES) {
    const file = path.join(expertDir, name, 'plugin.json')
    if (isFile(file)) return file
  }
  return path.join(expertDir, PLUGIN_DIR_NAMES[0], 'plugin.json')
}

/**
 * 读取专家目录下的清单（plugin.json）。新名优先、旧名兼容，都可解析就取新名。
 * @param {string} expertDir 专家 / 专家团目录（绝对路径）
 * @returns {Record<string, any>|null} 清单对象；不存在或不可解析返回 null
 */
function readPluginManifest(expertDir) {
  for (const name of PLUGIN_DIR_NAMES) {
    const parsed = readJsonSafe(path.join(expertDir, name, 'plugin.json'))
    if (parsed !== null && typeof parsed === 'object') return parsed
  }
  return null
}

/**
 * 判断路径是否是存在的目录（打开目录前的前置校验）。
 * @param {string} dir 路径
 * @returns {boolean} 是否是目录
 */
function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory()
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
  // http(s):// 形式：不允许携带空白；git@ 形式：host:path。
  // http:// 用于内网自建 Git 服务（与 SkillHub 的 http 支持口径一致），明文传输风险由用户自行评估。
  if (/^https?:\/\//i.test(trimmed)) return /^https?:\/\/[^\s]+$/i.test(trimmed)
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
  if (/^https?:\/\//i.test(trimmed)) return rejected('git 仓库地址格式不正确（不能含空格或 ..）')
  // 其它协议（ssh://、ftp:// 等）一律拒绝，避免被当成相对路径；http(s):// 已在上面处理
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed) && !/^file:\/\//i.test(trimmed)) {
    return rejected('数据源地址不支持该协议：请填 http://、https://、git@ 或本机目录绝对路径')
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

/**
 * 校验分支名。分支名会作为 `git clone --branch` / `git fetch origin` 的**参数**传入，
 * 必须挡住被当成 git 选项或以任何形式越出 refs/heads/ 的情形：
 *  - 只接受 `[A-Za-z0-9._/-]`；
 *  - 不以 `-` 或 `/` 开头、不以 `/` 或 `.lock` 结尾；
 *  - 不含 `..`、`@{`、空白、控制字符与 git 特殊符号 `~ ^ : ? * [ \`。
 * `refs/heads/*` 前缀不在这里接受：前端拿到的是纯分支名，仓库里的标签/提交哈希不属于配置范围。
 * @param {string} value 待校验字符串（调用方已 trim）
 * @returns {boolean} 是否可作为分支配置
 */
function isValidBranchName(value) {
  if (typeof value !== 'string') return false
  const name = value.trim()
  if (name === '' || name.length > 200) return false
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.lock')) return false
  /* 只接受纯分支名：/settings/branches 返回的就是 refs/heads/ 之后的部分。
     允许 `refs/...` 会让 clone --branch / fetch origin 的语义与界面口径不一致。 */
  if (name.startsWith('refs/')) return false
  if (name.includes('..') || name.includes('@{')) return false
  if (/[\s\u0000-\u001f\u007f~^:?*\[\\]/.test(name)) return false
  return /^[A-Za-z0-9._/-]+$/.test(name)
}

/**
 * 当前生效的分支：用户配置优先；**空串表示未显式配置，跟随远端默认分支（远端 HEAD）**。
 *
 * 不硬编码 `main`：默认资源仓库的远端 HEAD 是 `master`，写死 main 会让未配置分支时
 * `fetch origin main` 直接失败。调用方据空串决定是否给 git 传 `--branch` / 分支参数。
 * 本机目录模式不执行 git 操作，调用方需自行判断 `parseSource(...).kind`。
 * @returns {string} 分支名，或空串（跟随远端默认分支）
 */
function resolveSourceBranch() {
  const configured = state.settings && typeof state.settings.sourceBranch === 'string'
    ? state.settings.sourceBranch.trim()
    : ''
  return isValidBranchName(configured) ? configured : ''
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
    fs.mkdirSync(WORKBENCH_DIR, { recursive: true })
  } catch (error) {
    state.warnings.push('无法创建工作目录：' + humanError(error))
  }
}

/**
 * 确保智聊会话的工作目录存在（阶段 0 全局固定一个 cwd）。
 * 静默处理：只读环境下不阻断插件启动，请求进来时再建一次。
 * @returns {string} 工作目录绝对路径
 */
function ensureZhiliaoCwd() {
  try {
    fs.mkdirSync(ZHILIAO_WORK_DIR, { recursive: true })
  } catch (error) {
    state.warnings.push('无法创建智聊工作目录：' + humanError(error))
  }
  return ZHILIAO_WORK_DIR
}

/** 目录名清洗：去掉路径分隔符与 Windows 非法字符，限制长度。 */
function zhiliaoSafeDirName(name) {
  const cleaned = String(name === null || name === undefined ? '' : name)
    .replace(/[\\/:*?"<>|\r\n\t]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  return cleaned.slice(0, 40) || 'default'
}

/**
 * 每个绑定身份一个独立工作区，目录名取绑定显示名（用户名称 / AI 名称）。
 * 同一绑定的所有会话共用该目录；不同绑定互不串扰。
 * @param {any} binding 绑定
 * @returns {string} 工作目录绝对路径
 */
const zhiliaoWorkDirCache = new Map()
/** 已尝试过在 DSH 侧注册为工作区的绑定（按 bindingId 去重，失败会移除以便重试）。 */
const zhiliaoWorkspaceRegistered = new Set()
/** bindingId → DSH 工作区 id（workspace/create 返回） */
const zhiliaoWorkspaceIds = new Map()
/** bindingId → 正在进行的注册 Promise，供会话创建前等待 */
const zhiliaoWorkspacePromises = new Map()

/**
 * 把绑定工作目录注册为 DSH 的 Workspace，让左侧「工作区」列表出现该条目。
 * 宿主 workspaceController.create 对同一目录幂等；注册成功后再重命名成用户名称。
 * @param {any} binding 绑定
 * @param {string} dir 工作目录绝对路径
 */
function zhiliaoEnsureDsWorkspace(binding, dir) {
  if (binding === null || typeof binding !== 'object') return
  const bindingId = String(binding.bindingId || '')
  const target = String(dir || '')
  if (bindingId === '' || target === '') return
  if (zhiliaoWorkspaceRegistered.has(bindingId)) return
  if (hostCtx === null || typeof hostCtx.inject !== 'function') return
  zhiliaoWorkspaceRegistered.add(bindingId)
  const pending = Promise.resolve()
    .then(() => hostCtx.inject(['workspaceController'], async (scope) => {
      const ctrl = scope !== null && scope !== undefined ? scope.workspaceController : null
      if (ctrl === null || ctrl === undefined || typeof ctrl.create !== 'function') return
      const created = await ctrl.create({ path: target })
      const ws = created !== null && typeof created === 'object' && created.workspace !== null
        && typeof created.workspace === 'object' ? created.workspace : null
      if (ws === null) return
      zhiliaoWorkspaceIds.set(bindingId, String(ws.workspaceId || ''))
      const title = String(binding.displayName || '').trim()
      if (title !== '' && typeof ctrl.rename === 'function' && String(ws.title || '') !== title) {
        try { await ctrl.rename({ workspaceId: ws.workspaceId, title }) } catch { /* 重名等忽略 */ }
      }
    }))
  zhiliaoWorkspacePromises.set(bindingId, pending)
  pending.catch(() => {
    zhiliaoWorkspaceRegistered.delete(bindingId)
    zhiliaoWorkspacePromises.delete(bindingId)
  })
}

/**
 * 取该绑定对应的 DSH 工作区 id（必要时等待注册完成）。
 * 拿不到时返回 null，调用方回退用 cwd 创建会话。
 * @param {any} binding 绑定
 * @returns {Promise<string|null>} workspaceId
 */
async function zhiliaoWorkspaceIdFor(binding) {
  if (binding === null || typeof binding !== 'object') return null
  const bindingId = String(binding.bindingId || '')
  if (bindingId === '') return null
  // 首次调用会触发工作区注册
  zhiliaoWorkDirFor(binding)
  let wsId = zhiliaoWorkspaceIds.get(bindingId)
  if (wsId !== undefined && wsId !== '') return wsId
  const pending = zhiliaoWorkspacePromises.get(bindingId)
  if (pending !== undefined) {
    try { await pending } catch { /* 注册失败则回退 cwd */ }
  }
  wsId = zhiliaoWorkspaceIds.get(bindingId)
  return wsId !== undefined && wsId !== '' ? wsId : null
}

/**
 * 强制确保工作区在 DSH 侧存在并返回 workspaceId（绕过 Once 缓存）。
 * 工作区被删除后 workspaceController.create 幂等重建；这是"无论何时都能看到会话"的关键。
 * @param {any} binding 绑定
 * @returns {Promise<string>} workspaceId，失败返回 ''
 */
async function zhiliaoEnsureWorkspaceLive(binding) {
  if (binding === null || typeof binding !== 'object') return ''
  const bindingId = String(binding.bindingId || '')
  if (bindingId === '') return ''
  const dir = zhiliaoWorkDirFor(binding)
  if (dir === '') return ''
  if (hostCtx === null || typeof hostCtx.inject !== 'function') return ''
  try {
    return await hostCtx.inject(['workspaceController'], async (scope) => {
      const ctrl = scope !== null && scope !== undefined ? scope.workspaceController : null
      if (ctrl === null || ctrl === undefined || typeof ctrl.create !== 'function') return ''
      const created = await ctrl.create({ path: dir })
      const ws = created !== null && typeof created === 'object' && created.workspace !== null
        && typeof created.workspace === 'object' ? created.workspace : null
      if (ws === null) return ''
      const wsId = String(ws.workspaceId || '')
      zhiliaoWorkspaceIds.set(bindingId, wsId)
      const title = String(binding.displayName || '').trim()
      if (title !== '' && typeof ctrl.rename === 'function' && String(ws.title || '') !== title) {
        try { await ctrl.rename({ workspaceId: ws.workspaceId, title }) } catch { /* 忽略 */ }
      }
      return wsId
    })
  } catch { return '' }
}

/**
 * 检查账本里的宿主会话是否仍然可见（未归档/未删除）。
 * 用 sessionController.list 拿可见会话集合判断。
 * @param {string} sessionId 会话 id
 * @returns {Promise<boolean>} 是否可见
 */
async function zhiliaoSessionVisible(sessionId) {
  const sid = String(sessionId || '')
  if (sid === '') return false
  const sc = hostService('sessionController')
  if (sc === null || typeof sc.list !== 'function') return true // 无法判断时信任账本
  try {
    const result = await sc.list({})
    // list 返回结构可能是数组或 {items/sessions}
    let ids = []
    if (Array.isArray(result)) ids = result
    else if (result !== null && typeof result === 'object') {
      const arr = result.items || result.sessions || result.value || result.values || []
      if (Array.isArray(arr)) ids = arr
    }
    if (ids.length === 0) return true // 拿不到列表时信任账本，避免误重建
    return ids.some((row) => {
      const id = typeof row === 'string' ? row
        : (row !== null && typeof row === 'object' ? (row.sessionId || row.id) : '')
      return String(id || '') === sid
    })
  } catch { return true }
}

function zhiliaoWorkDirFor(binding) {
  if (binding === null || typeof binding !== 'object') return ensureZhiliaoCwd()
  const cacheKey = String(binding.bindingId || '')
  if (cacheKey !== '' && zhiliaoWorkDirCache.has(cacheKey)) return zhiliaoWorkDirCache.get(cacheKey)
  const label = binding.displayName
    || (binding.userId !== undefined && binding.userId !== null && String(binding.userId) !== '' ? String(binding.userId) : '')
    || String(binding.bindingId || '')
  let dirName = zhiliaoSafeDirName(label)
  // 同一用户（userId）无论重新绑定多少次都应复用同一工作区；
  // 只有「同名但确实是不同 userId」才加后缀，避免重复建工作区。
  const identity = String(binding.userId !== undefined && binding.userId !== null
    ? binding.userId : (binding.aiId !== undefined && binding.aiId !== null ? 'ai_' + binding.aiId : binding.bindingId))
  let dir = path.join(ZHILIAO_WORK_DIR, dirName)
  try {
    if (fs.existsSync(dir)) {
      const marker = path.join(dir, '.zhiliao-binding')
      const owner = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : ''
      if (owner !== '' && owner !== identity) {
        dirName = dirName + '-' + identity.slice(-6)
        dir = path.join(ZHILIAO_WORK_DIR, dirName)
      }
    }
    fs.mkdirSync(dir, { recursive: true })
    const marker = path.join(dir, '.zhiliao-binding')
    if (!fs.existsSync(marker)) fs.writeFileSync(marker, identity)
    // 生成可读说明：目录打开就有内容，也便于排查这是谁的工作区
    const readme = path.join(dir, 'README.md')
    if (!fs.existsSync(readme)) {
      const who = String(binding.displayName || binding.bindingId || '')
      const kind = binding.aiId !== '' && binding.aiId !== undefined && binding.aiId !== null ? 'AI 好友' : '本人'
      const lines = [
        '# 智聊工作区 · ' + who,
        '',
        '- 绑定身份：' + who + '（' + kind + '）',
        '- 绑定 ID：' + String(binding.bindingId || ''),
        '- 创建时间：' + new Date().toLocaleString('zh-CN'),
        '',
        '## 说明',
        '',
        '本目录是「' + who + '」在智聊里与各联系人的 AI 会话工作目录。',
        'AI 执行任务时产生的文件会保存在这里；不同联系人各自一个独立会话（上下文互不影响）。',
        '纯文本问答不会写入文件，只有 AI 调用工具写盘时才会产生内容。',
        '',
      ].join('\n')
      try { fs.writeFileSync(readme, lines, 'utf8') } catch { /* 写说明失败不影响工作区 */ }
    }
  } catch (error) {
    state.warnings.push('无法创建绑定工作区：' + humanError(error))
    return ensureZhiliaoCwd()
  }
  if (cacheKey !== '') {
    zhiliaoWorkDirCache.set(cacheKey, dir)
    // 首次算出工作区时，同步注册到 DSH 的工作区列表（异步、失败不影响会话）
    zhiliaoEnsureDsWorkspace(binding, dir)
  }
  return dir
}

/**
 * 取会话并确保它落在该绑定的工作区。
 * 工作区发生变化（例如从旧的全局 work/ 迁到 <昵称>/）时换一个新的 agent 会话，
 * 避免宿主对同一 sessionId 报 cwd 冲突；该会话的上下文按新工作区重新开始。
 * @param {any} s 状态对象
 * @param {string} chatKey 会话键
 * @param {any} binding 绑定
 * @returns {any} 会话记录
 */
function zhiliaoEnsureSession(s, chatKey, binding) {
  const wantDir = zhiliaoWorkDirFor(binding)
  const existed = s.sessions[chatKey] !== undefined
  const session = getOrCreateChatSession(s, chatKey, binding.bindingId, wantDir)
  const currentCwd = String(session.cwd || '')
  // 工作区已注册时，会话必须换成以 workspaceId 创建，否则只会挂在默认区而非工作区下。
  // 目录或归属任一发生变化，都换一个新的 agent 会话，避开宿主 cwd/workspace 冲突。
  const wsId = String((zhiliaoWorkspaceIds.get(String(binding.bindingId || '')) || ''))
  const recordedWs = String(session.workspaceId || '')
  const needRebind = (existed === true && currentCwd !== '' && currentCwd !== wantDir)
    || (wsId !== '' && recordedWs !== wsId)
  if (needRebind === true) {
    session.cwd = wantDir
    if (wsId !== '') session.workspaceId = wsId
    session.dshSessionId = 'session-' + randomUUID()
    session.followCursor = 0
    session.lastMsgId = ''
    session.lastActiveAt = Date.now()
  }
  return session
}

/* ---------------------------------------------------------------------------
 * 智聊单实例检测：两个 dsh 宿主共用同一 profile 时，各自的内存账本会互相覆盖。
 * 只做「读锁 + 探活 + 告警」，绝不强制退出；退出时只删自己的那把锁。
 * ------------------------------------------------------------------------- */

/** 检测到的另一个宿主（仅本进程内存；不写入状态文件）。 */
let zhiliaoOtherHost = null

/**
 * 锁文件路径：与 state.json / zhiliao/ 同级。
 * @returns {string} host.json 绝对路径
 */
function zhiliaoHostFile() {
  return path.join(BASE_DIR, 'zhiliao', 'host.json')
}

/**
 * 探测 pid 是否存活：`kill(pid, 0)` 不真正发信号，只做存在性检查。
 * ESRCH = 已退出；EPERM = 存在但无权限（按存活处理）；其它异常也按存活处理，
 * 宁可少报「多实例」，也不能误判成陈旧锁去覆盖别人的。
 * @param {any} pid 进程号
 * @returns {boolean} 是否存活
 */
function zhiliaoPidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ESRCH') return false
    return true
  }
}

/**
 * 启动时读取 / 写入 host.json。
 * - 已有锁且 pid 存活且不是自己 → 不覆盖、记告警、status 报 multiHost；
 * - 无锁 / pid 已退出 / 是自己 → 写自己的锁。
 * 全程 try/catch：只读目录、/proc 不可用、权限不足都只是「检测不可用」，不能崩插件。
 * @param {number} [port] webServer 监听端口（取不到就省略该字段）
 * @returns {void}
 */
/** 已知的 webServer 端口（apply 时取一次；抢锁时写进 host.json 便于排障）。 */
let zhiliaoHostPort = 0

/**
 * 读 host.json（缺失 / 损坏都返回 null）。
 * @returns {Object<string, any>|null} 锁内容
 */
function zhiliaoReadHostLock() {
  try {
    const parsed = JSON.parse(fs.readFileSync(zhiliaoHostFile(), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * 把 host.json 写成自己的锁（抢占 / 首次注册共用）。
 * @returns {void}
 */
function zhiliaoClaimHostLock() {
  try {
    const payload = { pid: process.pid, startedAt: new Date().toISOString() }
    if (Number.isInteger(zhiliaoHostPort) && zhiliaoHostPort > 0) payload.port = zhiliaoHostPort
    try {
      const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
      if (pkg !== null && typeof pkg === 'object' && typeof pkg.version === 'string') payload.version = pkg.version
    } catch { /* 版本号可选 */ }
    fs.mkdirSync(path.dirname(zhiliaoHostFile()), { recursive: true })
    fs.writeFileSync(zhiliaoHostFile(), JSON.stringify(payload, null, 2) + '\n')
  } catch { /* 只读环境：静默降级 */ }
}

/**
 * 从锁文件算出「另一个存活宿主」（只读，不抢锁；status 用）。
 * @returns {{pid: number, startedAt: string}|null} 存活的其他宿主
 */
function zhiliaoOtherHostFromLock() {
  const lock = zhiliaoReadHostLock()
  const pid = lock !== null ? Number(lock.pid) : NaN
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return null
  if (!zhiliaoPidAlive(pid)) return null
  return { pid, startedAt: typeof lock.startedAt === 'string' ? lock.startedAt : '' }
}

/**
 * 启动时读取 / 写入 host.json。
 * - 已有锁且 pid 存活且不是自己 → 不覆盖、记告警、status 报 multiHost；
 * - 无锁 / pid 已退出 / 是自己 → 写自己的锁。
 * 全程 try/catch：只读目录、/proc 不可用、权限不足都只是「检测不可用」，不能崩插件。
 * @param {number} [port] webServer 监听端口（取不到就省略该字段）
 * @returns {void}
 */
function zhiliaoRegisterHostLock(port) {
  const listenPort = Number(port)
  if (Number.isInteger(listenPort) && listenPort > 0) zhiliaoHostPort = listenPort
  const other = zhiliaoOtherHostFromLock()
  if (other !== null) {
    zhiliaoOtherHost = other
    state.warnings.push(
      '检测到另一个 dsh 实例共用此 profile（pid=' + String(other.pid)
      + '，启动于 ' + (other.startedAt || '未知')
      + '）：两边的智聊账本可能互相覆盖，请只保留一个宿主',
    )
    return
  }
  zhiliaoClaimHostLock()
}

/**
 * 退出时释放锁：**只有锁里的 pid 是自己才删**，避免删掉另一个宿主的锁。
 * @returns {void}
 */
function zhiliaoReleaseHostLock() {
  const file = zhiliaoHostFile()
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && Number(parsed.pid) === process.pid) {
      fs.unlinkSync(file)
    }
  } catch { /* 缺失 / 不可读 / 删除失败：静默 */ }
}

/**
 * 多实例写入闸是否生效：**每次请求动态探活**（对方退出后立即放行，不需要重启）。
 * @returns {boolean} true 表示当前有另一个存活宿主共用 profile
 */
function zhiliaoMultiHostActive() {
  const other = zhiliaoOtherHostFromLock()
  if (other !== null) {
    zhiliaoOtherHost = other
    return true
  }
  // 对方已退出 / 无锁：**抢占锁**，保证之后启动的第三个实例能看见我们；
  // 否则「A 死 → B 放行 → C 启动也放行」会出现两台同时写账本。
  zhiliaoOtherHost = null
  const lock = zhiliaoReadHostLock()
  const pid = lock !== null ? Number(lock.pid) : NaN
  if (!(Number.isInteger(pid) && pid === process.pid)) zhiliaoClaimHostLock()
  return false
}

/**
 * 多实例写入闸的 503 回包：语义是「暂时不可用，稍后重试」，
 * HuLa 阶段 1 的 1s/5s/30s 退避会自然重试。
 * @returns {Object<string, any>} 503 响应体
 */
function zhiliaoMultiHostRejection() {
  return {
    ok: false,
    error: 'multi-host',
    detail: '检测到另一个 dsh 实例共用此 profile，智聊写入已暂停以避免账本互相覆盖；请只保留一个宿主',
    otherHost: zhiliaoOtherHost !== null
      ? { pid: zhiliaoOtherHost.pid, startedAt: zhiliaoOtherHost.startedAt }
      : null,
  }
}

/**
 * 统一发送多实例 503：只加 `Retry-After`，body / 语义与其它 503 保持一致。
 * @param {import('node:http').ServerResponse} res 响应对象
 * @returns {void}
 */
function zhiliaoSendMultiHostRejection(res) {
  send(res, zhiliaoMultiHostRejection(), 503, { 'Retry-After': String(ZHILIAO_MULTIHOST_RETRY_AFTER) })
}

/**
 * 工作台配置镜像：把**新对象**（写入权威）同步回**旧扁平字段**（运行期读取源）。
 * 只做 to-flat 一个方向；任一参数异常也不抛错，绝不阻断启动。
 * @param {'to-flat'} direction 镜像方向
 * @returns {void}
 */
function syncWorkbenchMirror(direction) {
  if (direction !== 'to-flat') return
  const wb = state.settings.workbench
  if (wb === null || typeof wb !== 'object') return
  state.settings.workbenchDataDir = typeof wb.dataDir === 'string' && wb.dataDir !== '' ? wb.dataDir : null
  state.settings.syncIntervalMs = typeof wb.syncMs === 'number' && Number.isFinite(wb.syncMs)
    ? Math.min(60000, Math.max(500, Math.floor(wb.syncMs))) : 2000
}

/**
 * 反向回填：用旧扁平字段重建新对象的 dataDir / syncMs。
 * 冷启动（老 state.json 无新对象）与 POST /settings 之后的唯一入口；
 * lastPrefs 保持现有值（默认 null）。
 * @returns {void}
 */
function reconcileFromFlat() {
  const wb = state.settings.workbench
  if (wb === null || typeof wb !== 'object') return
  const dir = typeof state.settings.workbenchDataDir === 'string' ? state.settings.workbenchDataDir.trim() : ''
  wb.dataDir = dir !== '' && localWorkbenchDirError(dir) === '' ? dir : null
  const ms = state.settings.syncIntervalMs
  wb.syncMs = typeof ms === 'number' && Number.isFinite(ms) ? Math.min(60000, Math.max(500, Math.floor(ms))) : 2000
}

/**
 * 技能 id 两种形态兜底解析：`skills/<dir>`（仓库索引 id）与 `<dir>`（本地目录名）。
 * 详情从云端卡片点开时用前者、从已安装视图点开时用后者，统一在这里兼容。
 * @param {string} id 技能 id
 * @returns {{ dir: string, abs: string, name: string, description: string, enabled: boolean }|null} 已安装技能
 */
function resolveInstalledSkillLoose(id) {
  let hit = resolveInstalledSkill(id)
  if (hit === null && typeof id === 'string' && id.indexOf('skills/') === 0) {
    hit = resolveInstalledSkill(id.slice('skills/'.length))
  }
  return hit
}

/**
 * 递归复制目录（自建而非 fs.cpSync）。
 * 实机踩坑：Node 22 / Windows 下 `fs.cpSync(recursive:true)` 遇到含中文的目标路径
 * 会静默返回但不复制任何文件；`fs.mkdirSync` + `fs.copyFileSync` 无此问题。
 * @param {string} src 源目录
 * @param {string} dst 目标目录（必须不存在）
 * @returns {void}
 */
function copyTreeSync(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const from = path.join(src, entry.name)
    const to = path.join(dst, entry.name)
    if (entry.isDirectory()) copyTreeSync(from, to)
    else if (entry.isFile()) fs.copyFileSync(from, to)
  }
}

/**
 * 自动把本地工作台上传到在线资料库（配置在线后触发一次，幂等）。
 *
 * 只传真正有数据的本地工作台（HTML + 至少一个 CSV）；已传过的按 id 映射跳过。
 * 同名时给在线节点名加「(本地)」后缀再建，避免覆盖线上同名工作台。
 * 上传不改本地任何文件；在线就绪后列表本就只显示在线，本地自然被隐藏。
 *
 * @param {object} config 在线配置
 * @param {boolean} force 是否忽略 autoUploadDone 强制重扫（手动触发用）
 * @returns {Promise<{ ok: boolean, uploaded: number, skipped: number, failed: Array<{id:string,error:string}>, message?: string }>} 结果
 */
let autoUploadInFlight = null
async function autoUploadLocalWorkbenches(config, force) {
  /* 并发闸门：自动触发与手动触发不能同时跑，否则会建出两份在线节点。 */
  if (autoUploadInFlight !== null) return autoUploadInFlight
  const run = doAutoUploadLocalWorkbenches(config, force)
  autoUploadInFlight = run
  try { return await run } finally { autoUploadInFlight = null }
}

async function doAutoUploadLocalWorkbenches(config, force) {
  const khub = state.settings.khub
  if (khub.autoUploadDone === true && force !== true) {
    return { ok: true, uploaded: 0, skipped: 0, failed: [], message: '本次会话已自动上传过' }
  }
  const dataDir = workbenchHtmlDir(state.settings.workbenchDataDir)
  const scanned = listWorkbenches(dataDir)
  const uploadedMap = khub.uploadedWorkbenches !== null && typeof khub.uploadedWorkbenches === 'object' && !Array.isArray(khub.uploadedWorkbenches)
    ? khub.uploadedWorkbenches : {}
  const failed = []
  let uploaded = 0
  let skipped = 0

  /* 先选出真正有 CSV 数据的本地工作台。 */
  const candidates = []
  for (const wb of scanned.workbenches) {
    if (uploadedMap[wb.id] !== undefined) { skipped++; continue }
    const tables = []
    for (const t of (Array.isArray(wb.tables) ? wb.tables : [])) {
      /* 本地 CSV 路径 = <数据目录>/<工作台 id>/<表名>.csv，与 workbench.js 的 dataFile 规则一致。 */
      const file = safePath(dataDir, path.join(wb.id, String(t.file || '')))
      if (file === null) continue
      const csv = readCsv(file)
      if (csv.missing === true || csv.columns.length === 0) continue
      const matrix = [csv.columns].concat(csv.rows.map((row) => csv.columns.map((c) => (row[c] === undefined || row[c] === null ? '' : String(row[c])))))
      tables.push({ name: String(t.label || t.file || '数据表'), localFile: String(t.file || ''), matrix })
    }
    if (tables.length === 0) { skipped++; continue }
    const htmlFile = safePath(dataDir, wb.file)
    if (htmlFile === null) { skipped++; continue }
    let html = ''
    try { html = fs.readFileSync(htmlFile, 'utf8') } catch { skipped++; continue }
    candidates.push({ id: wb.id, name: String(wb.name || wb.id), html, tables })
  }

  if (candidates.length > 0) {
    let space = null
    try { space = await pickWritableSpace(config) } catch (error) {
      return { ok: false, uploaded: 0, skipped, failed, message: '读取在线空间失败：' + String((error && error.message) || error) }
    }
    if (space === null) {
      return { ok: false, uploaded: 0, skipped, failed, message: '没有可写的在线空间，无法上传' }
    }
    /* catalog 里现有的在线工作台名，用于同名检测。 */
    let onlineNames = new Set()
    try {
      const catalog = await getCatalog(config)
      for (const w of (Array.isArray(catalog.workbenches) ? catalog.workbenches : [])) onlineNames.add(String(w.name || ''))
    } catch { /* 读不到就跳过同名检测，靠后缀也不影响正确性 */ }

    for (const c of candidates) {
      let finalName = c.name
      if (onlineNames.has(finalName)) finalName = c.name + ' (本地)'
      try {
        const result = await uploadLocalWorkbench(config, {
          spaceId: space.spaceId, name: finalName, html: c.html, tables: c.tables,
        })
        if (result.ok === true) {
          uploadedMap[c.id] = { nodeId: result.nodeId, name: finalName, at: Date.now() }
          onlineNames.add(finalName)
          uploaded++
        } else {
          failed.push({ id: c.id, error: String(result.error || '上传失败') })
        }
      } catch (error) {
        failed.push({ id: c.id, error: String((error && error.message) || error) })
      }
    }
  }

  khub.uploadedWorkbenches = uploadedMap
  /* 只有「没有失败」才算完成：失败（在线不可达 / 写入出错）保持 false，
     下次配置就绪或点「上传资料库」时会重试。之前无条件置 true，导致
     在线当时连不上时留下「已完成」的假标记，本地工作台永远不再自动上传。 */
  khub.autoUploadDone = failed.length === 0
  khub.autoUploadAt = Date.now()
  try { persistState() } catch { /* 落盘失败不阻断本次会话 */ }
  const message = candidates.length === 0
    ? '没有需要上传的本地工作台'
    : '已上传 ' + uploaded + ' 个本地工作台到在线' + (failed.length > 0 ? '，' + failed.length + ' 个失败' : '')
  if (uploaded > 0 || failed.length > 0) {
    state.warnings.push('[本地→在线上传] ' + message)
  }
  return { ok: true, uploaded, skipped, failed, message }
}

/**
 * 改数据目录时把旧目录里的工作台数据整体复制到新目录。
 * HTML 在数据目录根（*.html），CSV 在 <id>/ 子目录。只复制不删除旧目录 ——
 * 失败时两边都保留、提示用户手动处理，绝不丢数据。
 *
 * @param {string} fromDir 旧数据目录（绝对路径）
 * @param {string} toDir 新数据目录（绝对路径）
 * @returns {{ ok: boolean, moved: string[], error?: string }} 迁移结果
 */
function migrateWorkbenchData(fromDir, toDir) {
  const moved = []
  try {
    const from = path.resolve(fromDir)
    const to = path.resolve(toDir)
    if (from === to) return { ok: true, moved }
    if (!isDirectory(from)) return { ok: true, moved } // 旧目录不存在（新配置场景），无事可做
    try { fs.mkdirSync(to, { recursive: true }) } catch (error) {
      return { ok: false, moved, error: '无法创建目标目录：' + humanError(error) }
    }
    const entries = fs.readdirSync(from, { withFileTypes: true })
    for (const entry of entries) {
      /* 不跟随符号链接；只搬 html 文件与 <id>/ 子目录（里面都是 CSV）。 */
      if (entry.isSymbolicLink()) continue
      const src = path.join(from, entry.name)
      const dst = path.join(to, entry.name)
      if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
        if (fs.existsSync(dst)) continue // 新目录已有同名：不覆盖
        fs.copyFileSync(src, dst)
        moved.push(entry.name)
      } else if (entry.isDirectory() && !entry.name.startsWith('.')) {
        if (!fs.existsSync(dst)) {
          copyTreeSync(src, dst)
          moved.push(entry.name + '/')
        }
      }
    }
    return { ok: true, moved }
  } catch (error) {
    return { ok: false, moved, error: String((error && error.message) || error) }
  }
}

/**
 * 工作台设置的**唯一写入收口**：校验 → 写新对象 → 双向镜像 → 落盘。
 * 任何写入路径（/workbench/settings、@ 目录同步、restoreState 回填）都经此函数，
 * 保证 state.settings.workbench 与旧扁平字段恒等。
 * @param {{ dataDir?: string|null, syncMs?: number, order?: string[], lastPrefs?: object|null }} patch 已校验的字段
 * @param {string} origin 写入来源（仅日志 / 诊断）
 * @returns {void}
 */
function applyWorkbenchPatch(patch, origin) {
  const wb = state.settings.workbench
  const p = patch !== null && typeof patch === 'object' ? patch : {}
  /* 目录变更：先记下旧目录（未配置时用默认目录），写完 state 后把旧数据复制过去。
     迁移结果记到 state.warnings，让前端能看到「部分已搬 / 需手动处理」。 */
  let migrateFrom = null
  let migrateTo = null
  if (Object.prototype.hasOwnProperty.call(p, 'dataDir')) {
    migrateFrom = workbenchHtmlDir(wb.dataDir)
    const nextDir = typeof p.dataDir === 'string' && p.dataDir !== '' ? p.dataDir : null
    migrateTo = workbenchHtmlDir(nextDir)
    wb.dataDir = nextDir
  }
  if (Object.prototype.hasOwnProperty.call(p, 'syncMs')) {
    wb.syncMs = typeof p.syncMs === 'number' && Number.isFinite(p.syncMs)
      ? Math.min(60000, Math.max(500, Math.floor(p.syncMs))) : 2000
  }
  /* 左侧文件树的展示顺序：只存工作台 id 数组，未知 / 非法 id 在读取时忽略。 */
  if (Object.prototype.hasOwnProperty.call(p, 'order')) {
    wb.order = Array.isArray(p.order)
      ? p.order.filter((id) => typeof id === 'string' && WORKBENCH_ID_SHAPE.test(id)).slice(0, 500)
      : []
  }
  if (Object.prototype.hasOwnProperty.call(p, 'lastPrefs')) {
    wb.lastPrefs = p.lastPrefs !== null && typeof p.lastPrefs === 'object' && !Array.isArray(p.lastPrefs)
      ? p.lastPrefs : null
  }
  /* 自动刷新开关：打开时前端按 syncMs 轮询数据文件变化，关闭后只有手动刷新。 */
  if (Object.prototype.hasOwnProperty.call(p, 'autoSync')) {
    wb.autoSync = p.autoSync === true
  }
  void origin
  syncWorkbenchMirror('to-flat')
  persistState()
  if (migrateFrom !== null && migrateTo !== null && migrateFrom !== migrateTo) {
    const result = migrateWorkbenchData(migrateFrom, migrateTo)
    if (result.moved.length > 0) {
      const note = '已把旧数据目录（' + migrateFrom + '）的 ' + result.moved.length + ' 项复制到新目录：' + result.moved.join('、')
      state.warnings.push(note)
      console.warn('[workbench] ' + note)
    }
    if (result.ok === false) {
      const note = '数据目录迁移未完成（' + String(result.error || '未知错误') + '）；新旧目录均已保留，请手动核对后处理：' + migrateFrom + ' → ' + migrateTo
      state.warnings.push(note)
      console.warn('[workbench] ' + note)
    }
  }
}

/**
 * 从 state.json 恢复 lastSync / importedIds。
 * @returns {void}
 */
function restoreState() {
  const saved = readJsonSafe(STATE_FILE)
  if (saved === null || typeof saved !== 'object') return
  /* 会话注入历史：旧版 state.json 没有该字段即视为空。逐条校验，
     被手工改坏（非数组 / sessionId 非法 / ids 非字符串）一律跳过，绝不污染注册表。 */
  if (Array.isArray(saved.expertSessionHistory)) {
    for (const row of saved.expertSessionHistory.slice(-EXPERT_SESSION_HISTORY_LIMIT)) {
      if (row === null || typeof row !== 'object') continue
      if (typeof row.sessionId !== 'string' || !SESSION_ID_RE.test(row.sessionId)) continue
      if (!Array.isArray(row.ids)) continue
      const ids = new Set(row.ids.filter((value) => typeof value === 'string' && value !== ''))
      if (ids.size > 0) expertSessionHistory.set(row.sessionId, ids)
    }
  }
  if (typeof saved.lastSync === 'string') state.lastSync = saved.lastSync
  if (typeof saved.dataRoot === 'string' && saved.dataRoot !== '') {
    state.lastDataRoot = saved.dataRoot
  }
  /* 「待刷新」标志必须跨重启存活：切回 git 后重启，索引缓存作废、自动同步被抑制，
     /status 仍要报 indexStale 让前端提示点刷新。旧版 state.json 没有该字段，
     缺省 false；loadIndexCache 检测到本机目录残留缓存时会自行补上。 */
  if (saved.indexSwitchPending === true) indexSwitchPending = true
  if (Array.isArray(saved.importedIds)) {
    /* 治本：启动时就与真实目录对齐，只保留“目录里确实存在”的 id，
       杜绝历史脏 id（目录被删但数组没清）在本次会话的任何接口里被当成已导入。 */
    const onDisk = new Set(listLocalExperts().map((e) => e.id))
    state.importedIds = saved.importedIds.filter((id) => typeof id === 'string' && onDisk.has(id))
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
  /* 介绍弹窗已读版本与升级历史：只接受合法形态，坏数据直接丢弃，不让 state.json 影响启动。 */
  if (saved.settings !== null && typeof saved.settings === 'object') {
    if (typeof saved.settings.introSeenVersion === 'string') {
      const seen = saved.settings.introSeenVersion.trim()
      state.settings.introSeenVersion = seen === '' ? null : seen.slice(0, 40)
    }
    if (Array.isArray(saved.settings.updateHistory)) {
      state.settings.updateHistory = saved.settings.updateHistory
        .filter((item) => item !== null && typeof item === 'object' && typeof item.at === 'string')
        .slice(0, 5)
        .map((item) => ({
          at: String(item.at).slice(0, 40),
          ok: item.ok === true,
          from: String(item.from || '').slice(0, 40),
          to: String(item.to || '').slice(0, 40),
          message: String(item.message || '').slice(0, 200),
        }))
    }
  }
  /* 资源仓库分支：旧版 state.json 没有该字段 → null（回落默认分支）。
     被手工改坏的值一律丢弃，绝不让它进入 git 命令行参数。 */
  if (saved.settings !== null && typeof saved.settings === 'object' && typeof saved.settings.sourceBranch === 'string') {
    const branch = saved.settings.sourceBranch.trim()
    state.settings.sourceBranch = branch !== '' && isValidBranchName(branch) ? branch : null
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
  /* 个人工作台：旧 state.json 缺字段即保持默认。逐字段白名单，防止手工改坏的 state
     把非法路径或异常同步间隔带进运行时。 */
  if (saved.settings !== null && typeof saved.settings === 'object' && typeof saved.settings.workbenchDataDir === 'string') {
    const dir = saved.settings.workbenchDataDir.trim()
    state.settings.workbenchDataDir = dir !== '' && localWorkbenchDirError(dir) === '' ? dir : null
  }
  if (saved.settings !== null && typeof saved.settings === 'object' && typeof saved.settings.syncIntervalMs === 'number') {
    const ms = Math.floor(saved.settings.syncIntervalMs)
    state.settings.syncIntervalMs = Number.isFinite(ms) && ms >= 500 && ms <= 60000 ? ms : 2000
  }
  /* 在线资料库：只恢复非敏感字段（密钥在 credentials.enc 里，绝不写 state.json）。
     旧 state.json 没有 khub 字段时保持默认，即「未启用、回落本地」。 */
  if (saved.settings !== null && typeof saved.settings === 'object' &&
      saved.settings.khub !== null && typeof saved.settings.khub === 'object' &&
      !Array.isArray(saved.settings.khub)) {
    const rawKhub = saved.settings.khub
    const base = typeof rawKhub.baseUrl === 'string' ? rawKhub.baseUrl.trim() : ''
    state.settings.khub.baseUrl = base !== '' && isValidBaseUrl(base) ? base : ''
    state.settings.khub.clientId = typeof rawKhub.clientId === 'string' ? rawKhub.clientId.trim().slice(0, 120) : ''
    /* 语义是「显式关闭」：只有存了 false 才算关，缺字段一律视为开（填完即生效）。
       enabledRev 是迁移标记：v18 之前「在线优先」默认关闭，用户填完配置也会被存成
       false，这里一次性纠正为开启；带 rev 2 之后用户手动关掉的 false 会被尊重。 */
    state.settings.khub.enabled = Number(rawKhub.enabledRev) === 2 ? rawKhub.enabled !== false : true
    state.settings.khub.enabledRev = 2
    /* 本地→在线上传的幂等映射 + 自动上传完成标记。 */
    state.settings.khub.uploadedWorkbenches = rawKhub.uploadedWorkbenches !== null &&
      typeof rawKhub.uploadedWorkbenches === 'object' && !Array.isArray(rawKhub.uploadedWorkbenches)
      ? rawKhub.uploadedWorkbenches : {}
    state.settings.khub.autoUploadDone = rawKhub.autoUploadDone === true
    state.settings.khub.autoUploadAt = Number(rawKhub.autoUploadAt) || 0
  }
  /* 智聊：webhook secret 由面板填写后落 state.json（不是 token，不需要加密）；
     testMode 缺省 false，只有显式 true 才认阶段 0 的固定 token。 */
  if (saved.settings !== null && typeof saved.settings === 'object' &&
      saved.settings.zhiliao !== null && typeof saved.settings.zhiliao === 'object' &&
      !Array.isArray(saved.settings.zhiliao)) {
    const rawZl = saved.settings.zhiliao
    state.settings.zhiliao.webhookSecret = typeof rawZl.webhookSecret === 'string' ? rawZl.webhookSecret.trim().slice(0, 200) : ''
    state.settings.zhiliao.testMode = rawZl.testMode === true
    state.settings.zhiliao.replyBaseUrl = typeof rawZl.replyBaseUrl === 'string' ? rawZl.replyBaseUrl.trim().slice(0, 300) : ''
    state.settings.zhiliao.enabled = rawZl.enabled !== false
    state.settings.zhiliao.internalSecret = typeof rawZl.internalSecret === 'string' ? rawZl.internalSecret.trim().slice(0, 200) : ''
    const rawQueue = rawZl.queue !== null && typeof rawZl.queue === 'object' && !Array.isArray(rawZl.queue) ? rawZl.queue : {}
    const zlQueue = state.settings.zhiliao.queue
    const clampInt = (value, min, max, fallback) => {
      const n = Number(value)
      if (!Number.isFinite(n)) return fallback
      return Math.min(max, Math.max(min, Math.floor(n)))
    }
    zlQueue.maxConcurrent = clampInt(rawQueue.maxConcurrent, 1, 256, 16)
    zlQueue.perKeyLimit = clampInt(rawQueue.perKeyLimit, 1, 10000, 20)
    zlQueue.globalLimit = clampInt(rawQueue.globalLimit, 1, 100000, 1000)
    const rawRecycle = rawZl.recycle !== null && typeof rawZl.recycle === 'object' && !Array.isArray(rawZl.recycle) ? rawZl.recycle : {}
    state.settings.zhiliao.recycle.enabled = rawRecycle.enabled === true
    state.settings.zhiliao.recycle.idleMinutes = clampInt(rawRecycle.idleMinutes, 1, 1440, 30)
  }
  /* 关于与反馈地址（可被远程配置覆盖）：非敏感 URL，逐字段白名单恢复。 */
  if (saved.settings !== null && typeof saved.settings === 'object' &&
      saved.settings.about !== null && typeof saved.settings.about === 'object' &&
      !Array.isArray(saved.settings.about)) {
    const rawAbout = saved.settings.about
    for (const key of ['repoUrl', 'starUrl', 'feedbackUrl']) {
      state.settings.about[key] = isValidHttpUrl(rawAbout[key]) ? rawAbout[key] : ''
    }
  }
  /* 远程配置：元信息 + 覆盖前快照。快照是内部数据，只认对象形状，逐字段白名单恢复。
     注意这里只恢复「元信息」，被覆盖的设置字段本身已在上面各分支按普通设置恢复。 */
  if (saved.settings !== null && typeof saved.settings === 'object' &&
      saved.settings.remoteConfig !== null && typeof saved.settings.remoteConfig === 'object' &&
      !Array.isArray(saved.settings.remoteConfig)) {
    const rawRc = saved.settings.remoteConfig
    const rc = state.settings.remoteConfig
    rc.source = rawRc.source === 'url' || rawRc.source === 'upload' ? rawRc.source : ''
    rc.url = isValidHttpUrl(rawRc.url) ? rawRc.url : ''
    rc.filename = typeof rawRc.filename === 'string' ? rawRc.filename.slice(0, 200) : ''
    rc.loadedAt = typeof rawRc.loadedAt === 'string' ? rawRc.loadedAt : null
    rc.appliedFields = Array.isArray(rawRc.appliedFields)
      ? rawRc.appliedFields.filter((f) => typeof f === 'string').slice(0, 100) : []
    /* 快照形状较深，交给 restoreRemoteSnapshot 消费时逐字段兜底；这里只校验顶层是对象。 */
    rc.snapshot = rawRc.snapshot !== null && typeof rawRc.snapshot === 'object' && !Array.isArray(rawRc.snapshot)
      ? rawRc.snapshot : null
  }
  /* 个人工作台 v2：配置分层白名单恢复。必须放在上面两个旧扁平字段分支之后，
     才能拿到已恢复的旧值。A 有新对象则逐字段校验恢复并以新对象覆盖镜像；
     B 老 state.json 无对象则用旧值回填一次（零迁移、不删旧字段、不主动改写磁盘）；
     C 末尾再镜像一次保证两个来源恒等。 */
  if (
    saved.settings !== null && typeof saved.settings === 'object' &&
    saved.settings.workbench !== null && typeof saved.settings.workbench === 'object' &&
    !Array.isArray(saved.settings.workbench)
  ) {
    const raw = saved.settings.workbench
    const wb = state.settings.workbench
    const dir = typeof raw.dataDir === 'string' ? raw.dataDir.trim() : ''
    wb.dataDir = dir !== '' && localWorkbenchDirError(dir) === '' ? dir : null
    const ms = typeof raw.syncMs === 'number' && Number.isFinite(raw.syncMs) ? Math.floor(raw.syncMs) : 2000
    wb.syncMs = ms >= 500 && ms <= 60000 ? ms : 2000
    wb.order = Array.isArray(raw.order)
      ? raw.order.filter((id) => typeof id === 'string' && WORKBENCH_ID_SHAPE.test(id)).slice(0, 500)
      : []
    wb.lastPrefs = raw.lastPrefs !== null && typeof raw.lastPrefs === 'object' && !Array.isArray(raw.lastPrefs)
      ? raw.lastPrefs : null
    wb.autoSync = typeof raw.autoSync === 'boolean' ? raw.autoSync : true
    syncWorkbenchMirror('to-flat')
  } else {
    reconcileFromFlat()
  }
  syncWorkbenchMirror('to-flat')
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
      expertSessionHistory: serializeExpertSessionHistory(),
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
  const plugin = readPluginManifest(expertDir)
  if (plugin === null || typeof plugin !== 'object') {
    return { item: null, skipped: { id: dirName, reason: '缺少可解析的 .buddy-hub-plugin/plugin.json（或旧名 .codebuddy-plugin/plugin.json）' } }
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
 * 读技能目录里的 `_skillhub_meta.json`，取中文展示名与版本号。
 *
 * 这是资源仓库里随技能一起发布的可选元数据：`name` 是中文名、`version` 是版本号。
 * **只在文件真实存在且字段合法时**才返回，缺文件 / 非法 JSON / 空字段一律返回 null，
 * 展示层继续用 `SKILL.md` frontmatter 的 `name`。绝不改 `name` 本身 —— 安装、落地目录名、
 * `/` 指令名都还依赖这个机器名。
 * @param {string} dir SKILL.md 所在目录的绝对路径
 * @returns {{ displayName: string, version: string }|null} 展示元数据或 null
 */
function readSkillDisplayMeta(dir) {
  const data = readJsonSafe(path.join(dir, SKILL_META_FILE))
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const displayName = tidy(typeof data.name === 'string' ? data.name : '', 120)
  const version = tidy(typeof data.version === 'string' ? data.version : '', 40)
  if (displayName === '' && version === '') return null
  return { displayName, version }
}

/**
 * 找技能目录下的 `_icon.<ext>`（只查**本目录**，不向父集合回落：嵌套子技能共用父图标会误导）。
 * @param {string} dir SKILL.md 所在目录的绝对路径
 * @returns {string|null} 图标文件名；没有返回 null
 */
function findSkillIconName(dir) {
  for (const ext of SKILL_ICON_EXTS) {
    const name = '_icon' + ext
    if (isFile(path.join(dir, name))) return name
  }
  /* 兜底：扩展名大小写 / 少见格式，扫一次目录，只接受 IMAGE_MIME 认识的后缀。 */
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!/^_icon\.[A-Za-z0-9]+$/i.test(entry.name)) continue
    if (IMAGE_MIME[path.extname(entry.name).toLowerCase()] !== undefined) return entry.name
  }
  return null
}

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
    /** @type {Record<string, any>} */
    const item = {
      id: dirRel,
      name,
      description,
      collection,
      path: dirRel + '/SKILL.md',
    }
    /* 可选展示元数据：中文名 / 版本号 / 图标。只加字段、不改写 name 与 id，
       保证安装链路、`/` 指令名、已落地目录名不受影响。 */
    const display = readSkillDisplayMeta(dir)
    if (display !== null) {
      if (display.displayName !== '') item.displayName = display.displayName
      if (display.version !== '') item.version = display.version
    }
    const iconName = findSkillIconName(dir)
    if (iconName !== null) item.icon = dirRel + '/' + iconName
    out.push(item)
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
 * @param {number} [timeoutMs] 单次超时毫秒；列远端分支这类轻量探测用短超时，默认 5 分钟
 * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, message?: string, missing?: boolean }>} 执行结果
 */
function runGit(args, cwd, timeoutMs, auth) {
  return new Promise((resolve) => {
    const env = Object.assign({}, process.env, {
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      NO_COLOR: '1',
      LC_ALL: 'C',
    })
    /* 私有仓库凭据走 GIT_CONFIG_* 环境变量，不拼进 URL、不出现在命令行参数里。
       http.extraHeader 只对 HTTP(S) 传输生效；git@ SSH 源用系统密钥，不受影响。 */
    if (auth !== null && auth !== undefined && auth.user !== '' && auth.token !== '') {
      /* 宿主可能已经设了 GIT_CONFIG_COUNT，追加而不是覆盖，避免抹掉别人的配置。
         注意 http.extraHeader 对该次 git 进程的所有 HTTP 请求生效；仓库若重定向到
         其它主机理论上会带上同一头，内网自建 Git 场景下由用户自行评估。 */
      const existing = Number(env.GIT_CONFIG_COUNT)
      const idx = Number.isFinite(existing) && existing > 0 ? existing : 0
      env.GIT_CONFIG_COUNT = String(idx + 1)
      env['GIT_CONFIG_KEY_' + String(idx)] = 'http.extraHeader'
      env['GIT_CONFIG_VALUE_' + String(idx)] = 'Authorization: Basic ' + Buffer.from(auth.user + ':' + auth.token).toString('base64')
    }
    const options = {
      cwd,
      timeout: typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : 300000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env,
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
  const branch = resolveSourceBranch()
  // 未配置分支时 fetch 不指定 ref，跟随远端 HEAD；显式配置时只拉该分支。
  const fetchArgs = ['-c', 'advice.detachedHead=false', 'fetch', '--depth', '1', 'origin']
  if (branch !== '') fetchArgs.push(branch)
  const fetched = await runGit(fetchArgs, REPO_DIR, undefined, getSourceAuth())
  if (!fetched.ok) {
    /* 旧实现只 warnings.push 后 return，runSync 照常 saveIndex / lastSync=now，
       /refresh?wait=1 返回 ok:true —— 刷新失败却报成功。这里必须抛到 catch。 */
    const label = branch !== '' ? '分支 ' + branch : '默认分支'
    throw syncFailure('拉取远端' + label + '失败：索引未更新，请检查分支配置、网络或仓库地址后重试',
      fetched.message || '')
  }
  const reset = await runGit(['reset', '--hard', 'FETCH_HEAD'], REPO_DIR)
  if (reset.ok) return
  const fallback = await runGit(['reset', '--hard', branch !== '' ? 'origin/' + branch : 'origin/HEAD'], REPO_DIR)
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
  const branch = resolveSourceBranch()
  // 未配置分支时不传 --branch，让 clone 直接检出远端 HEAD（默认仓库是 master 而非 main）。
  const cloneArgs = ['clone', '--depth', '1']
  if (branch !== '') cloneArgs.push('--branch', branch)
  cloneArgs.push(source.url, REPO_DIR)
  const cloned = await runGit(cloneArgs, BASE_DIR, undefined, getSourceAuth())
  if (!cloned.ok) {
    const label = branch !== '' ? '分支 ' + branch : '远端默认分支'
    throw new Error('克隆资源仓库（' + label + '）失败：' + String(cloned.message || ''))
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
 * 就能让面板读出任意位置的清单目录（`.buddy-hub-plugin` 或旧名 `.codebuddy-plugin`）下的 plugin.json）。校验方式与
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
  /* 记录值优先（历史 .expert-source.json 可能记的是旧名），再试两个候选目录名。 */
  const names = [dir].concat(PLUGIN_DIR_NAMES.filter((name) => name !== dir))
  for (const name of names) {
    const file = path.resolve(base, name, 'plugin.json')
    if (!file.startsWith(base + path.sep)) continue
    if (isFile(file)) return file
  }
  return null
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
  const importedDir = path.join(IMPORTED_DIR, id)
  const candidates = PLUGIN_DIR_NAMES.map((name) => path.join(importedDir, name, 'plugin.json'))
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
  const plugin = readPluginManifest(expertDir)
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
  const manifestAbs = pluginManifestPath(expertDir)
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
  const haystack = (item.name + ' ' + (item.displayName || '') + ' ' + item.description + ' ' + item.id).toLowerCase()
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
 * 技能 id 的兼容变体（资源仓库去掉 `__skillhub` 目录后缀前后都能读）。
 *
 * 去后缀脚本只改目录名、不改任何文件内容，因此旧索引 / 旧草稿 / 旧收藏里可能还留着
 * `skills/foo__skillhub` 这种 id。这里按「原名 → 去后缀 → 加后缀 → 末段」顺序给出候选，
 * 调用方逐个试，命中即用。**不生成新文件、不改仓库**，纯内存别名解析。
 *
 * 例：`skills/kdocs-skill__skillhub/skills/kdocs-aippt`
 *  → 原名 / `skills/kdocs-skill/skills/kdocs-aippt` / 末段 `kdocs-aippt`。
 * @param {string} id 技能 id（相对数据根的 POSIX 路径）
 * @returns {string[]} 去重后的候选 id 列表
 */
function skillIdVariants(id) {
  const raw = typeof id === 'string' ? id.trim() : ''
  if (raw === '') return []
  /** @type {string[]} */
  const variants = [raw]
  const parts = raw.split(/[\\/]+/).filter((seg) => seg !== '')
  const stripped = parts
    .map((seg) => (seg.endsWith(SKILLHUB_DIR_SUFFIX) ? seg.slice(0, -SKILLHUB_DIR_SUFFIX.length) : seg))
    .join('/')
  if (stripped !== '' && !variants.includes(stripped)) variants.push(stripped)
  if (parts.length >= 2 && parts[0] === 'skills' && !parts[1].endsWith(SKILLHUB_DIR_SUFFIX)) {
    const added = parts.slice()
    added[1] = parts[1] + SKILLHUB_DIR_SUFFIX
    const candidate = added.join('/')
    if (!variants.includes(candidate)) variants.push(candidate)
  }
  /* 已安装技能按「目录名 / slug」索引，路径形式的 id 要补一个末段候选。 */
  for (const variant of variants.slice()) {
    const segments = variant.split('/').filter((seg) => seg !== '')
    if (segments.length < 2) continue
    const last = segments[segments.length - 1]
    if (!variants.includes(last)) variants.push(last)
  }
  return variants
}

/**
 * 在索引里按 id 找仓库技能，带 `__skillhub` 后缀别名兼容。
 * @param {any} index 当前索引
 * @param {string} id 技能 id
 * @returns {Record<string, any>|null} 命中的索引条目或 null
 */
function findRepoSkill(index, id) {
  const skills = Array.isArray(index && index.skills) ? index.skills : []
  for (const candidate of skillIdVariants(id)) {
    const found = skills.find((entry) => entry.id === candidate)
    if (found !== undefined) return found
  }
  return null
}

/**
 * 把仓库技能 id 解析成实际存在的技能目录（带后缀别名兼容）。
 * @param {string} id 技能 id
 * @returns {string|null} 含 SKILL.md 的绝对目录；找不到返回 null
 */
function resolveRepoSkillDir(id) {
  for (const candidate of skillIdVariants(id)) {
    const absolute = safeRepoDir(candidate)
    if (absolute !== null && isFile(path.join(absolute, 'SKILL.md'))) return absolute
  }
  return null
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

/* `/status` 被前端 1s 轮询：`counts.workbench` 用 1 秒粒度的模块级缓存，避免
   每次请求都 readdir + 读取全部 HTML。缓存只服务于这个计数 ——
   GET /workbench/list 每次仍然重新扫描，保证 agent 落盘 HTML 后「刷新列表即生效」。 */
let lastWorkbenchCountAt = 0
let lastWorkbenchCount = 0
let lastWorkbenchCountDir = ''
function cachedWorkbenchCount() {
  const now = Date.now()
  const dir = workbenchHtmlDir(state.settings.workbenchDataDir)
  /* 目录变了立即重扫（改数据目录后计数不能沿用旧目录的）。 */
  if (dir !== lastWorkbenchCountDir || now - lastWorkbenchCountAt >= 1000) {
    try { lastWorkbenchCount = listWorkbenches(dir).workbenches.length }
    catch { /* 扫描异常时沿用上次计数，不影响 /status 的其它字段 */ }
    lastWorkbenchCountAt = now
    lastWorkbenchCountDir = dir
  }
  return lastWorkbenchCount
}

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
  // 工作台数量：1 秒粒度缓存（见 cachedWorkbenchCount），不影响列表接口的实时扫描。
  const workbenchCount = cachedWorkbenchCount()
  const counts =
    index === null
      ? {
          experts: 0,
          teams: 0,
          skills: 0,
          connectors: connectorCounts.all,
          connectable: connectorCounts.connectable,
          unsupported: connectorCounts.unsupported,
          workbench: workbenchCount,
        }
      : {
          experts: mergeLocalExperts(index.experts.filter((item) => item.type !== 'team'), 'agent').length,
          teams: mergeLocalExperts(index.experts.filter((item) => item.type === 'team'), 'team').length,
          skills: index.counts.skills,
          connectors: connectorCounts.all,
          connectable: connectorCounts.connectable,
          unsupported: connectorCounts.unsupported,
          workbench: workbenchCount,
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
  // 内置技能的四个数只扫一次磁盘（items 与 excluded 各扫一遍目录，重复扫会白白多几次 IO）。
  const builtinCounts = builtinSkillSummary()
  return {
    ok: true,
    sourceUrl: effective,
    sourceKind: parseSource(effective).kind,
    /* 分支配置只对远程 git 源有意义：本机目录模式不执行任何 git 命令，
       前端据此隐藏分支输入框。空串 = 未显式配置，回落 defaultBranch。 */
    sourceBranch: typeof state.settings.sourceBranch === 'string' ? state.settings.sourceBranch : '',
    defaultBranch: '',
    branchSupported: parseSource(effective).kind === 'git',
    defaultUrl: SOURCE_URL,
    usingDefault: effective === SOURCE_URL,
    skillhubUrl: typeof state.settings.skillhubUrl === 'string' ? state.settings.skillhubUrl : '',
    /* 私有仓库凭据：只回显用户名与是否已配置，令牌绝不回显。 */
    sourceAuthUser: getSourceAuth() === null ? '' : getSourceAuth().user,
    sourceAuthConfigured: getSourceAuth() !== null,
    /* 个人工作台：HTML 与 CSV 共用同一个数据目录（HTML 在根、CSV 在 <id>/）。
       未配置时回落到默认目录，未配置也可用。 */
    workbenchDataDir: workbenchHtmlDir(state.settings.workbenchDataDir),
    workbenchHtmlDir: workbenchHtmlDir(state.settings.workbenchDataDir),
    workbenchDataDirDefault: WORKBENCH_DIR,
    syncIntervalMs: state.settings.syncIntervalMs,
    workbenchDataDirReady: localWorkbenchDirError(workbenchHtmlDir(state.settings.workbenchDataDir)) === '',
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

  /* 私有 Git 仓库凭据：仅在远程 git 源时接受。令牌只在提供时写入（留空 = 保持原值），
     清除走 sourceAuthClear。校验控制字符，避免把奇怪内容塞进加密文件或 git 环境变量。 */
  const authUserRaw = payload !== null && typeof payload === 'object' && typeof payload.sourceAuthUser === 'string'
    ? payload.sourceAuthUser.trim() : ''
  const authTokenRaw = payload !== null && typeof payload === 'object' && typeof payload.sourceAuthToken === 'string'
    ? payload.sourceAuthToken : ''
  const authClear = payload !== null && typeof payload === 'object' && payload.sourceAuthClear === true
  if (authTokenRaw !== '' && /[\u0000-\u001f\u007f]/.test(authTokenRaw)) {
    return { body: { ok: false, error: '访问令牌含非法字符' }, status: 400 }
  }
  if (authTokenRaw !== '' && authUserRaw === '') {
    return { body: { ok: false, error: '填写访问令牌时请同时填写 Git 用户名' }, status: 400 }
  }
  if (parsed.kind !== 'git' && (authTokenRaw !== '' || authClear === true)) {
    return { body: { ok: false, error: '私有仓库凭据只对远程 git 地址生效' }, status: 400 }
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

  /* 资源仓库分支：可选字段，只对远程 git 源生效（本机目录模式一律清空，绝不执行 git）。
     不传 = 保持原值（老前端向后兼容）；传空串 = 清除配置、回落默认分支。 */
  let rawBranch = null
  if (payload !== null && typeof payload === 'object' && payload.sourceBranch !== undefined) {
    const candidate = typeof payload.sourceBranch === 'string' ? payload.sourceBranch.trim() : ''
    if (candidate !== '' && !isValidBranchName(candidate)) {
      return {
        body: { ok: false, error: '分支名不合法：只支持字母、数字、. _ - /，不能以 - 或 / 开头，且不能含空格' },
        status: 400,
      }
    }
    rawBranch = candidate
  }
  const previousBranch = resolveSourceBranch()
  const keptBranch = rawBranch === null
    ? (typeof state.settings.sourceBranch === 'string' ? state.settings.sourceBranch.trim() : '')
    : rawBranch
  const nextBranch = parsed.kind === 'git' && keptBranch !== '' && isValidBranchName(keptBranch) ? keptBranch : null

  /* 个人工作台两个可选设置：不传保持原值、传空串恢复默认。
     插在既有校验之后，不改动 sourceUrl 必填与前面几项的校验顺序。 */
  const previousWorkbenchDir = workbenchHtmlDir(state.settings.workbenchDataDir)
  let nextWorkbenchDir = typeof state.settings.workbenchDataDir === 'string' ? state.settings.workbenchDataDir : null
  if (payload !== null && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'workbenchDataDir')) {
    const candidate = typeof payload.workbenchDataDir === 'string' ? payload.workbenchDataDir.trim() : ''
    if (candidate === '') nextWorkbenchDir = null
    else {
      const dirError = localWorkbenchDirError(candidate)
      if (dirError !== '') return { body: { ok: false, error: dirError }, status: 400 }
      nextWorkbenchDir = candidate
    }
  }
  let nextSyncMs = state.settings.syncIntervalMs
  if (payload !== null && typeof payload === 'object' && Object.prototype.hasOwnProperty.call(payload, 'syncIntervalMs')) {
    const rawMs = payload.syncIntervalMs
    if (rawMs === '' || rawMs === null) nextSyncMs = 2000
    else {
      const ms = Math.floor(Number(rawMs))
      if (!Number.isFinite(ms) || ms < 500 || ms > 60000) {
        return { body: { ok: false, error: '同步间隔需在 500-60000 毫秒之间' }, status: 400 }
      }
      nextSyncMs = ms
    }
  }

  // 记下改配置前的数据根：索引是绑定数据根的，根变了就必须作废。
  const oldRoot = dataRoot()
  // 写入前备份 state.json，写坏也不能留半截状态。
  try {
    if (isFile(STATE_FILE)) fs.copyFileSync(STATE_FILE, STATE_FILE + '.bak')
  } catch {
    // 备份失败不阻断保存（state 本身还没动）
  }

  try {
    if (authClear === true) {
      saveSecrets(BASE_DIR, { [SOURCE_AUTH_USER_KEY]: '', [SOURCE_AUTH_TOKEN_KEY]: '' })
    } else if (authTokenRaw !== '') {
      saveSecrets(BASE_DIR, { [SOURCE_AUTH_USER_KEY]: authUserRaw, [SOURCE_AUTH_TOKEN_KEY]: authTokenRaw })
    } else if (authUserRaw !== '' && getSourceAuth() !== null) {
      saveSecrets(BASE_DIR, { [SOURCE_AUTH_USER_KEY]: authUserRaw, [SOURCE_AUTH_TOKEN_KEY]: getSourceAuth().token })
    }
  } catch (error) {
    return { body: { ok: false, error: '凭据保存失败：' + String((error && error.message) || error) }, status: 500 }
  }
  state.settings.sourceUrl = value
  state.settings.sourceBranch = nextBranch
  const effectiveNextWorkbenchDir = workbenchHtmlDir(nextWorkbenchDir)
  state.settings.workbenchDataDir = nextWorkbenchDir
  state.settings.syncIntervalMs = nextSyncMs
  reconcileFromFlat() // v2 配置分层：旧字段写入后立即回填新对象，保证两个来源恒等
  /* 改目录时把旧目录的数据复制过去（保留旧目录，失败提示手动处理）。 */
  if (previousWorkbenchDir !== effectiveNextWorkbenchDir) {
    const result = migrateWorkbenchData(previousWorkbenchDir, effectiveNextWorkbenchDir)
    if (result.moved.length > 0) {
      const note = '已把旧数据目录（' + previousWorkbenchDir + '）的 ' + result.moved.length + ' 项复制到新目录：' + result.moved.join('、')
      state.warnings.push(note)
      console.warn('[workbench] ' + note)
    }
    if (result.ok === false) {
      const note = '数据目录迁移未完成（' + String(result.error || '未知错误') + '）；新旧目录均已保留，请手动核对：' + previousWorkbenchDir + ' → ' + effectiveNextWorkbenchDir
      state.warnings.push(note)
      console.warn('[workbench] ' + note)
    }
  }
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
  /* 只改分支、没改地址时数据根不变，上面的 oldRoot !== newRoot 不会命中；
     但索引内容确实可能随分支变化，仍要提示用户点「刷新」重新 fetch 该分支。 */
  const effectiveNextBranch = nextBranch === null ? '' : nextBranch
  if (parsed.kind === 'git' && effectiveNextBranch !== previousBranch) {
    indexSwitchPending = true
  }
  // 设置与「待刷新」标志一起落盘：重启后仍能提示点刷新，并抑制冷启动自动克隆。
  persistState()
  return {
    body: {
      ok: true,
      sourceUrl: value,
      sourceKind: parsed.kind,
      workbenchDataDir: nextWorkbenchDir === null ? '' : nextWorkbenchDir,
      syncIntervalMs: nextSyncMs,
      sourceBranch: nextBranch === null ? '' : nextBranch,
      defaultBranch: '',
      branchSupported: parsed.kind === 'git',
      skillhubUrl: typeof state.settings.skillhubUrl === 'string' ? state.settings.skillhubUrl : '',
    },
    status: 200,
  }
}

/**
 * `GET /workbench/settings`：独立工作台设置（配置分层）。
 *
 * dataDir / syncMs 从**旧扁平字段**读（与运行期数据面口径一致）。
 * @returns {Record<string, any>} 响应载荷
 */
/**
 * `GET /meta`：插件自身元数据 —— 版本、仓库地址、介绍弹窗的已读版本、最近升级历史。
 *
 * 前端设置页与介绍弹窗只读这一个接口，避免各自猜版本或各存一份状态。
 * @returns {Record<string, any>} 响应载荷
 */
function handleMeta() {
  const meta = readSelfMeta()
  /* 关于页地址：远程配置优先，package.json 派生值兜底，保证默认行为与以前一致。 */
  const about = state.settings.about !== null && typeof state.settings.about === 'object' ? state.settings.about : {}
  const repoUrl = typeof about.repoUrl === 'string' && about.repoUrl !== '' ? about.repoUrl : meta.repoUrl
  return {
    ok: true,
    name: meta.name,
    version: meta.version,
    repoUrl,
    starUrl: typeof about.starUrl === 'string' && about.starUrl !== '' ? about.starUrl : repoUrl,
    feedbackUrl: typeof about.feedbackUrl === 'string' && about.feedbackUrl !== '' ? about.feedbackUrl : (repoUrl + '/issues'),
    introSeenVersion: typeof state.settings.introSeenVersion === 'string' ? state.settings.introSeenVersion : null,
    updateHistory: Array.isArray(state.settings.updateHistory) ? state.settings.updateHistory.slice(0, 5) : [],
  }
}

/**
 * 记一条升级历史（新到旧，最多 5 条），并立刻落盘。
 * @param {{ ok: boolean, from: string, to: string, message: string }} entry 记录
 * @returns {void}
 */
function recordUpdateHistory(entry) {
  const list = Array.isArray(state.settings.updateHistory) ? state.settings.updateHistory : []
  list.unshift({
    at: new Date().toISOString(),
    ok: entry.ok === true,
    from: String(entry.from || ''),
    to: String(entry.to || ''),
    message: String(entry.message || ''),
  })
  state.settings.updateHistory = list.slice(0, 5)
  persistState()
}

/**
 * `POST /intro/ack`：把「已看过介绍」的版本号写进设置，下次启动不再弹。
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {Promise<{ body: Record<string, any>, status: number }>} 响应
 */
async function handleIntroAck(req) {
  let payload
  try {
    payload = JSON.parse((await readRawBody(req, 8 * 1024)).toString('utf8'))
  } catch {
    return { body: { ok: false, error: '请求体不是合法 JSON' }, status: 400 }
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { body: { ok: false, error: '请求体格式错误' }, status: 400 }
  }
  const version = typeof payload.version === 'string' ? payload.version.trim() : ''
  if (version === '') {
    return { body: { ok: false, error: 'version 必须是版本号字符串', code: 'invalid-version' }, status: 400 }
  }
  state.settings.introSeenVersion = version.slice(0, 40)
  persistState()
  return { body: { ok: true, introSeenVersion: state.settings.introSeenVersion }, status: 200 }
}

/**
 * `GET /update/check`：查 registry 上的最新版本（不安装）。
 *
 * 查询参数：`registry`（可选，覆盖默认 npm 官方）、`force=1`（跳过 5 分钟缓存）。
 * @param {URLSearchParams} query 查询参数
 * @returns {Promise<{ body: Record<string, any>, status: number }>} 响应
 */
async function handleUpdateCheck(query) {
  const registry = query.get('registry') || undefined
  const force = query.get('force') === '1'
  try {
    const info = await checkUpdate({ registry, force })
    return {
      body: {
        ok: true,
        current: info.current,
        latest: info.latest,
        hasUpdate: info.hasUpdate,
        publishedAt: info.publishedAt,
        registry: info.registry,
      },
      status: 200,
    }
  } catch (error) {
    return { body: { ok: false, error: String((error && error.message) || error), code: 'check-failed' }, status: 502 }
  }
}

/**
 * `POST /update/apply`：一键升级。
 *
 * body：`{ version?: string, dryRun?: boolean }`；不传 version 就升到最新版。
 * 成功后需要重启 dsh 才能加载新代码，响应里用 `reloadRequired: true` 标明。
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {Promise<{ body: Record<string, any>, status: number }>} 响应
 */
async function handleUpdateApply(req) {
  let payload
  try {
    payload = JSON.parse((await readRawBody(req, 8 * 1024)).toString('utf8'))
  } catch {
    return { body: { ok: false, error: '请求体不是合法 JSON' }, status: 400 }
  }
  const body = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  const version = typeof body.version === 'string' ? body.version.trim() : ''
  const meta = readSelfMeta()
  try {
    const result = await applyUpdate({ version, dryRun: body.dryRun === true })
    recordUpdateHistory({
      ok: true,
      from: result.from,
      to: result.to,
      message: result.dryRun === true ? '试运行：已下载并校验，未写入磁盘' : '已覆盖到 ' + String(result.files) + ' 个文件',
    })
    return {
      body: {
        ok: true,
        from: result.from,
        to: result.to,
        files: result.files,
        backup: result.backup,
        dryRun: result.dryRun === true,
        reloadRequired: result.dryRun !== true,
      },
      status: 200,
    }
  } catch (error) {
    const message = String((error && error.message) || error)
    recordUpdateHistory({ ok: false, from: meta.version, to: version || 'latest', message })
    return { body: { ok: false, error: message, code: 'apply-failed' }, status: 400 }
  }
}

/**
 * 当前在线资料库运行时配置。密钥从加密文件读取，state 里只有非敏感字段。
 * @returns {{config: object, ready: boolean}}
 */
function khubRuntime() {
  const config = configFromSettings(state.settings.khub, BASE_DIR)
  return { config, ready: configReady(config) }
}

/**
 * 选一个可写的在线空间作为本地工作台上传目标。
 * role 只读（READ / VIEWER）的跳过；没有明确 role 的空间按可写处理（兼容老服务端）。
 * @param {object} config 在线配置
 * @returns {Promise<{spaceId: number, name: string}|null>} 目标空间
 */
async function pickWritableSpace(config) {
  const catalog = await getCatalog(config)
  const spaces = Array.isArray(catalog.spaces) ? catalog.spaces : []
  const denied = /^(read|viewer|readonly)$/i
  for (const s of spaces) {
    const role = String((s && s.role) || '')
    if (denied.test(role)) continue
    const id = Number(s && s.id)
    if (Number.isFinite(id) && id > 0) return { spaceId: id, name: String((s && s.name) || '') }
  }
  return null
}

/* ------------------------------------------------------------------ 外部数据定时摄入 */

/** 摄入与补推的并发闸门：后台扫描和手动「立即处理」不叠加。 */
let ingestBusy = false

/**
 * 摄入上下文：插件数据根目录 + 工作台数据目录 + 在线配置（不可用时 config 为 null）。
 * @returns {{baseDir: string, dataDir: string, config: object|null}}
 */
function ingestContext() {
  const runtime = khubRuntime()
  /* 与个人工作台其它入口同口径：未配置时回落到默认数据目录，不为空串，
     否则外部数据同步弹窗会误报「未配置工作台数据目录」。 */
  const dir = workbenchHtmlDir(state.settings.workbenchDataDir)
  return { baseDir: BASE_DIR, dataDir: dir, config: runtime.ready ? runtime.config : null }
}

/** 摄入结果的错误码 → HTTP 状态（IngestError 自带 status，其它按 400 处理）。 */
function ingestStatusOf(error) {
  const status = error !== null && error !== undefined ? Number(error.status || 0) : 0
  return Number.isFinite(status) && status >= 400 ? status : 400
}

/**
 * POST /workbench/ingest：直接投递一个（或一批）批次。
 *
 * 支持两种形状：
 *  - 单个批次：`{batchId, workbench, table, ...}`
 *  - 多个批次：`{batches: [ ... ]}`
 * @param {import('node:http').IncomingMessage} req 请求
 * @returns {Promise<{status: number, body: object}>} 响应
 */
async function handleIngestSubmit(req) {
  const ctx = ingestContext()
  let raw = ''
  try {
    raw = (await readRawBody(req, 64 * 1024 * 1024)).toString('utf8')
  } catch (error) {
    return { status: 413, body: { ok: false, error: '请求体过大或读取失败：' + String((error && error.message) || error) } }
  }
  let payload = null
  try { payload = JSON.parse(raw) } catch (error) {
    return { status: 400, body: { ok: false, error: '请求体不是合法 JSON：' + String((error && error.message) || error) } }
  }
  const list = payload !== null && typeof payload === 'object' && Array.isArray(payload.batches)
    ? payload.batches
    : [payload]
  const options = payload !== null && typeof payload === 'object' ? payload.options || {} : {}
  const results = []
  for (const batch of list) {
    try {
      results.push(await applyBatch({
        baseDir: ctx.baseDir,
        dataDir: ctx.dataDir,
        batch,
        config: ctx.config,
        online: ctx.config !== null,
        chunkRows: Number(options.chunkRows) > 0 ? Number(options.chunkRows) : INGEST_DEFAULTS.chunkRows,
        deltaMax: Number(options.deltaMax) > 0 ? Number(options.deltaMax) : INGEST_DEFAULTS.deltaMax,
      }))
    } catch (error) {
      results.push({
        ok: false,
        batchId: batch !== null && typeof batch === 'object' ? String(batch.batchId || '') : '',
        error: String((error && error.message) || error),
        code: error !== null && error !== undefined ? String(error.code || '') : '',
      })
    }
  }
  const failed = results.filter((it) => it.ok === false)
  return {
    status: failed.length === 0 ? 200 : (failed.length === results.length ? ingestStatusOf({ status: 400 }) : 207),
    body: {
      ok: failed.length === 0,
      count: results.length,
      failed: failed.length,
      online: ctx.config !== null,
      dataDir: ctx.dataDir,
      results,
    },
  }
}

/**
 * POST /workbench/ingest/flush：手动处理 inbox + 补推待推队列。
 * @returns {Promise<{status: number, body: object}>} 响应
 */
async function handleIngestFlush() {
  if (ingestBusy === true) {
    return { status: 429, body: { ok: false, error: '上一轮摄入还没结束，请稍后再试' } }
  }
  const ctx = ingestContext()
  ingestBusy = true
  try {
    const inbox = await processInbox(ctx)
    const pending = await flushPending(ctx)
    return { status: 200, body: { ok: true, inbox, pending, status: ingestStatus(ctx) } }
  } finally {
    ingestBusy = false
  }
}

/**
 * 后台一轮：扫描 inbox + 补推待推。失败只记日志，不影响插件其它功能。
 * @returns {Promise<void>}
 */
async function ingestTick() {
  const ctx = ingestContext()
  if (ctx.dataDir === '' && ctx.config === null) return
  if (ingestBusy === true) return
  ingestBusy = true
  try {
    const inbox = await processInbox(ctx)
    const pending = await flushPending(ctx)
    if (inbox.failed > 0 || pending.failed > 0) {
      state.warnings.push('外部数据摄入：' + String(inbox.failed) + ' 个批次失败，' + String(pending.failed) + ' 张表待补推')
      if (state.warnings.length > 200) state.warnings = state.warnings.slice(-100)
    }
  } catch (error) {
    state.warnings.push('外部数据摄入异常：' + humanError(error))
    if (state.warnings.length > 200) state.warnings = state.warnings.slice(-100)
  } finally {
    ingestBusy = false
  }
}

/** GET /khub/settings：只回显非敏感字段 + 是否已配置密钥。 */
function handleKhubSettingsGet() {
  return publicSettings(state.settings.khub, BASE_DIR)
}

/**
 * POST /khub/settings：保存在线资料库配置。
 * 明文密钥只在本次请求里出现，写入 credentials.enc（AES-256-GCM），不进 state.json、
 * 不进日志、不回显。空串表示「不改动」，显式 clear* 才删除。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<{body: object, status: number}>}
 */
async function handleKhubSettingsSave(req) {
  let payload
  try {
    const raw = await readRawBody(req, 64 * 1024)
    payload = JSON.parse(raw.toString('utf8'))
  } catch {
    return { body: { ok: false, error: '请求体不是合法 JSON' }, status: 400 }
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { body: { ok: false, error: '请求体必须是 JSON 对象' }, status: 400 }
  }
  const current = state.settings.khub
  const next = {
    baseUrl: current.baseUrl,
    clientId: current.clientId,
    enabled: current.enabled,
    enabledRev: 2,
    /* 上传幂等状态随配置保存保留，不被覆盖丢失。 */
    uploadedWorkbenches: current.uploadedWorkbenches !== null && typeof current.uploadedWorkbenches === 'object' && !Array.isArray(current.uploadedWorkbenches) ? current.uploadedWorkbenches : {},
    autoUploadDone: current.autoUploadDone === true,
    autoUploadAt: Number(current.autoUploadAt) || 0,
  }
  if (payload.baseUrl !== undefined) {
    const raw = typeof payload.baseUrl === 'string' ? payload.baseUrl.trim() : ''
    if (raw !== '' && !isValidBaseUrl(raw)) {
      return { body: { ok: false, error: '服务地址必须是 http(s):// 开头的合法 URL' }, status: 400 }
    }
    next.baseUrl = raw === '' ? '' : (new URL(raw)).origin + (new URL(raw)).pathname.replace(/\/+$/, '')
  }
  if (payload.clientId !== undefined) {
    next.clientId = typeof payload.clientId === 'string' ? payload.clientId.trim().slice(0, 120) : ''
  }
  /* 「填完就默认打开」：只有显式传 enabled=false 才保持关闭；
     其它情况（未传 / true）在保存配置后一律视为开启，用户不需要再点开关。 */
  if (payload.enabled === false) next.enabled = false
  else if (payload.enabled === true || payload.enabled === undefined) next.enabled = true
  else return { body: { ok: false, error: 'enabled 必须是布尔值' }, status: 400 }
  /* 敏感值：非空覆盖，clear* 删除，其余不动。 */
  const secretPatch = {}
  if (typeof payload.clientSecret === 'string' && payload.clientSecret.trim() !== '') {
    secretPatch[KHUB_CLIENT_SECRET_KEY] = payload.clientSecret.trim()
  } else if (payload.clearClientSecret === true) {
    secretPatch[KHUB_CLIENT_SECRET_KEY] = ''
  }
  if (typeof payload.apiKey === 'string' && payload.apiKey.trim() !== '') {
    secretPatch[KHUB_API_KEY_KEY] = payload.apiKey.trim()
  } else if (payload.clearApiKey === true) {
    secretPatch[KHUB_API_KEY_KEY] = ''
  }
  try {
    if (Object.keys(secretPatch).length > 0) saveSecrets(BASE_DIR, secretPatch)
  } catch (error) {
    return { body: { ok: false, error: '密钥保存失败：' + String((error && error.message) || error) }, status: 500 }
  }
  state.settings.khub = next
  try { persistState() } catch { /* 落盘失败不阻断本次会话 */ }
  /* 在线配置就绪后自动把本地工作台上传一遍（不阻塞保存响应）。
     只在新配置 ready 时触发；autoUploadLocalWorkbenches 内部用 autoUploadDone 保证幂等。 */
  const nowReady = configReady(configFromSettings(next, BASE_DIR))
  if (nowReady && next.enabled !== false) {
    const cfg = configFromSettings(next, BASE_DIR)
    setTimeout(() => {
      autoUploadLocalWorkbenches(cfg, false).catch((error) => {
        state.warnings.push('[本地→在线上传] 失败：' + String((error && error.message) || error))
      })
    }, 0)
  }
  return { body: Object.assign({ ok: true, saved: true }, publicSettings(next, BASE_DIR)), status: 200 }
}

function handleWorkbenchSettingsGet() {
  const wb = state.settings.workbench
  /* 未配置时用默认数据目录：HTML 与 CSV 都在这里，用户不配置也能用。 */
  const configuredDir = typeof state.settings.workbenchDataDir === 'string' ? state.settings.workbenchDataDir.trim() : ''
  const dataDir = workbenchHtmlDir(configuredDir)
  const rawMs = state.settings.syncIntervalMs
  const syncMs = typeof rawMs === 'number' && Number.isFinite(rawMs)
    ? Math.min(60000, Math.max(500, Math.floor(rawMs))) : 2000
  return {
    ok: true,
    dataDir,
    configuredDataDir: configuredDir,
    dataDirDefault: WORKBENCH_DIR,
    usingDefaultDataDir: dataDir === WORKBENCH_DIR,
    dataDirReady: localWorkbenchDirError(dataDir) === '',
    syncMs,
    htmlDir: dataDir,
    order: Array.isArray(wb.order) ? wb.order.slice() : [],
    autoSync: wb.autoSync !== false,
    lastPrefs: wb.lastPrefs !== null && typeof wb.lastPrefs === 'object' && !Array.isArray(wb.lastPrefs)
      ? wb.lastPrefs : null,
  }
}

/**
 * `POST /workbench/settings`：独立工作台设置保存。
 *
 * 字段全可选、不传保持原值；**不依赖 sourceUrl**（与 /settings 的关键区别）。
 * 设置端点严格 400（带机器可读 code），未知枚举直接拒绝；写入统一经
 * applyWorkbenchPatch() 收口，200 回显完整 GET 形态。
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {Promise<{ body: Record<string, any>, status: number }>} 响应
 */
async function handleWorkbenchSettingsSave(req) {
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
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { body: { ok: false, error: '请求体格式错误' }, status: 400 }
  }
  /** @type {{ dataDir?: string|null, syncMs?: number, order?: string[], autoSync?: boolean }} */
  const patch = {}
  if (Object.prototype.hasOwnProperty.call(payload, 'dataDir')) {
    const v = payload.dataDir
    if (typeof v !== 'string') {
      return { body: { ok: false, error: '数据目录必须是字符串', code: 'invalid-data-dir' }, status: 400 }
    }
    const candidate = v.trim()
    if (candidate === '') patch.dataDir = null
    else {
      if (localWorkbenchDirError(candidate) !== '') {
        return { body: { ok: false, error: '数据目录不可用：' + candidate, code: 'invalid-data-dir' }, status: 400 }
      }
      patch.dataDir = candidate
    }
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'syncMs')) {
    const v = payload.syncMs
    if (v === '' || v === null) patch.syncMs = 2000
    else {
      const ms = Number(v)
      if (!Number.isFinite(ms) || !Number.isInteger(ms) || ms < 500 || ms > 60000) {
        return { body: { ok: false, error: '同步间隔需为 500-60000 之间的整数毫秒', code: 'invalid-sync-ms' }, status: 400 }
      }
      patch.syncMs = ms
    }
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'order')) {
    const v = payload.order
    if (!Array.isArray(v)) {
      return { body: { ok: false, error: '工作台顺序必须是数组', code: 'invalid-order' }, status: 400 }
    }
    if (v.length > 500 || v.some((id) => typeof id !== 'string' || WORKBENCH_ID_SHAPE.test(id) === false)) {
      return { body: { ok: false, error: '工作台顺序里有非法 id', code: 'invalid-order' }, status: 400 }
    }
    patch.order = v
  }
  /* 自动刷新开关：只接受布尔，避免 "false" / 0 之类被宽转成意外状态。 */
  if (Object.prototype.hasOwnProperty.call(payload, 'autoSync')) {
    if (typeof payload.autoSync !== 'boolean') {
      return { body: { ok: false, error: '自动刷新开关必须是布尔值', code: 'invalid-auto-sync' }, status: 400 }
    }
    patch.autoSync = payload.autoSync
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'action')) {
    return { body: { ok: false, error: '不支持的操作', code: 'invalid-action' }, status: 400 }
  }
  applyWorkbenchPatch(patch, 'POST /workbench/settings')
  return { body: handleWorkbenchSettingsGet(), status: 200 }
}

/**
 * `POST /settings/reset`：删除覆盖，回落内置默认地址。
 * @returns {{ body: Record<string, any>, status: number }} 响应
 */
/**
 * 写插件安装标记（更新 / 删除的凭证）。
 * @param {string} dir 本地安装目录
 * @param {string} type 资源类型
 * @param {string} id 资源 id
 * @param {string} version 安装时的版本
 * @returns {void}
 */
function writeInstallMarker(dir, type, id, version) {
  try {
    fs.writeFileSync(path.join(dir, PLUGIN_INSTALL_MARKER), JSON.stringify({
      plugin: 'dsh-buddy-expert-hub', type, id, version: String(version || ''), installedAt: Date.now(),
    }, null, 2), 'utf8')
  } catch { /* 标记写失败不影响安装本身，只是这次不能自动更新 / 删除 */ }
}

/**
 * 读插件安装标记；没有 / 解析失败返回 null（视为手工放置，不允许更新删除）。
 * @param {string} dir 本地安装目录
 * @returns {Record<string, any>|null} 标记对象
 */
function readInstallMarker(dir) {
  const m = readJsonSafe(path.join(dir, PLUGIN_INSTALL_MARKER))
  return m !== null && typeof m === 'object' && m.plugin === 'dsh-buddy-expert-hub' ? m : null
}

/**
 * 删除插件安装的本地目录（只删带标记或明确信任的目录）。
 * @param {string} dir 目标目录
 * @returns {{ ok: boolean, error?: string }} 结果
 */
function removeInstalledDir(dir) {
  try {
    if (!isDir(dir)) return { ok: true }
    fs.rmSync(dir, { recursive: true, force: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: humanError(error) }
  }
}

/**
 * 资源更新 / 删除能力查询（专家 / 专家团 / 技能 / 连接器）。
 *
 * 只认「插件自己装到本地」的条目才给 canDelete：
 *  - 专家 / 专家团：state.importedIds 记录 + 本地 DSH 目录存在；
 *  - 技能：state.installedSkills[dir] 有记录（源为 repo / market），且目录存在；
 *  - 连接器：复用已有的 installed 判定 + 本地定义目录。
 * 版本取「资源库清单优先、本地安装记录兜底」，连接器无版本字段 → canUpdate 恒 false。
 *
 * @param {string} type expert|team|skill|connector
 * @param {string} id 资源 id
 * @returns {Record<string, any>} 状态对象
 */
function handleResourceStatus(type, id) {
  const key = String(id === null || id === undefined ? '' : id).trim()
  if (key === '') return { ok: false, error: '缺少 id' }
  const base = { ok: true, type, id: key, installed: false, installedVersion: '', remoteVersion: '', canUpdate: false, canDelete: false }

  if (type === 'expert' || type === 'team') {
    const expected = type === 'team' ? 'team' : 'agent'
    let item = null
    const index = requireIndex()
    if (index !== null) {
      item = index.experts.find((e) => e.id === key && e.type === expected) || index.experts.find((e) => e.id === key) || null
      base.remoteVersion = item !== null && typeof item.version === 'string' ? item.version : ''
    }
    const localDir = path.join(LOCAL_EXPERTS_DIR, key)
    const installed = isDir(localDir)
    base.installed = installed
    /* 标记优先（新装的可靠凭证），旧数据没有标记时回落 importedIds。 */
    base.installedLocally = installed && (readInstallMarker(localDir) !== null || state.importedIds.indexOf(key) >= 0)
    if (installed) {
      /* 本地版本只认「安装当时写入的标记」—— 它是固定快照。
         绝不能读 IMPORTED_DIR 的原始 plugin.json：那份文件会随资源仓库刷新被改写，
         导致本地版本跟着远端一起变，版本比较永远相等、更新按钮永不出现。 */
      const marker = readInstallMarker(localDir)
      if (marker !== null && typeof marker.version === 'string') base.installedVersion = marker.version
      /* 历史数据兜底：没有标记时读原始包清单（仅此时才可能跟着资源库变）。 */
      if (base.installedVersion === '') {
        const manifest = readLocalSourceManifest(key)
        if (manifest !== null && typeof manifest.version === 'string') base.installedVersion = manifest.version
      }
    }
    base.canDelete = base.installedLocally === true
    base.canUpdate = installed && base.remoteVersion !== '' && base.installedVersion !== '' &&
      compareVersion(base.remoteVersion, base.installedVersion) > 0
    return base
  }

  if (type === 'skill') {
    const index = requireIndex()
    let repoItem = null
    if (index !== null) {
      repoItem = findRepoSkill(index, key)
      /* 详情回传的是本地目录名（如 demo-skill），仓库索引 id 却是 skills/demo-skill；
         两种形态都试，否则远程版本读不到、更新按钮永远不出现。 */
      if (repoItem === null && key.indexOf('/') < 0) repoItem = findRepoSkill(index, 'skills/' + key)
    }
    if (repoItem !== null && typeof repoItem.version === 'string') base.remoteVersion = repoItem.version
    const installed = resolveInstalledSkillLoose(key)
    base.installed = installed !== null
    if (installed !== null) {
      const marker = readInstallMarker(installed.abs)
      const display = readSkillDisplayMeta(installed.abs)
      /* 安装标记优先（固定快照），其次本地 _skillhub_meta.json。 */
      if (marker !== null && typeof marker.version === 'string') base.installedVersion = marker.version
      else if (display !== null && typeof display.version === 'string') base.installedVersion = display.version
      const rec = state.installedSkills[installed.dir]
      /* 只认插件装过的技能：带标记 或 state 记录 source=repo/market，手工放置的不删。 */
      base.installedLocally = readInstallMarker(installed.abs) !== null ||
        (rec !== null && rec !== undefined && (rec.source === 'repo' || rec.source === 'market'))
      if (base.installedVersion === '' && rec !== null && typeof rec.version === 'string') base.installedVersion = rec.version
    }
    base.canDelete = base.installedLocally === true
    base.canUpdate = base.installed && base.remoteVersion !== '' && base.installedVersion !== '' &&
      compareVersion(base.remoteVersion, base.installedVersion) > 0
    return base
  }

  if (type === 'connector') {
    /* 连接器定义没有 version 字段：不做版本比较，只提供删除（复用已安装判定）。 */
    const item = findConnectorItem(key)
    base.installed = item !== undefined && item.installed === true
    base.canDelete = base.installed
    return base
  }

  return { ok: false, error: '不支持的资源类型：' + type }
}

/**
 * 更新已安装的本地资源：删掉旧目录后重新走安装流程（覆盖）。
 * 只允许更新「插件装的」（带标记或 state 记录），手工放置的不动。
 * @param {import('node:http').IncomingMessage} req 请求
 * @returns {Promise<Record<string, any>>} 结果
 */
async function handleResourceUpdate(req) {
  let payload
  try {
    payload = JSON.parse((await readRawBody(req, 64 * 1024)).toString('utf8'))
  } catch (error) {
    return { ok: false, error: '请求体不合法：' + humanError(error) }
  }
  const type = String(payload !== null && payload.type ? payload.type : '')
  const id = safeId(payload !== null ? payload.id : '')
  if (id === null) return { ok: false, error: '非法 id' }
  const status = handleResourceStatus(type, id)
  if (status.ok !== true) return status
  if (status.installed !== true) return { ok: false, error: '该资源还没安装，无法更新' }
  if (status.canUpdate !== true) {
    return { ok: false, error: '没有可用更新（本地版本已是最新或版本信息缺失）', remoteVersion: status.remoteVersion, installedVersion: status.installedVersion }
  }

  if (type === 'expert' || type === 'team') {
    if (status.installedLocally !== true) return { ok: false, error: '本地目录不是插件安装的，不允许覆盖' }
    /* 删两类目录：DSH 原生包 + 原始 bundle，随后 handleImport 会重建。 */
    const dirs = [path.join(LOCAL_EXPERTS_DIR, id), path.join(IMPORTED_DIR, id)]
    for (const dir of dirs) {
      const r = removeInstalledDir(dir)
      if (r.ok !== true) return { ok: false, error: '旧版本清理失败：' + r.error }
    }
    const root = dataRoot()
    if (root === null) return { ok: false, error: '没有可用的数据源' }
    const item = requireIndex() === null ? null : requireIndex().experts.find((e) => e.id === id)
    if (item === undefined || item === null) return { ok: false, error: '资源库里找不到该条目：' + id }
    const plugin = readPluginManifest(path.join(root, 'experts', id))
    if (plugin === null) return { ok: false, error: '源条目的 plugin.json 不可解析' }
    plugin.__dirName = id
    const written = writeDshExpertPackage(root, plugin)
    if (written.ok !== true) return { ok: false, error: written.error || '写入 DSH 专家目录失败' }
    writeSourceBundle(root, id)
    copyExpertSkills(path.join(root, 'experts', id), path.join(LOCAL_EXPERTS_DIR, id), id)
    if (!state.importedIds.includes(id)) { state.importedIds.push(id); persistState() }
    writeInstallMarker(path.join(LOCAL_EXPERTS_DIR, id), type, id, status.remoteVersion)
    return { ok: true, updated: true, from: status.installedVersion, to: status.remoteVersion, id, type }
  }

  if (type === 'skill') {
    const installed = resolveInstalledSkillLoose(id)
    if (installed === null) return { ok: false, error: '找不到已安装的技能目录' }
    if (status.installedLocally !== true) return { ok: false, error: '该技能不是插件安装的，不允许覆盖' }
    const r = removeInstalledDir(installed.abs)
    if (r.ok !== true) return { ok: false, error: '旧版本清理失败：' + r.error }
    let sourceDir = resolveRepoSkillDir(id)
    if (sourceDir === null && id.indexOf('/') < 0) sourceDir = resolveRepoSkillDir('skills/' + id)
    if (sourceDir === null) return { ok: false, error: '资源库里找不到该技能：' + id }
    const meta = readSkillMeta(sourceDir)
    const dir = skillDirNameOf(meta !== null ? meta.name : path.basename(sourceDir)) || skillDirNameOf(path.basename(sourceDir))
    if (dir === '') return { ok: false, error: '技能名无法生成合法目录名' }
    const targetDir = path.join(SKILLS_INSTALL_DIR, dir)
    fs.mkdirSync(targetDir, { recursive: true })
    const warnings = []
    const copied = copyDirFiles(sourceDir, targetDir, warnings, '技能')
    if (copied === 0) {
      try { fs.rmSync(targetDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
      return { ok: false, error: '复制技能文件失败' + (warnings.length > 0 ? '：' + warnings[0] : '') }
    }
    state.installedSkills[dir] = { enabled: true, source: 'repo', installedAt: Date.now() }
    persistState()
    writeInstallMarker(targetDir, 'skill', id, status.remoteVersion)
    return { ok: true, updated: true, from: status.installedVersion, to: status.remoteVersion, id, dir }
  }

  return { ok: false, error: '该资源类型不支持更新' }
}

/**
 * 删除本地安装的本地资源（专家 / 专家团 / 技能）。连接器走现有卸载路由。
 * 只允许删「插件装的」（带标记或 state 记录），带二次确认由前端负责。
 */
async function handleResourceDelete(req) {
  let payload
  try {
    payload = JSON.parse((await readRawBody(req, 64 * 1024)).toString('utf8'))
  } catch (error) {
    return { ok: false, error: '请求体不合法：' + humanError(error) }
  }
  const type = String(payload !== null && payload.type ? payload.type : '')
  const id = safeId(payload !== null ? payload.id : '')
  if (id === null) return { ok: false, error: '非法 id' }
  const status = handleResourceStatus(type, id)
  if (status.ok !== true) return status
  if (status.installed !== true) return { ok: true, deleted: false, message: '本地未安装，无需删除' }
  if (status.canDelete !== true) return { ok: false, error: '该目录不是插件安装的，不允许删除（请手动处理）' }

  if (type === 'expert' || type === 'team') {
    const dirs = [path.join(LOCAL_EXPERTS_DIR, id), path.join(IMPORTED_DIR, id)]
    for (const dir of dirs) {
      const r = removeInstalledDir(dir)
      if (r.ok !== true) return { ok: false, error: '删除失败：' + r.error }
    }
    state.importedIds = state.importedIds.filter((x) => x !== id)
    persistState()
    return { ok: true, deleted: true, id, type }
  }
  if (type === 'skill') {
    const installed = resolveInstalledSkillLoose(id)
    if (installed === null) return { ok: true, deleted: false }
    const r = removeInstalledDir(installed.abs)
    if (r.ok !== true) return { ok: false, error: '删除失败：' + r.error }
    delete state.installedSkills[installed.dir]
    persistState()
    return { ok: true, deleted: true, id, dir: installed.dir }
  }
  return { ok: false, error: '该资源类型不支持删除' }
}

function handleSettingsReset() {
  if (state.settings.sourceUrl === null) {
    // 地址已是默认但残留分支配置（旧 state 手工改坏）时一并清掉。
    if (state.settings.sourceBranch !== null) {
      state.settings.sourceBranch = null
      persistState()
    }
    return {
      body: {
        ok: true, sourceUrl: SOURCE_URL, sourceKind: 'git', defaultUrl: SOURCE_URL, usingDefault: true,
        sourceBranch: '', defaultBranch: '', branchSupported: true,
      },
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
  state.settings.sourceBranch = null
  try { saveSecrets(BASE_DIR, { [SOURCE_AUTH_USER_KEY]: '', [SOURCE_AUTH_TOKEN_KEY]: '' }) } catch { /* 清理失败不阻断重置 */ }
  dataRootCache = null
  const newRoot = dataRoot()
  if (oldRoot !== newRoot) indexSwitchPending = true
  // 与「待刷新」标志一起落盘，重启后行为不变。
  persistState()
  return {
    body: {
      ok: true, sourceUrl: SOURCE_URL, sourceKind: 'git', defaultUrl: SOURCE_URL, usingDefault: true,
      sourceBranch: '', defaultBranch: '', branchSupported: true,
    },
    status: 200,
  }
}

// ---------------------------------------------------------------------------
// 远程配置（用户输入 http URL 或上传 JSON → 覆盖设置页参数）
// ---------------------------------------------------------------------------

/**
 * 抓取「远程配置可覆盖字段」的当前本地值，作为恢复快照。
 * 密钥明文不进快照（快照会落 state.json）：本地密钥先备份到 credentials.enc 的
 * 专用键，快照里只记「已备份」标记，清除时再从加密文件读回。
 * @returns {object} 快照对象
 */
function captureRemoteSnapshot() {
  const s = state.settings
  const snap = {
    sourceUrl: s.sourceUrl,
    sourceBranch: s.sourceBranch,
    skillhubUrl: s.skillhubUrl,
    workbench: {
      dataDir: s.workbench.dataDir,
      syncMs: s.workbench.syncMs,
      order: s.workbench.order.slice(),
      autoSync: s.workbench.autoSync,
    },
    khub: { baseUrl: s.khub.baseUrl, clientId: s.khub.clientId, enabled: s.khub.enabled },
    zhiliao: {
      testMode: s.zhiliao.testMode,
      replyBaseUrl: s.zhiliao.replyBaseUrl,
      internalBaseUrl: typeof s.zhiliao.internalBaseUrl === 'string' ? s.zhiliao.internalBaseUrl : '',
      enabled: s.zhiliao.enabled,
      queue: Object.assign({}, s.zhiliao.queue),
      recycle: Object.assign({}, s.zhiliao.recycle),
    },
    about: Object.assign({}, s.about),
    khubSecretsBackedUp: false,
  }
  /* 把当前密钥备份进加密文件（空串由 saveSecrets 语义删除备份键，保证干净）。 */
  try {
    const secrets = readSecrets(BASE_DIR)
    saveSecrets(BASE_DIR, {
      [REMOTE_BAK_CLIENT_SECRET]: typeof secrets[KHUB_CLIENT_SECRET_KEY] === 'string' ? secrets[KHUB_CLIENT_SECRET_KEY] : '',
      [REMOTE_BAK_API_KEY]: typeof secrets[KHUB_API_KEY_KEY] === 'string' ? secrets[KHUB_API_KEY_KEY] : '',
    })
    snap.khubSecretsBackedUp = true
  } catch { /* 备份失败不阻断加载；清除时按「无备份」处理 */ }
  return snap
}

/**
 * 从快照恢复本地设置（「清除远程配置」用）。恢复后触发必要副作用，与保存路径一致。
 * @param {object} snap captureRemoteSnapshot() 产出的快照
 * @returns {void}
 */
function restoreRemoteSnapshot(snap) {
  if (snap === null || typeof snap !== 'object') return
  const s = state.settings
  const oldRoot = dataRoot()

  if (typeof snap.sourceUrl === 'string' || snap.sourceUrl === null) s.sourceUrl = snap.sourceUrl
  if (typeof snap.sourceBranch === 'string' || snap.sourceBranch === null) s.sourceBranch = snap.sourceBranch
  if (typeof snap.skillhubUrl === 'string' || snap.skillhubUrl === null) s.skillhubUrl = snap.skillhubUrl

  if (snap.workbench !== null && typeof snap.workbench === 'object') {
    applyWorkbenchPatch({
      dataDir: snap.workbench.dataDir,
      syncMs: snap.workbench.syncMs,
      order: Array.isArray(snap.workbench.order) ? snap.workbench.order : [],
      autoSync: snap.workbench.autoSync !== false,
    }, 'remote-config-restore')
  }
  if (snap.khub !== null && typeof snap.khub === 'object') {
    s.khub.baseUrl = typeof snap.khub.baseUrl === 'string' ? snap.khub.baseUrl : ''
    s.khub.clientId = typeof snap.khub.clientId === 'string' ? snap.khub.clientId : ''
    s.khub.enabled = snap.khub.enabled !== false
    s.khub.enabledRev = 2
    /* 密钥：从加密文件的备份键读回还原，随后删掉备份键（空串=删除）。 */
    if (snap.khubSecretsBackedUp === true) {
      try {
        const secrets = readSecrets(BASE_DIR)
        saveSecrets(BASE_DIR, {
          [KHUB_CLIENT_SECRET_KEY]: typeof secrets[REMOTE_BAK_CLIENT_SECRET] === 'string' ? secrets[REMOTE_BAK_CLIENT_SECRET] : '',
          [KHUB_API_KEY_KEY]: typeof secrets[REMOTE_BAK_API_KEY] === 'string' ? secrets[REMOTE_BAK_API_KEY] : '',
          [REMOTE_BAK_CLIENT_SECRET]: '',
          [REMOTE_BAK_API_KEY]: '',
        })
      } catch { /* 还原失败不阻断清除 */ }
    }
  }
  if (snap.about !== null && typeof snap.about === 'object') {
    s.about = {
      repoUrl: typeof snap.about.repoUrl === 'string' ? snap.about.repoUrl : '',
      starUrl: typeof snap.about.starUrl === 'string' ? snap.about.starUrl : '',
      feedbackUrl: typeof snap.about.feedbackUrl === 'string' ? snap.about.feedbackUrl : '',
    }
  }
  if (snap.zhiliao !== null && typeof snap.zhiliao === 'object') {
    const z = snap.zhiliao
    s.zhiliao.testMode = z.testMode === true
    s.zhiliao.replyBaseUrl = typeof z.replyBaseUrl === 'string' ? z.replyBaseUrl : ''
    s.zhiliao.internalBaseUrl = typeof z.internalBaseUrl === 'string' ? z.internalBaseUrl : ''
    s.zhiliao.enabled = z.enabled !== false
    if (z.queue !== null && typeof z.queue === 'object') s.zhiliao.queue = Object.assign({}, z.queue)
    if (z.recycle !== null && typeof z.recycle === 'object') s.zhiliao.recycle = Object.assign({}, z.recycle)
    /* 运行中的单例同步到恢复值。 */
    if (zhiliaoQueue !== null) ensureZhiliaoQueue()
    if (zhiliaoRecycler !== null) {
      zhiliaoRecycler.enabled = s.zhiliao.recycle.enabled === true
      zhiliaoRecycler.idleMinutes = s.zhiliao.recycle.idleMinutes
    }
    try { zhiliaoWsRestart() } catch { /* WS 重连失败不阻止恢复 */ }
  }

  /* 数据源可能变了：与 /settings/reset 同一套失效逻辑。 */
  dataRootCache = null
  if (oldRoot !== dataRoot()) indexSwitchPending = true
}

/**
 * 把规范化后的 patch 应用到 state.settings，并触发与保存路径一致的副作用。
 * 调用方负责 persistState()（applyWorkbenchPatch 内部也会写一次，重复无害）。
 * @param {object} patch normalizeRemoteConfig() 的 patch
 * @returns {void}
 */
function applyRemotePatch(patch) {
  if (patch === null || typeof patch !== 'object') return
  const s = state.settings
  const oldRoot = dataRoot()
  const oldBranch = resolveSourceBranch()

  if (Object.prototype.hasOwnProperty.call(patch, 'sourceUrl')) s.sourceUrl = patch.sourceUrl
  if (Object.prototype.hasOwnProperty.call(patch, 'sourceBranch')) s.sourceBranch = patch.sourceBranch
  if (Object.prototype.hasOwnProperty.call(patch, 'skillhubUrl')) s.skillhubUrl = patch.skillhubUrl

  if (patch.workbench !== null && typeof patch.workbench === 'object') {
    applyWorkbenchPatch(patch.workbench, 'remote-config-apply')
  }
  if (patch.khub !== null && typeof patch.khub === 'object') {
    const kh = patch.khub
    if (Object.prototype.hasOwnProperty.call(kh, 'baseUrl')) s.khub.baseUrl = kh.baseUrl
    if (Object.prototype.hasOwnProperty.call(kh, 'clientId')) s.khub.clientId = kh.clientId
    if (Object.prototype.hasOwnProperty.call(kh, 'enabled')) { s.khub.enabled = kh.enabled; s.khub.enabledRev = 2 }
    /* 密钥只写加密文件，绝不写 state.json；normalize 已保证空串不会出现在这里。 */
    const remoteSecrets = {}
    if (Object.prototype.hasOwnProperty.call(kh, 'clientSecret')) remoteSecrets[KHUB_CLIENT_SECRET_KEY] = kh.clientSecret
    if (Object.prototype.hasOwnProperty.call(kh, 'apiKey')) remoteSecrets[KHUB_API_KEY_KEY] = kh.apiKey
    if (Object.keys(remoteSecrets).length > 0) {
      try { saveSecrets(BASE_DIR, remoteSecrets) } catch (error) {
        state.warnings.push('远程密钥保存失败：' + humanError(error))
      }
    }
  }
  if (patch.about !== null && typeof patch.about === 'object') {
    for (const key of ['repoUrl', 'starUrl', 'feedbackUrl']) {
      if (Object.prototype.hasOwnProperty.call(patch.about, key)) s.about[key] = patch.about[key]
    }
  }
  if (patch.zhiliao !== null && typeof patch.zhiliao === 'object') {
    const z = patch.zhiliao
    for (const key of ['testMode', 'enabled', 'replyBaseUrl', 'internalBaseUrl']) {
      if (Object.prototype.hasOwnProperty.call(z, key)) s.zhiliao[key] = z[key]
    }
    if (z.queue !== null && typeof z.queue === 'object') s.zhiliao.queue = Object.assign({}, z.queue)
    if (z.recycle !== null && typeof z.recycle === 'object') s.zhiliao.recycle = Object.assign({}, z.recycle)
    if (zhiliaoQueue !== null) ensureZhiliaoQueue()
    if (zhiliaoRecycler !== null) {
      zhiliaoRecycler.enabled = s.zhiliao.recycle.enabled === true
      zhiliaoRecycler.idleMinutes = s.zhiliao.recycle.idleMinutes
    }
    try { zhiliaoWsRestart() } catch { /* WS 重连失败不阻止应用 */ }
  }

  /* 数据源 / 分支变化时按 /settings 的语义作废旧索引，避免界面显示新地址却用旧数据。 */
  dataRootCache = null
  const newRoot = dataRoot()
  const newBranch = resolveSourceBranch()
  if (oldRoot !== newRoot) {
    if (parseSource(resolveSourceUrl()).kind === 'local') {
      indexSwitchPending = false
      lastSyncFailedAt = null
      invalidateIndexForNewRoot()
    } else {
      indexSwitchPending = true
    }
  } else if (oldBranch !== newBranch && parseSource(resolveSourceUrl()).kind === 'git') {
    indexSwitchPending = true
  }
}

/**
 * GET /config/remote：当前远程配置状态 + 可用字段说明 + 示例 JSON。
 * @returns {Record<string, any>} 响应载荷
 */
function handleRemoteConfigGet() {
  const meta = state.settings.remoteConfig
  return {
    ok: true,
    config: {
      source: meta.source || '',
      url: meta.url || '',
      filename: meta.filename || '',
      loadedAt: meta.loadedAt || null,
      appliedFields: Array.isArray(meta.appliedFields) ? meta.appliedFields.slice() : [],
      active: meta.loadedAt !== null && Array.isArray(meta.appliedFields) && meta.appliedFields.length > 0,
    },
    fieldDocs: REMOTE_CONFIG_FIELD_DOCS,
    /* 导出当前全量配置（示例字段范围、密钥字段空串占位）。 */
    sample: sampleConfigText(state.settings),
  }
}

/**
 * 从 URL 拉取 JSON 文本（超时 + 大小上限 + 仅 http(s)）。
 * @param {string} url 地址
 * @returns {Promise<string>} 文本
 */
async function fetchRemoteConfigText(url) {
  if (!isValidHttpUrl(url)) throw new Error('配置文件地址需为合法的 http(s) URL')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REMOTE_CONFIG_TIMEOUT_MS)
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json,text/plain,*/*' },
      signal: controller.signal,
    })
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' ' + String(resp.statusText || ''))
    const buf = await resp.arrayBuffer()
    if (buf.byteLength > REMOTE_CONFIG_MAX_BYTES) throw new Error('配置文件过大（上限 2MB）')
    return Buffer.from(buf).toString('utf8')
  } catch (error) {
    if (error !== null && error !== undefined && error.name === 'AbortError') {
      throw new Error('拉取配置文件超时（15 秒）')
    }
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * POST /config/remote/load：从 url 拉取或直接接收上传的 JSON 内容，校验后应用覆盖。
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {Promise<{ body: Record<string, any>, status: number }>} 响应
 */
async function handleRemoteConfigLoad(req) {
  let raw
  try {
    raw = await readRawBody(req, REMOTE_CONFIG_MAX_BYTES)
  } catch (error) {
    return { body: { ok: false, error: '读取请求失败：' + humanError(error) }, status: 400 }
  }
  let payload
  try {
    payload = JSON.parse(raw.toString('utf8'))
  } catch {
    return { body: { ok: false, error: '请求体不是合法 JSON' }, status: 400 }
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { body: { ok: false, error: '请求体必须是 JSON 对象' }, status: 400 }
  }

  const mode = payload.mode === 'url' ? 'url' : 'upload'
  let text
  let url = ''
  let filename = ''
  if (mode === 'url') {
    url = typeof payload.url === 'string' ? payload.url.trim() : ''
    if (url === '') return { body: { ok: false, error: '请填写配置文件地址' }, status: 400 }
    try {
      text = await fetchRemoteConfigText(url)
    } catch (error) {
      return { body: { ok: false, error: '拉取配置失败：' + humanError(error) }, status: 400 }
    }
  } else {
    text = typeof payload.content === 'string' ? payload.content : ''
    filename = typeof payload.filename === 'string' ? payload.filename.slice(0, 200) : ''
    if (text.trim() === '') return { body: { ok: false, error: '上传内容为空' }, status: 400 }
  }

  let parsed
  try {
    /* 示例文件带 // 中文说明，这里先剥离注释再解析；URL 里的 // 由状态机保护不被误删。 */
    parsed = JSON.parse(stripJsonComments(text))
  } catch (error) {
    return { body: { ok: false, error: '配置文件不是合法 JSON：' + String((error && error.message) || error) }, status: 400 }
  }

  const result = normalizeRemoteConfig(parsed, {
    isValidSourceUrl,
    isValidBranchName,
    isValidHttpUrl,
    isValidBaseUrl,
    localWorkbenchDirError,
  })
  if (result.ok !== true) {
    return { body: { ok: false, error: result.error || '配置中没有可识别的设置项', warnings: result.warnings }, status: 400 }
  }

  try {
    if (isFile(STATE_FILE)) fs.copyFileSync(STATE_FILE, STATE_FILE + '.bak')
  } catch { /* 备份失败不阻断 */ }
  const meta = state.settings.remoteConfig
  /* 快照只在首次生效时抓一次；已有快照说明当前正被上一层远程配置覆盖，
     再加载新配置不应把「已覆盖值」当成基线保存，否则清除后回不到真正的本地值。 */
  if (meta.snapshot === null || typeof meta.snapshot !== 'object') {
    meta.snapshot = captureRemoteSnapshot()
  }
  applyRemotePatch(result.patch)
  meta.source = mode
  meta.url = mode === 'url' ? url : ''
  meta.filename = mode === 'upload' ? filename : ''
  meta.loadedAt = new Date().toISOString()
  meta.appliedFields = result.appliedFields.slice()
  persistState()

  return {
    body: {
      ok: true,
      appliedFields: result.appliedFields,
      warnings: result.warnings,
      ignoredFields: result.ignoredFields,
      config: handleRemoteConfigGet().config,
    },
    status: 200,
  }
}

/**
 * POST /config/remote/clear：清除远程配置，恢复覆盖前的本地值。
 * @returns {{ body: Record<string, any>, status: number }} 响应
 */
function handleRemoteConfigClear() {
  const meta = state.settings.remoteConfig
  if (meta.loadedAt === null) {
    return { body: Object.assign({ ok: true, message: '当前没有远程配置' }, handleRemoteConfigGet()), status: 200 }
  }
  try {
    if (isFile(STATE_FILE)) fs.copyFileSync(STATE_FILE, STATE_FILE + '.bak')
  } catch { /* 备份失败不阻断 */ }
  if (meta.snapshot !== null && typeof meta.snapshot === 'object') restoreRemoteSnapshot(meta.snapshot)
  state.settings.remoteConfig = Object.assign({}, DEFAULT_REMOTE_CONFIG_META, { snapshot: null })
  persistState()
  return { body: Object.assign({ ok: true, message: '已清除远程配置，恢复本地设置' }, handleRemoteConfigGet()), status: 200 }
}

/**
 * POST /workbench/open-html-dir：用系统文件管理器打开工作台数据目录（HTML 与 CSV 共用）。
 * 路径来自插件内部配置（不接受用户输入），天然无路径穿越风险。
 *
 * 用 `spawn` + `detached` + `unref` 而不是 `execFile`：
 *  - execFile 会等子进程退出并受 timeout 约束，explorer 常驻或被 kill 时行为不可控；
 *  - detached 让文件管理器完全脱离 dsh 进程，即使 dsh 退出也不影响已打开的窗口。
 * Windows 上 explorer 即使成功打开也返回非零退出码，因此只把「进程启动失败」当错误。
 * @returns {Promise<{ body: Record<string, any>, status: number }>} 响应
 */
function handleOpenHtmlDir() {
  const dir = workbenchHtmlDir(state.settings.workbenchDataDir)
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (error) {
    return Promise.resolve({ body: { ok: false, error: '无法创建数据目录：' + humanError(error), dir }, status: 500 })
  }
  /* 目录必须真实存在，否则文件管理器打开的是「找不到」提示。 */
  if (!isDirectory(dir)) {
    return Promise.resolve({ body: { ok: false, error: '数据目录不存在或不是目录：' + dir, dir }, status: 500 })
  }
  const platform = process.platform
  let command
  let args
  if (platform === 'win32') {
    command = 'explorer.exe'
    /* 传绝对路径；explorer 会把目录在新窗口打开。 */
    args = [dir]
  } else if (platform === 'darwin') {
    command = 'open'
    args = [dir]
  } else {
    command = 'xdg-open'
    args = [dir]
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (body, status) => {
      if (settled) return
      settled = true
      resolve({ body, status })
    }
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
      /* spawn 的 error 只在「命令压根没起来」（ENOENT / EACCES）时触发；
         正常启动后立刻返回成功，不等文件管理器退出。 */
      child.once('error', (error) => {
        finish({ ok: false, error: '无法启动文件管理器：' + humanError(error) + '（' + command + '）', dir }, 500)
      })
      /* 未捕获的 error 不该拖垮插件；上面已处理，这里兜底避免 EPIPE 之类抛到全局。 */
      child.on('error', () => {})
      child.unref()
      /* 给 error 事件一个 tick 的窗口再报成功（ENOENT 是异步派发的）。 */
      setTimeout(() => finish({ ok: true, dir }, 200), 120)
    } catch (error) {
      finish({ ok: false, error: '无法打开目录：' + humanError(error), dir }, 500)
    }
  })
}

/**
 * 读取资源仓库的私有访问凭据（用户名 + 访问令牌）。
 * 凭据存在加密文件 credentials.enc，不在 state.json、不随响应回显令牌。
 * @returns {{ user: string, token: string } | null} 凭据；未配置或不完整返回 null
 */
function getSourceAuth() {
  let secrets = {}
  try { secrets = readSecrets(BASE_DIR) } catch { return null }
  const user = typeof secrets[SOURCE_AUTH_USER_KEY] === 'string' ? secrets[SOURCE_AUTH_USER_KEY].trim() : ''
  const token = typeof secrets[SOURCE_AUTH_TOKEN_KEY] === 'string' ? secrets[SOURCE_AUTH_TOKEN_KEY] : ''
  if (user === '' || token === '') return null
  return { user, token }
}

/**
 * `GET /settings/probe?url=...`：匿名探测远程 git 仓库是否私有。
 *
 * 用不带凭据的 `git ls-remote --heads`：成功 = 公开；认证类失败（401/403/要求用户名） = 私有。
 * 网络不可达、DNS 失败、仓库不存在等一律返回 ok:false 且 private:null —— 不猜测，前端允许用户手动勾选「私有仓库」兜底。
 * @param {URLSearchParams} query 查询参数
 * @returns {Promise<Record<string, any>>} 响应载荷
 */
async function handleSettingsProbe(query) {
  const raw = typeof query.get('url') === 'string' ? String(query.get('url')).trim() : ''
  const parsed = parseSource(raw)
  if (parsed.kind !== 'git') {
    return { ok: false, error: '仅支持远程 git 仓库（http://、https:// 或 git@）', private: null }
  }
  const probe = await runGit(['ls-remote', '--heads', parsed.url], BASE_DIR, 10000, null)
  if (probe.ok === true) return { ok: true, private: false, needsAuth: false, sourceUrl: parsed.url }
  const text = String(probe.stderr || probe.message || '').trim()
  const authFailed = /401|403|Authentication failed|authentication required|could not read Username|Permission denied|Access denied|terminal prompts disabled|fatal: could not read/i.test(text)
  if (authFailed) {
    return { ok: true, private: true, needsAuth: true, sourceUrl: parsed.url, reason: text.slice(0, 300) }
  }
  return {
    ok: false, private: null, needsAuth: false, sourceUrl: parsed.url,
    error: text === '' ? '无法判定仓库是否私有（地址或网络问题）' : '无法判定仓库是否私有：' + text.slice(0, 300),
  }
}

/**
 * `GET /settings/branches?url=...`：列出远程 git 仓库的分支，供设置弹窗选择。
 *
 * 只读的 `git ls-remote --heads`：不 clone、不 checkout、不写任何工作树，15 秒短超时。
 * 私有仓库可能因凭证不可用而失败，此时返回 ok:false —— 前端仍允许手动填写分支名。
 * 未传 url 时用当前生效地址；本机目录 / 非法地址一律拒绝，绝不把本机路径传给 git。
 * @param {URLSearchParams} query 查询参数
 * @returns {Promise<Record<string, any>>} 响应载荷
 */
async function handleSettingsBranches(query) {
  const raw = typeof query.get('url') === 'string' ? String(query.get('url')).trim() : ''
  const target = raw !== '' ? raw : resolveSourceUrl()
  const parsed = parseSource(target)
  if (parsed.kind !== 'git') {
    return { ok: false, error: '分支列表仅支持远程 git 仓库（http://、https:// 或 git@）；本机目录模式不执行 git 操作' }
  }
  const listed = await runGit(['ls-remote', '--heads', parsed.url], BASE_DIR, 15000, getSourceAuth())
  if (!listed.ok) {
    return {
      ok: false,
      error: '无法获取分支列表：' + String(listed.message || '请检查网络或仓库权限'),
      sourceUrl: parsed.url,
    }
  }
  const names = String(listed.stdout || '')
    .split(/\r?\n/)
    .map((line) => {
      const match = line.match(/refs\/heads\/(.+)$/)
      return match === null ? '' : String(match[1]).trim()
    })
    .filter((name) => name !== '' && isValidBranchName(name))
  const unique = Array.from(new Set(names)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  return {
    ok: true,
    sourceUrl: parsed.url,
    branches: unique.slice(0, MAX_BRANCH_OPTIONS),
    truncated: unique.length > MAX_BRANCH_OPTIONS,
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

/* 这里曾有一段「读 WorkBuddy 的插件注册表 → 宿主已装就跳过内置技能」的判定，已整体删除。
   原因：dsh 与 WorkBuddy 是两套独立运行时，各自只扫自己的目录（dsh 只扫
   `$DSH_HOME/skills`，不解析 WorkBuddy 插件包），宿主装了什么是宿主的事，**不能当作
   「dsh 已经有了」的依据** —— 那样唯一的效果就是 dsh 少装一批技能，而且界面上看不出来。
   原则从「宁可少装」改成：自包含就装，宁可重复，不要缺。 */

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
 * 判定只看技能自己**是否自包含**，与宿主装了什么插件**无关** —— dsh 读不到宿主
 * 插件提供的技能，拿宿主的安装状态来跳过只会让 dsh 少装技能。
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
 *
 * 两个来源都**不看宿主装了什么**：自包含就纳入，宿主状态不参与判定。
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
 * `excluded` = 被排除的插件技能数）。
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
  // 只装 items：excluded（依赖插件运行时 / 体积超限）永远不进本地技能库。
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
 * `excluded` 是内置插件里**未纳入**的技能及原因（依赖插件运行时 / 体积超限），只展示、不安装。
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
    /* 仓库技能装进本地时会把 `_skillhub_meta.json` / `_icon.*` 一起复制过来，
       所以已安装列表同样能展示中文名、版本号与图标。`skill-icon:` 前缀由前端
       assetUrl() 转成受限的 `/skill-icon?dir=` 请求（不会走数据根）。 */
    const display = readSkillDisplayMeta(abs)
    const iconName = findSkillIconName(abs)
    items.push({
      dir,
      name: meta.name,
      displayName: display !== null ? display.displayName : '',
      version: display !== null ? display.version : '',
      icon: iconName !== null ? 'skill-icon:' + dir : '',
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
  items.sort((a, b) => {
    const left = a.displayName || a.name
    const right = b.displayName || b.name
    return left < right ? -1 : left > right ? 1 : 0
  })
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

  /* 去后缀改名前后的 id 都能装：resolveRepoSkillDir 内部按别名逐个试。 */
  const sourceDir = resolveRepoSkillDir(id)
  if (sourceDir === null) {
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
  /* 版本优先取 _skillhub_meta.json（仓库技能的版本在这里），frontmatter 作兜底。 */
  const repoDisplay = readSkillDisplayMeta(sourceDir)
  const installVersion = repoDisplay !== null && repoDisplay.version !== ''
    ? repoDisplay.version
    : (meta !== null && typeof meta.version === 'string' ? meta.version : '')
  writeInstallMarker(targetDir, 'skill', id, installVersion)
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
        avatar: kind === 'agent' || kind === 'team'
          ? expertAvatarOf(item)
          : kind === 'skill' && typeof item.icon === 'string' ? item.icon : '',
        profession: kind === 'agent' || kind === 'team' ? expertProfessionOf(item) : '',
      }
      /* 技能条目额外下发 dir / enabled：前端 `choose()` 直接用 dir 作宿主原生技能名，
         不必再拉一次 /skills/installed 二次解析（老响应没有这两个字段时前端仍有兜底）。
         version 供选择器在名称右侧显示 `vX.Y.Z`，没有该字段时前端不渲染。 */
      if (kind === 'skill') {
        return Object.assign(base, {
          dir: typeof item.dir === 'string' ? item.dir : '',
          enabled: item.enabled !== false,
          version: typeof item.version === 'string' ? item.version : '',
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
      group('skill', '技能', skillsFiltered,
        (item) => tidy(item.displayName || item.name || item.id, 80),
        (item) => tidy(item.description || '', 600)),
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
  const plugin = readPluginManifest(expertDir)
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
 * 会话级「专家注入历史」：sessionId -> Set<expertId>（曾成功挂载过的专家 id）。
 *
 * **一个会话只允许注入一次专家 / 专家团。** 模型在会话里创建的子智能体、角色设定与
 * 历史消息都属于宿主会话；`detachExpert()` 只能回收插件自己注册的 runtime skill 与
 * systemPrompt section，删不掉这些历史。若允许在同一会话里删了再选（或直接换一个），
 * 新专家的 prompt 会和旧专家的子智能体混在同一上下文里 —— 实测表现为「chip 已换成
 * 新专家团，但 AI 还在给旧成员 design-system-expert 发消息」。
 *
 * 与 `attachedExperts` 的关键区别：**detach 不清这里**。命中历史时 `/attach` 返回
 * `SESSION_EXPERT_LOCKED`，前端据此开新会话再挂。持久化到 state.json，避免插件重启后
 * 旧会话又能换专家（宿主会话历史仍在）。
 */
const expertSessionHistory = new Map()
/** state.json 里最多保留多少个会话的注入历史（超出按插入顺序淘汰最早）。 */
const EXPERT_SESSION_HISTORY_LIMIT = 200

/**
 * 记录一次成功的专家挂载并落盘。
 * @param {string} sessionId 会话 id
 * @param {string} expertId 专家 id
 * @returns {void}
 */
function markExpertAttached(sessionId, expertId) {
  let ids = expertSessionHistory.get(sessionId)
  if (ids === undefined) {
    ids = new Set()
    expertSessionHistory.set(sessionId, ids)
  }
  ids.add(expertId)
  while (expertSessionHistory.size > EXPERT_SESSION_HISTORY_LIMIT) {
    const oldest = expertSessionHistory.keys().next().value
    if (oldest === undefined) break
    expertSessionHistory.delete(oldest)
  }
  persistState()
}

/**
 * 序列化注入历史供 state.json 持久化。
 * @returns {Array<{ sessionId: string, ids: string[] }>} 可 JSON 化的数组
 */
function serializeExpertSessionHistory() {
  /** @type {Array<{ sessionId: string, ids: string[] }>} */
  const out = []
  for (const [sessionId, ids] of expertSessionHistory) {
    out.push({ sessionId, ids: Array.from(ids) })
  }
  return out
}

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
/** 给智聊会话注册「个人资料检索」技能（AI 按需检索在线资料库+工作台）。@returns {Promise<{ok:boolean, dispose?:Function}>} */
async function zhiliaoRegisterRetrievalSkill(agent) {
  try {
    if (agent === null || agent === undefined || agent.ctx === null || agent.ctx === undefined) return { ok: false }
    const dir = path.join(PLUGIN_ROOT, 'retrieval')
    if (!isDir(dir)) return { ok: false }
    const def = {
      name: 'zhiliao-retrieval',
      description: '检索用户个人的在线资料库（knowledge-hub）与工作台表格内容。当问题涉及"我/我的"资料里的事实（项目进度、任务、分工、会议纪要、客户信息等）且上下文里没有时，用本技能检索后再回答。',
      content: '这是「个人资料检索」技能。当用户问题可能需要查你的个人文档或工作台表格才能回答时，先阅读本目录的 SKILL.md，按其指引运行检索脚本 retrieve.mjs（传具体关键词），拿到内容后用你自己的话自然回答。纯闲聊不要用。',
      resourceBase: { kind: 'directory', path: dir },
      source: 'dsh-buddy-expert-hub',
      invocation: { modelInvocable: true, userInvocable: false },
    }
    const r = await registerOnAgent(agent, def)
    zhiliaoPersonaDebug('检索技能注册: ok=' + r.ok + ' name=' + (r.name || '') + ' warning=' + (r.warning || ''))
    return { ok: r.ok === true, dispose: typeof r.dispose === 'function' ? r.dispose : null }
  } catch (e) {
    zhiliaoPersonaDebug('检索技能注册异常: ' + (e && e.message ? e.message : String(e)))
    return { ok: false }
  }
}

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
  /* 换专家时旧专家的子智能体 / 历史消息属于宿主会话，插件删不掉；用显式指令
     让模型以本区块为准，避免「chip 已换成新专家，AI 还在给旧成员发消息」。 */
  block += '<identity-priority>\n'
  block += '本区块是**本会话当前唯一有效**的专家/专家团身份设定。若本会话此前注入过其它专家，'
  block += '或此前基于旧专家创建过子智能体、引用过旧角色文档、沿用过旧专家的口吻与规范，'
  block += '一律以本区块为准：忽略旧身份设定，停止调用旧专家的子智能体，不得把旧专家的结论、术语或产物当作当前身份的依据。\n'
  block += '</identity-priority>\n'
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

/** 已注入人设的会话 id，避免 agent 重复创建时重复注入 */
const zhiliaoPersonaInjected = new Set()
/** 会话 id → {bindingId, text, revision}：注入的动态文本源，内容更新后自动反映到会话 */
const zhiliaoPersonaBlocks = new Map()
/** 会话 id → {agent, dispose}：保存注入注册，人设变化时重新注册以触发宿主 system-prompt/change */
const zhiliaoPersonaRegs = new Map()

/**
 * 从服务端拉取该绑定的身份/记忆/Skill bundle（/api/open/persona）。
 * 个人 Key → 用户维度 persona/记忆/蒸馏 Skill；AI 好友 Key → AI 自己的 persona/skill。
 * @param {any} binding 绑定
 * @returns {Promise<{ok: boolean, persona: string, memory: string, skillContent: string, skillName: string, revision: string}>}
 */
async function zhiliaoFetchPersonaBundle(binding) {
  const empty = { ok: false, persona: '', memory: '', skillContent: '', skillName: '', profile: '', revision: '' }
  if (binding === null || typeof binding !== 'object') return empty
  const base = zhiliaoOpenBase(binding, zhiliaoConfig())
  const apiKey = zhiliaoReadApiKey(binding)
  if (base === '' || apiKey === '') return empty
  try {
    const res = await zhiliaoGetJson(base + '/api/open/persona', zhiliaoOpenHeaders(apiKey))
    if (res.ok !== true || res.body === null || typeof res.body !== 'object') return empty
    const d = res.body.data !== undefined && res.body.data !== null && typeof res.body.data === 'object'
      ? res.body.data : res.body
    return {
      ok: true,
      persona: String(d.persona || ''),
      memory: String(d.memory || ''),
      skillContent: String(d.skillContent || ''),
      skillName: String(d.skillName || ''),
      profile: String(d.profile || ''),
      revision: String(d.revision || ''),
    }
  } catch { return empty }
}


/**
 * 查询会话当前生效的接管模式（GET /api/open/conv-mode）。
 * @returns {Promise<string>} 'NONE'|'HALF'|'FULL'，查询失败返回 ''（调用方据此降级放行）
 */
async function zhiliaoFetchConvMode(binding, convKey) {
  try {
    const base = zhiliaoOpenBase(binding, zhiliaoConfig())
    const apiKey = zhiliaoReadApiKey(binding)
    if (base === '' || apiKey === '' || convKey === '') return ''
    const aiId = binding.aiId === undefined || binding.aiId === null ? '' : String(binding.aiId)
    const query = '?convKey=' + encodeURIComponent(convKey) + (aiId !== '' ? '&aiId=' + encodeURIComponent(aiId) : '')
    const res = await zhiliaoGetJson(base + '/api/open/conv-mode' + query, zhiliaoOpenHeaders(apiKey))
    if (res.ok !== true || res.body === null || typeof res.body !== 'object') return ''
    if (res.body.code !== undefined && res.body.code !== 0) return ''
    const d = res.body.data !== undefined && res.body.data !== null && typeof res.body.data === 'object'
      ? res.body.data : res.body
    return String(d.mode || '').toUpperCase()
  } catch { return '' }
}

/**
 * 上报 AI 处理状态给智聊服务端（thinking/done/error），由服务端 WS 广播给客户端展示。
 * 失败静默，不影响主流程。
 */
async function zhiliaoReportAiStatus(binding, convKey, status, errorText) {
  try {
    if (binding === null || binding === undefined || convKey === '') return
    const base = zhiliaoOpenBase(binding, zhiliaoConfig())
    const apiKey = zhiliaoReadApiKey(binding)
    if (base === '' || apiKey === '') return
    const payload = { convKey, status }
    if (errorText !== undefined && errorText !== null && String(errorText) !== '') payload.error = String(errorText)
    await zhiliaoPostJson(base + '/api/open/ai-status', zhiliaoOpenHeaders(apiKey), payload)
  } catch { /* 上报失败不影响回复 */ }
}
/**
 * 把服务端 bundle 组装成注入对话上下文的 prompt 区块。
 * @param {{persona: string, memory: string, skillContent: string, skillName: string}} bundle
 * @returns {string} prompt 文本
 */
function zhiliaoComposePersonaBlock(bundle) {
  // 照专家模块格式：XML 包裹 + 明确"你是本人"指令 + identity-priority，普通 section 注入（与专家同款）。
  const persona = String(bundle.persona || '').trim() || '一个正在用聊天软件聊天的真人'
  let block = '<zhiliao-persona type="user">\n'
  block += '<instructions>\n' + persona.slice(0, 6000) + '\n</instructions>\n'
  // 个人信息档案：JSON 转成自然可读的自我介绍素材，AI 可自然融入对话
  const profileRaw = String(bundle.profile || '').trim()
  if (profileRaw !== '' && profileRaw !== '{}' && profileRaw !== '[]') {
    try {
      const pf = JSON.parse(profileRaw)
      const LABELS = { name: '姓名', age: '年龄', gender: '性别', address: '住址', city: '城市', occupation: '职业', birthday: '生日', phone: '电话', email: '邮箱' }
      const items = []
      for (const k of Object.keys(pf)) {
        const v = pf[k]
        if (v === null || v === undefined || String(v).trim() === '') continue
        items.push((LABELS[k] || k) + '：' + String(v))
      }
      if (items.length > 0) {
        block += '<profile>\n以下是你的个人信息，聊天时可自然提起，不用生硬罗列：\n' + items.join('，') + '\n</profile>\n'
      }
    } catch { /* profile 非 JSON 时忽略 */ }
  }
  const memory = String(bundle.memory || '').trim()
  if (memory !== '' && memory !== '[]') {
    try {
      const list = JSON.parse(memory)
      if (Array.isArray(list) && list.length > 0) {
        const facts = list.slice(-30).map((m) => '  - ' + String((m && m.fact) || m)).join('\n')
        block += '<memory>\n关于你（长期记忆，自然融入对话）：\n' + facts + '\n</memory>\n'
      }
    } catch { block += '<memory>\n' + memory.slice(0, 1500) + '\n</memory>\n' }
  }
  const skill = String(bundle.skillContent || '').trim()
  if (skill !== '') {
    const name = String(bundle.skillName || '个人 Skill')
    block += '<skill name="' + name + '">\n' + skill.slice(0, 4000) + '\n</skill>\n'
  }
  block += '以上面描述的那个人身份自然聊天即可，本设定对本会话持续生效。\n'
  block += '与模型自带身份冲突时以这里为准：别人问你是谁，就按上面的自我介绍自然回答。\n'
  block += '</zhiliao-persona>'
  return block
}

/**
 * 若该 agent 会话属于某个智聊绑定，注入"真人化"人设区块。
 * @param {any} agent 宿主 agent
 * @returns {void}
 */
/** 人设注入诊断日志（排查"人设没生效"用），只写本地文件 */
function zhiliaoPersonaDebug(line) {
  try {
    const file = path.join(BASE_DIR, 'zhiliao', 'persona-debug.log')
    const ts = new Date().toISOString()
    fs.appendFileSync(file, '[' + ts + '] ' + String(line) + '\n', 'utf8')
  } catch { /* ignore */ }
}

async function zhiliaoInjectPersona(agent) {
  if (agent === null || agent === undefined) return
  let sid = String(agent.id || '')
  let sessInfo = ''
  try {
    const asess = agent.session
    if (asess !== null && typeof asess === 'object') {
      sessInfo = ' sessionId=' + String(asess.id || (asess.header && asess.header.id) || '')
        + ' cwd=' + String(asess.cwd || (asess.header && asess.header.cwd) || '')
        + ' origin=' + String(asess.header && asess.header.origin || '')
    }
  } catch {}
  zhiliaoPersonaDebug('agent/created: agent.id=' + sid + sessInfo)
  let binding = zhiliaoBindingForSession(sid)
  // 兜底：某些宿主版本 agent.id 不是 sessionId，尝试从 agent.session 取
  if (binding === null && agent.session !== null && typeof agent.session === 'object') {
    const alt = String(agent.session.id || (agent.session.header && agent.session.header.id) || '')
    if (alt !== '') { sid = alt; binding = zhiliaoBindingForSession(sid) }
  }
  zhiliaoPersonaDebug('反查binding: sid=' + sid + ' -> ' + (binding !== null ? binding.bindingId : 'NULL'))
  if (binding === null || sid === '' || zhiliaoPersonaInjected.has(sid)) {
    zhiliaoPersonaDebug('跳过: binding空/已注入=' + (binding !== null && zhiliaoPersonaInjected.has(sid)))
    return
  }

  // 从服务端拉身份/记忆/Skill；失败则回退本地默认模板，保证一定有注入
  const bundle = await zhiliaoFetchPersonaBundle(binding)
  zhiliaoPersonaDebug('bundle: ok=' + bundle.ok + ' personaChars=' + bundle.persona.length + ' skillChars=' + bundle.skillContent.length + ' revision=' + bundle.revision)
  const blockText = bundle.ok === true
    ? zhiliaoComposePersonaBlock(bundle)
    : zhiliaoPersonaBlock(binding)
  if (blockText === '') return
  // 存到动态源：text 是函数，后续 bundle 更新时改这里即可自动反映到会话
  zhiliaoPersonaBlocks.set(sid, {
    bindingId: String(binding.bindingId || ''),
    text: blockText,
    revision: bundle.revision,
  })
  const provider = () => {
    const cur = zhiliaoPersonaBlocks.get(sid)
    return cur !== undefined ? cur.text : blockText
  }
  const dispose = registerPromptSection(agent, 'zhiliao-persona', provider, true, false)
  zhiliaoPersonaRegs.set(sid, { agent, dispose, skillDispose: null })
  // 注册「个人资料检索」技能（异步，不阻塞人设注入）；dispose 回填便于会话销毁时清理
  void zhiliaoRegisterRetrievalSkill(agent).then((sr) => {
    const reg = zhiliaoPersonaRegs.get(sid)
    if (reg !== undefined && sr.ok === true) reg.skillDispose = sr.dispose
  })
  zhiliaoPersonaDebug('注入完成: sid=' + sid + ' blockChars=' + blockText.length + ' dispose=' + (dispose !== null))
  zhiliaoPersonaInjected.add(sid)
  if (agent.ctx !== null && agent.ctx !== undefined && typeof agent.ctx.on === 'function') {
    try {
      agent.ctx.on('dispose', () => {
        const reg = zhiliaoPersonaRegs.get(sid)
        try { if (reg !== undefined && typeof reg.skillDispose === 'function') reg.skillDispose() } catch { /* 已回收 */ }
        zhiliaoPersonaInjected.delete(sid)
        zhiliaoPersonaBlocks.delete(sid)
        zhiliaoPersonaRegs.delete(sid)
      })
    } catch { /* ignore */ }
  }
  if (dispose !== null && typeof dispose === 'function') void dispose
}

/**
 * 按宿主会话 id 反查它属于哪个智聊绑定（遍历账本 sessions 的 dshSessionId）。
 * @param {string} dshSessionId 宿主会话 id
 * @returns {Object<string, any>|null} 绑定或 null
 */
function zhiliaoBindingForSession(dshSessionId) {
  const sid = String(dshSessionId || '')
  if (sid === '') return null
  try {
    const st = loadZhiliaState(BASE_DIR)
    if (st === null || st.sessions === null || typeof st.sessions !== 'object') return null
    for (const key of Object.keys(st.sessions)) {
      const sess = st.sessions[key]
      if (sess === null || typeof sess !== 'object') continue
      if (String(sess.dshSessionId || '') !== sid) continue
      const bound = findBindingById(st, String(sess.bindingId || ''))
      if (bound !== null) return bound
      // 账本里 bindingId 可能是占位值（如 zhiliao-workspace），回退用第一个真实绑定
      const all = listBindings(st)
      return all !== null && all.length > 0 ? all[0] : null
    }
    // 兜底：DSH 主界面手动新建的会话不在账本里（精确匹配不到），
    // 但用户希望所有会话都用智聊人设回答。只有一个启用绑定时用它。
    // 多绑定时不猜测，避免 A 会话注入 B 的人设。
    const all = listBindings(st).filter((b) => b !== null && b.enabled !== false)
    if (all.length === 1) return all[0]
  } catch { /* ignore */ }
  return null
}

/**
 * 给智聊会话生成"真人化"人设 system prompt：让 AI 表现得像绑定的这个人本人。
 * @param {any} binding 绑定
 * @returns {string} prompt 区块文本
 */
function zhiliaoPersonaBlock(binding) {
  if (binding === null || typeof binding !== 'object') return ''
  const name = tidy(binding.displayName || binding.userId || '我', 40) || '我'
  const isAi = binding.aiId !== '' && binding.aiId !== undefined && binding.aiId !== null
  const role = isAi ? 'AI 好友「' + name + '」' : '用户「' + name + '」本人'
  const lines = [
    '<zhiliao-persona>',
    '你现在的身份是智聊里正在聊天的这个人：' + role + '。',
    '接下来你要代替 TA 在聊天软件里回复消息，让对方以为就是 TA 本人在回。',
    '要求：',
    '- 用第一人称、日常口语说话，像真人聊天：简短、自然、接地气，不要书面腔。',
    '- 不要提到"AI""助手""模型""系统提示""人设""智聊"这些词，也不要暴露你是在代回。',
    '- 不要过度热情或客套，不要动不动就"很高兴为您服务"；按对方的话顺势接话即可。',
    '- 回复长度跟对方的消息匹配：对方随口一句就简短回，对方认真问就认真答。',
    '- 只输出要发出的聊天消息正文，不要加解释、标注或引号。',
    '</zhiliao-persona>',
  ]
  return lines.join('\n')
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
function registerPromptSection(agent, expertId, block, orderAfterSuffix, asComplete) {
  try {
    if (agent === null || agent === undefined || agent.ctx === undefined || agent.ctx === null) return null
    let lastError = null
    // section() 的返回值必须留存：宿主可能只认这个独立 disposer，不认 fiber.unwind。
    let registration = undefined
    const fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
      try {
        registration = scope.systemPrompt.section({
          name: 'dsh-buddy-expert-hub:' + expertId,
          // 默认在 prefix 之后；智聊人设通过 orderAfterSuffix 覆盖到所有人设最后。
          order: orderAfterSuffix === true
            ? scope.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') + 1
            : scope.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1,
          // complete：作为唯一 system prompt，彻底覆盖宿主默认人设（工具/上下文仍会被解析保留）
          ...(asComplete === true ? { complete: true } : {}),
          // block 支持函数：注入后内容更新（如从服务端拉到新人设/记忆）能自动反映到会话
          text: () => {
            const t = (typeof block === 'function' ? block() : block)
            if (String(expertId).indexOf('zhiliao-persona') >= 0) {
              zhiliaoPersonaDebug('section.text() 被调用: chars=' + String(t || '').length)
            }
            return t
          },
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

  /* 曾尝试「一个会话只注入一次」：命中注入历史就返回 SESSION_EXPERT_LOCKED，
     让前端 sessions.create() 开新会话再挂。实测副作用更大 —— 宿主 sessions facade
     只有 create、没有切换当前会话的 open/select，新建会话不会自动变成用户正在看的
     会话；dock 按当前 sessionId 读 /attachments 自然为空，用户看到「选了专家却没
     显示到对话框」，state.json 里还积累了一堆一次性会话。故撤销拦截：换专家一律
     在**当前会话**内替换（detachExpert 双 dispose 清掉旧 runtime skill 与
     systemPrompt section），chip 立刻更新。历史仍记录，仅用于诊断/统计，不参与
     准入判断；旧专家残留改由 expertPromptBlock() 的「身份唯一性」指令纠正。 */
  const existing = attachedExperts.get(sessionId)
  const previousIds = existing === undefined ? [] : [...existing.keys()]
  const replaced = previousIds.length > 0 ? previousIds[0] : null
  if (previousIds.length > 0) detachExpert(sessionId, null)
  const out = await attachExpert(sessionId, id, item)
  if (out !== null && typeof out === 'object' && out.ok === true) markExpertAttached(sessionId, id)
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
    /* installed=1（从「已安装」视图点开）：直接读本地技能库，不让同名仓库条目盖掉本地状态。 */
    if (query.get('installed') === '1') {
      let installedItem = null
      for (const candidate of skillIdVariants(id)) {
        installedItem = resolveInstalledSkill(candidate)
        if (installedItem !== null) break
      }
      if (installedItem === null) return { ok: false, error: '找不到已安装的技能：' + id }
      const text = readTextSafe(path.join(installedItem.abs, 'SKILL.md'))
      const display = readSkillDisplayMeta(installedItem.abs)
      const iconName = findSkillIconName(installedItem.abs)
      const saved = state.installedSkills[installedItem.dir]
      return {
        ok: true,
        type: 'skill',
        item: {
          id: installedItem.dir,
          name: installedItem.name,
          displayName: display !== null ? display.displayName : '',
          version: display !== null ? display.version : '',
          icon: iconName !== null ? 'skill-icon:' + installedItem.dir : '',
          description: installedItem.description,
          collection: '已安装',
          path: toPosix(path.join('skills', installedItem.dir, 'SKILL.md')),
          skillsDir: installedItem.abs,
          installed: true,
          enabled: installedItem.enabled,
          source: saved !== undefined ? saved.source : 'local',
        },
        readme: text === null ? '' : stripFrontmatter(text).trim().slice(0, README_LIMIT),
      }
    }
    const item = findRepoSkill(index, id)
    if (item === null) {
      /* 已安装技能（SkillHub 下载 / 用户手工放置）不在仓库索引里：
         回退到本地技能库，按目录名（或 SkillHub slug）匹配，让对话引用也能取到正文。
         去后缀改名前后的 id 都试一遍，旧草稿里的引用不会突然失效。 */
      let installed = null
      for (const candidate of skillIdVariants(id)) {
        installed = resolveInstalledSkill(candidate)
        if (installed !== null) break
      }
      if (installed === null) return { ok: false, error: '未找到该技能：' + id }
      /* 已关闭的技能也能查看详情（只是不能引用），所以这里不拦截。
         id 统一回真实目录名：/resource/status、/resource/delete 都按 dir 解析，
         传 slug 或展示名会解析失败，导致已安装技能「看得了详情但删不掉」。 */
      const text = readTextSafe(path.join(installed.abs, 'SKILL.md'))
      const display = readSkillDisplayMeta(installed.abs)
      const iconName = findSkillIconName(installed.abs)
      return {
        ok: true,
        type: 'skill',
        item: {
          id: installed.dir,
          name: installed.name,
          displayName: display !== null ? display.displayName : '',
          version: display !== null ? display.version : '',
          icon: iconName !== null ? 'skill-icon:' + installed.dir : '',
          description: installed.description,
          collection: '已安装',
          path: toPosix(path.join('skills', installed.dir, 'SKILL.md')),
          skillsDir: installed.abs,
          installed: true,
          enabled: installed.enabled,
          source: state.installedSkills[installed.dir] !== undefined
            ? state.installedSkills[installed.dir].source : 'local',
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
 * `/skill-icon?dir=<目录名>`：已安装技能目录下的 `_icon.*`。
 *
 * 已安装技能在 `$DSH_HOME/skills/` 或 `skills-disabled/` 下，不在数据根里，
 * 不能走 `/asset?path=`。dir 只接受 `safeId` 白名单（不含路径分隔符 / `..`），
 * 再用 realpath 二次确认没被符号链接带出技能库根目录。
 * 找不到图标一律 404，前端回落到确定性字母方块。
 * @param {import('node:http').ServerResponse} res 响应对象
 * @param {URLSearchParams} query 查询参数
 * @returns {void}
 */
function handleSkillIcon(res, query) {
  const dir = safeId(query.get('dir'))
  if (dir === null) {
    send(res, { ok: false, error: '图标不存在' }, 404)
    return
  }
  for (const root of [SKILLS_INSTALL_DIR, SKILLS_DISABLED_DIR]) {
    const absolute = path.join(root, dir)
    if (!isDir(absolute)) continue
    try {
      const realRoot = fs.realpathSync(root)
      const realDir = fs.realpathSync(absolute)
      if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) continue
    } catch {
      continue
    }
    const iconName = findSkillIconName(absolute)
    if (iconName === null) continue
    sendImage(res, path.join(absolute, iconName))
    return
  }
  send(res, { ok: false, error: '图标不存在' }, 404)
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

  const plugin = readPluginManifest(path.join(root, 'experts', id))
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
  writeInstallMarker(targetDir, item.type, id, item.version)

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
  /* 治本：本地目录（`~/.dsh/experts/` 下含 expert.yml 的目录）是「已导入」的唯一权威。
     importedIds 只作它的持久化缓存，绝不反过来给 ids 做 concat —— 否则目录被删后
     id 仍留在数组里，前端「已导入」标签与已导入视图会显示一个根本不存在的专家。
     这里用扫描结果直接覆盖缓存，顺带清掉历史脏 id（如 khub-workbench-builder）。 */
  const scanned = Array.from(new Set(items.map((entry) => entry.id))).sort()
  state.importedIds = scanned
  persistState()
  return {
    ok: true,
    ids: scanned,
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
  const plugin = readPluginManifest(expertDir)
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
    const meta = readPluginManifest(absDir)
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

    const plugin = readPluginManifest(stagingDir)
    if (plugin === null || typeof plugin !== 'object') {
      throw new Error('包内缺少 .buddy-hub-plugin/plugin.json（或旧名 .codebuddy-plugin/plugin.json），不是有效专家包')
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
 *     或可解析且含 name / displayName 的清单（.buddy-hub-plugin 或旧名 .codebuddy-plugin）/plugin.json；
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
  /* 上传的文件夹里清单目录可能是新名或旧名，两个都试（上传路径始终是 POSIX 风格）。 */
  const plugin = jsonOf('.buddy-hub-plugin/plugin.json') || jsonOf('.codebuddy-plugin/plugin.json')
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
    notes.push('按 .buddy-hub-plugin/plugin.json（或旧名 .codebuddy-plugin）兼容格式导入')
    if (roleMd === null) notes.push('缺少 role.md，已按清单描述生成')
  } else {
    reasons.push('缺少 expert.yml + role.md，也没有含 name / displayName 的 .buddy-hub-plugin/plugin.json（或旧名 .codebuddy-plugin/plugin.json）')
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
      const plugin = readPluginManifest(stagingDir)
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

/* ---------------------------------------------------------------------------
 * 智聊阶段 0：/zhiliao/inbound（curl 假消息打通 create → prompt → follow）
 * ------------------------------------------------------------------------- */

/**
 * 拆掉宿主服务的 RemoteResult 包装：远程 face 会把业务值包进 `{ok:true,value}`，
 * 本地 face 直接返回业务值；两者的 error 分支统一还原成 throw。
 * @param {any} value 宿主调用返回值
 * @returns {any} 业务值
 */
function unwrapHostResult(value) {
  if (value === null || typeof value !== 'object') return value
  if (value.ok === true && Object.prototype.hasOwnProperty.call(value, 'value')) {
    return unwrapHostResult(value.value)
  }
  if (value.ok === false && value.error) throw value.error
  return value
}

/**
 * 从 `assistant/message` 事件里取最终回复文本。
 * 宿主主路径：`event.data.message.content = [{type:'text', text}]`（dsh-llm ContentBlock）；
 * 其余形状是兼容兜底，避免宿主事件结构微调就让阶段 0 拿空串。
 * @param {any} event SessionWireEvent
 * @returns {string} 纯文本回复
 */
function zhiliaoReplyText(event) {
  const data = event !== null && typeof event === 'object' && event.data !== null
    && typeof event.data === 'object' ? event.data : {}
  const message = data.message !== null && typeof data.message === 'object' ? data.message : null
  const blocks = message !== null && Array.isArray(message.content)
    ? message.content
    : (Array.isArray(data.content) ? data.content : [])
  const parts = []
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  if (parts.length > 0) return parts.join('')
  if (typeof data.text === 'string') return data.text
  if (message !== null && typeof message.text === 'string') return message.text
  if (typeof data.content === 'string') return data.content
  return ''
}

/**
 * 清洗回复里混入的 provider/配额错误噪声。
 * 某些中转模型超额时会把 "Your quota is exhausted / API key status / USDT spent"
 * 这类文本作为正常 content 返回，必须剔除后再发给用户。
 * @param {string} text 原始回复
 * @returns {string} 清洗后的回复
 */
function zhiliaoCleanReply(text) {
  let out = String(text || '')
  if (out === '') return out
  // 噪声常与正常回复挤在同一行，必须"精确删除片段"而非整行删除，
  // 否则会把紧跟其后的正常中文回复一起删掉。
  // 先删带固定结构的账单片段（顺序：长片段优先，避免残留）
  out = out.replace(/Name:\s*#[^\s]+\s*/gi, '')
  out = out.replace(/USDT\s+balance:\s*[0-9.\-]+\s*USDT\s*/gi, '')
  out = out.replace(/USDT\s+spent:\s*[0-9.\-]+\s*USDT\s*/gi, '')
  out = out.replace(/exp_date:\s*[0-9T:.\-]+Z?\s*/gi, '')
  out = out.replace(/API key status:\s*exceeded\s*/gi, '')
  out = out.replace(/Your quota is exhausted\.?\s*/gi, '')
  out = out.replace(/insufficient (balance|quota)[^。！.\n]*/gi, '')
  out = out.replace(/rate limit exceeded[^。！.\n]*/gi, '')
  out = out.replace(/invalid api key[^。！.\n]*/gi, '')
  out = out.replace(/provider error[^。！.\n]*/gi, '')
  // 若整段仅剩空白/标点，视为无有效内容（调用方按失败处理）
  return out.trim()
}

/**
 * 宿主异常 → 对外稳定错误码。
 * @param {any} error 异常对象
 * @returns {{error: string, code: string, detail: string}} 错误描述
 */
function zhiliaoErrorOf(error) {
  const code = String((error !== null && typeof error === 'object' && error.code) ||
    (error !== null && typeof error === 'object' && error.error !== null
      && typeof error.error === 'object' && error.error.code) || '')
  const detail = String((error !== null && typeof error === 'object' && error.message) ||
    (error !== null && typeof error === 'object' && error.error !== null
      && typeof error.error === 'object' && error.error.message) || error || '')
  if (code === 'session/not-found' || /ApiSessionNotFound|session .* not found/i.test(detail)) {
    return { error: 'session/not-found', code, detail }
  }
  return { error: 'agent-error', code, detail }
}

/**
 * 通用 JSON POST（回投 / 待发草稿发送）。超时 10s，返回结构化结果，不抛异常。
 * @param {string} url 完整 URL
 * @param {Object<string, string>} extraHeaders 额外请求头
 * @param {any} payload JSON 载荷
 * @returns {Promise<{ok: boolean, status: number, body: any}>} 响应
 */
async function zhiliaoPostJson(url, extraHeaders, payload) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ZHILIAO_REPLY_TIMEOUT_MS)
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'content-type': 'application/json' }, extraHeaders || {}),
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const text = await resp.text()
    let parsed = text
    try { parsed = text === '' ? null : JSON.parse(text) } catch { /* 非 JSON 原文回传 */ }
    return { ok: resp.ok, status: resp.status, body: parsed }
  } catch (error) {
    return { ok: false, status: 0, body: String((error !== null && typeof error === 'object' && error.message) || error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 通用 JSON GET（绑定测试查联系人用）。超时与 POST 一致，返回结构也一致。
 * @param {string} url 完整 URL
 * @param {Object<string, string>} extraHeaders 额外请求头
 * @returns {Promise<{ok: boolean, status: number, body: any}>} 响应
 */
async function zhiliaoGetJson(url, extraHeaders) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ZHILIAO_REPLY_TIMEOUT_MS)
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: Object.assign({}, extraHeaders || {}),
      signal: controller.signal,
    })
    const text = await resp.text()
    let parsed = text
    try { parsed = text === '' ? null : JSON.parse(text) } catch { /* 非 JSON 原文回传 */ }
    return { ok: resp.ok, status: resp.status, body: parsed }
  } catch (error) {
    return { ok: false, status: 0, body: String((error !== null && typeof error === 'object' && error.message) || error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * HuLa Server 的 roomId / replyToMsgId 是 Java Long，字符串会触发「参数类型解析异常」。
 * @param {any} value 原始值
 * @returns {number|null} 数字或 null
 */
function zhiliaoLong(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value)
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim())
  return null
}

/** zhiliao-server API Key 在 credentials.enc 中的键名。 */
function zhiliaoApiKeySecretKey(bindingId) {
  return 'zhiliao.' + String(bindingId || '') + '.apiKey'
}

/**
 * 读取绑定 API Key；只从 credentials.enc 读，绝不回显。
 * @param {Object<string, any>} binding 绑定
 * @returns {string} API Key 或空串
 */
function zhiliaoReadApiKey(binding) {
  if (binding === null || binding === undefined) return ''
  const ref = typeof binding.apiKeyRef === 'string' && binding.apiKeyRef !== ''
    ? binding.apiKeyRef : zhiliaoApiKeySecretKey(binding.bindingId)
  try {
    const secrets = readSecrets(BASE_DIR)
    return typeof secrets[ref] === 'string' ? secrets[ref].trim() : ''
  } catch {
    return ''
  }
}

/** API Key 脱敏，日志只能出现这个结果。 */
function zhiliaoMaskApiKey(apiKey) {
  const key = String(apiKey || '')
  if (key === '') return ''
  if (key.length <= 8) return '****'
  return key.slice(0, 3) + '****' + key.slice(-4)
}

/**
 * 绑定/全局 baseUrl 解析：binding.baseUrl 优先，其次 settings.replyBaseUrl。
 * @param {Object<string, any>} binding 绑定
 * @param {Object<string, any>} cfg zhiliaoConfig()
 * @returns {string} base URL
 */
function zhiliaoOpenBase(binding, cfg) {
  const bindingBase = binding !== null && binding !== undefined && typeof binding.baseUrl === 'string'
    ? binding.baseUrl.trim().replace(/\/+$/, '') : ''
  if (bindingBase !== '') return bindingBase
  return cfg !== null && cfg !== undefined && typeof cfg.replyBaseUrl === 'string'
    ? cfg.replyBaseUrl.trim().replace(/\/+$/, '') : ''
}

/**
 * 解析 open API 的 data.content（JSON 字符串或对象）。
 * @param {any} content 原始 content
 * @returns {{text: string, urls: string[], fileName: string, fileSize: number, mimeType: string, atUidList: string[]}} 归一内容
 */
function zhiliaoParseContent(content) {
  let parsed = content
  if (typeof content === 'string') {
    try { parsed = JSON.parse(content) } catch { parsed = { text: content } }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = { text: String(parsed || '') }
  const atUidList = Array.isArray(parsed.atUidList) ? parsed.atUidList.map((v) => String(v)) : []
  return {
    text: typeof parsed.text === 'string' ? parsed.text : '',
    urls: Array.isArray(parsed.urls) ? parsed.urls.map((v) => String(v)) : [],
    fileName: typeof parsed.fileName === 'string' ? parsed.fileName : '',
    fileSize: Number.isFinite(Number(parsed.fileSize)) ? Number(parsed.fileSize) : 0,
    mimeType: typeof parsed.mimeType === 'string' ? parsed.mimeType : '',
    atUidList,
  }
}

/** open API 请求头。 */
function zhiliaoOpenHeaders(apiKey) {
  return { 'X-Api-Key': String(apiKey || '') }
}

/**
 * GET /api/open/me。
 * @param {string} base base URL
 * @param {string} apiKey API Key
 * @returns {Promise<{ok: boolean, status: number, body: any, detail?: string}>} 结果
 */
async function zhiliaoOpenMe(base, apiKey) {
  const delivered = await zhiliaoGetJson(base + '/api/open/me', zhiliaoOpenHeaders(apiKey))
  const body = delivered.body !== null && typeof delivered.body === 'object' ? delivered.body : null
  const data = body !== null && body.data !== null && typeof body.data === 'object' ? body.data : body
  if (delivered.ok !== true || data === null) {
    return { ok: false, status: delivered.status, body: delivered.body, detail: 'HTTP ' + String(delivered.status) }
  }
  return { ok: true, status: delivered.status, body: data }
}

/**
 * GET /api/open/lookup/user|group。
 * @param {string} base base URL
 * @param {string} apiKey API Key
 * @param {'user'|'group'} kind 类型
 * @param {string} id userId 或 groupId
 * @returns {Promise<{ok: boolean, status: number, body: any}>} 结果
 */
async function zhiliaoOpenLookup(base, apiKey, kind, id) {
  const param = kind === 'group' ? 'groupId' : 'userId'
  const delivered = await zhiliaoGetJson(
    base + '/api/open/lookup/' + kind + '?' + param + '=' + encodeURIComponent(id),
    zhiliaoOpenHeaders(apiKey),
  )
  const body = delivered.body !== null && typeof delivered.body === 'object' ? delivered.body : null
  const data = body !== null && body.data !== null && typeof body.data === 'object' ? body.data : body
  const explicitOk = data !== null && data.ok !== undefined ? data.ok === true : true
  const found = delivered.ok === true && data !== null && explicitOk && data.error === undefined
    && data.success !== false && (kind === 'group' ? data.groupId !== undefined : data.userId !== undefined)
  const errorMessage = found === false && data !== null
    ? String(data.message || data.detail || '') : ''
  // 返回解包后的 data：调用方取 body.name / body.nickname 才能拿到，否则退化成 id
  return { ok: found, status: delivered.status, body: data, detail: errorMessage }
}

/**
 * GET /api/open/lookup/account：按账号/手机号/邮箱解析目标（kind=auto：先用户后 AI 好友）。
 * @param {string} base base URL
 * @param {string} apiKey API Key
 * @param {string} keyword 账号 / 手机号 / 邮箱
 * @returns {Promise<{ok: boolean, status: number, body: any}>} 结果
 */
async function zhiliaoOpenLookupAccount(base, apiKey, keyword) {
  const delivered = await zhiliaoGetJson(
    base + '/api/open/lookup/account?keyword=' + encodeURIComponent(String(keyword || '')),
    zhiliaoOpenHeaders(apiKey),
  )
  const body = delivered.body !== null && typeof delivered.body === 'object' ? delivered.body : null
  const data = body !== null && body.data !== null && typeof body.data === 'object' ? body.data : body
  const found = delivered.ok === true && data !== null && data.error === undefined
    && data.success !== false && (data.userId !== undefined || data.aiId !== undefined)
  // 后端失败时 Result.fail 形如 {code,message,success:false}，message 才是真实原因，透传给上层
  const errorMessage = found === false && data !== null
    ? String(data.message || data.detail || '') : ''
  return { ok: found, status: delivered.status, body: data, detail: errorMessage }
}

/**
 * POST /api/open/msg/send。
 * @param {string} base base URL
 * @param {string} apiKey API Key
 * @param {{convKey: string, text: string, requestId: string, atUidList?: string[], as?: 'ai'|'user'}} msg 消息
 * @returns {Promise<{ok: boolean, status: number, body: any}>} 结果
 */
async function zhiliaoOpenSend(base, apiKey, msg) {
  const payload = {
    convKey: String(msg.convKey || ''),
    contentType: 'TEXT',
    text: String(msg.text || ''),
    requestId: String(msg.requestId || ''),
    as: msg.as === 'user' ? 'user' : 'ai',
  }
  if (Array.isArray(msg.atUidList) && msg.atUidList.length > 0) {
    payload.atUidList = msg.atUidList.map((v) => String(v))
  }
  const delivered = await zhiliaoPostJson(base + '/api/open/msg/send', zhiliaoOpenHeaders(apiKey), payload)
  // 智聊返回 Result 包装 {code:0,message,data:{msgId,seq}}，需解包到 data，
  // 否则调用方在外层找不到 msgId，会把成功当失败。
  const wrapper = delivered.body !== null && typeof delivered.body === 'object' ? delivered.body : null
  const data = wrapper !== null && wrapper.data !== null && typeof wrapper.data === 'object'
    ? wrapper.data : wrapper
  const codeOk = wrapper === null || wrapper.code === undefined || Number(wrapper.code) === 0
  return { ok: delivered.ok === true && codeOk, status: delivered.status, body: data }
}

/**
 * GET /api/open/msg/history（补拉用；beforeSeq 取最大以拿最新，再按 lastSeq 过滤）。
 * @param {string} base base URL
 * @param {string} apiKey API Key
 * @param {string} convKey 会话键
 * @param {number} beforeSeq 上界
 * @param {number} size 条数
 * @returns {Promise<{ok: boolean, status: number, body: any}>} 结果
 */
async function zhiliaoOpenHistory(base, apiKey, convKey, beforeSeq, size) {
  const query = '?convKey=' + encodeURIComponent(convKey)
    + '&beforeSeq=' + encodeURIComponent(String(beforeSeq || 9007199254740991))
    + '&size=' + encodeURIComponent(String(size || 30))
  return zhiliaoGetJson(base + '/api/open/msg/history' + query, zhiliaoOpenHeaders(apiKey))
}

/**
 * 把绑定的 requireConfirm 同步为服务端接管模式。
 * requireConfirm=true → HALF（AI 起草，用户在智聊确认后才发）；false → FULL（直接发）。
 * 范围：该绑定已建立的会话（chatKey）。新建会话在建 session 后也会再同步一次。
 * @param {any} binding 绑定
 * @param {any} cfg 插件配置
 * @returns {Promise<number>} 成功同步的会话数
 */
async function zhiliaoSyncTakeoverMode(binding, cfg) {
  if (binding === null || binding === undefined) return 0
  const base = zhiliaoOpenBase(binding, cfg)
  const apiKey = zhiliaoReadApiKey(binding)
  const aiId = binding.aiId === undefined || binding.aiId === null ? '' : String(binding.aiId)
  if (base === '' || apiKey === '' || aiId === '') return 0
  const mode = binding.requireConfirm === true ? 'HALF' : 'FULL'
  let chatKeys = []
  try {
    const state = loadZhiliaState()
    chatKeys = Object.keys(state.sessions || {}).filter((k) => {
      const cs = state.sessions[k]
      return cs !== null && typeof cs === 'object' && String(cs.bindingId) === String(binding.bindingId)
    })
  } catch { return 0 }
  let done = 0
  for (const convKey of chatKeys) {
    try {
      const r = await zhiliaoPostJson(base + '/api/open/conv-mode', zhiliaoOpenHeaders(apiKey),
        { convKey, aiId, mode })
      const bodyOk = r !== null && typeof r === 'object' && r.ok === true
        && r.body !== null && typeof r.body === 'object' && r.body.error === undefined
      if (bodyOk) done++
    } catch { /* 单条失败不影响其它 */ }
  }
  return done
}

/**
 * 回投是否成功：HuLa 的 R 包装用 success 字段，HTTP 200 也可能是业务失败。
 * @param {{ok: boolean, status: number, body: any}} delivered zhiliaoPostJson 的结果
 * @returns {boolean} 是否真的投递成功
 */
function zhiliaoDeliveryOk(delivered) {
  if (delivered === null || typeof delivered !== 'object' || delivered.ok !== true) return false
  const body = delivered.body
  return !(body !== null && typeof body === 'object' && body.success === false)
}

/**
 * 判断回投失败是否属于鉴权 / Token 类失败（401/403 或错误文案命中关键词）。
 * HuLa 的 R 包装常把错误放在 msg 里且 HTTP 仍是 200，所以两种都要看。
 * @param {{ok: boolean, status: number, body: any}} delivered zhiliaoPostJson 的结果
 * @returns {boolean} 是否 Token 类失败
 */
function zhiliaoIsTokenFailure(delivered) {
  if (delivered === null || typeof delivered !== 'object') return false
  const status = Number(delivered.status)
  // 明确的鉴权状态码：直接判定，不看 body。
  if (status === 401 || status === 403) return true
  // 5xx 是服务端故障（即便文案里带 token 也不能自动暂停绑定）；其它 4xx 同样不算鉴权失败。
  if (status >= 500 || !(status >= 200 && status < 300)) return false
  const body = delivered.body
  if (body === null || typeof body !== 'object') return false
  // HuLa 的 R 包装把错误放在 msg/error/code 等字段；只取明确字段，避免误伤成功响应里的普通文本。
  const parts = []
  for (const key of ['msg', 'message', 'error', 'detail', 'reason', 'code']) {
    const value = body[key]
    if (value !== null && value !== undefined) parts.push(String(value))
  }
  if (parts.length === 0) {
    try { parts.push(JSON.stringify(body)) } catch { return false }
  }
  const text = parts.join(' ').toLowerCase()
  return /(unauthoriz|forbidden|\b401\b|\b403\b|invalid[\s_-]*token|token[\s_-]*(expired|invalid|missing|required|revoked)|token\s*已?(失效|过期)|鉴权失败|认证失败)/.test(text)
}

/**
 * Token 失效自动降级：tokenStatus=expired + enabled=false，避免反复失败刷屏。
 * 不自动刷新 Token（HuLa refresh API 未对接），只提示用户去面板重填。
 * @param {string} bindingId 绑定 id
 * @returns {Promise<void>} 完成
 */
async function zhiliaoDisableExpiredToken(bindingId, reason) {
  await withZhiliaState((s) => {
    const binding = findBindingById(s, bindingId)
    if (binding === null) return
    binding.tokenStatus = 'expired'
    binding.enabled = false
  })
  state.warnings.push(
    reason !== undefined && reason !== ''
      ? String(reason)
      : '智聊绑定 ' + String(bindingId) + ' 的 Token 已失效（鉴权失败），已自动暂停该绑定；请在面板重新保存 Token 恢复',
  )
}

/**
 * 组装回投 body（字段类型与 HuLa Server ZhiliaoReplyReq 对齐）。
 * @param {Object<string, any>} binding 绑定
 * @param {Object<string, any>} payload webhook 载荷
 * @param {string} msgId 消息 id
 * @param {string} text 回复文本
 * @returns {Object<string, any>|null} 回投 body；roomId 非法返回 null
 */
function zhiliaoReplyBody(binding, payload, msgId, text) {
  const roomId = zhiliaoLong(payload !== null && typeof payload === 'object' ? payload.roomId : null)
  if (roomId === null) return null
  const replyTo = zhiliaoLong(msgId)
  const body = {
    bindingId: binding.bindingId,
    identityType: binding.identityType,
    roomId,
    text,
    requestId: msgId,
  }
  if (replyTo !== null) body.replyToMsgId = replyTo
  return body
}

/* ---------------------------------------------------------------------------
 * B1：以「原用户」身份调 HuLa 官方 /im/chat/msg 发消息（用户 Token）。
 * 只用于 identityType==='original-user' 且 credentials.enc 里有对应 token 的绑定；
 * bot / 无 token 的绑定仍走原来的 /zhiliao/internal/reply 路径。
 * ------------------------------------------------------------------------- */

/** 官方 API 业务失败码（HTTP 仍是 200）里明确代表 Token / 登录态失效的那些。 */
const ZHILIAO_USER_TOKEN_FAIL_CODES = [401, 403, 406, 40001, 40009]

/* 极简绑定：一个工作空间 = 一个全局绑定。固定 bindingId 让服务端能按
   `zhiliao-workspace-` 前缀的设备指纹跳过 kickout（方案 A）。 */
const ZHILIAO_WORKSPACE_BINDING_ID = 'zhiliao-workspace'
/** 应用级凭证：裸 base64(clientId:clientSecret)，没有 "Basic " 前缀。 */
const ZHILIAO_APP_BASIC_AUTH = 'bHVvaHVvX3dlYjpsdW9odW9fd2ViX3NlY3JldA=='
/** 绑定测试默认目标：小管家 uid=1。 */
const ZHILIAO_TEST_UID_DEFAULT = '1'

/** proactive refresh 提前量：过期前 2 分钟先换票，避免临界失败。 */
const ZHILIAO_REFRESH_SKEW_MS = 2 * 60 * 1000
/** 同一 binding 的 refresh 单飞锁：并发发送共享同一个 Promise，避免一次性 refreshToken 被并发消费。 */
const zhiliaoRefreshInFlight = new Map()

/**
 * 读取某个绑定的用户凭证三元组（加密文件，不进 state，不回显）。
 * @param {string} bindingId 绑定 id
 * @returns {{token: string, refreshToken: string, expiresAt: number}} 凭证；缺失字段为空串/0
 */
function zhiliaoReadUserCredentials(bindingId) {
  try {
    const secrets = readSecrets(BASE_DIR)
    const prefix = 'zhiliao.' + String(bindingId) + '.'
    const token = typeof secrets[prefix + 'token'] === 'string' ? secrets[prefix + 'token'].trim() : ''
    const refreshToken = typeof secrets[prefix + 'refreshToken'] === 'string'
      ? secrets[prefix + 'refreshToken'].trim() : ''
    const expiresRaw = Number(secrets[prefix + 'tokenExpiresAt'])
    const expiresAt = Number.isFinite(expiresRaw) && expiresRaw > 0 ? expiresRaw : 0
    return { token, refreshToken, expiresAt }
  } catch {
    return { token: '', refreshToken: '', expiresAt: 0 }
  }
}

/**
 * 工作空间设备指纹：生成一次后持久化在 credentials.enc，供登录 body 的 clientId 使用。
 * 前缀 `zhiliao-workspace-` 是服务端 A 方案跳过 kickout 的判定依据，不能改。
 * @param {boolean} [persist=true] 是否把新生成的指纹写盘；dry-run 传 false，保证零落盘
 * @returns {string} 设备指纹
 */
function zhiliaoWorkspaceClientId(persist) {
  const key = 'zhiliao.' + ZHILIAO_WORKSPACE_BINDING_ID + '.clientId'
  try {
    const secrets = readSecrets(BASE_DIR)
    const saved = typeof secrets[key] === 'string' ? secrets[key].trim() : ''
    if (saved !== '') return saved
    const generated = 'zhiliao-workspace-' + randomUUID()
    if (persist !== false) saveSecrets(BASE_DIR, { [key]: generated })
    return generated
  } catch {
    // 写盘失败时也返回一个可用指纹，避免整个绑定流程被本地文件权限卡死。
    return 'zhiliao-workspace-' + randomUUID()
  }
}

/**
 * 账号密码登录 HuLa：成功后返回 uid/token/refreshToken/到期时间，失败返回错误码和文案。
 * 密码只作为请求体一次性使用，不写 state、不写 credentials.enc。
 * @param {string} base HuLa Server 网关地址
 * @param {string} account 账号
 * @param {string} password 密码
 * @param {boolean} [persistClientId=true] dry-run 传 false，避免生成设备指纹时写 credentials.enc
 * @returns {Promise<{ok: boolean, uid?: string, token?: string, refreshToken?: string, expiresAt?: number, code?: number, msg?: string}>} 结果
 */
async function zhiliaoLoginByAccount(base, account, password, persistClientId) {
  const delivered = await zhiliaoPostJson(
    base + '/api/oauth/anyTenant/login',
    { Authorization: ZHILIAO_APP_BASIC_AUTH },
    {
      account,
      password,
      clientId: zhiliaoWorkspaceClientId(persistClientId),
      systemType: 2,
      deviceType: 'PC',
      grantType: 'PASSWORD',
    },
  )
  const body = delivered !== null && delivered.body !== null && typeof delivered.body === 'object'
    ? delivered.body : null
  const code = body !== null ? Number(body.code) : Number(delivered.status)
  const data = body !== null && body.data !== null && typeof body.data === 'object' ? body.data : null
  if (delivered.ok !== true || body === null || !(body.success === true || code === 200) || data === null) {
    return {
      ok: false,
      code: Number.isFinite(code) ? code : Number(delivered.status),
      msg: String(body !== null && typeof body.msg === 'string' ? body.msg : '登录失败'),
    }
  }
  const uid = String(data.uid !== undefined && data.uid !== null ? data.uid : '').trim()
  const token = typeof data.token === 'string' ? data.token.trim() : ''
  const refreshToken = typeof data.refreshToken === 'string' ? data.refreshToken.trim() : ''
  if (uid === '' || token === '') return { ok: false, code: Number.isFinite(code) ? code : -1, msg: '登录响应缺少 uid 或 token' }
  /* 登录响应不带 expiration；B2 已有的「expire 秒 → 绝对毫秒」回退在这里复用。 */
  const expiration = Number(data.expiration)
  const expireSeconds = Number(data.expire)
  const expiresAt = Number.isFinite(expiration) && expiration > 0
    ? Math.floor(expiration)
    : (Number.isFinite(expireSeconds) && expireSeconds > 0 ? Date.now() + Math.floor(expireSeconds * 1000) : 0)
  return { ok: true, uid, token, refreshToken, expiresAt }
}

/**
 * 绑定成功后由后端代理查询真实昵称：access token 绝不下发到前端。
 * 查询失败/超时静默回退账号，不影响绑定成功。
 * @param {string} base replyBaseUrl
 * @param {string} uid 登录返回的 uid
 * @param {string} token 刚拿到的 access token
 * @returns {Promise<string>} 昵称；失败返回空串
 */
async function zhiliaoFetchDisplayName(base, uid, token) {
  try {
    const delivered = await zhiliaoGetJson(
      base + '/api/im/user/getById/' + encodeURIComponent(String(uid)),
      { Token: token },
    )
    const body = delivered !== null && delivered.body !== null && typeof delivered.body === 'object'
      ? delivered.body : null
    const data = body !== null && body.data !== null && typeof body.data === 'object' ? body.data : null
    const name = data !== null && typeof data.name === 'string' ? data.name.trim() : ''
    return name.slice(0, 80)
  } catch {
    return ''
  }
}

/**
 * 调 HuLa 官方 refresh 接口换新 access token，并写回 3 个 secret。
 * 端点：`POST <base>/api/oauth/anyTenant/refresh`，body `{refreshToken}`，无需额外 header。
 * @param {string} base replyBaseUrl（网关）
 * @param {string} bindingId 绑定 id
 * @returns {Promise<{ok: boolean, token?: string, refreshToken?: string, expiresAt?: number, code?: number, msg?: string}>} 结果
 */
async function zhiliaoRefreshUserToken(base, bindingId) {
  const credentials = zhiliaoReadUserCredentials(bindingId)
  if (credentials.refreshToken === '') return { ok: false, code: 0, msg: 'no refreshToken' }
  const delivered = await zhiliaoPostJson(
    base + '/api/oauth/anyTenant/refresh',
    {},
    { refreshToken: credentials.refreshToken },
  )
  const body = delivered !== null && typeof delivered.body === 'object' ? delivered.body : null
  const code = body !== null ? Number(body.code) : Number(delivered.status)
  const data = body !== null && body.data !== null && typeof body.data === 'object' ? body.data : null
  const token = data !== null && typeof data.token === 'string' ? data.token.trim() : ''
  if (delivered.ok !== true || body === null || !(body.success === true || code === 200) || token === '') {
    return { ok: false, code: Number.isFinite(code) ? code : Number(delivered.status), msg: String(body !== null ? (body.msg || '') : 'refresh failed') }
  }
  const nextRefresh = data !== null && typeof data.refreshToken === 'string' && data.refreshToken.trim() !== ''
    ? data.refreshToken.trim() : credentials.refreshToken
  const expireSeconds = data !== null ? Number(data.expire) : NaN
  /* M4 起服务端还会回 expiration（绝对毫秒）；优先用它，其次按 expire 秒推算。 */
  const expirationMs = data !== null ? Number(data.expiration) : NaN
  const expiresAt = Number.isFinite(expirationMs) && expirationMs > 0
    ? Math.floor(expirationMs)
    : (Number.isFinite(expireSeconds) && expireSeconds > 0 ? Date.now() + Math.floor(expireSeconds * 1000) : 0)
  const patch = {
    ['zhiliao.' + bindingId + '.token']: token,
    ['zhiliao.' + bindingId + '.refreshToken']: nextRefresh,
  }
  if (expiresAt > 0) patch['zhiliao.' + bindingId + '.tokenExpiresAt'] = String(expiresAt)
  try {
    saveSecrets(BASE_DIR, patch)
  } catch (error) {
    return { ok: false, code: 0, msg: 'refresh 成功但写回凭证失败：' + humanError(error) }
  }
  return { ok: true, token, refreshToken: nextRefresh, expiresAt }
}

/**
 * refresh 单飞：同一 binding 的并发调用复用同一个 Promise。
 * @param {string} base replyBaseUrl
 * @param {string} bindingId 绑定 id
 * @returns {Promise<Object>} refresh 结果
 */
function zhiliaoRefreshUserTokenSingleFlight(base, bindingId) {
  const key = String(bindingId)
  const running = zhiliaoRefreshInFlight.get(key)
  if (running !== undefined) return running
  const task = zhiliaoRefreshUserToken(base, bindingId).finally(() => {
    if (zhiliaoRefreshInFlight.get(key) === task) zhiliaoRefreshInFlight.delete(key)
  })
  zhiliaoRefreshInFlight.set(key, task)
  return task
}

/**
 * 用户 Token 发消息：Header 是 `Token`（sa-token token-name，token-prefix 为空），
 * body 是官方 ZhiliaoMsgSendReq 形态；from_uid / create_by 由 HuLa 登录态自动填。
 * @param {string} base replyBaseUrl（MVP 用网关 18760）
 * @param {string} token 用户 access token
 * @param {number} roomId 房间号（Java Long）
 * @param {string} text 回复正文
 * @param {number|null} replyToMsgId 可选回复目标 msgId
 * @param {string[]} [atUidList] 群消息 @ 的 uid 列表
 * @returns {Promise<{ok: boolean, status: number, body: any}>} 官方 R 响应
 */
async function zhiliaoSendAsUser(base, token, roomId, text, replyToMsgId, atUidList) {
  const msgBody = { content: text }
  if (Array.isArray(atUidList) && atUidList.length > 0) {
    /* HuLa TextMsgReq.atUidList 是 List<Long>，必须发 JSON 数字而不是字符串。 */
    msgBody.atUidList = atUidList.map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0)
  }
  const replyTo = Number(replyToMsgId)
  if (Number.isFinite(replyTo) && replyTo > 0) msgBody.replyMsgId = Math.floor(replyTo)
  const payload = {
    roomId: Math.floor(Number(roomId)),
    msgType: 1,
    body: msgBody,
    skip: false,
    isTemp: false,
    isPushMessage: false,
  }
  return zhiliaoPostJson(base + '/im/chat/msg', { Token: token }, payload)
}

/**
 * 用户 Token 回投是否成功：HTTP 2xx + R.success/code + data.msgId 非空。
 * @param {{ok: boolean, status: number, body: any}} delivered 投递结果
 * @returns {boolean} 成功与否
 */
function zhiliaoUserSendOk(delivered) {
  if (!zhiliaoDeliveryOk(delivered)) return false
  const body = delivered.body
  if (body === null || typeof body !== 'object') return false
  if (!(body.success === true || Number(body.code) === 200 || Number(body.code) === 0)) return false
  const data = body.data !== null && typeof body.data === 'object' ? body.data : {}
  /* 真机契约：官方接口把 msgId 放在 data.message.id；同时兼容任务书里的 data.msgId。 */
  const message = data.message !== null && typeof data.message === 'object' ? data.message : {}
  const msgId = data.msgId !== undefined ? data.msgId : message.id
  if (typeof msgId === 'string') return msgId.trim() !== ''
  return Number.isFinite(Number(msgId)) && Number(msgId) > 0
}

/**
 * 官方 API 的 Token / 登录态失效判定（HTTP 200 + R.fail(code,msg)）。
 * 5xx / 超时等非业务失败一律不算 Token 失效；B1 不接 refresh，只记 failed + 告警。
 * @param {{ok: boolean, status: number, body: any}} delivered 投递结果
 * @returns {boolean} 是否 Token / 登录态失效
 */
function zhiliaoUserTokenFailure(delivered) {
  if (delivered === null || typeof delivered !== 'object') return false
  const status = Number(delivered.status)
  if (status >= 500 || (status > 0 && (status < 200 || status >= 300))) return false
  const body = delivered.body
  if (body === null || typeof body !== 'object') return false
  if (ZHILIAO_USER_TOKEN_FAIL_CODES.includes(Number(body.code))) return true
  const msg = String(body.msg !== undefined ? body.msg : (body.message !== undefined ? body.message : '')).toLowerCase()
  return /(token|登录|login).*(过期|失效|无效|未登录|被踢|expired|invalid)|未登录|被踢|unauthoriz|forbidden/.test(msg)
}

/**
 * 用户 Token 回投失败告警：B1 只提示，不改 tokenStatus / 不自动 refresh。
 * @param {string} bindingId 绑定 id
 * @param {string} detail 失败原因
 * @returns {void}
 */
function zhiliaoWarnUserDelivery(bindingId, detail) {
  state.warnings.push('智聊绑定 ' + String(bindingId) + ' 用户 Token 回投失败：' + String(detail).slice(0, 300))
}

/**
 * 用户 Token 发送 + 自动刷新：
 * 1. expiresAt 临近（提前 2 分钟）→ 先 proactive refresh；
 * 2. 发送鉴权失败且有 refreshToken → 单飞 refresh 一次 → 重试一次；
 * 3. 超时/5xx 不 refresh、不重试（官方 API 无幂等，避免重复发消息）。
 * @param {string} base replyBaseUrl（网关）
 * @param {string} bindingId 绑定 id
 * @param {number} roomId 房间号
 * @param {string} text 回复正文
 * @param {number|null} replyToMsgId 可选回复目标
 * @param {string[]} [atUidList] 群消息 @ 的 uid 列表
 * @returns {Promise<{delivered: Object|null, refreshAttempted: boolean, refreshOk: boolean, hadRefreshToken: boolean, refreshError: Object|null}>} 结果
 */
async function zhiliaoSendAsUserWithRefresh(base, bindingId, roomId, text, replyToMsgId, atUidList) {
  const credentials = zhiliaoReadUserCredentials(bindingId)
  const hadRefreshToken = credentials.refreshToken !== ''
  const out = {
    delivered: null,
    refreshAttempted: false,
    refreshOk: false,
    hadRefreshToken,
    refreshError: null,
  }
  if (credentials.token === '') return out
  let token = credentials.token
  const proactive = credentials.expiresAt > 0
    && Date.now() >= credentials.expiresAt - ZHILIAO_REFRESH_SKEW_MS
  if (proactive && hadRefreshToken) {
    out.refreshAttempted = true
    const refreshed = await zhiliaoRefreshUserTokenSingleFlight(base, bindingId)
    if (refreshed.ok === true) {
      token = refreshed.token
      out.refreshOk = true
    } else {
      out.refreshError = refreshed
    }
  }
  out.delivered = await zhiliaoSendAsUser(base, token, roomId, text, replyToMsgId, atUidList)
  if (zhiliaoUserSendOk(out.delivered)) return out
  /* reactive：只有第一次鉴权失败才刷新，且必须还没尝试过 refresh。 */
  if (!out.refreshAttempted && hadRefreshToken && zhiliaoUserTokenFailure(out.delivered)) {
    out.refreshAttempted = true
    const refreshed = await zhiliaoRefreshUserTokenSingleFlight(base, bindingId)
    if (refreshed.ok === true) {
      out.refreshOk = true
      out.delivered = await zhiliaoSendAsUser(base, refreshed.token, roomId, text, replyToMsgId, atUidList)
    } else {
      out.refreshError = refreshed
    }
  }
  return out
}

/**
 * 用户 Token 鉴权失败的最终告警文案（区分自动过期 / 刷新失败 / 无 refreshToken）。
 * @param {string} bindingId 绑定 id
 * @param {{refreshAttempted: boolean, hadRefreshToken: boolean}} result send 结果
 * @returns {string} 告警文案
 */
function zhiliaoUserAuthFailureWarning(bindingId, result) {
  const id = String(bindingId)
  if (result !== null && result.refreshAttempted === true) {
    return '智聊绑定 ' + id + ' 的 Token 与 refreshToken 均已失效（自动刷新失败），已自动暂停该绑定；请重填 Token 与 refreshToken'
  }
  if (result !== null && result.hadRefreshToken === true) {
    return '智聊绑定 ' + id + ' 的 Token 已失效且自动刷新未成功，已自动暂停该绑定；请重填 Token 与 refreshToken'
  }
  return '智聊绑定 ' + id + ' 的 Token 已失效且未配置 refreshToken，已自动暂停该绑定；请重填 Token 与 refreshToken'
}

/**
 * 取智聊配置（含缺省值），面板与 inbound 共用。
 * @returns {{webhookSecret: string, webhookSecretConfigured: boolean, internalSecret: string, internalSecretConfigured: boolean, productionWarnings: string[], testMode: boolean, replyBaseUrl: string, enabled: boolean, queue: {maxConcurrent: number, perKeyLimit: number, globalLimit: number}, recycle: {enabled: boolean, idleMinutes: number}}} 配置
 */
function zhiliaoConfig() {
  const cfg = state.settings !== null && typeof state.settings === 'object' && state.settings.zhiliao !== null
    && typeof state.settings.zhiliao === 'object' ? state.settings.zhiliao : {}
  const rawQueue = cfg.queue !== null && typeof cfg.queue === 'object' ? cfg.queue : {}
  const rawRecycle = cfg.recycle !== null && typeof cfg.recycle === 'object' ? cfg.recycle : {}
  const clampInt = (value, min, max, fallback) => {
    const n = Number(value)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, Math.floor(n)))
  }
  /* 密钥优先级：面板保存的 state 配置 > 环境变量 > 开发默认值。
     环境变量只在 state 未配置时生效，避免面板改完被启动环境覆盖。 */
  const stateWebhook = typeof cfg.webhookSecret === 'string' ? cfg.webhookSecret.trim() : ''
  const envWebhook = typeof process.env.DSH_ZHILIAO_WEBHOOK_SECRET === 'string'
    ? process.env.DSH_ZHILIAO_WEBHOOK_SECRET.trim() : ''
  const webhookSecret = stateWebhook !== '' ? stateWebhook : (envWebhook !== '' ? envWebhook : ZHILIAO_DEFAULT_SECRET)
  const stateInternal = typeof cfg.internalSecret === 'string' ? cfg.internalSecret.trim() : ''
  const envInternal = typeof process.env.DSH_ZHILIAO_INTERNAL_SECRET === 'string'
    ? process.env.DSH_ZHILIAO_INTERNAL_SECRET.trim() : ''
  const internalSecret = stateInternal !== '' ? stateInternal : (envInternal !== '' ? envInternal : ZHILIAO_INTERNAL_SECRET)
  const stateInternalBase = typeof cfg.internalBaseUrl === 'string' ? cfg.internalBaseUrl.trim().replace(/\/+$/, '') : ''
  const envInternalBase = typeof process.env.DSH_ZHILIAO_INTERNAL_BASE === 'string'
    ? process.env.DSH_ZHILIAO_INTERNAL_BASE.trim().replace(/\/+$/, '') : ''
  /* 默认留空：留空时由 zhiliaoInternalBase() 回落到 replyBaseUrl，生产网关正常时无需额外配置。 */
  const internalBaseUrl = stateInternalBase !== '' ? stateInternalBase : envInternalBase
  const webhookSecretConfigured = webhookSecret !== ZHILIAO_DEFAULT_SECRET
  const internalSecretConfigured = internalSecret !== ZHILIAO_INTERNAL_SECRET
  const productionWarnings = []
  if (!webhookSecretConfigured) productionWarnings.push('智聊 webhook 密钥仍为开发默认值，生产环境必须更换')
  if (!internalSecretConfigured) productionWarnings.push('智聊内部共享密钥仍为开发默认值，生产环境必须更换')
  return {
    webhookSecret,
    webhookSecretConfigured,
    internalSecret,
    internalSecretConfigured,
    internalBaseUrl,
    productionWarnings,
    testMode: cfg.testMode === true,
    replyBaseUrl: typeof cfg.replyBaseUrl === 'string' ? cfg.replyBaseUrl.trim().replace(/\/+$/, '') : '',
    /* 绑定测试目标：account 优先；为空时回落旧 uid 配置（默认小管家 1）。 */
    bindingTestAccount: typeof cfg.bindingTestAccount === 'string' ? cfg.bindingTestAccount.trim().slice(0, 120) : '',
    bindingTestUid: typeof cfg.bindingTestUid === 'string' && cfg.bindingTestUid.trim() !== ''
      ? cfg.bindingTestUid.trim() : ZHILIAO_TEST_UID_DEFAULT,
    enabled: cfg.enabled !== false,
    queue: {
      maxConcurrent: clampInt(rawQueue.maxConcurrent, 1, 256, 16),
      perKeyLimit: clampInt(rawQueue.perKeyLimit, 1, 10000, 20),
      globalLimit: clampInt(rawQueue.globalLimit, 1, 100000, 1000),
    },
    recycle: {
      enabled: rawRecycle.enabled === true,
      idleMinutes: clampInt(rawRecycle.idleMinutes, 1, 1440, 30),
    },
  }
}

/**
 * 内部 API base：settings/internalBaseUrl > env（已由 config 合并）> 本机 18778。
 * 不能回落 replyBaseUrl：网关未放行 /zhiliao/internal 时会 406。
 * @param {Object<string, any>} cfg zhiliaoConfig() 结果
 * @returns {string} 内部 API base
 */
function zhiliaoInternalBase(cfg) {
  const internal = cfg !== null && cfg !== undefined && typeof cfg.internalBaseUrl === 'string'
    ? cfg.internalBaseUrl.trim().replace(/\/+$/, '') : ''
  return internal !== '' ? internal : ZHILIAO_INTERNAL_BASE_DEFAULT
}

/**
 * 智聊状态事务：转调 `lib/zhiliao.js` 的进程内写锁（缓存 + 合并落盘）。
 *
 * 阶段 3 允许 16 个 turn 并发；如果每个 turn 各读一份快照、跑完 LLM 再整表覆盖写，
 * 后写者会用陈旧快照覆盖前写者的 done 记录 / 新建 session（真机 20 并发曾丢 18 条）。
 * 锁在 zhiliao.js 里，本函数只固定 BASE_DIR。
 *
 * 约束：**锁内禁止 await 网络 / LLM**，只做内存改动。
 *
 * @template T
 * @param {(state: Object<string, any>) => T|Promise<T>} mutate 修改函数
 * @returns {Promise<T>} mutate 的返回值
 */
function withZhiliaState(mutate) {
  return withZhiliaStateTx(BASE_DIR, mutate)
}

/** 智聊队列 / 回收器 / 启动时间：apply() 里初始化，路由与 handler 共用。 */
let zhiliaoQueue = null
let zhiliaoRecycler = null
/** 多绑定：每个 enabled 绑定一条 WS 连接（bindingId → client） */
const zhiliaoWsClients = new Map()
/** 多绑定连接状态（bindingId → status） */
const zhiliaoWsStatuses = new Map()
const zhiliaoBootAt = Date.now()

/** 打开 API 的 WS 地址：http(s) → ws(s)。 */
function zhiliaoWsUrl(base) {
  const b = String(base || '').trim().replace(/\/+$/, '')
  if (b.startsWith('https://')) return 'wss://' + b.slice('https://'.length)
  if (b.startsWith('http://')) return 'ws://' + b.slice('http://'.length)
  return b
}

/** 取当前工作空间允许连接的绑定（单工作空间）。 */
function zhiliaoWsBinding() {
  // 兼容旧调用：返回第一个启用中的绑定
  for (const binding of listBindings(loadZhiliaState(BASE_DIR))) {
    if (binding.enabled === true && binding.needsRebind !== true) return binding
  }
  return null
}

/**
 * 解析请求指向的绑定：优先 body.bindingId / query.bindingId，其次第一个绑定。
 * @param {any} source 请求体或查询对象
 * @returns {Object<string, any>|null} 绑定
 */
function zhiliaoResolveBinding(source) {
  const src = source !== null && typeof source === 'object' ? source : {}
  const wanted = String(src.bindingId || '').trim()
  const zlState = loadZhiliaState(BASE_DIR)
  if (wanted !== '') return findBindingById(zlState, wanted)
  const all = listBindings(zlState)
  return all.length > 0 ? all[0] : null
}

/** 从 history 响应中提取消息数组（兼容 items/messages/data）。 */
function zhiliaoHistoryItems(body) {
  if (Array.isArray(body)) return body
  if (body === null || typeof body !== 'object') return []
  for (const key of ['items', 'messages', 'records']) {
    if (Array.isArray(body[key])) return body[key]
  }
  if (body.data !== null && typeof body.data === 'object') {
    for (const key of ['items', 'messages', 'records']) {
      if (Array.isArray(body.data[key])) return body.data[key]
    }
  }
  return []
}

/**
 * 断线/启动补拉：按 sessions.json 的 lastSeq 拉最新一页，只处理 seq > lastSeq。
 * @param {Object<string, any>} binding 绑定
 * @returns {Promise<void>}
 */
async function zhiliaoWsBackfill(binding) {
  const base = zhiliaoOpenBase(binding, zhiliaoConfig())
  const apiKey = zhiliaoReadApiKey(binding)
  if (base === '' || apiKey === '') return
  const sessions = loadZhiliaState(BASE_DIR).sessions || {}
  for (const chatKey of Object.keys(sessions)) {
    if (!/^[sg]_/.test(chatKey)) continue
    const session = sessions[chatKey]
    const lastSeq = Number(session.lastSeq) || 0
    /* 首次连接不补历史（避免把旧消息重放给 agent）；断线重连才按 lastSeq 补。 */
    if (lastSeq <= 0) continue
    const delivered = await zhiliaoOpenHistory(base, apiKey, chatKey, 9007199254740991, 30)
    if (delivered.ok !== true) continue
    const items = zhiliaoHistoryItems(delivered.body)
    for (const item of items.slice().sort((a, b) => Number(a.seq) - Number(b.seq))) {
      const seq = Number(item.seq)
      if (!Number.isFinite(seq) || seq <= lastSeq) continue
      const content = zhiliaoParseContent(item.content)
      if (content.text === '') continue
      await handleInboundMessage({
        msgId: String(item.msgId || item.id || ''),
        chatKey,
        convKey: chatKey,
        senderId: String(item.senderId || ''),
        text: content.text,
        atList: content.atUidList,
        seq,
        bindingId: binding.bindingId,
      }).catch(() => { /* 单条补拉失败不阻断 */ })
    }
  }
}

/** 收到一帧 MSG → 转成统一 inbound payload。 */
async function handleZhiliaoWsFrame(binding, frame) {
  const data = frame !== null && typeof frame === 'object' && frame.data !== null && typeof frame.data === 'object'
    ? frame.data : null
  if (data === null) return
  const senderId = String(data.senderId || '')
  if (senderId === binding.userId || (binding.aiId !== '' && senderId === binding.aiId)) return
  if (data.aiGenerated === true) return
  const content = zhiliaoParseContent(data.content)
  if (content.text === '') return
  const convKey = String(frame.convKey || data.convKey || '')
  if (!/^[sg]_/.test(convKey)) return
  const out = await handleInboundMessage({
    msgId: String(data.msgId || data.id || ''),
    chatKey: convKey,
    convKey,
    senderId,
    text: content.text,
    atList: content.atUidList,
    seq: Number(data.seq),
    bindingId: binding.bindingId,
  })
  if (out && (out.ignored !== undefined || out.dedupe === 'duplicate')) {
    await zhiliaoAdvanceLastSeq(convKey, data.seq)
  }
}

/** 建立/重建 WS 连接；解绑、禁用、配置变化都调用它。 */
/** 建立/重建某一个绑定的 WS 连接。 */
function zhiliaoWsRestartOne(binding) {
  if (binding === null || typeof binding !== 'object') return
  const bindingId = String(binding.bindingId || '')
  if (bindingId === '') return
  zhiliaoWsStopOne(bindingId)
  // 重建后重新计时，避免探测误判为长期未鉴权
  if (typeof zhiliaoWsProbeStarted !== 'undefined') zhiliaoWsProbeStarted.delete(bindingId)
  const cfg = zhiliaoConfig()
  if (cfg.enabled !== true) return
  if (binding.enabled !== true || binding.needsRebind === true) return
  const base = zhiliaoOpenBase(binding, cfg)
  const apiKey = zhiliaoReadApiKey(binding)
  if (base === '' || apiKey === '') return
  const client = new ZhiliaoWsClient({
    url: zhiliaoWsUrl(base),
    apiKey,
    // 闭包绑定 binding：同一条连接收到的帧，身份与工作区都是该绑定的
    onMessage: (frame) => { void handleZhiliaoWsFrame(binding, frame).catch(() => { /* 单条消息失败不影响连接 */ }) },
    onAuth: () => { void zhiliaoWsBackfill(binding).catch(() => { /* ignore */ }) },
    onStatus: (status) => { zhiliaoWsStatuses.set(bindingId, status) },
  })
  zhiliaoWsClients.set(bindingId, client)
  client.connect()
}

/** 停止单个绑定的 WS。 */
function zhiliaoWsStopOne(bindingId) {
  const key = String(bindingId || '')
  const client = zhiliaoWsClients.get(key)
  if (client !== undefined && client !== null) {
    try { client.stop() } catch { /* ignore */ }
  }
  zhiliaoWsClients.delete(key)
  zhiliaoWsStatuses.delete(key)
}

/** 全量重启：为所有启用中的绑定各建一条 WS，支持同时接收多路会话。 */
function zhiliaoWsRestart() {
  zhiliaoWsStop()
  const cfg = zhiliaoConfig()
  if (cfg.enabled !== true) return
  for (const binding of listBindings(loadZhiliaState(BASE_DIR))) {
    if (binding !== null && typeof binding === 'object') zhiliaoWsRestartOne(binding)
  }
}

/** 主动断开全部 WS。 */
function zhiliaoWsStop() {
  for (const bindingId of Array.from(zhiliaoWsClients.keys())) {
    zhiliaoWsStopOne(bindingId)
  }
  zhiliaoWsClients.clear()
  zhiliaoWsStatuses.clear()
}

/**
 * 探测所有启用绑定：缺连接的补建，长期未鉴权的强制重连。
 * 供 DSH 启动后和周期性兜底调用，避免「面板显示未连接却没人拉起」。
 */
function zhiliaoWsProbe() {
  const cfg = zhiliaoConfig()
  if (cfg.enabled !== true) return
  const now = Date.now()
  for (const binding of listBindings(loadZhiliaState(BASE_DIR))) {
    if (binding === null || typeof binding !== 'object') continue
    if (binding.enabled !== true || binding.needsRebind === true) continue
    const bindingId = String(binding.bindingId || '')
    if (bindingId === '') continue
    const client = zhiliaoWsClients.get(bindingId)
    if (client === undefined || client === null) {
      zhiliaoWsRestartOne(binding)
      continue
    }
    const status = zhiliaoWsStatuses.get(bindingId)
    const authenticated = status !== undefined && status !== null && status.authenticated === true
    if (authenticated === true) continue
    // 连接存在但长期认证不上：客户端退避可能已失效，强制重建
    const since = zhiliaoWsProbeStarted.get(bindingId) || now
    zhiliaoWsProbeStarted.set(bindingId, since)
    // 服务器重启后 12s 还没认证上就强制重建，配合客户端快速退避尽快恢复
    if (now - since > 12000) zhiliaoWsRestartOne(binding)
  }
}
const zhiliaoWsProbeStarted = new Map()

/** 多路 WS 状态汇总（面板展示用）。 */
function zhiliaoWsSummary() {
  const items = []
  let connectedCount = 0
  let authenticatedCount = 0
  for (const [bindingId, status] of zhiliaoWsStatuses) {
    const st = status !== null && typeof status === 'object' ? status : {}
    if (st.connected === true) connectedCount += 1
    if (st.authenticated === true) authenticatedCount += 1
    items.push({
      bindingId,
      connected: st.connected === true,
      authenticated: st.authenticated === true,
      attempts: Number(st.attempts) || 0,
      apiKeyMasked: String(st.apiKeyMasked || ''),
    })
  }
  return {
    total: zhiliaoWsStatuses.size,
    connectedCount,
    authenticatedCount,
    connected: connectedCount > 0,
    authenticated: authenticatedCount === zhiliaoWsStatuses.size && zhiliaoWsStatuses.size > 0,
    items,
  }
}

/**
 * 确保队列实例存在（配置热更新时按需重建参数）。
 * @returns {ZhiliaoQueue} 队列
 */
function ensureZhiliaoQueue() {
  const cfg = zhiliaoConfig()
  if (zhiliaoQueue === null) {
    // close()（宿主退出）时把还在排队的任务标 failed，让上游重试而不是卡在 processing。
    const onDiscard = (meta) => {
      const msgId = meta !== null && typeof meta === 'object' ? String(meta.msgId || '') : ''
      if (msgId === '') return
      void withZhiliaState((s) => { markFailed(s, msgId, '宿主退出，排队任务未执行') })
        .catch(() => { /* 退出阶段记账失败可接受 */ })
    }
    zhiliaoQueue = new ZhiliaoQueue(Object.assign({}, cfg.queue, { onDiscard }))
    return zhiliaoQueue
  }
  // 配置变了才就地更新上限；已在飞的任务不受影响。
  if (zhiliaoQueue.maxConcurrent !== cfg.queue.maxConcurrent) zhiliaoQueue.maxConcurrent = cfg.queue.maxConcurrent
  if (zhiliaoQueue.perKeyLimit !== cfg.queue.perKeyLimit) zhiliaoQueue.perKeyLimit = cfg.queue.perKeyLimit
  if (zhiliaoQueue.globalLimit !== cfg.queue.globalLimit) zhiliaoQueue.globalLimit = cfg.queue.globalLimit
  return zhiliaoQueue
}

/**
 * 遍历启用中的绑定，批量设置 HuLa 侧 paused 状态（退出/启动各一次）。
 * 单个失败只记日志；3 秒总超时，避免退出卡住。
 * @param {boolean} paused 是否暂停
 * @param {boolean} [quiet] 静默模式（启动恢复接管用）：失败只计数、不写 warnings
 * @returns {Promise<{ok: number, failed: number, skipped: number}>} 结果统计
 */
async function zhiliaoSetAllPaused(paused, quiet) {
  const cfg = zhiliaoConfig()
  const zlState = loadZhiliaState(BASE_DIR)
  const targets = listBindings(zlState).filter((b) => b.enabled !== false)
  const calls = []
  let skipped = 0
  for (const binding of targets) {
    const base = zhiliaoInternalBase(cfg)
    if (base === '') { skipped += 1; continue }
    calls.push(zhiliaoPostJson(
      base + '/zhiliao/internal/binding/paused',
      { 'x-zhiliao-internal-secret': cfg.internalSecret },
      { bindingId: binding.bindingId, paused: paused === true },
    ))
  }
  if (calls.length === 0) return { ok: 0, failed: 0, skipped }
  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve('timeout'), 3000)
  }).then((value) => value)
  const settled = await Promise.race([Promise.allSettled(calls), timeout])
  if (timer !== null) clearTimeout(timer)
  const quietMode = quiet === true
  if (settled === 'timeout') {
    if (!quietMode) state.warnings.push('智聊 paused 广播超时（3s），部分绑定可能未更新')
    return { ok: 0, failed: calls.length, skipped }
  }
  let ok = 0
  let failed = 0
  for (const row of settled) {
    const delivered = row.status === 'fulfilled' ? row.value : null
    if (zhiliaoDeliveryOk(delivered)) ok += 1
    else failed += 1
  }
  if (failed > 0 && !quietMode) state.warnings.push('智聊 paused 广播部分失败：' + String(failed) + ' 个绑定')
  return { ok, failed, skipped }
}

/**
 * 群范围校验：`binding.scope.groups` 非空时，只有 `group:<id>` 命中白名单才放行。
 *
 * <p>空数组 / 未配置 = 不限制（保持现有全群行为，向后兼容）；私聊（`direct:`）不受
 * 群白名单影响；群 ID 与白名单统一转成字符串再比，兼容配置里写数字或字符串。</p>
 *
 * @param {any} binding 已解析的绑定
 * @param {string} chatKey 会话键，如 `group:1` / `direct:uidA:uidB`
 * @returns {boolean} true 表示放行，false 表示该群不在绑定白名单内
 */
export function zhiliaoGroupScopeAllows(binding, chatKey) {
  if (binding === null || typeof binding !== 'object') return true
  if (typeof chatKey !== 'string' || (chatKey.startsWith('group:') !== true && chatKey.startsWith('g_') !== true)) return true
  const scope = binding.scope
  if (scope === null || typeof scope !== 'object' || Array.isArray(scope)) return true
  const groups = Array.isArray(scope.groups) ? scope.groups : []
  if (groups.length === 0) return true
  const groupId = (chatKey.startsWith('g_') ? chatKey.slice(2) : chatKey.slice('group:'.length)).trim()
  // 白名单非空但 chatKey 解析不出群 ID：无法确认在范围内，按不放行处理。
  if (groupId === '') return false
  return groups.some((value) => String(value).trim() === groupId)
}

/**
 * 处理一条 HuLa Webhook / 阶段 0 兼容 curl 消息。
 *
 * 默认（真实 webhook）：验签/去重/绑定/@ 过滤后**入队并立即 ACK**，真正跑 turn 由
 * 分区串行队列异步完成，回复走独立回投接口，不依赖 HTTP 响应。
 * 兼容（testMode + 显式 sessionId 的阶段 0 curl）：仍同步跑完并返回 reply/turnEnd。
 *
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {Promise<Object<string, any>>} 回包；可能带 status（429 背压）
 */
/**
 * 统一入站业务处理（WS / 兼容 HTTP 共用）：校验 → 绑定 → 群白名单 → 去重 → 入队。
 * @param {{msgId: string, chatKey?: string, convKey?: string, senderId?: string, from?: string, text: string, atList?: string[], seq?: number, bindingId?: string}} payload 消息
 * @returns {Promise<Object<string, any>>} ACK / ignored / 错误
 */
async function handleInboundMessage(payload) {
  const p = payload !== null && typeof payload === 'object' ? payload : {}
  const msgId = String(p.msgId || '').trim()
  const chatKey = String(p.convKey || p.chatKey || '').trim()
  const text = String(p.text || '').trim()
  if (!ZHILIAO_ID_RE.test(msgId)) return { ok: false, error: 'invalid-arg', detail: 'msgId 缺失或格式非法' }
  if (!ZHILIAO_CHAT_KEY_RE.test(chatKey)) return { ok: false, error: 'invalid-arg', detail: 'convKey/chatKey 缺失或格式非法' }
  if (text === '') return { ok: false, error: 'invalid-arg', detail: 'text 缺失或为空' }
  if (text.length > ZHILIAO_TEXT_MAX) return { ok: false, error: 'invalid-arg', detail: 'text 过长' }
  const senderId = String(p.senderId || p.from || '')
  const atList = Array.isArray(p.atList) ? p.atList.map((v) => String(v)) : []
  const resolved = resolveBinding(loadZhiliaState(BASE_DIR), {
    bindingId: p.bindingId, convKey: chatKey, senderId, atList,
  })
  if (resolved.ignored !== '') return { ok: true, msgId, chatKey, ignored: resolved.ignored }
  const binding = resolved.binding
  if (zhiliaoGroupScopeAllows(binding, chatKey) !== true) {
    await withZhiliaState((s) => {
      const session = zhiliaoEnsureSession(s, chatKey, binding)
      const seq = Number(p.seq)
      if (Number.isFinite(seq) && seq > (Number(session.lastSeq) || 0)) session.lastSeq = seq
    })
    return { ok: true, msgId, chatKey, ignored: 'group-not-in-scope' }
  }
  // 接管模式检查：会话设为 NONE（不接管）时，消息根本不该发给 AI。
  // 明确查到 NONE 才拦截；查询失败（如 AI 身份 Key 无权限查询）则降级放行，避免误伤。
  if (binding !== null) {
    const mode = await zhiliaoFetchConvMode(binding, chatKey)
    if (mode === 'NONE') {
      zhiliaoPersonaDebug('入站拦截: convKey=' + chatKey + ' 接管模式=NONE，不发给AI')
      return { ok: true, msgId, chatKey, ignored: 'takeover-none' }
    }
  }
  const prepared = await withZhiliaState((s) => {
    resetStaleProcessing(s, 2 * 60 * 1000)
    const cached = checkDedupe(s, msgId)
    if (cached !== null && cached.status === 'processing') return { duplicate: 'processing' }
    if (cached !== null && cached.status === 'done') return { duplicate: 'done', reply: cached.reply || '' }
    const isNewSession = s.sessions[chatKey] === undefined
    const session = zhiliaoEnsureSession(s, chatKey, binding)
    session.lastActiveAt = Date.now()
    markProcessing(s, msgId)
    return { sessionId: session.dshSessionId, isNewSession }
  })
  if (prepared.duplicate === 'processing') {
    return { ok: true, msgId, chatKey, dedupe: 'duplicate', queued: true, processing: true }
  }
  if (prepared.duplicate === 'done') {
    return { ok: true, msgId, chatKey, dedupe: 'duplicate', reply: prepared.reply, turnEnd: 'complete' }
  }
  const seq = Number(p.seq)
  const turnParams = {
    msgId, text, requestId: msgId, sessionId: prepared.sessionId, binding,
    body: { atUidList: atList }, cfg: zhiliaoConfig(), chatKey,
    seq: Number.isFinite(seq) ? seq : 0,
  }
  const queue = ensureZhiliaoQueue()
  const enq = queue.enqueue(chatKey, () => zhiliaoRunTurn(turnParams), {
    seq: Number.isFinite(seq) ? seq : undefined,
    msgId,
  })
  if (enq.accepted !== true) {
    const detail = '队列已满（' + enq.reason + '），等待重连补拉'
    await withZhiliaState((s) => { markFailed(s, msgId, detail) })
    return { ok: false, error: 'queue-full', msgId, chatKey, detail }
  }
  return { ok: true, msgId, chatKey, queued: true, position: enq.position, dedupe: 'first' }
}

async function handleZhiliaInbound(req) {
  const bad = (error, extra) => Object.assign({ ok: false, error }, extra || {})
  const headers = req !== null && typeof req === 'object' && req.headers !== null
    && typeof req.headers === 'object' ? req.headers : {}
  const cfg = zhiliaoConfig()

  // 原始 body 字节必须留着做 HMAC —— 绝不能用 JSON.parse 后的重序列化字符串。
  let raw = null
  try {
    raw = await readRawBody(req, 1024 * 1024)
  } catch {
    return bad('invalid-arg', { detail: '读取请求体失败' })
  }
  // ① 验签：testMode 下兼容阶段 0 固定 token；默认走 HMAC（secret 可面板配置）。
  const sign = headerValue(headers, 'x-zhiliao-sign')
  const testRequest = cfg.testMode && sign === ZHILIAO_TEST_TOKEN
  if (!testRequest && !verifyWebhookSign(raw, sign, cfg.webhookSecret)) return bad('invalid-sign')

  let body = null
  try {
    const text = raw.toString('utf8').trim()
    if (text !== '') body = JSON.parse(text)
  } catch {
    return bad('invalid-arg', { detail: '请求体不是合法 JSON' })
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return bad('invalid-arg', { detail: '请求体必须是 JSON 对象' })
  }

  const preSessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  /* 阶段 0 兼容判定必须在去重之前算出来：同步路径的 processing 空回复是错误，
     异步路径的 processing 空回复只代表「已入队、正在跑」，语义不同。 */
  const preSync = testRequest && (preSessionId !== '' ||
    (body.bindingId === undefined && body.atList === undefined && body.from === undefined))

  // ② 参数校验（去重前先做：合法 webhook 的重投 payload 与首投相同，不影响 duplicate 语义）。
  const msgId = typeof body.msgId === 'string' ? body.msgId.trim() : ''
  const text = typeof body.text === 'string' ? body.text.trim() : ''
  if (!ZHILIAO_ID_RE.test(msgId)) return bad('invalid-arg', { detail: 'msgId 缺失或格式非法' })
  if (text === '') return bad('invalid-arg', { detail: 'text 缺失或为空' })
  if (text.length > ZHILIAO_TEXT_MAX) return bad('invalid-arg', { detail: 'text 过长' })
  const requestId = typeof body.requestId === 'string' && body.requestId.trim() !== ''
    ? body.requestId.trim() : msgId
  if (!ZHILIAO_ID_RE.test(requestId)) return bad('invalid-arg', { detail: 'requestId 格式非法' })
  const explicitSessionId = typeof body.sessionId === 'string' && ZHILIAO_ID_RE.test(body.sessionId.trim())
    ? body.sessionId.trim() : ''
  let chatKey = typeof body.chatKey === 'string' ? body.chatKey.trim() : ''
  if (chatKey !== '' && !ZHILIAO_CHAT_KEY_RE.test(chatKey)) return bad('invalid-arg', { detail: 'chatKey 格式非法' })

  // 绑定解析用只读快照（不写盘，不需要进写锁）。
  let binding = null
  if (!preSync) {
    if (chatKey === '') return bad('invalid-arg', { detail: 'chatKey 缺失或格式非法' })
    const resolved = resolveBinding(loadZhiliaState(BASE_DIR), body)
    if (resolved.ignored !== '') return { ok: true, msgId, chatKey, ignored: resolved.ignored }
    /* 群白名单：冻结的 zhiliao.js 不参与范围过滤，这里在绑定解析之后补一层；
       不在白名单内直接 ACK ignored，不占账本、不入队、不跑 agent。 */
    if (zhiliaoGroupScopeAllows(resolved.binding, chatKey) !== true) {
      return { ok: true, msgId, chatKey, ignored: 'group-not-in-scope' }
    }
    binding = resolved.binding
    /* 私聊会话键统一成 `direct:<selfUid>:<peerUid>`：当前用户固定在前，
       这样同一对方无论 webhook 里两位 uid 顺序如何，都落到同一个 dsh 会话。 */
    if (chatKey.startsWith('direct:')) {
      const parts = chatKey.split(':')
      const selfUid = String(binding.userId || binding.hulaUid || '')
      if (parts.length >= 3) {
        const peer = parts[1] === selfUid ? parts[2] : (parts[2] === selfUid ? parts[1] : '')
        if (peer !== '') chatKey = 'direct:' + selfUid + ':' + peer
      }
    }
  }

  const sc = hostService('sessionController')
  if (sc === null || typeof sc.create !== 'function' || typeof sc.prompt !== 'function'
    || typeof sc.follow !== 'function') {
    return bad('agent-error', { detail: '宿主未提供 sessionController 服务' })
  }

  // ③ 原子事务：重置僵死 + 去重重检 + 会话映射 + 占 processing 一次完成。
  // 这是修 P1 的关键：并发 turn 不再拿陈旧快照覆盖别人的 done / 新 session。
  const prepared = await withZhiliaState((s) => {
    resetStaleProcessing(s)
    const cached = checkDedupe(s, msgId)
    if (cached !== null && (cached.status === 'done' || cached.status === 'processing')) {
      return { cached }
    }
    let sid = ''
    if (preSync && explicitSessionId !== '') {
      sid = explicitSessionId
    } else if (preSync && chatKey !== '') {
      sid = stableSessionId(chatKey)
    } else {
      const chatSession = zhiliaoEnsureSession(s, chatKey, binding)
      sid = chatSession.dshSessionId
      // lastMsgId 是展示字段，等本轮真正成功再更新（P3：并发下不要记成较早的消息）。
      chatSession.lastActiveAt = Date.now()
      chatSession.followCursor = Number(chatSession.followCursor) || 0
    }
    markProcessing(s, msgId)
    return { cached: null, sessionId: sid }
  })

  if (prepared.cached !== null) {
    const cached = prepared.cached
    const cachedReply = typeof cached.reply === 'string' ? cached.reply : ''
    // processing 没有缓存回复：同步路径不能假装成功；异步路径是「排队/执行中」，如实回 ACK。
    if (cached.status === 'processing' && cachedReply === '') {
      if (preSync) {
        return bad('duplicate', {
          msgId,
          detail: '同 msgId 的上一条仍在处理中（processing），请稍后重试或等僵死超时重放',
        })
      }
      return { ok: true, msgId, chatKey, dedupe: 'duplicate', queued: true, processing: true }
    }
    const cachedSession = findChatSession(loadZhiliaState(BASE_DIR), chatKey)
    const cachedSessionId = explicitSessionId !== ''
      ? explicitSessionId
      : (cachedSession !== null ? cachedSession.dshSessionId : (chatKey !== '' ? stableSessionId(chatKey) : ''))
    const dupOut = {
      ok: true,
      msgId,
      sessionId: cachedSessionId,
      reply: cachedReply,
      turnEnd: 'complete',
      dedupe: 'duplicate',
    }
    if (!preSync) dupOut.chatKey = chatKey
    return dupOut
  }

  const sessionId = prepared.sessionId
  if (zhiliaoRecycler !== null && chatKey !== '') zhiliaoRecycler.touch(chatKey)

  const turnParams = { msgId, text, requestId, sessionId, binding, body, cfg, chatKey }
  if (preSync) return await zhiliaoRunTurn(turnParams)

  // ④ 默认路径：入队即 ACK，真正执行由分区串行队列异步完成。
  const queue = ensureZhiliaoQueue()
  const seq = Number(body.seq)
  const enq = queue.enqueue(chatKey, () => zhiliaoRunTurn(turnParams), {
    seq: Number.isFinite(seq) ? seq : undefined,
    msgId,
  })
  if (enq.accepted !== true) {
    const detail = '队列已满（' + enq.reason + '），请稍后按退避重试'
    await withZhiliaState((s) => { markFailed(s, msgId, detail) })
    return Object.assign({}, bad('queue-full', { msgId, chatKey, detail }), { status: 429 })
  }
  return {
    ok: true,
    msgId,
    chatKey,
    queued: true,
    position: enq.position,
    dedupe: 'first',
  }
}

/**
 * 跑完一轮 create → prompt → follow → 回投/待发/记账（同步路径与队列任务共用）。
 * @param {{msgId: string, text: string, requestId: string, sessionId: string, binding: any, body: any, cfg: any, chatKey: string}} params 参数
 * @returns {Promise<Object<string, any>>} 单轮结果
 */
/**
 * 群消息进 agent 前归一化 @mention：绑定名整段删除，其余 @token 去掉 @ 只留文本。
 * 避免模型把 `@leng` / `@冷血` 当成 subagent 名；只清洗 prompt 文本，
 * dedupe.reply / 回投内容 / 日志仍用原文。
 * @param {string} text 原始文本
 * @param {Object<string, any>|null} binding 绑定
 * @returns {string} 归一化后的 prompt 文本；无正文时返回占位文案
 */
function zhiliaoStripMentions(text, binding) {
  const original = typeof text === 'string' ? text : String(text || '')
  if (ZHILIAO_STRIP_MENTION !== true || original === '') return original
  const names = []
  if (binding !== null && binding !== undefined) {
    if (typeof binding.displayName === 'string' && binding.displayName.trim() !== '') {
      names.push(binding.displayName.trim())
    }
    if (typeof binding.account === 'string' && binding.account.trim() !== '') {
      names.push(binding.account.trim())
    }
  }
  let out = original
  const seen = new Set()
  for (const name of names) {
    if (seen.has(name)) continue
    seen.add(name)
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    /* 绑定账号/昵称 mention：大小写不敏感，保留前导空白，避免粘连正文。 */
    out = out.replace(new RegExp('(^|\\s)@' + escaped + '(?=\\s|$|[，,。！？!?])[ \\t]*', 'gi'), '$1')
  }
  /* 其余 @token 去掉 @ 符号（仅开头/空白/括号后的 @，邮箱 a@b.com 不误伤）。 */
  out = out.replace(/(^|[\s(（])@([^\s@，,。！？!?、]+)/g, '$1$2')
  out = out.trim()
  /* 绑定 mention 后紧跟标点时，删除 mention 会留下前导标点；只剥开头，正文中间不动。 */
  out = out.replace(/^[\s，,。.！!？?；;：:、~～\-—]+/, '').trim()
  return out === '' ? '（对方 @ 了你，但没有输入正文内容）' : out
}

/** 会话对端名称缓存：kind:id → 名称 */
const zhiliaoPeerNameCache = new Map()

/**
 * 解析会话对端（聊天的对方）名称，用于给 DSH 工作区里的会话起可读标题。
 * @param {string} chatKey 会话键 s_<a>_<b> 或 g_<groupId>
 * @param {any} binding 绑定
 * @param {any} cfg 配置
 * @returns {Promise<string>} 对端名称；查不到返回 id
 */
async function zhiliaoResolvePeerName(chatKey, binding, cfg) {
  const base = zhiliaoOpenBase(binding, cfg)
  const apiKey = zhiliaoReadApiKey(binding)
  if (base === '' || apiKey === '') return ''
  const self = String(binding.userId || '')
  let kind = 'user'
  let id = ''
  const key = String(chatKey || '')
  if (key.startsWith('s_')) {
    const parts = key.slice(2).split('_')
    if (parts.length !== 2) return ''
    id = parts[0] === self ? parts[1] : parts[0]
  } else if (key.startsWith('g_')) {
    kind = 'group'
    id = key.slice(2)
  } else return ''
  if (id === '') return ''
  const cacheKey = kind + ':' + id
  if (zhiliaoPeerNameCache.has(cacheKey)) return zhiliaoPeerNameCache.get(cacheKey)
  const lookup = await zhiliaoOpenLookup(base, apiKey, kind, id)
  const body = lookup.ok === true && lookup.body !== null && typeof lookup.body === 'object' ? lookup.body : null
  const name = body !== null ? String(body.name || body.nickname || id) : id
  zhiliaoPeerNameCache.set(cacheKey, name)
  return name
}

/**
 * 给 DSH 工作区里的会话设置标题：<对方名称>：<消息内容摘要>。
 * 失败不影响消息处理。
 */
async function zhiliaoTitleSession(sc, sessionId, chatKey, text, binding, cfg) {
  if (sc === null || typeof sc.rename !== 'function') return
  try {
    const peer = await zhiliaoResolvePeerName(chatKey, binding, cfg)
    const snippet = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 24)
    const title = peer !== '' ? (peer + (snippet !== '' ? '：' + snippet : '')) : snippet
    if (title !== '') await sc.rename({ sessionId, title })
  } catch { /* 标题失败不影响回复 */ }
}

/** 成功处理一条消息后推进会话 lastSeq，供 WS 断线补拉过滤。 */
async function zhiliaoAdvanceLastSeq(chatKey, seq) {
  const n = Number(seq)
  if (chatKey === '' || !Number.isFinite(n) || n <= 0) return
  await withZhiliaState((s) => {
    const session = findChatSession(s, chatKey)
    if (session !== null && n > (Number(session.lastSeq) || 0)) session.lastSeq = n
  })
}

/** 包装：上报 thinking → 执行 → 上报 done/error（供前端在聊天框显示进度/异常） */
async function zhiliaoRunTurn(params) {
  const convKey = String((params && params.chatKey) || '').trim()
  const binding = params && params.binding
  void zhiliaoReportAiStatus(binding, convKey, 'thinking')
  let result = null
  try {
    result = await zhiliaoRunTurnInner(params)
  } catch (err) {
    const detail = err !== null && err !== undefined && err.message ? String(err.message) : '处理异常'
    void zhiliaoReportAiStatus(binding, convKey, 'error', detail)
    throw err
  }
  if (result !== null && result !== undefined && result.ok === true) {
    void zhiliaoReportAiStatus(binding, convKey, 'done')
  } else {
    const detail = result && (result.detail || result.error) ? String(result.detail || result.error) : '回复生成失败'
    void zhiliaoReportAiStatus(binding, convKey, 'error', detail)
  }
  return result
}

async function zhiliaoRunTurnInner(params) {
  const { msgId, text, requestId, sessionId, binding, body, cfg, chatKey, seq } = params
  const bad = (error, extra) => Object.assign({ ok: false, error }, extra || {})

  const sc = hostService('sessionController')
  if (sc === null || typeof sc.create !== 'function' || typeof sc.prompt !== 'function'
    || typeof sc.follow !== 'function') {
    return bad('agent-error', { detail: '宿主未提供 sessionController 服务' })
  }

  // ④ create（幂等）→ ⑤ prompt（requestId 幂等）→ ⑥ follow 取回复。
  // dedupe 的 processing 已由调用方（入队前）落盘，这里不再重复标记。
  const cwd = zhiliaoWorkDirFor(binding)
  // 宿主 sessionController.create 的 workspaceId 与 cwd 互斥：
  // 有工作区就传 workspaceId，会话才会出现在 DSH 左栏的工作区下
  // 每次消息都强制确保工作区存在（workspaceController.create 幂等）：
  // 用户删除工作区后，缓存的旧 workspaceId 会失效导致 "workspace not found"，这里会重建。
  let workspaceId = await zhiliaoEnsureWorkspaceLive(binding)
  if (workspaceId === '') workspaceId = await zhiliaoWorkspaceIdFor(binding)
  /* 只清洗送进 agent 的文本；dedupe.reply / 回投 / 日志仍保留原文。 */
  const promptText = zhiliaoStripMentions(text, binding)
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(new Error('zhiliao follow timeout')), ZHILIAO_FOLLOW_TIMEOUT_MS)
  try {
    const wsId = String(workspaceId || '')
    try {
      unwrapHostResult(wsId !== ''
        ? await sc.create({ sessionId, workspaceId: wsId })
        : await sc.create({ sessionId, cwd }))
    } catch (createError) {
      // 工作区刚被删/失效导致 workspace not found：回退 cwd 创建，确保消息一定能回复
      const detail = String((createError && createError.message) || createError)
      if (wsId !== '' && /workspace|not found|不存在/i.test(detail)) {
        zhiliaoPersonaDebug('sc.create workspace失效，回退cwd: ' + detail)
        unwrapHostResult(await sc.create({ sessionId, cwd }))
      } else throw createError
    }
    // 工作区被删除重建后 workspaceId 可能变化，写回账本避免下次又用旧 id
    if (wsId !== '') {
      try {
        await withZhiliaState((st) => {
          const sess = getOrCreateChatSession(st, chatKey, binding.bindingId, cwd)
          if (String(sess.workspaceId || '') !== wsId) { sess.workspaceId = wsId; sess.lastActiveAt = Date.now() }
        })
      } catch { /* 账本更新失败不影响本轮回复 */ }
    }
    // 会话标题 = 当前聊天对象 + 消息摘要，便于在工作区里辨认
    await zhiliaoTitleSession(sc, sessionId, chatKey, text, binding, cfg)
    // 本轮 prompt 前，先取会话当前最后一条 assistant 文本作为基线。
    // follow 的 snapshot 会包含全部历史；若本轮还没产出新回复，兜底会误把历史最后一条当成本轮回复（回复串台）。
    // 有了基线，兜底时排除它，宁可失败也不回旧内容。
    let baselineReply = ''
    if (typeof sc.page === 'function') {
      try {
        const basePage = unwrapHostResult(await sc.page({
          address: { kind: 'session', sessionId },
          maxMessages: 50,
        }, abort.signal))
        if (basePage !== null && typeof basePage === 'object' && Array.isArray(basePage.records)) {
          for (const record of basePage.records) {
            if (record !== null && typeof record === 'object' && record.type === 'event'
              && record.event !== null && typeof record.event === 'object'
              && record.event.type === 'assistant/message') {
              const t = zhiliaoReplyText(record.event)
              if (t !== '') baselineReply = t
            }
          }
        }
      } catch { /* 基线获取失败：退化为不过滤，至少不影响正常路径 */ }
    }

    unwrapHostResult(await sc.prompt({
      requestId,
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: promptText }],
    }, abort.signal))

    let reply = ''
    let turnEnd = 'incomplete'
    let turnError = ''
    let snapshotCursor = -1
    let snapshotFallback = ''
    for await (const frame of sc.follow({
      address: { kind: 'session', sessionId },
      maxMessages: 50,
      assistantStream: false,
    }, abort.signal)) {
      if (frame === null || typeof frame !== 'object') continue
      if (frame.type === 'snapshot') {
        const cursor = Number(frame.cursor)
        snapshotCursor = Number.isFinite(cursor) ? cursor : -1
        // 极端快的情况：prompt 的事件在订阅前就落进快照，留作兜底。
        if (Array.isArray(frame.records)) {
          for (const record of frame.records) {
            if (record !== null && typeof record === 'object' && record.type === 'event'
              && record.event !== null && typeof record.event === 'object'
              && record.event.type === 'assistant/message') {
              const t = zhiliaoReplyText(record.event)
              if (t !== '' && t !== baselineReply) snapshotFallback = t
            }
          }
        }
        continue
      }
      if (frame.type !== 'event' || frame.event === null || typeof frame.event !== 'object') continue
      const event = frame.event
      // 快照已包含的历史事件不重放（seq 单调递增）。
      if (snapshotCursor >= 0 && typeof event.seq === 'number' && event.seq <= snapshotCursor) continue
      if (event.type === 'assistant/message') {
        const t = zhiliaoReplyText(event)
        if (t !== '') reply = t
      } else if (event.type === 'turn/end') {
        // 错误结束（如 provider 405 / model-unavailable）不会产出 assistant/message，
        // 把宿主给的 reason 留下来，回包里如实说明，绝不伪造 reply。
        const reason = event.data !== null && typeof event.data === 'object' ? event.data.reason : null
        if (reason !== null && typeof reason === 'object' && reason.kind === 'error') {
          const inner = reason.error !== null && typeof reason.error === 'object' ? reason.error : null
          turnError = String((inner !== null && inner.message) || reason.message || 'turn/end error')
        } else {
          turnEnd = 'complete'
        }
        break
      }
    }
    if (reply === '' && snapshotFallback !== '') reply = snapshotFallback

    // page 兜底：远程流没给文本时从历史页捞最后一条 assistant 文本。
    if (reply === '' && typeof sc.page === 'function') {
      try {
        const page = unwrapHostResult(await sc.page({
          address: { kind: 'session', sessionId },
          throughSeq: snapshotCursor >= 0 ? snapshotCursor : 1,
          maxMessages: 50,
        }, abort.signal))
        if (page !== null && typeof page === 'object' && Array.isArray(page.records)) {
          for (const record of page.records) {
            if (record !== null && typeof record === 'object' && record.type === 'event'
              && record.event !== null && typeof record.event === 'object'
              && record.event.type === 'assistant/message') {
              const t = zhiliaoReplyText(record.event)
              if (t !== '' && t !== baselineReply) reply = t
            }
          }
        }
      } catch {
        // page 只是兜底，失败交给下面的 agent-error。
      }
    }
    // turn/end 报 error 时无论是否已拿到部分文本，都必须按失败返回：
    // 成功响应只允许 turnEnd:'complete'，否则破坏契约。
    if (reply === '' || turnError !== '') {
      const detail = turnError !== '' ? turnError : 'follow/page 均未取得 assistant/message 文本'
      await withZhiliaState((s) => { markFailed(s, msgId, detail) })
      return bad('agent-error', { msgId, sessionId, detail })
    }

    // 清洗 provider 混入的配额/密钥错误噪声，避免把 "quota exhausted" 发给用户
    reply = zhiliaoCleanReply(reply)
    // 清洗后为空则按失败处理，不发送空消息
    if (reply === '') {
      await withZhiliaState((s) => { markFailed(s, msgId, '回复内容仅含错误信息') })
      return bad('agent-error', { msgId, sessionId, detail: '回复内容仅含错误信息' })
    }

    // 本轮成功后再记 lastMsgId（展示字段，并发下不至于记成更早的消息）。
    if (chatKey !== '') {
      await withZhiliaState((s) => {
        updateChatSession(s, chatKey, { lastMsgId: msgId, lastActiveAt: Date.now() })
      })
    }

    // ⑦ 回投 / 待发 / 只记录，然后写 dedupe。
    const out = { ok: true, msgId, sessionId, reply, turnEnd, dedupe: 'first' }
    // 半托管的「生成草稿 → 用户确认」统一由智聊服务端接管策略（HALF）决定：
    // 服务端会返回 {pending:true,draftId}，用户在智聊客户端「待确认」里确认或丢弃。
    // 插件不再自持草稿，避免两处确认入口。binding.requireConfirm 仅作为
    // 「未配置服务端接管时」的兼容开关：服务端不会自动读它，故此处不再拦截。
    if (binding !== null && binding.autoReply === false) {
      await withZhiliaState((s) => { markDone(s, msgId, reply) })
      out.delivered = false
      await zhiliaoAdvanceLastSeq(chatKey, seq)
      return out
    }
    if (binding !== null) {
      const base = zhiliaoOpenBase(binding, cfg)
      const apiKey = zhiliaoReadApiKey(binding)
      if (base === '' || apiKey === '') {
        const detail = !base ? '未配置 zhiliao-server 地址' : '绑定缺少 API Key，请重新配置'
        await withZhiliaState((s) => { markFailed(s, msgId, detail) })
        return Object.assign({}, bad('delivery-failed', { msgId, sessionId, detail }), { dedupe: 'failed' })
      }
      const atUidList = chatKey.startsWith('g_') && Array.isArray(body.atUidList)
        ? body.atUidList.map((v) => String(v)) : []
      const delivered = await zhiliaoOpenSend(base, apiKey, {
        convKey: chatKey,
        text: String(binding.replyPrefix || '') + reply,
        // 入站消息已用 msgId 落库，回投复用会被智聊幂等吞掉（返回成功但不产生新消息）
        requestId: String(msgId || '') + '-reply',
        as: binding.aiId !== '' ? 'ai' : 'user',
        atUidList,
      })
      const deliveredBody = delivered.body !== null && typeof delivered.body === 'object' ? delivered.body : null
      // 半托管：服务端只落草稿，等用户在智聊确认后才会真正发出——这不是失败
      const deliveredPending = delivered.ok === true && deliveredBody !== null && deliveredBody.pending === true
      if (deliveredPending) {
        const draftId = deliveredBody.draftId
        await withZhiliaState((s) => { markDone(s, msgId, reply) })
        out.delivered = false
        out.pending = true
        out.draftId = draftId
        out.delivery = deliveredBody
        state.warnings.push('半托管：回复已生成草稿，等待用户在智聊确认后发送（draftId=' + String(draftId) + '）'
          + (binding.displayName ? '：' + String(binding.displayName) : ''))
        await zhiliaoAdvanceLastSeq(chatKey, seq)
        return out
      }
      const deliveredOk = delivered.ok === true && deliveredBody !== null
        && deliveredBody.error === undefined && (deliveredBody.msgId !== undefined || deliveredBody.seq !== undefined)
      if (!deliveredOk) {
        const errText = deliveredBody !== null
          ? String(deliveredBody.error || deliveredBody.message || deliveredBody.detail || JSON.stringify(deliveredBody))
          : String(delivered.body || '')
        const detail = '发送失败：HTTP ' + String(delivered.status) + ' ' + errText.slice(0, 300)
        if (delivered.status === 403 || errText.indexOf('takeover') >= 0 || errText.indexOf('接管') >= 0) {
          state.warnings.push('智聊发送被拒（用户未开启 AI 接管）：' + String(binding.displayName || binding.bindingId))
        }
        await withZhiliaState((s) => { markFailed(s, msgId, detail) })
        return Object.assign({}, bad('delivery-failed', { msgId, sessionId, detail }), { dedupe: 'failed' })
      }
      await withZhiliaState((s) => { markDone(s, msgId, reply) })
      out.delivered = true
      out.delivery = deliveredBody
      await zhiliaoAdvanceLastSeq(chatKey, seq)
      return out
    }
    // 阶段 0 兼容路径：没有绑定就不回投，回复直接回给调用方。
    await withZhiliaState((s) => { markDone(s, msgId, reply) })
    await zhiliaoAdvanceLastSeq(chatKey, seq)
    return out
  } catch (error) {
    const mapped = zhiliaoErrorOf(error)
    try {
      await withZhiliaState((s) => { markFailed(s, msgId, mapped.detail || mapped.error) })
    } catch { /* 记账失败不影响回传 */ }
    return Object.assign({ ok: false, msgId, sessionId, dedupe: 'failed' }, mapped)
  } finally {
    clearTimeout(timer)
    abort.abort()
  }
}

/* ---------------------------------------------------------------------------
 * 智聊阶段 2：面板用路由（全部沿用 localRequestGuard 的本机来源防护）
 * ------------------------------------------------------------------------- */

/**
 * 从请求体解析 JSON 对象。
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {Promise<Object<string, any>|null>} 对象或 null
 */
async function zhiliaoReadJson(req) {
  try {
    const raw = await readRawBody(req, 2 * 1024 * 1024)
    const text = raw.toString('utf8').trim()
    if (text === '') return null
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * GET /zhiliao/status：状态概览（不回显任何密钥）。
 * @returns {Object<string, any>} 状态
 */
function handleZhiliaStatus() {
  const cfg = zhiliaoConfig()
  const zlState = loadZhiliaState(BASE_DIR)
  // 只读判定，避免 GET 顺带抢锁；写闸 zhiliaoMultiHostActive() 才会抢。
  const zhiliaoStatusOtherHost = zhiliaoOtherHostFromLock()
  const queue = zhiliaoQueue !== null ? zhiliaoQueue.stats() : {
    activeChatKeys: 0, queued: 0, inflight: 0,
    maxConcurrent: cfg.queue.maxConcurrent, perKeyLimit: cfg.queue.perKeyLimit, globalLimit: cfg.queue.globalLimit,
  }
  const recycle = zhiliaoRecycler !== null ? zhiliaoRecycler.stats() : {
    enabled: cfg.recycle.enabled, idleMinutes: cfg.recycle.idleMinutes, tracked: 0, handles: 0,
    recycled: 0, recycleSkipped: 0, lastSkipReason: '',
  }
  return {
    ok: true,
    enabled: cfg.enabled,
    bindingCount: listBindings(zlState).length,
    chatSessionCount: Object.keys(zlState.sessions).length,
    pendingCount: listPendingReplies(zlState).length,
    qaMode: cfg.testMode,
    /* 兼容阶段 2 的顶层字段；testMode 下仍视为「已配置」以免破坏老面板判断。 */
    webhookSecretConfigured: cfg.webhookSecretConfigured || cfg.testMode,
    security: {
      webhookSecretConfigured: cfg.webhookSecretConfigured,
      internalSecretConfigured: cfg.internalSecretConfigured,
      defaultSecretInUse: !cfg.webhookSecretConfigured || !cfg.internalSecretConfigured,
      warnings: cfg.productionWarnings,
    },
    bindings: {
      total: listBindings(zlState).length,
      expiredCount: listBindings(zlState).filter((b) => b.needsRebind === true || b.enabled === false).length,
    },
    queue: {
      activeChatKeys: queue.activeChatKeys,
      queued: queue.queued,
      inflight: queue.inflight,
      maxConcurrent: queue.maxConcurrent,
      perKeyLimit: queue.perKeyLimit,
      globalLimit: queue.globalLimit,
    },
    recycle: {
      enabled: recycle.enabled,
      idleMinutes: recycle.idleMinutes,
      recycled: recycle.recycled,
      recycleSkipped: recycle.recycleSkipped,
    },
    /* 账本缓存健康：dirty=true 表示内存有未落盘修改；lastError 非空表示上次落盘失败。
       QA 排查「账本条目消失」时，用它能一眼区分「没落盘」还是「被旧快照覆盖」。 */
    state: zhiliaStateDiagnostics(),
    /* 单实例检测：只读锁文件 + 动态探活，不抢锁；对方退出自动回落 false。 */
    ws: zhiliaoWsSummary(),
    /* 人设注入诊断：已注入会话数与每个会话的注入摘要，用于排查"人设没生效" */
    persona: {
      injectedCount: zhiliaoPersonaInjected.size,
      sessions: Array.from(zhiliaoPersonaBlocks.entries()).map(([sid, entry]) => ({
        sessionId: sid,
        bindingId: entry !== undefined && entry !== null ? entry.bindingId : '',
        revision: entry !== undefined && entry !== null ? entry.revision : '',
        chars: entry !== undefined && entry !== null && typeof entry.text === 'string' ? entry.text.length : 0,
        textHead: entry !== undefined && entry !== null && typeof entry.text === 'string' ? entry.text.slice(0, 80) : '',
      })),
    },
    multiHost: zhiliaoStatusOtherHost !== null,
    otherHost: zhiliaoStatusOtherHost,
    uptimeMs: Date.now() - zhiliaoBootAt,
  }
}

/**
 * GET /zhiliao/bindings：绑定列表（tokenRef 只回引用，绝不回明文）。
 * @returns {Object<string, any>} 列表
 */
function handleZhiliaBindings() {
  const zlState = loadZhiliaState(BASE_DIR)
  const bindings = listBindings(zlState).map((b) => Object.assign({}, b, {
    chatSessionCount: Object.keys(zlState.sessions).filter((key) => {
      const s = zlState.sessions[key]
      return s !== null && typeof s === 'object' && s.bindingId === b.bindingId
    }).length,
    workDir: zhiliaoWorkDirFor(b),
    workspaceId: zhiliaoWorkspaceIds.get(String(b.bindingId)) || '',
    ws: zhiliaoWsStatuses.get(String(b.bindingId)) || null,
  }))
  return {
    ok: true,
    bindings,
    expiredCount: bindings.filter((b) => b.needsRebind === true || b.enabled === false).length,
  }
}

/**
 * POST /zhiliao/binding：创建/更新绑定；token 写加密文件，state 只留 tokenRef。
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {Promise<{body: Object<string, any>, status: number}>} 响应
 */
/**
 * 把绑定注册到 HuLa 运行态 registry；失败必须让 UI 看到，不能静默成功。
 * @param {Object<string, any>} cfg zhiliaoConfig()
 * @param {Object<string, any>} binding 本地已保存的绑定
 * @returns {Promise<{ok: boolean, detail?: string}>} 注册结果
 */
async function zhiliaoRegisterBinding(cfg, binding) {
  const base = zhiliaoInternalBase(cfg)
  const delivered = await zhiliaoPostJson(
    base + '/zhiliao/internal/binding/register',
    { 'x-zhiliao-internal-secret': cfg.internalSecret },
    {
      bindingId: String(binding.bindingId),
      hulaUid: String(binding.hulaUid || ''),
      identityType: binding.identityType === 'bot' ? 'bot' : 'original-user',
      botUid: 0,
      enabled: binding.enabled !== false,
    },
  )
  const body = delivered !== null && delivered.body !== null && typeof delivered.body === 'object'
    ? delivered.body : null
  const code = body !== null ? Number(body.code) : Number(delivered !== null ? delivered.status : 0)
  const ok = delivered !== null && delivered.ok === true && body !== null
    && (body.success === true || code === 200)
  if (ok) return { ok: true }
  return {
    ok: false,
    detail: 'HTTP ' + String(delivered !== null ? delivered.status : 0) + ' '
      + String(JSON.stringify(body !== null ? body : '')).slice(0, 300),
  }
}

/**
 * 注销 HuLa 运行态 registry；解绑失败不阻断本地删除，只记 warning。
 * @param {Object<string, any>} cfg zhiliaoConfig()
 * @param {string} bindingId 绑定 id
 * @returns {Promise<{ok: boolean, detail?: string}>} 注销结果
 */
async function zhiliaoUnregisterBinding(cfg, bindingId) {
  const base = zhiliaoInternalBase(cfg)
  const delivered = await zhiliaoPostJson(
    base + '/zhiliao/internal/binding/unregister',
    { 'x-zhiliao-internal-secret': cfg.internalSecret },
    { bindingId: String(bindingId) },
  )
  const body = delivered !== null && delivered.body !== null && typeof delivered.body === 'object'
    ? delivered.body : null
  const code = body !== null ? Number(body.code) : Number(delivered !== null ? delivered.status : 0)
  const ok = delivered !== null && delivered.ok === true && body !== null
    && (body.success === true || code === 200)
  if (ok) return { ok: true }
  return {
    ok: false,
    detail: 'HTTP ' + String(delivered !== null ? delivered.status : 0) + ' '
      + String(JSON.stringify(body !== null ? body : '')).slice(0, 300),
  }
}

/**
 * 用一次成功登录的凭证持久化绑定并注册（保存绑定与 dry-run 自动保存共用）。
 * @param {Object<string, any>} payload 请求体
 * @param {{uid: string, token: string, refreshToken?: string, expiresAt?: number}} login 登录结果
 * @param {Object<string, any>} cfg zhiliaoConfig()
 * @returns {Promise<{ok: boolean, error?: string, detail?: string, status: number, binding?: Object}>} 结果
 */
async function zhiliaoPersistBinding(payload, login, cfg) {
  const account = typeof payload.account === 'string' ? payload.account.trim() : ''
  const rawScope = payload.scope !== null && typeof payload.scope === 'object' && !Array.isArray(payload.scope)
    ? payload.scope : {}
  const groups = Array.isArray(rawScope.groups)
    ? rawScope.groups.map((value) => String(value).trim()).filter((value) => value !== '').slice(0, 200)
    : []
  const fetchedName = await zhiliaoFetchDisplayName(cfg.replyBaseUrl, login.uid, login.token)
  const displayName = fetchedName !== '' ? fetchedName : account
  const bindingId = ZHILIAO_WORKSPACE_BINDING_ID
  const secretKey = 'zhiliao.' + bindingId + '.'
  let secretError = null
  const saved = await withZhiliaState((s) => {
    const old = findBindingById(s, bindingId)
    try {
      saveSecrets(BASE_DIR, {
        [secretKey + 'token']: login.token,
        [secretKey + 'refreshToken']: typeof login.refreshToken === 'string' ? login.refreshToken : '',
        [secretKey + 'tokenExpiresAt']: Number(login.expiresAt) > 0 ? String(login.expiresAt) : '',
      })
    } catch (error) {
      secretError = humanError(error)
      return null
    }
    const raw = {
      bindingId,
      hulaUid: String(login.uid),
      identityType: payload.identityType === 'bot' ? 'bot' : 'original-user',
      displayName,
      replyPrefix: typeof payload.replyPrefix === 'string' ? payload.replyPrefix.slice(0, 200) : '',
      autoReply: payload.autoReply !== false,
      requireConfirm: payload.requireConfirm === true,
      enabled: payload.enabled !== false,
      scope: { groups, mentionOnly: rawScope.mentionOnly !== false, dms: true },
      tokenRef: secretKey + 'token',
      tokenStatus: 'ok',
      paused: old !== null && old.paused === true,
    }
    if (old !== null) raw.createdAt = old.createdAt
    const result = saveBinding(s, raw)
    if (result !== null) result.tokenStatus = 'ok'
    return result
  })
  if (secretError !== null) return { ok: false, error: 'token-save-failed', detail: secretError, status: 500 }
  if (saved === null) return { ok: false, error: 'invalid-arg', detail: '绑定参数不合法', status: 400 }
  const registered = await zhiliaoRegisterBinding(cfg, saved)
  if (registered.ok !== true) {
    return { ok: false, error: 'register-failed', detail: registered.detail, status: 502, binding: saved }
  }
  return { ok: true, binding: saved, status: 200 }
}

async function handleZhiliaBindingSave(req) {
  const payload = await zhiliaoReadJson(req)
  if (payload === null) return { body: { ok: false, error: 'invalid-arg', detail: '请求体不是合法 JSON' }, status: 400 }
  const cfg = zhiliaoConfig()
  // 多绑定：payload.bindingId 指定编辑目标；未指定则稍后按 userId 复用或新建
  const requestedId = typeof payload.bindingId === 'string' ? payload.bindingId.trim() : ''
  let bindingId = requestedId
  let old = requestedId !== '' ? findBindingById(loadZhiliaState(BASE_DIR), requestedId) : null
  const baseUrl = String(payload.baseUrl || (old !== null ? old.baseUrl : '') || cfg.replyBaseUrl || '').trim().replace(/\/+$/, '')
  if (baseUrl === '') return { body: { ok: false, error: 'invalid-arg', detail: '请先填写 zhiliao-server 地址' }, status: 400 }
  const suppliedKey = typeof payload.apiKey === 'string' ? payload.apiKey.trim() : ''
  const apiKey = suppliedKey !== '' ? suppliedKey : (old !== null ? zhiliaoReadApiKey(old) : '')
  if (apiKey === '') return { body: { ok: false, error: 'invalid-arg', detail: '请填写 API Key' }, status: 400 }
  const me = await zhiliaoOpenMe(baseUrl, apiKey)
  if (me.ok !== true) {
    return { body: { ok: false, error: 'api-key-invalid', detail: 'API Key 校验失败：' + String(me.detail || '') }, status: 502 }
  }
  const identity = me.body !== null && typeof me.body === 'object' ? me.body : {}
  const userId = String(identity.userId || '').trim()
  const aiId = String(identity.aiId || '').trim()
  if (userId === '') return { body: { ok: false, error: 'api-key-invalid', detail: '服务端未返回 userId' }, status: 502 }
  if (bindingId === '') {
    // 同一用户重复绑定时复用原绑定，避免出现两条指向同一身份的连接
    const existing = findBindingByUserId(loadZhiliaState(BASE_DIR), userId)
    if (existing !== null) {
      bindingId = String(existing.bindingId)
      old = existing
    } else {
      bindingId = 'zl_' + userId
    }
  }
  const rawScope = payload.scope !== null && typeof payload.scope === 'object' && !Array.isArray(payload.scope) ? payload.scope : {}
  const groups = Array.isArray(rawScope.groups)
    ? rawScope.groups.map((value) => String(value).trim()).filter((value) => value !== '').slice(0, 200)
    : []
  const secretKey = zhiliaoApiKeySecretKey(bindingId)
  let secretError = null
  const saved = await withZhiliaState((s) => {
    try {
      saveSecrets(BASE_DIR, { [secretKey]: apiKey })
    } catch (error) {
      secretError = humanError(error)
      return null
    }
    const next = {
      bindingId,
      baseUrl,
      apiKeyRef: secretKey,
      aiId,
      userId,
      displayName: String(identity.name || userId).trim().slice(0, 80),
      takeoverDefault: identity.takeoverDefault === true,
      replyPrefix: typeof payload.replyPrefix === 'string' ? payload.replyPrefix.slice(0, 200) : (old !== null ? old.replyPrefix : ''),
      autoReply: Object.prototype.hasOwnProperty.call(payload, 'autoReply') ? payload.autoReply !== false : (old !== null ? old.autoReply : true),
      requireConfirm: Object.prototype.hasOwnProperty.call(payload, 'requireConfirm') ? payload.requireConfirm === true : (old !== null ? old.requireConfirm : false),
      enabled: Object.prototype.hasOwnProperty.call(payload, 'enabled') ? payload.enabled !== false : (old !== null ? old.enabled : true),
      scope: {
        groups: Array.isArray(rawScope.groups) ? groups : (old !== null ? old.scope.groups : []),
        mentionOnly: Object.prototype.hasOwnProperty.call(rawScope, 'mentionOnly') ? rawScope.mentionOnly !== false : (old !== null ? old.scope.mentionOnly : true),
        dms: old !== null ? old.scope.dms !== false : true,
      },
      createdAt: old !== null && Number(old.createdAt) > 0 ? Number(old.createdAt) : Date.now(),
    }
    return saveBinding(s, next)
  })
  if (secretError !== null) return { body: { ok: false, error: 'api-key-save-failed', detail: secretError }, status: 500 }
  if (saved === null) return { body: { ok: false, error: 'invalid-arg', detail: '绑定参数不合法' }, status: 400 }
  try { zhiliaoWsRestartOne(saved) } catch { /* WS 连接失败不阻断本地保存 */ }
  // 写入时把 requireConfirm 同步为服务端接管模式（HALF/FULL），失败不阻断保存
  const takeoverSynced = 0  // 不再由插件反向写接管模式，避免覆盖用户在前端设的 NONE
  return {
    body: {
      ok: true,
      binding: saved,
      identity: { userId, aiId, name: String(identity.name || ''), takeoverDefault: identity.takeoverDefault === true },
      takeoverSynced,
    },
    status: 200,
  }
}

/**
 * DELETE /zhiliao/binding?id=...：删除绑定；关联会话标 archived 保留历史。
 * @param {string} bindingId 绑定 id
 * @returns {Promise<{body: Object<string, any>, status: number}>} 响应
 */
async function handleZhiliaBindingDelete(bindingId) {
  zhiliaoWorkDirCache.delete(String(bindingId || ''))
  const removed = await withZhiliaState((s) => removeBinding(s, bindingId) === true)
  if (removed !== true) {
    return { body: { ok: false, error: 'not-found', detail: '绑定不存在' }, status: 404 }
  }
  try {
    saveSecrets(BASE_DIR, { [zhiliaoApiKeySecretKey(bindingId)]: '' })
  } catch { /* 凭证清理失败不阻断解绑 */ }
  try { zhiliaoWsRestart() } catch { /* 主动断开失败不阻断 */ }
  return { body: { ok: true, bindingId }, status: 200 }
}

/**
 * GET /zhiliao/pending：待发草稿列表。
 * @returns {Object<string, any>} 列表
 */
/**
 * 按 account 查测试目标（服务端内部端点，使用 internal secret，token 不下发）。
 * @param {string} base HuLa 网关
 * @param {'user'|'group'} kind 目标类型
 * @param {string} account 账号
 * @param {string} internalSecret 内部共享密钥
 * @returns {Promise<{ok: boolean, notFound?: boolean, uid?: string, roomId?: number, account?: string, name?: string, detail?: string}>} 结果
 */
async function zhiliaoLookupTargetByAccount(base, kind, account, internalSecret) {
  const label = kind === 'group' ? 'group' : 'user'
  const delivered = await zhiliaoGetJson(
    base + '/zhiliao/internal/' + label + '/by-account?account=' + encodeURIComponent(account),
    { 'x-zhiliao-internal-secret': internalSecret },
  )
  const body = delivered !== null && delivered.body !== null && typeof delivered.body === 'object'
    ? delivered.body : null
  const code = body !== null ? Number(body.code) : Number(delivered !== null ? delivered.status : 0)
  /* 线上契约：业务字段在 R 信封的 data 里；data.ok 才是目标是否命中，不能拿外层 success 当命中。 */
  const data = body !== null && body.data !== null && typeof body.data === 'object' ? body.data : null
  const targetOk = data !== null ? data.ok === true : (body !== null && body.ok === true)
  const targetError = data !== null && typeof data.error === 'string'
    ? data.error : (body !== null && typeof body.error === 'string' ? body.error : '')
  if (delivered === null || delivered.ok !== true || body === null || targetOk !== true) {
    const notFound = Number(delivered !== null ? delivered.status : 0) === 404
      || targetError === 'not-found' || code === 404
    return {
      ok: false,
      notFound,
      invalidAccount: targetError === 'invalid-account',
      detail: 'HTTP ' + String(delivered !== null ? delivered.status : 0) + ' '
        + String(JSON.stringify(body !== null ? body : '')).slice(0, 300),
    }
  }
  const uidRaw = data !== null && data.uid !== undefined ? data.uid : (body.uid !== undefined ? body.uid : null)
  const roomRaw = data !== null && data.roomId !== undefined ? data.roomId : (body.roomId !== undefined ? body.roomId : null)
  return {
    ok: true,
    uid: uidRaw !== undefined && uidRaw !== null ? String(uidRaw) : '',
    roomId: zhiliaoLong(roomRaw),
    account: String(data !== null && data.account !== undefined ? data.account
      : (body.account !== undefined ? body.account : account)),
    name: String(data !== null && data.name !== undefined ? data.name
      : (body.name !== undefined ? body.name : '')),
  }
}

/**
 * 查与指定 uid 的单聊 roomId（沿用原 contact/detail/friend 契约）。
 * @param {string} base HuLa 网关
 * @param {string} token 用户 access token
 * @param {string} uid 对方 uid
 * @returns {Promise<{ok: boolean, roomId?: number, detail?: string}>} 结果
 */
async function zhiliaoResolveFriendRoomId(base, token, uid) {
  const detail = await zhiliaoGetJson(
    base + '/api/im/chat/contact/detail/friend?id=' + encodeURIComponent(uid) + '&roomType=2',
    { Token: token },
  )
  const body = detail !== null && detail.body !== null && typeof detail.body === 'object' ? detail.body : null
  const code = body !== null ? Number(body.code) : Number(detail !== null ? detail.status : 0)
  if (detail.ok !== true || body === null || !(body.success === true || code === 200)) {
    return {
      ok: false,
      detail: 'HTTP ' + String(detail !== null ? detail.status : 0) + ' '
        + String(JSON.stringify(body !== null ? body : '')).slice(0, 300),
    }
  }
  const roomId = zhiliaoLong(body.data !== null && typeof body.data === 'object' ? body.data.roomId : null)
  if (roomId === null) return { ok: false, detail: '测试会话 roomId 非法' }
  return { ok: true, roomId }
}

/**
 * POST /zhiliao/binding/test：绑定测试。支持 account 指定用户/群，也兼容旧 uid。
 * 不跑 LLM、不写 dedupe；用户走单聊 roomId，群直接用 group/by-account 返回的 roomId。
 * @returns {Promise<{body: Object<string, any>, status: number}>} 响应
 */
async function handleZhiliaBindingTest(payload) {
  const cfg = zhiliaoConfig()
  const requestBody = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  const binding = zhiliaoResolveBinding(requestBody)
  const baseUrl = String(requestBody.baseUrl || (binding !== null ? binding.baseUrl : '') || cfg.replyBaseUrl || '').trim().replace(/\/+$/, '')
  const apiKey = String(requestBody.apiKey || (binding !== null ? zhiliaoReadApiKey(binding) : '') || '').trim()
  if (baseUrl === '' || apiKey === '') {
    return { body: { ok: false, error: 'invalid-arg', detail: '请先填写 zhiliao-server 地址和 API Key' }, status: 400 }
  }
  const me = await zhiliaoOpenMe(baseUrl, apiKey)
  if (me.ok !== true) return { body: { ok: false, error: 'api-key-invalid', detail: 'API Key 校验失败' }, status: 502 }
  const selfId = String(me.body.userId || '').trim()
  const aiId = String(me.body.aiId || '').trim()
  if (selfId === '') return { body: { ok: false, error: 'api-key-invalid', detail: '服务端未返回 userId' }, status: 502 }
  const target = String(requestBody.testTarget || requestBody.bindingTestTarget || '').trim()
  if (target === '') return { body: { ok: false, error: 'invalid-arg', detail: '请输入测试目标（用户账号/手机号/邮箱，或群 g:<groupId>）' }, status: 400 }
  let targetType = ''
  let targetId = ''
  let targetName = ''
  let convKey = ''
  const match = /^([ug]):(.+)$/.exec(target)
  if (match !== null) {
    // 显式前缀：u:<userId> / g:<groupId>
    targetType = match[1] === 'g' ? 'group' : 'user'
    targetId = match[2].trim()
    if (targetId === '') return { body: { ok: false, error: 'invalid-arg', detail: '测试目标不能为空' }, status: 400 }
    if (targetType === 'user' && targetId === selfId) {
      return { body: { ok: false, error: 'invalid-arg', detail: '测试目标不能是自己' }, status: 400 }
    }
    const lookup = await zhiliaoOpenLookup(baseUrl, apiKey, targetType, targetId)
    if (lookup.ok !== true) {
      return { body: { ok: false, error: 'target-not-found', detail: lookup.detail !== '' ? lookup.detail : (targetType + ' 不存在：' + targetId) }, status: 404 }
    }
    const looked = lookup.body !== null && typeof lookup.body === 'object' ? lookup.body : {}
    targetName = String(looked.name || looked.nickname || targetId)
    convKey = targetType === 'group' ? 'g_' + targetId : 's_' + [selfId, targetId].sort().join('_')
  } else {
    // 无前缀：按账号 / 手机号 / 邮箱解析（服务端先查用户，再查 AI 好友账号）
    const acc = await zhiliaoOpenLookupAccount(baseUrl, apiKey, target)
    if (acc.ok !== true) {
      return {
        body: {
          ok: false, error: 'target-not-found',
          detail: acc.detail !== '' ? acc.detail
            : ('未找到该用户或 AI 好友：' + target + '（用户可填账号/手机号/邮箱，AI 好友只能填账号）'),
        },
        status: 404,
      }
    }
    if (acc.body.userId !== undefined) {
      targetType = 'user'
      targetId = String(acc.body.userId)
    } else {
      targetType = 'ai'
      targetId = String(acc.body.aiId)
    }
    targetName = String(acc.body.name || acc.body.nickname || targetId)
    convKey = String(acc.body.convKey || ('s_' + [selfId, targetId].sort().join('_')))
  }
  const msgId = 'bindtest-' + Date.now()
  const delivered = await zhiliaoOpenSend(baseUrl, apiKey, {
    convKey,
    text: '智聊绑定测试',
    requestId: msgId,
    as: aiId !== '' ? 'ai' : 'user',
    atUidList: targetType === 'group' && Array.isArray(requestBody.atUidList) ? requestBody.atUidList : [],
  })
  if (delivered.ok !== true || delivered.body === null || typeof delivered.body !== 'object' || delivered.body.error !== undefined) {
    return {
      body: {
        ok: false, error: 'test-failed',
        detail: '测试消息发送失败：HTTP ' + String(delivered.status) + ' '
          + String(JSON.stringify(delivered.body !== null ? delivered.body : '')).slice(0, 300),
      },
      status: 502,
    }
  }
  const sentData = delivered.body !== null && typeof delivered.body === 'object' ? delivered.body : {}
  // 账本里该会话已有的宿主会话 ID：打开会话时优先复用，避免新建空会话
  let existingSessionId = ''
  try {
    const zlState = loadZhiliaState(BASE_DIR)
    const known = findChatSession(zlState, convKey)
    if (known !== null) existingSessionId = String(known.dshSessionId || '')
  } catch { /* 读账本失败不影响测试 */ }
  return {
    body: {
      ok: true, msgId, seq: sentData.seq === undefined ? '' : sentData.seq, convKey, targetType, targetId,
      existingSessionId,
      as: aiId !== '' ? 'ai' : 'user',
      targetAccount: targetId,
      targetName: targetName !== '' ? targetName : targetId,
      selfName: String(me.body.name || ''),
      convKeyDesc: targetType === 'group'
        ? '与群「' + (targetName || targetId) + '」的群聊'
        : '你与「' + (targetName || targetId) + '」的一对一私聊',
    },
    status: 200,
  }
}

/** 兼容宿主 create 返回的多种形态：string / {sessionId} / {value:{sessionId}}。 */
function zhiliaoCreatedId(result) {
  if (typeof result === 'string') return result.trim()
  if (result === null || typeof result !== 'object') return ''
  let id = String(result.sessionId || result.id || '')
  if (id === '' && result.value !== null && typeof result.value === 'object') {
    id = String(result.value.sessionId || result.value.id || '')
  }
  return id.trim()
}

/**
 * POST /zhiliao/session/ensure：自愈式确保该聊天对象在 DSH 有一个可见会话。
 * 无论工作区被删除、会话被归档/删除，都重建并返回可用的会话 id + workspaceId。
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {Promise<{body: Object<string, any>, status: number}>} 响应
 */
async function handleZhiliaSessionEnsure(payload) {
  const body = payload !== null && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  const chatKey = String(body.chatKey || '').trim()
  if (!ZHILIAO_CHAT_KEY_RE.test(chatKey)) {
    return { body: { ok: false, error: 'invalid-arg', detail: 'chatKey 格式非法' }, status: 400 }
  }
  const binding = zhiliaoResolveBinding(body)
  if (binding === null) return { body: { ok: false, error: 'not-bound', detail: '尚未绑定' }, status: 400 }

  // ① 强制确保工作区存在（删除后会幂等重建）
  const workspaceId = await zhiliaoEnsureWorkspaceLive(binding)

  // ② 查账本会话，判断是否还可见
  let sessionId = ''
  try {
    const known = findChatSession(loadZhiliaState(BASE_DIR), chatKey)
    if (known !== null) sessionId = String(known.dshSessionId || '')
  } catch { /* ignore */ }
  let reused = false
  if (sessionId !== '') {
    reused = await zhiliaoSessionVisible(sessionId)
    if (!reused) sessionId = ''
  }

  // ③ 不可见 → 新建会话（带 workspaceId）并绑定账本
  if (sessionId === '') {
    const sc = hostService('sessionController')
    if (sc === null || typeof sc.create !== 'function') {
      return { body: { ok: false, error: 'host-unavailable', detail: '宿主未提供 sessionController' }, status: 503 }
    }
    try {
      const opts = workspaceId !== '' ? { workspaceId } : { cwd: zhiliaoWorkDirFor(binding) }
      const created = await sc.create(opts)
      sessionId = zhiliaoCreatedId(created)
    } catch (error) {
      return { body: { ok: false, error: 'session-create-failed', detail: String((error && error.message) || error) }, status: 500 }
    }
    if (sessionId === '') {
      return { body: { ok: false, error: 'session-create-failed', detail: '宿主未返回会话 id' }, status: 500 }
    }
    await withZhiliaState((st) => {
      const sess = getOrCreateChatSession(st, chatKey, binding.bindingId, zhiliaoWorkDirFor(binding))
      sess.dshSessionId = sessionId
      if (workspaceId !== '') sess.workspaceId = workspaceId
      sess.lastActiveAt = Date.now()
    })
  }

  // ④ 会话标题：对方名称（前端无法可靠 rename，这里尽力为之）
  const title = String(body.title || '').trim()
  if (title !== '') {
    const sc = hostService('sessionController')
    if (sc !== null && typeof sc.rename === 'function') {
      try { await sc.rename({ sessionId, title }) } catch { /* 标题失败不影响 */ }
    }
  }

  return {
    body: { ok: true, sessionId, workspaceId, reused, chatKey },
    status: 200,
  }
}

/**
 * POST /zhiliao/chat-session/bind：把宿主新建的会话 id 绑定到 chatKey。
 * 冻结的 updateChatSession 白名单不含 dshSessionId，所以在写锁内直接改内存对象。
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {Promise<{body: Object<string, any>, status: number}>} 响应
 */
async function handleZhiliaChatSessionBind(req) {
  const payload = await zhiliaoReadJson(req)
  if (payload === null) return { body: { ok: false, error: 'invalid-arg', detail: '请求体不是合法 JSON' }, status: 400 }
  const chatKey = typeof payload.chatKey === 'string' ? payload.chatKey.trim() : ''
  const dshSessionId = typeof payload.dshSessionId === 'string' ? payload.dshSessionId.trim() : ''
  if (!ZHILIAO_CHAT_KEY_RE.test(chatKey) || !ZHILIAO_ID_RE.test(dshSessionId)) {
    return { body: { ok: false, error: 'invalid-arg', detail: 'chatKey / dshSessionId 格式非法' }, status: 400 }
  }
  const binding = zhiliaoResolveBinding(payload)
  if (binding === null) {
    return { body: { ok: false, error: 'not-bound', detail: '当前工作空间尚未绑定' }, status: 400 }
  }
  const saved = await withZhiliaState((s) => {
    const session = zhiliaoEnsureSession(s, chatKey, binding)
    session.dshSessionId = dshSessionId
    session.lastActiveAt = Date.now()
    return session
  })
  return { body: { ok: true, chatKey, dshSessionId: saved.dshSessionId }, status: 200 }
}

function handleZhiliaPending() {
  const zlState = loadZhiliaState(BASE_DIR)
  return { ok: true, pending: listPendingReplies(zlState) }
}

/**
 * POST /zhiliao/pending/send | /zhiliao/pending/discard：消费一条待发草稿。
 * @param {string} action 'send' | 'discard'
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {Promise<{body: Object<string, any>, status: number}>} 响应
 */
async function handleZhiliaPendingAction(action, req) {
  const payload = await zhiliaoReadJson(req)
  const msgId = payload !== null && typeof payload.msgId === 'string' ? payload.msgId.trim() : ''
  if (msgId === '') return { body: { ok: false, error: 'invalid-arg', detail: 'msgId 缺失' }, status: 400 }
  // 读草稿 + 绑定信息在锁内取快照；真正的网络投递放到锁外，避免把并发串行化。
  const snapshot = await withZhiliaState((s) => {
    const draft = findPendingReply(s, msgId)
    return { draft, binding: draft !== null ? findBindingById(s, draft.bindingId) : null }
  })
  const draft = snapshot.draft
  if (draft === null) return { body: { ok: false, error: 'not-found', detail: '草稿不存在' }, status: 404 }
  if (action === 'discard') {
    await withZhiliaState((s) => { removePendingReply(s, msgId) })
    return { body: { ok: true, msgId, discarded: true }, status: 200 }
  }
  const binding = snapshot.binding
  if (binding === null) return { body: { ok: false, error: 'not-bound', detail: '绑定不存在' }, status: 404 }
  const cfg = zhiliaoConfig()
  const base = zhiliaoOpenBase(binding, cfg)
  const apiKey = zhiliaoReadApiKey(binding)
  const convKey = String(draft.convKey || draft.chatKey || '')
  if (base === '' || apiKey === '') return { body: { ok: false, error: 'delivery-failed', detail: '绑定缺少地址或 API Key' }, status: 400 }
  if (!/^[sg]_/.test(convKey)) return { body: { ok: false, error: 'delivery-failed', detail: '草稿 convKey 非法' }, status: 400 }
  const delivered = await zhiliaoOpenSend(base, apiKey, {
    convKey,
    text: String(draft.text || ''),
    requestId: msgId,
    as: binding.aiId !== '' ? 'ai' : 'user',
    atUidList: Array.isArray(draft.atUidList) ? draft.atUidList : [],
  })
  const deliveredBody = delivered.body !== null && typeof delivered.body === 'object' ? delivered.body : null
  if (delivered.ok !== true || deliveredBody === null || deliveredBody.error !== undefined) {
    return {
      body: {
        ok: false, error: 'delivery-failed',
        detail: 'HTTP ' + String(delivered.status) + ' '
          + String(JSON.stringify(delivered.body !== null ? delivered.body : null)).slice(0, 300),
      },
      status: 502,
    }
  }
  await withZhiliaState((s) => { removePendingReply(s, msgId) })
  return { body: { ok: true, msgId, delivered: true, delivery: delivered.body }, status: 200 }
}

/**
 * GET /zhiliao/settings：只读配置（密钥只回「是否已配置」，不回明文）。
 * 多实例写入闸生效时仍可读，方便面板/排障确认当前配置。
 * @returns {Object<string, any>} 配置
 */
function handleZhiliaSettingsRead() {
  const cfg = zhiliaoConfig()
  return {
    ok: true,
    settings: {
      enabled: cfg.enabled,
      testMode: cfg.testMode,
      replyBaseUrl: cfg.replyBaseUrl,
      bindingTestAccount: cfg.bindingTestAccount,
      bindingTestUid: cfg.bindingTestUid,
      internalBaseUrl: cfg.internalBaseUrl,
      /* 只读暴露给前端：宿主建会话必须传同一 cwd，否则 inbound 会被宿主拒绝。 */
      zhiliaoWorkDir: ZHILIAO_WORK_DIR,
      webhookSecretConfigured: cfg.webhookSecretConfigured || cfg.testMode,
      internalSecretConfigured: cfg.internalSecretConfigured,
      queue: cfg.queue,
      recycle: cfg.recycle,
    },
  }
}

/**
 * POST /zhiliao/settings：保存面板配置（webhookSecret / testMode / replyBaseUrl / enabled）。
 * @param {import('node:http').IncomingMessage} req 请求对象
 * @returns {Promise<{body: Object<string, any>, status: number}>} 响应
 */
async function handleZhiliaSettingsSave(req) {
  const payload = await zhiliaoReadJson(req)
  if (payload === null) return { body: { ok: false, error: 'invalid-arg', detail: '请求体不是合法 JSON' }, status: 400 }
  const cfg = state.settings.zhiliao
  if (Object.prototype.hasOwnProperty.call(payload, 'webhookSecret')) {
    cfg.webhookSecret = typeof payload.webhookSecret === 'string' ? payload.webhookSecret.trim().slice(0, 200) : ''
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'testMode')) cfg.testMode = payload.testMode === true
  if (Object.prototype.hasOwnProperty.call(payload, 'enabled')) cfg.enabled = payload.enabled !== false
  if (Object.prototype.hasOwnProperty.call(payload, 'replyBaseUrl')) {
    const base = typeof payload.replyBaseUrl === 'string' ? payload.replyBaseUrl.trim().replace(/\/+$/, '') : ''
    if (base !== '') {
      try {
        const parsed = new URL(base)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('协议不支持')
      } catch {
        return { body: { ok: false, error: 'invalid-arg', detail: 'zhiliao-server 地址需为 http(s):// 形式' }, status: 400 }
      }
    }
    cfg.replyBaseUrl = base
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'bindingTestAccount')) {
    cfg.bindingTestAccount = String(payload.bindingTestAccount || '').trim().slice(0, 120)
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'bindingTestUid')) {
    cfg.bindingTestUid = String(payload.bindingTestUid || '').trim().slice(0, 64) || ZHILIAO_TEST_UID_DEFAULT
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'internalSecret')) {
    cfg.internalSecret = typeof payload.internalSecret === 'string' ? payload.internalSecret.trim().slice(0, 200) : ''
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'internalBaseUrl')) {
    const internalBase = typeof payload.internalBaseUrl === 'string'
      ? payload.internalBaseUrl.trim().replace(/\/+$/, '').slice(0, 300) : ''
    if (internalBase !== '') {
      try {
        const parsed = new URL(internalBase)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('协议不支持')
      } catch {
        return { body: { ok: false, error: 'invalid-arg', detail: 'IM 直连地址需为 http(s):// 形式' }, status: 400 }
      }
    }
    cfg.internalBaseUrl = internalBase
  }
  if (payload.queue !== null && typeof payload.queue === 'object' && !Array.isArray(payload.queue)) {
    const clampInt = (value, min, max, fallback) => {
      const n = Number(value)
      if (!Number.isFinite(n)) return fallback
      return Math.min(max, Math.max(min, Math.floor(n)))
    }
    cfg.queue.maxConcurrent = clampInt(payload.queue.maxConcurrent, 1, 256, cfg.queue.maxConcurrent)
    cfg.queue.perKeyLimit = clampInt(payload.queue.perKeyLimit, 1, 10000, cfg.queue.perKeyLimit)
    cfg.queue.globalLimit = clampInt(payload.queue.globalLimit, 1, 100000, cfg.queue.globalLimit)
  }
  if (payload.recycle !== null && typeof payload.recycle === 'object' && !Array.isArray(payload.recycle)) {
    if (Object.prototype.hasOwnProperty.call(payload.recycle, 'enabled')) cfg.recycle.enabled = payload.recycle.enabled === true
    const minutes = Number(payload.recycle.idleMinutes)
    if (Number.isFinite(minutes)) cfg.recycle.idleMinutes = Math.min(1440, Math.max(1, Math.floor(minutes)))
  }
  persistState()
  // 配置可能改了并发上限 / 回收开关：同步到运行中的单例。
  if (zhiliaoQueue !== null) ensureZhiliaoQueue()
  if (zhiliaoRecycler !== null) {
    zhiliaoRecycler.enabled = cfg.recycle.enabled === true
    zhiliaoRecycler.idleMinutes = cfg.recycle.idleMinutes
  }
  try { zhiliaoWsRestart() } catch { /* WS 重连失败不阻止保存 */ }
  /* 与 GET /zhiliao/settings 共用脱敏投影：只回配置态，绝不回密钥明文。 */
  return {
    body: {
      ok: true,
      settings: handleZhiliaSettingsRead().settings,
      queue: zhiliaoQueue !== null ? zhiliaoQueue.stats() : null,
      recycle: zhiliaoRecycler !== null ? zhiliaoRecycler.stats() : null,
    },
    status: 200,
  }
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
    // 智聊：独立路由簇，放在通用 /khub/* 分支之前，沿用上面的本机来源防护。
    if (route === '/zhiliao/inbound-legacy') {
      if (method !== 'POST') {
        send(res, { ok: false, error: '仅支持 POST' }, 405)
        return
      }
      // 多实例写入闸：不入队、不写账本、不跑 agent；503 让 HuLa 退避重试。
      if (zhiliaoMultiHostActive()) { zhiliaoSendMultiHostRejection(res); return }
      const out = await handleZhiliaInbound(req)
      const status = Number.isFinite(Number(out.status)) ? Number(out.status) : (out.ok === true ? 200 : 400)
      send(res, out, status)
      return
    }
    if (route === '/zhiliao/status') {
      if (method !== 'GET') { send(res, { ok: false, error: '仅支持 GET' }, 405); return }
      send(res, handleZhiliaStatus())
      return
    }
    if (route === '/zhiliao/bindings') {
      if (method !== 'GET') { send(res, { ok: false, error: '仅支持 GET' }, 405); return }
      send(res, handleZhiliaBindings())
      return
    }
    if (route === '/zhiliao/binding/test') {
      if (method !== 'POST') { send(res, { ok: false, error: '仅支持 POST' }, 405); return }
      if (zhiliaoMultiHostActive()) { zhiliaoSendMultiHostRejection(res); return }
      const testPayload = await zhiliaoReadJson(req)
      const out = await handleZhiliaBindingTest(testPayload)
      send(res, out.body, out.status)
      return
    }
    if (route === '/zhiliao/session/ensure') {
      if (method !== 'POST') { send(res, { ok: false, error: '仅支持 POST' }, 405); return }
      if (zhiliaoMultiHostActive()) { zhiliaoSendMultiHostRejection(res); return }
      const ensurePayload = await zhiliaoReadJson(req)
      const out = await handleZhiliaSessionEnsure(ensurePayload)
      send(res, out.body, out.status)
      return
    }
    if (route === '/zhiliao/chat-session/bind') {
      if (method !== 'POST') { send(res, { ok: false, error: '仅支持 POST' }, 405); return }
      if (zhiliaoMultiHostActive()) { zhiliaoSendMultiHostRejection(res); return }
      const out = await handleZhiliaChatSessionBind(req)
      send(res, out.body, out.status)
      return
    }
    if (route === '/zhiliao/binding') {
      if (method === 'POST' || method === 'DELETE') {
        if (zhiliaoMultiHostActive()) { zhiliaoSendMultiHostRejection(res); return }
        if (method === 'POST') {
          const out = await handleZhiliaBindingSave(req)
          send(res, out.body, out.status)
          return
        }
        const out = await handleZhiliaBindingDelete(query.get('id') || '')
        send(res, out.body, out.status)
        return
      }
      send(res, { ok: false, error: '仅支持 POST / DELETE' }, 405)
      return
    }
    if (route === '/zhiliao/pending') {
      if (method !== 'GET') { send(res, { ok: false, error: '仅支持 GET' }, 405); return }
      send(res, handleZhiliaPending())
      return
    }
    if (route === '/zhiliao/pending/send' || route === '/zhiliao/pending/discard') {
      if (method !== 'POST') { send(res, { ok: false, error: '仅支持 POST' }, 405); return }
      if (zhiliaoMultiHostActive()) { zhiliaoSendMultiHostRejection(res); return }
      const out = await handleZhiliaPendingAction(
        route === '/zhiliao/pending/send' ? 'send' : 'discard', req)
      send(res, out.body, out.status)
      return
    }
    if (route === '/zhiliao/settings') {
      if (method === 'GET') {
        send(res, handleZhiliaSettingsRead())
        return
      }
      if (method !== 'POST') { send(res, { ok: false, error: '仅支持 GET / POST' }, 405); return }
      if (zhiliaoMultiHostActive()) { zhiliaoSendMultiHostRejection(res); return }
      const out = await handleZhiliaSettingsSave(req)
      send(res, out.body, out.status)
      return
    }
    if (route === '/status') {
      send(res, handleStatus())
      return
    }
    if (route === '/meta') {
      send(res, handleMeta())
      return
    }
    if (route === '/intro/ack') {
      if (method !== 'POST') {
        send(res, { ok: false, error: '仅支持 POST' }, 405)
        return
      }
      const introResult = await handleIntroAck(req)
      send(res, introResult.body, introResult.status)
      return
    }
    if (route === '/update/check') {
      const checkResult = await handleUpdateCheck(query)
      send(res, checkResult.body, checkResult.status)
      return
    }
    if (route === '/update/apply') {
      if (method !== 'POST') {
        send(res, { ok: false, error: '仅支持 POST' }, 405)
        return
      }
      const applyResult = await handleUpdateApply(req)
      send(res, applyResult.body, applyResult.status)
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
    if (route === '/resource/status') {
      send(res, handleResourceStatus(String(query.get('type') || ''), String(query.get('id') || '')))
      return
    }
    if (route === '/resource/update' || route === '/resource/delete') {
      if (method !== 'POST') { send(res, { ok: false, error: '仅支持 POST' }, 405); return }
      const out = route === '/resource/update' ? await handleResourceUpdate(req) : await handleResourceDelete(req)
      send(res, out)
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
    if (route === '/skill-icon') {
      handleSkillIcon(res, query)
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
    if (route === '/settings/probe') {
      if (method !== 'GET') { send(res, { ok: false, error: '仅支持 GET' }, 405); return }
      send(res, await handleSettingsProbe(query))
      return
    }
    if (route === '/settings/branches') {
      if (method !== 'GET') {
        send(res, { ok: false, error: '仅支持 GET' }, 405)
        return
      }
      send(res, await handleSettingsBranches(query))
      return
    }
    /* 在线资料库配置：GET 回显（不含密钥），POST 保存（密钥进加密文件）。 */
    if (route === '/khub/settings') {
      if (method === 'GET') { send(res, handleKhubSettingsGet()); return }
      if (method === 'POST') {
        const out = await handleKhubSettingsSave(req)
        send(res, out.body, out.status)
        return
      }
      send(res, { ok: false, error: '仅支持 GET / POST' }, 405)
      return
    }
    /* 资料库里的 HTML 预览与原始文件代理：返回 HTML / 二进制，不走 JSON 分发。 */
    if (route === '/khub/html') {
      if (method !== 'GET') { send(res, { ok: false, error: '仅支持 GET' }, 405); return }
      try {
        await handleKhubHtml(res, query, khubRuntime().config)
      } catch (error) {
        if (!res.writableEnded) {
          send(res, { ok: false, error: String((error && error.message) || error), code: String((error && error.code) || '') }, 502)
        }
      }
      return
    }
    if (route === '/khub/raw') {
      if (method !== 'GET') { send(res, { ok: false, error: '仅支持 GET' }, 405); return }
      try {
        await handleKhubRaw(res, query, khubRuntime().config)
      } catch (error) {
        if (!res.writableEnded) {
          const status = error !== null && typeof error === 'object' && Number(error.status) > 0 ? Number(error.status) : 502
          res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end(String((error && error.message) || error))
        }
      }
      return
    }
    /* Office 版式级预览 / 编辑：返回插件自身同源的薄 HTML（服务端带 PAT 代取 OnlyOffice config），
       不走 JSON 分发；必须放在通用 /khub/ 分支之前，否则会被当成数据端点。
       query 是 URLSearchParams，id / mode(view|edit) 都从这里透传；mode 只认 view/edit，
       其余一律按 view（handler 内部再做一次兜底）。edit 有 canWrite 权限门槛。 */
    if (route === '/khub/office/frame') {
      if (method !== 'GET') { send(res, { ok: false, error: '仅支持 GET' }, 405); return }
      try {
        const frameMode = query.get('mode') === 'edit' ? 'edit' : 'view'
        await handleKhubOfficeFrame(res, query, khubRuntime().config, frameMode)
      } catch (error) {
        if (!res.writableEnded) {
          send(res, { ok: false, error: String((error && error.message) || error), code: String((error && error.code) || '') }, 502)
        }
      }
      return
    }
    if (route.indexOf('/khub/') === 0) {
      const runtime = khubRuntime()
      let body = {}
      if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
        try {
          const raw = await readRawBody(req, 4 * 1024 * 1024)
          const text = raw.toString('utf8').trim()
          if (text !== '') body = JSON.parse(text)
        } catch {
          send(res, { ok: false, error: '请求体不是合法 JSON' }, 400)
          return
        }
      }
      const out = await handleKhubApi(route, method, query, body, runtime.config)
      send(res, out.body, out.status)
      return
    }
    if (route === '/workbench/settings') {
      if (method === 'GET') { send(res, handleWorkbenchSettingsGet()); return }
      if (method === 'POST') {
        const out = await handleWorkbenchSettingsSave(req)
        send(res, out.body, out.status)
        return
      }
      send(res, { ok: false, error: '仅支持 GET / POST' }, 405)
      return
    }
    if (route === '/workbench/ingest/status') {
      if (method !== 'GET') { send(res, { ok: false, error: '仅支持 GET' }, 405); return }
      const ctx = ingestContext()
      ensureIngestDirs(ctx.baseDir)
      send(res, ingestStatus(ctx))
      return
    }
    if (route === '/workbench/ingest') {
      if (method !== 'POST') { send(res, { ok: false, error: '仅支持 POST' }, 405); return }
      const out = await handleIngestSubmit(req)
      send(res, out.body, out.status)
      return
    }
    if (route === '/workbench/ingest/flush') {
      if (method !== 'POST') { send(res, { ok: false, error: '仅支持 POST' }, 405); return }
      const out = await handleIngestFlush()
      send(res, out.body, out.status)
      return
    }
    if (route === '/workbench/upload-local') {
      if (method !== 'POST') { send(res, { ok: false, error: '仅支持 POST' }, 405); return }
      const runtime = khubRuntime()
      if (!runtime.ready) { send(res, { ok: false, error: '在线资料库未配置或不可用' }, 400); return }
      let force = false
      try {
        const raw = await readRawBody(req, 64 * 1024)
        const p = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {}
        force = p !== null && typeof p === 'object' && p.force === true
      } catch { /* 空 body / 非法 JSON 都按非强制处理 */ }
      try {
        send(res, await autoUploadLocalWorkbenches(runtime.config, force))
      } catch (error) {
        send(res, { ok: false, error: String((error && error.message) || error) }, 500)
      }
      return
    }
    if (route === '/workbench/list') {
      if (method !== 'GET') { send(res, { ok: false, error: '仅支持 GET' }, 405); return }
      const runtime = khubRuntime()
      if (runtime.ready) {
        try {
          await handleKhubWorkbenchList(res, runtime.config, state.settings.syncIntervalMs)
          return
        } catch { /* 在线不可用：静默回落本地目录 */ }
      }
      try { handleWorkbenchList(res, query, state.settings.workbenchDataDir, state.settings.syncIntervalMs) }
      catch (error) { send(res, { ok: false, error: String((error && error.message) || error) }, 500) }
      return
    }
    /* 插件头像：设置页头部用，直接返回包内 PNG（不参与任何用户数据）。 */
    if (route === '/avatar') {
      if (method !== 'GET') { send(res, { ok: false, error: '仅支持 GET' }, 405); return }
      try {
        const avatar = fs.readFileSync(path.join(PLUGIN_ROOT, 'assets', 'avatar.png'))
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Length': avatar.length,
          'Cache-Control': 'public, max-age=3600',
        })
        res.end(avatar)
      } catch {
        send(res, { ok: false, error: '头像文件缺失' }, 404)
      }
      return
    }
    if (route === '/workbench/html') {
      if (method !== 'GET') { send(res, { ok: false, error: '仅支持 GET' }, 405); return }
      const runtime = khubRuntime()
      if (runtime.ready) {
        try {
          await handleKhubWorkbenchHtml(res, query, runtime.config)
          return
        } catch { /* 在线不可用：静默回落本地 HTML */ }
      }
      try { handleWorkbenchHtml(res, query, state.settings.workbenchDataDir) }
      catch (error) { send(res, { ok: false, error: String((error && error.message) || error) }, 500) }
      return
    }
    if (route === '/workbench/bridge.js') {
      if (method !== 'GET') { send(res, { ok: false, error: '仅支持 GET' }, 405); return }
      try { handleWorkbenchBridge(res) }
      catch (error) { send(res, { ok: false, error: String((error && error.message) || error) }, 500) }
      return
    }
    if (route === '/workbench/data') {
      const runtime = khubRuntime()
      const dataDir = state.settings.workbenchDataDir
      if (method === 'GET') {
        if (runtime.ready) {
          try {
            await handleKhubWorkbenchDataGet(res, query, runtime.config)
            return
          } catch { /* 在线不可用：静默回落本地 CSV / 镜像 */ }
        }
        /* 在线工作台（khub-*）没有本地 HTML 声明，`handleWorkbenchDataGet` 会 404；
           这里先读本机镜像，断网时页面照样能看到「任务已经写进来的数据」。 */
        const wbId = String(query.get('workbench') || '')
        if (/^khub-/i.test(wbId) && sendMirrorDataGet(res, query, dataDir) === true) return
        try { handleWorkbenchDataGet(res, query, dataDir) }
        catch (error) { send(res, { ok: false, error: String((error && error.message) || error) }, 500) }
        return
      }
      if (method === 'POST') {
        /* POST 只能读一次 body：先读下来，再按 workbench id 决定走在线、镜像还是本地。
           在线写入本身失败不静默改本地，避免数据分裂。 */
        let body = null
        let raw = null
        try {
          raw = await readRawBody(req, 64 * 1024 * 1024)
          body = JSON.parse(raw.toString('utf8'))
        } catch (error) {
          send(res, { ok: false, error: '请求体不是合法 JSON：' + String((error && error.message) || error) }, 400)
          return
        }
        const wbId = String(body !== null && body !== undefined && body.workbench !== undefined ? body.workbench : '')
        let onlineReady = runtime.ready
        if (onlineReady) {
          try { await getCatalog(runtime.config) } catch { onlineReady = false }
        }
        if (onlineReady && /^khub-/i.test(wbId)) {
          try {
            await handleKhubWorkbenchDataPost(res, body, runtime.config)
          } catch (error) {
            if (!res.writableEnded) {
              send(res, { ok: false, error: '在线资料库写入失败：' + String((error && error.message) || error) }, 502)
            }
          }
          return
        }
        /* 在线工作台但当前不可达：写本机镜像 + 挂待补推，联网后自动推到在线。 */
        if (/^khub-/i.test(wbId) && onlineNodeIdOf(wbId, String(body.table || '')) > 0) {
          const out = writeMirrorFromPayload(body, dataDir, BASE_DIR)
          send(res, out.body, out.status)
          return
        }
        try { await handleWorkbenchDataPostBody(res, body, dataDir) }
        catch (error) { send(res, { ok: false, error: String((error && error.message) || error) }, 500) }
        return
      }
      send(res, { ok: false, error: '仅支持 GET / POST' }, 405)
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
    if (route === '/config/remote') {
      if (method === 'GET') {
        send(res, handleRemoteConfigGet())
        return
      }
      send(res, { ok: false, error: '仅支持 GET' }, 405)
      return
    }
    if (route === '/config/remote/load') {
      if (method !== 'POST') { send(res, { ok: false, error: '仅支持 POST' }, 405); return }
      const out = await handleRemoteConfigLoad(req)
      send(res, out.body, out.status)
      return
    }
    if (route === '/config/remote/clear') {
      if (method !== 'POST') { send(res, { ok: false, error: '仅支持 POST' }, 405); return }
      const out = handleRemoteConfigClear()
      send(res, out.body, out.status)
      return
    }
    if (route === '/workbench/open-html-dir') {
      if (method !== 'POST') { send(res, { ok: false, error: '仅支持 POST' }, 405); return }
      const out = await handleOpenHtmlDir()
      send(res, out.body, out.status)
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

/** 依赖的服务（智聊阶段 0 追加 sessionController，用于 create → prompt → follow）。 */
export const inject = ['webServer', 'agents', 'sessionController']

/**
 * 插件入口。
 * @param {any} ctx cordis 上下文
 * @returns {void}
 */
export function apply(ctx) {
  try {
    restoreState()
    /* 启动时把净化后的 importedIds 落盘：restoreState 只改内存（恢复中途不能写盘），
       这里状态已完整，写一次避免“重启后到首次 /imported 之前”state.json 仍留脏 id。 */
    {
      const onDisk = new Set(listLocalExperts().map((e) => e.id))
      state.importedIds = state.importedIds.filter((id) => onDisk.has(id))
      /* 无条件写一次：restoreState 已净化内存，无法靠“长度变化”判断磁盘是否脏。 */
      persistState()
    }
    ensureDirsQuiet()
    // 智聊工作目录（阶段 0 全局固定 cwd）随插件启动建好，避免首个请求才建目录。
    ensureZhiliaoCwd()
    // 单实例检测：只读探测 + 告警，不退出。两个宿主共用 profile 会互相覆盖账本。
    let zhiliaoListenPort = 0
    try {
      if (ctx.webServer !== null && typeof ctx.webServer === 'object' && typeof ctx.webServer.port === 'number') {
        zhiliaoListenPort = ctx.webServer.port
      }
    } catch { /* 未监听 / 取不到端口：省略 port 字段 */ }
    zhiliaoRegisterHostLock(zhiliaoListenPort)
    // 预加载索引缓存，避免首个请求多一次 IO。
    loadIndexCache()

    // 供 /attach /detach 软取 agents / skills 服务（缺失时接口返回 501，不崩插件）。
    hostCtx = ctx
    // 启动即把所有已绑定身份的工作区同步到 DSH 工作区列表（左栏可见）
    try {
      for (const binding of listBindings(loadZhiliaState(BASE_DIR))) {
        if (binding !== null && typeof binding === 'object') zhiliaoWorkDirFor(binding)
      }
    } catch { /* 读取失败不影响启动 */ }

    /* 智聊阶段 3：队列 / 回收器初始化 + 崩溃重放重置。
       processing 遗留超过 5 分钟的条目在这里统一放行重放（HuLa 侧会按 msgId 重试）。 */
    ensureZhiliaoQueue()
    const zlCfg = zhiliaoConfig()
    zhiliaoRecycler = new ZhiliaoRecycler(zlCfg.recycle)
    try {
      const zlState = loadZhiliaState(BASE_DIR)
      const resetCount = resetStaleProcessing(zlState, 5 * 60 * 1000)
      if (resetCount > 0) saveZhiliaState(BASE_DIR, zlState)
    } catch { /* 只读环境：跳过 */ }

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

    // 外部数据定时摄入：脚本把批次写进 ingest/inbox，这里定期消费并补推待推。
    // 纯 Node 定时器 + 纯文件 IO，Windows / Linux 行为一致；dsh 没在跑时脚本照常写文件，
    // 下次启动后第一轮扫描就会补上（幂等由 batchId + checksum 保证）。
    ctx.effect(() => {
      try { ensureIngestDirs(BASE_DIR) } catch { /* 只读环境：等有请求时再建 */ }
      const boot = setTimeout(() => { void ingestTick() }, 5000)
      const timer = setInterval(() => { void ingestTick() }, INGEST_DEFAULTS.pollMs)
      return () => {
        clearTimeout(boot)
        clearInterval(timer)
      }
    }, 'dsh-buddy-expert-hub: ingest')

    /* 智聊闲时回收：默认关闭（sessionController 无 dispose，只有 ctx.agents.create 的会话
       才拿得到 AgentHandle）。开启后每分钟扫一遍，能回收就回收，拿不到 handle 就记一次跳过。 */
    ctx.effect(() => {
      /* 回收跳过是常态（默认拿不到 AgentHandle），只按次数采样记日志，避免 warnings 单调膨胀。 */
      let skipSamples = 0
      const timer = setInterval(() => {
        const recycler = zhiliaoRecycler
        if (recycler === null || recycler.enabled !== true) return
        void recycler.sweep({
          onSkip: (chatKey, reason) => {
            skipSamples += 1
            if (skipSamples === 1 || skipSamples % 100 === 0) {
              state.warnings.push('智聊回收跳过 ' + chatKey + '：' + reason + '（累计 ' + String(skipSamples) + ' 次）')
            }
          },
        }).catch(() => { /* 回收失败不影响主链路 */ })
      }, 60 * 1000)
      return () => clearInterval(timer)
    }, 'dsh-buddy-expert-hub: zhiliao recycle')

    /* 启动即探测：立即 + 1s + 每 15s 兜底，确保 DSH 打开后 WS 一定被拉起。
       连接本身即订阅；客户端内部还有指数退避，这里只处理「压根没启动 / 长期认证不上」。 */
    ctx.effect(() => {
      const kick = () => { try { zhiliaoWsProbe() } catch { /* ignore */ } }
      kick()
      const boot = setTimeout(kick, 1000)
      const timer = setInterval(kick, 8000)
      return () => { clearTimeout(boot); clearInterval(timer) }
    }, 'dsh-buddy-expert-hub: zhiliao ws boot')

    /* 人设/记忆/Skill 自动更新：定期从服务端拉最新 bundle，revision 变了就更新内存文本。
       注入时用的是函数式 text，所以这里一改，已存在的会话上下文立即生效，无需重建会话。 */
    ctx.effect(() => {
      const refresh = async () => {
        if (zhiliaoPersonaBlocks.size === 0) return
        zhiliaoPersonaDebug('[刷新] 定时器触发, 已注入会话数=' + zhiliaoPersonaBlocks.size)
        const byBinding = new Map()
        for (const entry of zhiliaoPersonaBlocks.values()) {
          if (entry !== undefined && typeof entry === 'object' && entry.bindingId !== '') {
            byBinding.set(entry.bindingId, true)
          }
        }
        for (const bindingId of byBinding.keys()) {
          try {
            const binding = findBindingById(loadZhiliaState(BASE_DIR), bindingId)
            if (binding === null) continue
            const bundle = await zhiliaoFetchPersonaBundle(binding)
            if (bundle.ok !== true) { zhiliaoPersonaDebug('[刷新] bundle失败 binding=' + bindingId); continue }
            for (const [sid, entry] of zhiliaoPersonaBlocks) {
              if (entry.bindingId !== bindingId) continue
              zhiliaoPersonaDebug('[刷新] sid=' + sid.slice(0,20) + ' 旧rev=' + entry.revision + ' 新rev=' + bundle.revision + ' 相同=' + (entry.revision === bundle.revision))
              if (entry.revision === bundle.revision && entry.text !== '') continue
              entry.text = zhiliaoComposePersonaBlock(bundle)
              entry.revision = bundle.revision
              // 关键：宿主只在 section 注册/撤销时发 system-prompt/change，
              // 光改函数读取的 text 不会触发重新组装。必须重新注册让宿主刷新 surface node。
              const reg = zhiliaoPersonaRegs.get(sid)
              if (reg !== undefined && reg.agent !== undefined && reg.agent !== null) {
                try { if (typeof reg.dispose === 'function') reg.dispose() } catch { /* 已回收 */ }
                const provider = () => {
                  const cur = zhiliaoPersonaBlocks.get(sid)
                  return cur !== undefined ? cur.text : entry.text
                }
                const newDispose = registerPromptSection(reg.agent, 'zhiliao-persona', provider, true, false)
                reg.dispose = newDispose
                zhiliaoPersonaDebug('[刷新] 已重新注册section, 新长度=' + entry.text.length)
              } else {
                zhiliaoPersonaDebug('[刷新] 仅更新text(无agent引用), 新长度=' + entry.text.length)
              }
            }
          } catch { /* 单个绑定刷新失败不影响其他 */ }
        }
      }
      const timer = setInterval(() => { void refresh() }, 10000)
      return () => { clearInterval(timer) }
    }, 'dsh-buddy-expert-hub: zhiliao persona refresh')

    // agent 生命周期接线：created 时补挂 pending，disposed 时清理注册表
    // （agent 作用域的技能注册本身也会被宿主自动 unwind，这里只是清账）。
    if (typeof ctx.on === 'function') {
      ctx.on('agent/created', ({ agent }) => {
        // 智聊会话：注入"真人化"人设，让 AI 以绑定用户身份口语化回复
        // 异步拉取服务端人设；失败静默，不影响主链路
        void Promise.resolve().then(() => zhiliaoInjectPersona(agent)).catch(() => { /* ignore */ })
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
      /* 退出语义（用户决策 #7）：宿主退出即不接管——通知 HuLa 把所有启用绑定置 paused。
         异步尽力完成（3s 总超时），不阻塞宿主退出；单个失败只记 warning。 */
      ctx.on('dispose', () => {
        try {
          if (zhiliaoQueue !== null) zhiliaoQueue.close()
        } catch { /* 队列已关 */ }
        // 只删自己的锁；别人的锁不动。
        zhiliaoReleaseHostLock()
        // 关闭队列会给残留任务标 failed，这里把未落盘的修改立刻写掉，避免退出丢账本。
        try { flushZhiliaState() } catch { /* 只读环境：忽略 */ }
        try { zhiliaoWsStop() } catch { /* ignore */ }
      })
    }
  } catch (error) {
    // 绝不让插件异常阻断 dsh web 启动。
    // eslint-disable-next-line no-console
    console.error('[dsh-buddy-expert-hub] 初始化失败：', error)
  }
}
