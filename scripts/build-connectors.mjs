#!/usr/bin/env node
/**
 * 构建连接器离线快照 `data/connectors.json`。
 *
 * 扫描本机 WorkBuddy 连接器市场目录：
 *   ~/.workbuddy/connectors-marketplace/connectors/<id>/mcp.json   —— MCP 类型连接器
 *   ~/.workbuddy/connectors-marketplace/connectors/<id>/cli.json   —— CLI 类型连接器
 *   ~/.workbuddy/connectors-marketplace/connectors/<id>/skills[/<skill>]/SKILL.md —— 取名称/描述/作者
 *   ~/.workbuddy/connectors-marketplace/icons/<id>.{svg,png,jpg,jpeg,webp}  —— 图标扩展名
 *
 * 同时把命中的图标文件复制到插件内置的 `data/icons/`，这样插件脱离本机市场目录
 * 也能显示品牌图标（`/icon` 会优先读市场目录，读不到再回落到内置目录）。
 *
 * 产物为纯数组，供插件在运行时缺少本机市场目录时回落使用。
 * 零依赖，仅使用 node: 内置模块。
 *
 * 用法：node scripts/build-connectors.mjs [--out <file>]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// frontmatter 解析只有一份实现，与运行时 lib/index.js 共用（块标量坑踩过两次）
import { parseFrontmatter } from '../lib/frontmatter.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(HERE, '..')
const DEFAULT_OUT = path.join(PLUGIN_ROOT, 'data', 'connectors.json')
const ICON_OUT_DIR = path.join(PLUGIN_ROOT, 'data', 'icons')

const ICON_EXTS = ['.svg', '.png', '.jpg', '.jpeg', '.webp']
const MAX_NAME = 120
const MAX_DESC = 600
/**
 * 单个图标体积上限：2MB。
 * 超过的都只是几个设计工具导出的超大 SVG/PNG（最大 1.4MB），再大就不入包，
 * 前端回落首字母色块。
 */
const MAX_ICON_BYTES = 2 * 1024 * 1024

/**
 * 解析 out 参数。
 * @returns {string} 目标文件绝对路径
 */
function resolveOutFile() {
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out' && typeof argv[i + 1] === 'string') return path.resolve(argv[i + 1])
  }
  return DEFAULT_OUT
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
 * 把市场图标复制到插件内置目录，供离线场景使用。
 * @param {string} iconsDir 市场 icons 目录
 * @param {string} id 连接器 id
 * @param {string} ext 扩展名（含点）
 * @returns {'copied'|'skipped'|'missing'} 处理结果
 */
function copyIcon(iconsDir, id, ext) {
  if (ext === '') return 'missing'
  const source = path.join(iconsDir, id + ext)
  let stat
  try {
    stat = fs.statSync(source)
  } catch {
    return 'missing'
  }
  if (!stat.isFile() || stat.size > MAX_ICON_BYTES) return 'skipped'
  fs.mkdirSync(ICON_OUT_DIR, { recursive: true })
  fs.copyFileSync(source, path.join(ICON_OUT_DIR, id + ext))
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
 * @param {string} id 连接器 id
 * @returns {Record<string, any>|null} 条目或 null（无法识别时）
 */
function buildConnectorEntry(connectorsDir, iconsDir, id) {
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
  // 图标可用才写进快照：没复制成功就不留 iconExt，避免前端一直发 404 请求。
  const iconState = copyIcon(iconsDir, id, iconExt)

  return {
    id,
    name: displayName,
    description,
    author,
    transport,
    url,
    iconExt: iconState === 'copied' ? iconExt : '',
    config,
  }
}

/**
 * 主流程：扫描市场目录并写入快照。
 * @returns {number} 写入的条目数
 */
function main() {
  const outFile = resolveOutFile()
  const marketDir = path.join(os.homedir(), '.workbuddy', 'connectors-marketplace')
  const connectorsDir = path.join(marketDir, 'connectors')
  const iconsDir = path.join(marketDir, 'icons')

  if (!fs.existsSync(connectorsDir)) {
    process.stderr.write('[build-connectors] 未找到连接器市场目录：' + connectorsDir + '\n')
    process.stderr.write('[build-connectors] 跳过生成，保留既有快照（若存在）。\n')
    return fs.existsSync(outFile) ? readJsonSafe(outFile)?.length ?? 0 : 0
  }

  const ids = fs
    .readdirSync(connectorsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  /** @type {Array<Record<string, any>>} */
  const items = []
  for (const id of ids) {
    try {
      const entry = buildConnectorEntry(connectorsDir, iconsDir, id)
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
  process.stdout.write('[build-connectors] 扫描到目录 ' + ids.length + ' 个，写入条目 ' + items.length + ' 条\n')
  process.stdout.write(
    '[build-connectors] 有描述 ' + withDescription + ' · 有作者 ' + withAuthor + ' · 图标已内置 ' + withIcon + '\n',
  )
  process.stdout.write('[build-connectors] 图标目录：' + ICON_OUT_DIR + '\n')
  process.stdout.write('[build-connectors] 输出：' + outFile + '\n')
  return items.length
}

main()
