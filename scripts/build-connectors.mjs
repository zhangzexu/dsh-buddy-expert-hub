#!/usr/bin/env node
/**
 * 资源仓库维护工具：生成 `connectors/connectors.json` 并同步图标。
 *
 * 输出位置是**资源仓库（当前数据根）**，不再写插件自己的 `data/`：
 *   <数据根>/connectors/connectors.json     —— 单文件清单（JSON 数组）
 *   <数据根>/connectors/icons/<id>.<ext>    —— 命中的品牌图标
 *
 * 输入是本机 WorkBuddy 连接器市场目录（维护者的上游数据源）：
 *   ~/.workbuddy/connectors-marketplace/connectors/<id>/mcp.json   —— MCP 类型连接器
 *   ~/.workbuddy/connectors-marketplace/connectors/<id>/cli.json   —— CLI 类型连接器
 *   ~/.workbuddy/connectors-marketplace/connectors/<id>/skills[/<skill>]/SKILL.md —— 取名称/描述/作者
 *   ~/.workbuddy/connectors-marketplace/icons/<id>.{svg,png,jpg,jpeg,webp}  —— 图标扩展名
 *
 * 插件运行时只读这里的产物（`lib/connector-store.js` 的 `listCloudDefinitions`），
 * 因此本脚本只给资源仓库维护者用，普通用户不需要执行。
 * 零依赖，仅使用 node: 内置模块。
 *
 * 用法：node scripts/build-connectors.mjs [--out <file>] [--data-root <dir>]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
// frontmatter 解析只有一份实现，与运行时 lib/index.js 共用（块标量坑踩过两次）
import { parseFrontmatter } from '../lib/frontmatter.js'
// 认证模式 / 参数元数据判定与运行时 lib/index.js 共用，避免两条数据路径漂移
import { computeNeedsSetup, connectorParamMeta, readAuthModeMap } from '../lib/connector-meta.js'

/** 连接器清单在数据根内的相对位置。 */
const CONNECTORS_RELATIVE = ['connectors', 'connectors.json']

const ICON_EXTS = ['.svg', '.png', '.jpg', '.jpeg', '.webp']
const MAX_NAME = 120
const MAX_DESC = 600
/**
 * 单个图标体积上限：2MB。
 * 超过的都只是几个设计工具导出的超大 SVG/PNG（最大 1.4MB），再大就不入库，
 * 前端回落首字母色块。
 */
const MAX_ICON_BYTES = 2 * 1024 * 1024

/**
 * 读命令行里某个 `--flag <value>` 参数。
 * @param {string} flag 参数名（含 `--`）
 * @returns {string} 参数值；未给出返回空串
 */
function argValue(flag) {
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === flag && typeof argv[i + 1] === 'string') return path.resolve(argv[i + 1])
  }
  return ''
}

/**
 * 判断目录下是否存在非空 `experts/`（与运行时 `dataRoot()` 同一判定）。
 * @param {string} dir 候选数据根
 * @returns {boolean} 是否可作为数据根
 */
function hasExpertsDir(dir) {
  const expertsDir = path.join(dir, 'experts')
  try {
    return fs.statSync(expertsDir).isDirectory() && fs.readdirSync(expertsDir).length > 0
  } catch {
    return false
  }
}

/**
 * 解析当前数据根（资源仓库副本），与运行时保持同一优先级：
 *   1. `$DSH_HOME/ntd-resource`（NTD 已同步的只读副本）；
 *   2. `$DSH_HOME/dsh-buddy-expert-hub/repo`（插件自己同步的副本）。
 * `--data-root` 显式给出时优先使用它。
 *
 * @returns {string} 数据根绝对路径；都不可用时返回空串
 */
function resolveDataRoot() {
  const explicit = argValue('--data-root')
  if (explicit !== '') return fs.existsSync(explicit) ? explicit : ''
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh')
  const ntd = path.join(home, 'ntd-resource')
  if (hasExpertsDir(ntd)) return ntd
  const own = path.join(home, 'dsh-buddy-expert-hub', 'repo')
  if (hasExpertsDir(own)) return own
  return ''
}

/**
 * 读取 JSON 文件，失败返回 null。
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
 * 在连接器的 skills 目录里找到「代表性」SKILL.md。
 * 优先级：`skills/<id>/SKILL.md` > `skills/SKILL.md` > 任意子目录下的第一个 SKILL.md。
 * @param {string} connectorDir 连接器目录绝对路径
 * @param {string} id 连接器 id
 * @returns {{ file: string, canonical: boolean }|null} 文档路径与是否代表连接器本身
 */
function findSkillDoc(connectorDir, id) {
  const skillsDir = path.join(connectorDir, 'skills')
  if (!fs.existsSync(skillsDir)) return null
  const named = path.join(skillsDir, id, 'SKILL.md')
  if (fs.existsSync(named)) return { file: named, canonical: true }
  const direct = path.join(skillsDir, 'SKILL.md')
  if (fs.existsSync(direct)) return { file: direct, canonical: true }
  let entries
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const nested = path.join(skillsDir, entry.name, 'SKILL.md')
    if (fs.existsSync(nested)) return { file: nested, canonical: false }
  }
  return null
}

/**
 * 探测连接器图标扩展名。
 * @param {string} iconsDir 市场 icons 目录
 * @param {string} id 连接器 id
 * @returns {string} 扩展名（含点），未找到返回空串
 */
function detectIconExt(iconsDir, id) {
  for (const ext of ICON_EXTS) {
    if (fs.existsSync(path.join(iconsDir, id + ext))) return ext
  }
  return ''
}

/**
 * 把市场图标复制到资源仓库的 `connectors/icons/`，插件运行时从这里读图标。
 * @param {string} sourceIconsDir 市场 icons 目录
 * @param {string} targetIconsDir 资源仓库 icons 目录
 * @param {string} id 连接器 id
 * @param {string} ext 扩展名（含点）
 * @returns {'copied'|'skipped'|'missing'} 处理结果
 */
function copyIcon(sourceIconsDir, targetIconsDir, id, ext) {
  if (ext === '') return 'missing'
  const source = path.join(sourceIconsDir, id + ext)
  let stat
  try {
    stat = fs.statSync(source)
  } catch {
    return 'missing'
  }
  if (!stat.isFile() || stat.size > MAX_ICON_BYTES) return 'skipped'
  fs.mkdirSync(targetIconsDir, { recursive: true })
  fs.copyFileSync(source, path.join(targetIconsDir, id + ext))
  return 'copied'
}

/**
 * 从 mcp.json 中提取第一个 MCP server 定义。
 * @param {string} connectorDir 连接器目录
 * @returns {{ key: string, server: Record<string, any>, config: Record<string, any> }|null}
 */
function readMcpServer(connectorDir) {
  const parsed = readJsonSafe(path.join(connectorDir, 'mcp.json'))
  if (parsed === null || typeof parsed !== 'object') return null
  const servers = parsed.mcpServers
  if (servers === null || typeof servers !== 'object') return null
  const keys = Object.keys(servers)
  if (keys.length === 0) return null
  const key = keys[0]
  const server = servers[key]
  if (server === null || typeof server !== 'object') return null
  return { key, server, config: { mcpServers: { [key]: server } } }
}

/**
 * 判断连接器是否为 CLI 类型。
 * @param {string} connectorDir 连接器目录
 * @returns {boolean} 是否存在 cli.json
 */
function hasCliManifest(connectorDir) {
  return fs.existsSync(path.join(connectorDir, 'cli.json'))
}

/**
 * 裁剪字符串并清理空白。
 * @param {string} text 原始文本
 * @param {number} max 最大长度
 * @returns {string} 清洗后的文本
 */
function tidy(text, max) {
  const value = String(text == null ? '' : text).replace(/\s+/g, ' ').trim()
  return value.length > max ? value.slice(0, max) : value
}

/**
 * 构建单个连接器条目。
 * @param {string} connectorsDir 市场 connectors 目录
 * @param {string} iconsDir 市场 icons 目录
 * @param {string} targetIconsDir 资源仓库 icons 目录（图标的落地位置）
 * @param {string} id 连接器 id
 * @param {Map<string, string>} authModes id → auth_mode 映射
 * @returns {Record<string, any>|null} 条目或 null（无法识别时）
 */
function buildConnectorEntry(connectorsDir, iconsDir, targetIconsDir, id, authModes) {
  const connectorDir = path.join(connectorsDir, id)
  const stat = fs.statSync(connectorDir)
  if (!stat.isDirectory()) return null

  const mcp = readMcpServer(connectorDir)
  const isCli = hasCliManifest(connectorDir)
  if (mcp === null && !isCli) return null

  const skillDoc = findSkillDoc(connectorDir, id)
  const front = skillDoc === null ? {} : parseFrontmatter(fs.readFileSync(skillDoc.file, 'utf8'))

  // 只有「代表连接器本身」的 SKILL.md 才可用它的 name 作为连接器名，
  // 否则（任意子技能）沿用目录 id，避免展示成某个子技能的名字。
  const frontName = skillDoc !== null && skillDoc.canonical === true ? front.name || '' : ''
  const displayName = tidy(frontName || mcp?.key || id, MAX_NAME) || id
  const description = tidy(front.description_zh || front.description || '', MAX_DESC)
  const author = tidy(front.author || '', MAX_NAME)

  let transport = 'cli'
  let url = ''
  let config = null
  if (mcp !== null) {
    transport = tidy(mcp.server.type || 'stdio', 40) || 'stdio'
    url = typeof mcp.server.url === 'string' ? mcp.server.url : ''
    config = mcp.config
  }

  const iconExt = detectIconExt(iconsDir, id)
  // 图标复制成功才写进清单：否则前端会一直发 404 请求。
  const iconState = copyIcon(iconsDir, targetIconsDir, id, iconExt)

  // 认证模式来自市场元数据；参数以 token-schema.json 为权威，mcp.json 的 ${VAR} 作补充。
  // 只提取变量名与展示文案，绝不把任何实际值写进清单。
  const authMode = authModes.get(id) || ''
  const paramMeta = connectorParamMeta(config, connectorDir)
  const needsSetup = computeNeedsSetup(authMode, paramMeta.requiredParams)

  return {
    id,
    name: displayName,
    description,
    author,
    transport,
    url,
    iconExt: iconState === 'copied' ? iconExt : '',
    config,
    authMode,
    requiredParams: paramMeta.requiredParams,
    optionalParams: paramMeta.optionalParams,
    paramFields: paramMeta.paramFields,
    setupSchema: paramMeta.setupSchema,
    needsSetup,
  }
}

/**
 * 主流程：扫描市场目录，把清单与图标写进资源仓库（当前数据根）。
 *
 * 数据根不可用时给出中文可读错误并以非 0 退出（资源仓库维护者必须能一眼看出
 * 「我还没同步仓库」而不是以为脚本成功跑完了）。
 *
 * @returns {number} 写入的条目数
 */
function main() {
  const dataRoot = resolveDataRoot()
  if (dataRoot === '') {
    process.stderr.write('[build-connectors] 未找到资源仓库数据根。\n')
    process.stderr.write('[build-connectors] 请先同步资源仓库（插件面板右上「刷新」），或显式指定 --data-root <目录>。\n')
    process.exit(1)
  }
  const connectorsDirInRepo = path.join(dataRoot, CONNECTORS_RELATIVE[0])
  const targetIconsDir = path.join(connectorsDirInRepo, 'icons')
  const outFile = argValue('--out') !== ''
    ? argValue('--out')
    : path.join(connectorsDirInRepo, CONNECTORS_RELATIVE[1])
  /* `--out` 指到别处时，图标跟着清单一起走（<out 所在目录>/icons）。 */
  const iconsOutDir = path.dirname(outFile) === connectorsDirInRepo
    ? targetIconsDir
    : path.join(path.dirname(outFile), 'icons')

  const marketDir = path.join(os.homedir(), '.workbuddy', 'connectors-marketplace')
  const marketConnectorsDir = path.join(marketDir, 'connectors')
  const marketIconsDir = path.join(marketDir, 'icons')
  // 元数据在 .codebuddy-connector/connectors.json；缺失时全部按「无认证模式」处理。
  const authModes = readAuthModeMap(marketDir)

  if (!fs.existsSync(marketConnectorsDir)) {
    process.stderr.write('[build-connectors] 未找到本机连接器市场目录：' + marketConnectorsDir + '\n')
    process.stderr.write('[build-connectors] 没有可导入的上游数据，本次不写任何文件。\n')
    process.exit(1)
  }

  const ids = fs
    .readdirSync(marketConnectorsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  /** @type {Array<Record<string, any>>} */
  const items = []
  for (const id of ids) {
    try {
      const entry = buildConnectorEntry(marketConnectorsDir, marketIconsDir, iconsOutDir, id, authModes)
      if (entry !== null) items.push(entry)
    } catch (error) {
      process.stderr.write('[build-connectors] 跳过 ' + id + '：' + String((error && error.message) || error) + '\n')
    }
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, JSON.stringify(items, null, 0) + '\n', 'utf8')

  const withDescription = items.filter((item) => item.description !== '').length
  const withAuthor = items.filter((item) => item.author !== '').length
  const withIcon = items.filter((item) => item.iconExt !== '').length
  const withSetup = items.filter((item) => item.needsSetup === true).length
  const withRequired = items.filter((item) => item.requiredParams.length > 0).length
  const withOptional = items.filter((item) => item.optionalParams.length > 0).length
  const withSchema = items.filter((item) => item.setupSchema !== null).length
  process.stdout.write('[build-connectors] 扫描到目录 ' + ids.length + ' 个，写入条目 ' + items.length + ' 条\n')
  process.stdout.write(
    '[build-connectors] 有描述 ' + withDescription + ' · 有作者 ' + withAuthor + ' · 图标已入库 ' + withIcon +
    ' · 需连接 ' + withSetup + ' · 含必填参数 ' + withRequired + ' · 含选填参数 ' + withOptional +
    ' · 带配置说明 ' + withSchema + '\n',
  )
  process.stdout.write('[build-connectors] 数据根：' + dataRoot + '\n')
  process.stdout.write('[build-connectors] 图标目录：' + iconsOutDir + '\n')
  process.stdout.write('[build-connectors] 输出：' + outFile + '\n')
  return items.length
}

main()
