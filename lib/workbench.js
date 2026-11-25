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
import { ensureIndex, invalidateIndex, readPage, readHeaders, dataRowCount, readLine, writeLine, LARGE_BYTES } from './csv-index.js'
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
  try {
    /* 客户端（宿主代理）先超时断开时，写响应会抛 ERR_STREAM_WRITE_AFTER_END；
       没有这层防护就是未捕获异常，直接把插件服务带走 —— 之后所有接口都 502。 */
    if (typeof res.on === 'function') res.on('error', () => {})
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store'
    })
    res.end(buf)
  } catch { /* 已经被断开：静默放弃这次响应 */ }
}

/**
 * 工作台 HTML 目录：默认就是默认数据目录（legacy 的 HTML 在根目录，新布局的 HTML 在 <id>/ 子目录，CSV 始终在 <id>/ 子目录）。
 * 用户改过数据目录时由调用方传入当前值；未传 / 空串回落到默认值。
 * @param {string|null|undefined} dataDir 当前数据目录
 * @returns {string} HTML 目录绝对路径
 */
export function workbenchHtmlDir(dataDir) {
  return typeof dataDir === 'string' && dataDir.trim() !== '' ? dataDir.trim() : WORKBENCH_DIR
}

/** 每次重新扫描 HTML 目录；单个声明非法不影响其它工作台。 */
export function listWorkbenches(htmlDir) {
  const dir = workbenchHtmlDir(htmlDir)
  const workbenches = []
  const errors = []
  /* 两种布局都支持：
     - legacy：HTML 直接在根目录（file = '名字.html'）
     - 新版『一工作台一目录』：HTML 在 <id>/ 子目录内（file = '<id>/xxx.html'）
     同一 id 同时存在时以子目录版本为准。 */
  const candidates = [] // { rel, file }
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if (error !== null && error.code === 'ENOENT') return { workbenches, errors }
    return { workbenches, errors: ['无法读取工作台目录：' + String((error && error.message) || error)] }
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.html')) {
      candidates.push({ rel: entry.name, inSub: false })
    } else if (entry.isDirectory() && ID_RE.test(entry.name) && !entry.name.startsWith('.')) {
      /* 只看合法 id 的子目录，跳过符号链接由真实路径校验兜底。 */
      let subs
      try { subs = fs.readdirSync(path.join(dir, entry.name)) } catch { continue }
      for (const sn of subs) {
        if (sn.toLowerCase().endsWith('.html')) {
          candidates.push({ rel: entry.name + '/' + sn, inSub: true })
        }
      }
    }
  }
  for (const cand of candidates) {
    const abs = safePath(dir, cand.rel)
    if (abs === null) { errors.push(cand.rel + '：路径越界，已跳过'); continue }
    let html
    try { html = fs.readFileSync(abs, 'utf8') } catch (error) {
      errors.push(cand.rel + '：读取失败 ' + String((error && error.message) || error)); continue
    }
    const result = extractMenu(html)
    if (result.menu === null) { errors.push(cand.rel + '：' + result.error); continue }
    /* 同一 id 去重：新版（子目录）优先。 */
    const existing = workbenches.findIndex((w) => w.id === result.menu.id)
    if (existing >= 0) {
      if (cand.inSub && !workbenches[existing].__inSub) workbenches[existing] = Object.assign({}, result.menu, { file: cand.rel, __inSub: true })
      else continue
    } else {
      workbenches.push(Object.assign({}, result.menu, { file: cand.rel, __inSub: cand.inSub }))
    }
  }
  /* 对外不暴露内部去重标记。 */
  for (const w of workbenches) delete w.__inSub
  return { workbenches, errors }
}

function findWorkbench(id, htmlDir) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null
  return listWorkbenches(htmlDir).workbenches.find((w) => w.id === id) || null
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
/**
 * 组装本地工作台列表（不写响应）。
 *
 * 抽出来是为了和在线列表**合并**：接入在线资料库后本地工作台仍然要出现在列表里
 * （以前 `/workbench/list` 在线可用就直接返回在线结果，本地工作台整体消失）。
 *
 * @param {string} dataDir 数据目录
 * @param {number} syncIntervalMs 同步间隔
 * @returns {Record<string, any>} 列表载荷
 */
export function buildWorkbenchList(dataDir, syncIntervalMs) {
  /* HTML 与 CSV 共用数据目录：HTML 在根（legacy）或 <id>/ 子目录（新布局），CSV 在 <id>/ 子目录。 */
  const effectiveDir = workbenchHtmlDir(dataDir)
  const result = listWorkbenches(effectiveDir)
  return {
    ok: true,
    source: 'local',
    workbenches: result.workbenches,
    errors: result.errors,
    htmlDir: effectiveDir,
    dataDir: effectiveDir,
    defaultDataDir: WORKBENCH_DIR,
    usingDefaultDataDir: effectiveDir === WORKBENCH_DIR,
    dataDirReady: localWorkbenchDirError(effectiveDir) === '',
    syncIntervalMs: normalizeSyncIntervalMs(syncIntervalMs)
  }
}

export function handleWorkbenchList(res, params, dataDir, syncIntervalMs) {
  sendJson(res, buildWorkbenchList(dataDir, syncIntervalMs))
}

/**
 * 合并「在线」与「本地」两个工作台列表。
 *
 * 接入在线资料库后，本地工作台必须仍然可见 —— 两边的 id 空间本来就不同
 * （在线是 `khub-<nodeId>`，本地是目录名），同 id 时以在线为准去重。
 * 目录树 / 空间列表只有在线有，原样保留；本地目录信息单独挂在 local* 字段上。
 *
 * @param {Record<string, any>} online 在线列表载荷
 * @param {Record<string, any>} local 本地列表载荷
 * @returns {Record<string, any>} 合并结果
 */
export function mergeWorkbenchLists(online, local) {
  const onlineWorkbenches = Array.isArray(online.workbenches) ? online.workbenches : []
  const localWorkbenches = Array.isArray(local.workbenches) ? local.workbenches : []
  const onlineIds = new Set(onlineWorkbenches.map((w) => w.id))
  const localOnly = localWorkbenches.filter((w) => !onlineIds.has(w.id))
  return Object.assign({}, online, {
    workbenches: onlineWorkbenches.concat(localOnly),
    errors: (Array.isArray(online.errors) ? online.errors : []).concat(local.errors || []),
    localCount: localOnly.length,
    localDataDir: local.dataDir,
    localHtmlDir: local.htmlDir,
    localDataDirReady: local.dataDirReady,
  })
}

/**
 * GET /workbench/html?workbench=<id>，注入 postMessage 桥脚本。
 *
 * 注入只发生在 HTTP 响应文本上，磁盘 HTML 字节不变；BRIDGE_SOURCE 保持原样。
 * 页面外观（含配色 / 主题）由 HTML 自己控制，插件不再注入任何样式或主题变量。
 * @param {import('node:http').ServerResponse} res 响应对象
 * @param {URLSearchParams} params 查询参数
 * @param {string|null|undefined} dataDir 当前数据目录（HTML 与 CSV 共用）
 * @returns {void}
 */
export function handleWorkbenchHtml(res, params, dataDir) {
  const id = params.get('workbench') || ''
  const htmlDir = workbenchHtmlDir(dataDir)
  const menu = findWorkbench(id, htmlDir)
  if (menu === null) { sendJson(res, { ok: false, error: '工作台不存在或 id 非法：' + id }, 404); return }
  const abs = safePath(htmlDir, menu.file)
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
  const effectiveDir = workbenchHtmlDir(dataDir)
  const dirError = localWorkbenchDirError(effectiveDir)
  if (dirError !== '') { sendJson(res, { ok: false, error: dirError }, 400); return }
  const menu = findWorkbench(id, effectiveDir)
  if (menu === null) { sendJson(res, { ok: false, error: '工作台不存在' }, 404); return }
  const table = findTable(menu, tableName)
  if (table === null) { sendJson(res, { ok: false, error: '数据表不存在：' + tableName }, 404); return }
  const file = dataFile(effectiveDir, id, table.file)
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
  /* 大文件走索引分页：100 万行的对象数组在 Node 里能吃 1GB+ 内存，
     而且整表 JSON 也塞不进浏览器。小文件保持原来的全量返回，行为不变。 */
  const pageParam = params.get('page')
  const wantsPaged = pageParam !== null && pageParam !== '' || size > LARGE_BYTES
  if (wantsPaged === true && table !== null) {
    let index
    try {
      index = ensureIndex(file)
    } catch (error) {
      sendJson(res, { ok: false, error: '建立行索引失败：' + String((error && error.message) || error) }, 500)
      return
    }
    const totalRows = dataRowCount(index)
    const pageSize = Math.min(2000, Math.max(1, Number(params.get('pageSize')) || 200))
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize))
    const page = Math.min(Math.max(1, Number(pageParam) || 1), totalPages)
    const startRow = (page - 1) * pageSize
    let rows
    try {
      rows = readPage(file, index, startRow, pageSize)
    } catch (error) {
      sendJson(res, { ok: false, error: '读取分页失败：' + String((error && error.message) || error) }, 500)
      return
    }
    /* 行标识用**全局行号**而不是随机 _id：随机 id 每次翻页都会变，前端没法稳定引用。 */
    const withRow = rows.map((row, i) => Object.assign({}, row, { __row: startRow + i }))
    const headers = readHeaders(file, index)
    sendJson(res, {
      ok: true,
      workbench: id,
      table: table.file,
      columns: headers.length > 0 ? headers : table.keys,
      fields: table.fields,
      rows: withRow,
      page,
      pageSize,
      startRow,
      totalRows,
      totalPages,
      large: true,
      hash: currentHash,
      mtimeMs,
      size,
      changed: true
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

/**
 * `POST /workbench/cell`：单行单元格更新（大表专用）。
 *
 * 整表写在大文件上不现实（百万行既传不动也存不住），这里按**行号**定位，
 * 只重写文件、不构造内存矩阵。行号是数据行下标（0 起，不含表头）。
 *
 * body：`{ workbench, table, row, col, value, baseHash? }`
 */
export function handleWorkbenchCellPost(res, body, dataDir) {
  const id = String((body && body.workbench) || '')
  const tableName = String((body && body.table) || '')
  const row = Number(body && body.row)
  const col = String((body && body.col) || '')
  const value = body && body.value !== undefined && body.value !== null ? String(body.value) : ''
  const baseHash = String((body && body.baseHash) || '')
  const effectiveDir = workbenchHtmlDir(dataDir)
  const dirError = localWorkbenchDirError(effectiveDir)
  if (dirError !== '') { sendJson(res, { ok: false, error: dirError }, 400); return }
  const menu = findWorkbench(id, effectiveDir)
  if (menu === null) { sendJson(res, { ok: false, error: '工作台不存在' }, 404); return }
  const table = findTable(menu, tableName)
  if (table === null) { sendJson(res, { ok: false, error: '数据表不存在：' + tableName }, 404); return }
  const file = dataFile(effectiveDir, id, table.file)
  if (file === null) { sendJson(res, { ok: false, error: '数据表路径越界' }, 400); return }
  if (!Number.isInteger(row) || row < 0) { sendJson(res, { ok: false, error: '行号非法' }, 400); return }
  if (col === '') { sendJson(res, { ok: false, error: '列名不能为空' }, 400); return }
  const before = fileHash(file)
  if (baseHash !== '' && baseHash !== before) {
    sendJson(res, { ok: false, code: 'conflict', error: '数据表已被其他窗口修改，请刷新后重试', hash: before }, 409)
    return
  }
  try {
    const index = ensureIndex(file)
    const headers = readHeaders(file, index)
    const colIdx = headers.indexOf(col)
    if (colIdx < 0) { sendJson(res, { ok: false, error: '列不存在：' + col }, 400); return }
    const lineNo = row + 1
    if (lineNo >= index.totalLines) { sendJson(res, { ok: false, error: '行不存在：' + row }, 400); return }
    const values = readLine(file, index, lineNo)
    while (values.length <= colIdx) values.push('')
    values[colIdx] = value
    writeLine(file, index, lineNo, values)
    sendJson(res, { ok: true, hash: fileHash(file), row, col, value, size: fs.statSync(file).size })
  } catch (error) {
    sendJson(res, { ok: false, error: String((error && error.message) || error) }, 500)
  }
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
  await handleWorkbenchDataPostBody(res, payload, dataDir)
}

/**
 * POST /workbench/data 的「已解析请求体」版本。
 *
 * 拆出来是因为上层要先看 workbench id 才知道该走本地还是在线镜像，
 * 而请求体只能读一次（`readBody` 消费流）。
 * @param {import('node:http').ServerResponse} res 响应
 * @param {object} payload 已解析的请求体
 * @param {string} dataDir 工作台数据目录
 * @returns {Promise<void>} 无返回值
 */
export async function handleWorkbenchDataPostBody(res, payload, dataDir) {
  const effectiveDir = workbenchHtmlDir(dataDir)
  const dirError = localWorkbenchDirError(effectiveDir)
  if (dirError !== '') { sendJson(res, { ok: false, error: dirError }, 400); return }
  const id = typeof payload.workbench === 'string' ? payload.workbench : ''
  const menu = findWorkbench(id, effectiveDir)
  if (menu === null) { sendJson(res, { ok: false, error: '工作台不存在' }, 404); return }
  const table = findTable(menu, payload.table)
  if (table === null) { sendJson(res, { ok: false, error: '数据表不存在' }, 404); return }
  const file = dataFile(effectiveDir, id, table.file)
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
  WORKBENCH_DIR, workbenchHtmlDir, safePath, localWorkbenchDirError, fileHash, sendHtml, listWorkbenches,
  handleWorkbenchList, handleWorkbenchHtml, handleWorkbenchBridge, handleWorkbenchDataGet,
  handleWorkbenchDataPost, handleWorkbenchDataPostBody
}
