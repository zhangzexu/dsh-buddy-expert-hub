/**
 * dsh-buddy-expert-hub — 个人工作台后端：目录扫描、HTML 托管、CSV 双向同步（CAS）。
 * 零依赖；HTML 由 dsh agent 落盘到 WORKBENCH_DIR，插件只扫描/校验/读取。
 * @module dsh-buddy-expert-hub/workbench
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { parseCsv, stringifyCsv, mergeColumns, ensureRowId, readCsv, atomicWrite } from './csv.js'
import { extractMenu } from './workbench-menu.js'
import { BRIDGE_SOURCE } from './workbench-bridge.js'

const DSH_HOME =
  typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : path.join(os.homedir(), '.dsh')

/** HTML 展示文件目录（固定，由 BASE_DIR 派生；发布包目录是只读的，不能用）。 */
export const WORKBENCH_DIR = path.join(DSH_HOME, 'dsh-buddy-expert-hub', 'workbench')

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
const FILE_RE = /^[A-Za-z0-9._-]+\.csv$/

/** 词法 + realpath 双重越界校验，返回绝对路径或 null。 */
export function safePath(root, rel) {
  const base = path.resolve(root)
  const abs = path.resolve(base, String(rel === null || rel === undefined ? '' : rel))
  if (abs !== base && !abs.startsWith(base + path.sep)) return null
  try {
    const realRoot = fs.realpathSync(base)
    const real = fs.realpathSync(abs)
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null
  } catch { /* 目标尚不存在时跳过 realpath 校验 */ }
  return abs
}

/** 工作台数据目录校验：存在、是目录、可读写。 */
export function localWorkbenchDirError(dir) {
  const value = String(dir === null || dir === undefined ? '' : dir).trim()
  if (value === '') return '请先填写个人工作台数据目录的绝对路径'
  if (!path.isAbsolute(value)) return '数据目录必须是绝对路径'
  try {
    const st = fs.statSync(value)
    if (!st.isDirectory()) return '数据目录不是一个目录：' + value
  } catch (error) {
    return '数据目录不存在或不可访问：' + value
  }
  const probe = path.join(value, '.dsh-workbench-write-probe-' + randomBytes(4).toString('hex'))
  try {
    fs.writeFileSync(probe, '', { flag: 'wx' })
    fs.unlinkSync(probe)
  } catch {
    return '数据目录不可写：' + value
  }
  return ''
}

export function fileHash(file) {
  try { return createHash('sha256').update(fs.readFileSync(file)).digest('hex') }
  catch (error) {
    if (error !== null && error.code === 'ENOENT') return ''
    throw error
  }
}

function sendJson(res, body, status) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(typeof status === 'number' ? status : 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store'
  })
  res.end(buf)
}

export function sendHtml(res, html) {
  const buf = Buffer.from(String(html), 'utf8')
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store'
  })
  res.end(buf)
}

/** 每次重新扫描 HTML 目录；单个声明非法不影响其它工作台。 */
export function listWorkbenches() {
  const workbenches = []
  const errors = []
  let names
  try {
    names = fs.readdirSync(WORKBENCH_DIR).filter((n) => n.toLowerCase().endsWith('.html')).sort()
  } catch (error) {
    if (error !== null && error.code === 'ENOENT') return { workbenches, errors }
    return { workbenches, errors: ['无法读取工作台目录：' + String((error && error.message) || error)] }
  }
  for (const name of names) {
    const abs = safePath(WORKBENCH_DIR, name)
    if (abs === null) { errors.push(name + '：路径越界，已跳过'); continue }
    let html
    try { html = fs.readFileSync(abs, 'utf8') } catch (error) {
      errors.push(name + '：读取失败 ' + String((error && error.message) || error)); continue
    }
    const result = extractMenu(html)
    if (result.menu === null) { errors.push(name + '：' + result.error); continue }
    workbenches.push(Object.assign({}, result.menu, { file: name }))
  }
  return { workbenches, errors }
}

function findWorkbench(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null
  return listWorkbenches().workbenches.find((w) => w.id === id) || null
}

function findTable(menu, tableName) {
  const wanted = String(tableName === null || tableName === undefined ? '' : tableName)
  return menu.tables.find((t) => t.file === wanted || t.file.replace(/\.csv$/, '') === wanted) || null
}

function dataFile(dataDir, id, tableFile) {
  const root = path.resolve(dataDir)
  const abs = safePath(root, path.join(id, tableFile))
  if (abs === null) return null
  return abs
}

/** 同步间隔归一化：非数字 / 非有限值回落 2000，数字 clamp 到 500..60000。 */
function normalizeSyncIntervalMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 2000
  return Math.min(60000, Math.max(500, Math.floor(value)))
}

/** GET /workbench/list：每次重新扫描 HTML 目录（agent 落盘后刷新即生效）。 */
export function handleWorkbenchList(res, params, dataDir, syncIntervalMs) {
  const result = listWorkbenches()
  sendJson(res, {
    ok: true,
    workbenches: result.workbenches,
    errors: result.errors,
    htmlDir: WORKBENCH_DIR,
    dataDir: typeof dataDir === 'string' ? dataDir : '',
    dataDirReady: typeof dataDir === 'string' && dataDir !== '' && localWorkbenchDirError(dataDir) === '',
    syncIntervalMs: normalizeSyncIntervalMs(syncIntervalMs)
  })
}

/**
 * GET /workbench/html?workbench=<id>，注入 postMessage 桥脚本。
 *
 * 注入只发生在 HTTP 响应文本上，磁盘 HTML 字节不变；BRIDGE_SOURCE 保持原样。
 * 页面外观（含配色 / 主题）由 HTML 自己控制，插件不再注入任何样式或主题变量。
 * @param {import('node:http').ServerResponse} res 响应对象
 * @param {URLSearchParams} params 查询参数
 * @returns {void}
 */
export function handleWorkbenchHtml(res, params) {
  const id = params.get('workbench') || ''
  const menu = findWorkbench(id)
  if (menu === null) { sendJson(res, { ok: false, error: '工作台不存在或 id 非法：' + id }, 404); return }
  const abs = safePath(WORKBENCH_DIR, menu.file)
  if (abs === null) { sendJson(res, { ok: false, error: '工作台文件路径越界' }, 400); return }
  const html = fs.readFileSync(abs, 'utf8')
  const bridge = '<script>' + BRIDGE_SOURCE + '</script>'
  const injected = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (m) => m + bridge)
    : bridge + html
  sendHtml(res, injected)
}

/** GET /workbench/bridge.js：CSP 回退，把 postMessage 桥作为独立 JS 资源托管。 */
export function handleWorkbenchBridge(res) {
  const buf = Buffer.from(String(BRIDGE_SOURCE), 'utf8')
  res.writeHead(200, {
    'Content-Type': 'application/javascript; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store'
  })
  res.end(buf)
}

/**
 * GET /workbench/data?workbench=&table=&hash=
 * 带 hash 时做轻量轮询：hash 未变则只回元数据（不读 / 不解析 CSV），
 * 变了则回完整数据并置 changed:true；不带 hash 时行为与旧版完全一致。
 */
export function handleWorkbenchDataGet(res, params, dataDir) {
  const id = params.get('workbench') || ''
  const tableName = params.get('table') || ''
  const probeHash = params.get('hash') || ''
  const dirError = typeof dataDir === 'string' && dataDir !== '' ? localWorkbenchDirError(dataDir) : '尚未配置个人工作台数据目录，请在设置里选择本地目录'
  if (dirError !== '') { sendJson(res, { ok: false, error: dirError }, 400); return }
  const menu = findWorkbench(id)
  if (menu === null) { sendJson(res, { ok: false, error: '工作台不存在' }, 404); return }
  const table = findTable(menu, tableName)
  if (table === null) { sendJson(res, { ok: false, error: '数据表不存在：' + tableName }, 404); return }
  const file = dataFile(dataDir, id, table.file)
  if (file === null) { sendJson(res, { ok: false, error: '数据表路径越界' }, 400); return }
  // hash = sha256(磁盘 CSV 原始字节)；stat 提前取，轻量轮询与完整响应共用。
  const currentHash = fileHash(file)
  let mtimeMs = null, size = 0
  try { const st = fs.statSync(file); mtimeMs = st.mtimeMs; size = st.size }
  catch { /* 文件不存在时用空值 */ }
  if (probeHash !== '' && probeHash === currentHash) {
    sendJson(res, {
      ok: true,
      changed: false,
      workbench: id,
      table: table.file,
      hash: currentHash,
      mtimeMs,
      size
    })
    return
  }
  let parsed
  try { parsed = readCsv(file) } catch (error) {
    sendJson(res, { ok: false, error: String((error && error.message) || error) }, 400); return
  }
  const columns = parsed.columns.length > 0 ? parsed.columns : table.keys
  const withId = ensureRowId(columns, parsed.rows)
  sendJson(res, {
    ok: true,
    workbench: id,
    table: table.file,
    columns: withId.columns,
    fields: table.fields,
    rows: withId.rows,
    hash: fileHash(file),
    mtimeMs,
    size,
    lineEnding: parsed.lineEnding,
    changed: probeHash !== '' ? true : parsed.missing === true
  })
}

/** 进程内串行写队列：同一张表不并发写；队列内 double-check hash。 */
const queues = new Map()
function enqueue(key, task) {
  const prev = queues.get(key) || Promise.resolve()
  const next = prev.then(task, task)
  queues.set(key, next.catch(() => {}))
  return next
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 4 * 1024 * 1024) reject(new Error('请求体过大'))
    })
    req.on('end', () => resolve(raw))
    req.on('error', reject)
  })
}

/** POST /workbench/data：同 hash 才写，旧 hash 返回 409 + 当前数据。 */
export async function handleWorkbenchDataPost(req, res, dataDir) {
  let payload
  try { payload = JSON.parse(await readBody(req)) } catch (error) {
    sendJson(res, { ok: false, error: '请求体不是合法 JSON：' + String((error && error.message) || error) }, 400)
    return
  }
  const dirError = typeof dataDir === 'string' && dataDir !== '' ? localWorkbenchDirError(dataDir) : '尚未配置个人工作台数据目录，请在设置里选择本地目录'
  if (dirError !== '') { sendJson(res, { ok: false, error: dirError }, 400); return }
  const id = typeof payload.workbench === 'string' ? payload.workbench : ''
  const menu = findWorkbench(id)
  if (menu === null) { sendJson(res, { ok: false, error: '工作台不存在' }, 404); return }
  const table = findTable(menu, payload.table)
  if (table === null) { sendJson(res, { ok: false, error: '数据表不存在' }, 404); return }
  const file = dataFile(dataDir, id, table.file)
  if (file === null) { sendJson(res, { ok: false, error: '数据表路径越界' }, 400); return }
  const baseHash = typeof payload.baseHash === 'string' ? payload.baseHash : ''
  const nextColumns = Array.isArray(payload.columns) && payload.columns.length > 0 ? payload.columns.map(String) : table.keys
  if (nextColumns.some((key) => !/^[A-Za-z0-9_]+$/.test(key))) {
    sendJson(res, { ok: false, error: '字段名只能包含字母、数字、下划线' }, 400)
    return
  }
  const rows = Array.isArray(payload.rows) ? payload.rows : []
  try {
    const result = await enqueue(id + ':' + table.file, async () => {
      const currentHash = fileHash(file)
      if (currentHash !== baseHash) {
        let current = null
        try {
          const parsed = readCsv(file)
          const withId = ensureRowId(parsed.columns.length > 0 ? parsed.columns : table.keys, parsed.rows)
          current = { columns: withId.columns, rows: withId.rows, hash: currentHash }
        } catch { /* 冲突响应里带不到当前数据时仍返回冲突 */
        }
        return { conflict: true, current }
      }
      const parsed = readCsv(file)
      const lineEnding = parsed.lineEnding
      const merged = mergeColumns(nextColumns, rows)
      const withId = ensureRowId(nextColumns, merged)
      atomicWrite(file, stringifyCsv(withId.columns, withId.rows, lineEnding))
      return { conflict: false, hash: fileHash(file), columns: withId.columns, rows: withId.rows }
    })
    if (result.conflict === true) {
      sendJson(res, { ok: false, code: 'conflict', error: '数据表已在外部被修改，已重新加载，请确认后重试', current: result.current }, 409)
      return
    }
    sendJson(res, { ok: true, hash: result.hash, columns: result.columns, rows: result.rows })
  } catch (error) {
    sendJson(res, { ok: false, error: String((error && error.message) || error) }, 500)
  }
}

export default {
  WORKBENCH_DIR, safePath, localWorkbenchDirError, fileHash, sendHtml, listWorkbenches,
  handleWorkbenchList, handleWorkbenchHtml, handleWorkbenchBridge, handleWorkbenchDataGet, handleWorkbenchDataPost
}
