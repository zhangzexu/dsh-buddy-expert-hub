/**
 * dsh-buddy-expert-hub — 外部数据定时摄入（ingest）。
 *
 * 场景：用户需要定时从别处取数据（行情、报表、表单导出…），在线工作台跑不了代码，
 * 由 dsh 自动化任务执行用户自己的 python / node 脚本采集，再把结果交给本模块。
 *
 * 设计要点（为什么不是「脚本直接调在线接口」）：
 *  - 脚本只产出批次文件，不持有任何凭据、不关心在线资料库在哪台机器、断网也能写；
 *  - 本地镜像文件（`<dataDir>/<workbench>/<table>.csv`）是这台机器的权威副本，
 *    断网时工作台页面照常读它，等联网后由本模块补推；
 *  - 在线只推「变化的部分」：优先走单元格 / 追加行这类意图接口，
 *    变化太多才退回整表覆盖（带 baseVersion 乐观锁，冲突自动重读重算）；
 *  - 幂等：batchId + 内容 checksum 记账，同一批次重复投递不会写两遍；
 *  - 分批：单批行数按 chunkRows 切块处理，避免一次吃满内存、也让进度可报告。
 *
 * 零依赖，只用 Node 内置模块。
 * @module dsh-buddy-expert-hub/ingest
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { readCsv, stringifyCsv, atomicWrite, ensureRowId } from './csv.js'
import { safePath, fileHash, localWorkbenchDirError } from './workbench.js'
import { api } from './knowledge-hub.js'

/** 摄入引擎默认参数（可在请求体里逐项覆盖）。 */
export const INGEST_DEFAULTS = {
  /** 单批行的分块大小：一次处理多少行，也是进度上报的粒度。 */
  chunkRows: 2000,
  /** 整表覆盖前的变化量阈值：变化格数 + 新增行数不超过它就只推增量。 */
  deltaMax: 200,
  /** 单批最大行数，超过就请脚本自己拆分（防止一次吃爆内存）。 */
  maxRowsPerBatch: 200000,
  /** 在线 409 冲突后的重算次数。 */
  retries: 2,
  /** inbox 自动扫描间隔（毫秒）。 */
  pollMs: 60000,
  /** 已处理记录保留条数。 */
  keepApplied: 500,
}

const BATCH_ID_RE = /^[A-Za-z0-9._:-]{1,120}$/
const WORKBENCH_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/i
const TABLE_FILE_RE = /^[A-Za-z0-9._-]+\.csv$/
const MODES = ['upsert', 'append', 'replace']

/** 可判定的摄入错误：status 直接用于 HTTP 响应码。 */
export class IngestError extends Error {
  /**
   * @param {string} message 中文可读信息
   * @param {string} code 机器码（invalid-batch / no-data-dir / write-failed / online-failed）
   * @param {number} status HTTP 状态码
   */
  constructor(message, code, status) {
    super(message)
    this.name = 'IngestError'
    this.code = String(code || 'ingest')
    this.status = Number(status || 400)
  }
}

/* ------------------------------------------------------------------ 目录与状态 */

/**
 * 摄入目录布局。
 * @param {string} baseDir 插件数据根目录（`~/.dsh/dsh-buddy-expert-hub`）
 * @returns {{root: string, inbox: string, done: string, failed: string, pending: string, state: string}}
 */
export function ingestPaths(baseDir) {
  const root = path.join(String(baseDir), 'ingest')
  return {
    root,
    inbox: path.join(root, 'inbox'),
    done: path.join(root, 'done'),
    failed: path.join(root, 'failed'),
    pending: path.join(root, 'pending.json'),
    state: path.join(root, 'state.json'),
  }
}

/**
 * 建目录（幂等）。脚本可以先把批次写进 inbox，即使插件还没启动过。
 * @param {string} baseDir 插件数据根目录
 * @returns {{root: string, inbox: string, done: string, failed: string, pending: string, state: string}} 目录布局
 */
export function ensureIngestDirs(baseDir) {
  const paths = ingestPaths(baseDir)
  for (const dir of [paths.root, paths.inbox, paths.done, paths.failed]) {
    try { fs.mkdirSync(dir, { recursive: true }) } catch { /* 只读环境：后续写入会明确报错 */ }
  }
  return paths
}

function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    atomicWrite(file, JSON.stringify(value, null, 2) + '\n')
  } catch { /* 记账失败不影响数据写入，下次最多重做一遍（幂等兜底） */ }
}

/** 读取幂等账本；结构坏了就当空的，不让一条坏记录卡住整条链路。 */
function readState(baseDir) {
  const paths = ingestPaths(baseDir)
  const raw = readJson(paths.state, {})
  return {
    applied: raw.applied !== null && typeof raw.applied === 'object' ? raw.applied : {},
    lastRun: typeof raw.lastRun === 'string' ? raw.lastRun : '',
    lastError: typeof raw.lastError === 'string' ? raw.lastError : '',
    recent: Array.isArray(raw.recent) ? raw.recent.slice(-50) : [],
  }
}

function saveState(baseDir, next) {
  const paths = ingestPaths(baseDir)
  const applied = next.applied !== null && typeof next.applied === 'object' ? next.applied : {}
  const keys = Object.keys(applied)
  if (keys.length > INGEST_DEFAULTS.keepApplied) {
    /* 记账只需覆盖「最近可能重复投递」的批次，按时间砍掉最老的一半 */
    const sorted = keys.sort((a, b) => String(applied[a].at || '').localeCompare(String(applied[b].at || '')))
    for (const key of sorted.slice(0, keys.length - INGEST_DEFAULTS.keepApplied)) delete applied[key]
  }
  writeJson(paths.state, {
    applied,
    lastRun: next.lastRun || '',
    lastError: next.lastError || '',
    recent: Array.isArray(next.recent) ? next.recent.slice(-50) : [],
  })
}

/** 待补推队列：按 `工作台|表` 去重，同一张表只留最后一次待推。 */
function readPending(baseDir) {
  const raw = readJson(ingestPaths(baseDir).pending, {})
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
}

function savePending(baseDir, value) {
  writeJson(ingestPaths(baseDir).pending, value)
}

/* ------------------------------------------------------------------ 批次校验 */

/**
 * 把一行（数组或对象）归一成对象，缺列补空串。
 * @param {any} row 原始行
 * @param {string[]} columns 列名
 * @param {number} index 行号（报错用，1 起）
 * @returns {Record<string, string>} 归一后的行
 */
function rowToObject(row, columns, index) {
  if (Array.isArray(row)) {
    if (columns.length === 0) throw new IngestError('第 ' + String(index) + ' 行是数组，但没给 columns')
    if (row.length !== columns.length) {
      throw new IngestError('第 ' + String(index) + ' 行列数 ' + String(row.length) + ' 与 columns 的 ' + String(columns.length) + ' 不一致')
    }
    const out = {}
    columns.forEach((key, i) => { out[key] = row[i] === undefined || row[i] === null ? '' : String(row[i]) })
    return out
  }
  if (row !== null && typeof row === 'object') {
    const out = {}
    for (const key of Object.keys(row)) {
      const value = row[key]
      out[key] = value === undefined || value === null ? '' : String(value)
    }
    return out
  }
  throw new IngestError('第 ' + String(index) + ' 行既不是数组也不是对象')
}

/**
 * 校验并归一一个批次。字段说明见 docs/user-guide.md「外部数据定时更新」。
 * @param {any} raw 脚本产出的 JSON
 * @returns {{batchId: string, workbench: string, table: string, mode: string,
 *   primaryKey: string[], columns: string[], rows: Record<string, string>[],
 *   source: string, producedAt: string}} 归一后的批次
 */
export function normalizeBatch(raw) {
  if (raw === null || raw === undefined || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new IngestError('批次必须是 JSON 对象')
  }
  const batchId = String(raw.batchId === null || raw.batchId === undefined ? '' : raw.batchId).trim()
  if (!BATCH_ID_RE.test(batchId)) {
    throw new IngestError('batchId 缺失或含非法字符（允许字母、数字、点、下划线、冒号、短横线，最长 120）')
  }
  const workbench = String(raw.workbench === null || raw.workbench === undefined ? '' : raw.workbench).trim()
  if (!WORKBENCH_ID_RE.test(workbench)) {
    throw new IngestError('workbench 缺失或非法：应是工作台 id（在线为 khub-<节点id>，本地为工作台 id）')
  }
  const table = String(raw.table === null || raw.table === undefined ? '' : raw.table).trim()
  if (!TABLE_FILE_RE.test(table)) throw new IngestError('table 缺失或非法：应是 xxx.csv')
  const mode = String(raw.mode === null || raw.mode === undefined ? 'upsert' : raw.mode).trim().toLowerCase()
  if (MODES.indexOf(mode) < 0) throw new IngestError('mode 只支持 upsert / append / replace，收到：' + mode)

  const columns = (Array.isArray(raw.columns) ? raw.columns : [])
    .map((key) => String(key).trim()).filter((key) => key !== '' && key !== '_id')
  const pkRaw = Array.isArray(raw.primaryKey)
    ? raw.primaryKey
    : (typeof raw.primaryKey === 'string' ? String(raw.primaryKey).split(',') : [])
  const primaryKey = pkRaw.map((key) => String(key).trim()).filter((key) => key !== '')
  if (mode === 'upsert' && primaryKey.length === 0) {
    throw new IngestError('mode=upsert 必须给 primaryKey（主键列，可多列），否则无法判断哪一行是同一行')
  }

  const rowsRaw = Array.isArray(raw.rows) ? raw.rows : []
  if (rowsRaw.length === 0) throw new IngestError('rows 为空：没有可写入的数据')
  if (rowsRaw.length > INGEST_DEFAULTS.maxRowsPerBatch) {
    throw new IngestError('rows 有 ' + String(rowsRaw.length) + ' 行，超过单批上限 ' +
      String(INGEST_DEFAULTS.maxRowsPerBatch) + '，请脚本自行拆成多个批次')
  }

  const rows = rowsRaw.map((row, i) => rowToObject(row, columns, i + 1))
  const cols = columns.length > 0 ? columns : Object.keys(rows[0])
  if (cols.length === 0) throw new IngestError('无法确定列名：请给 columns，或用对象数组的键')
  for (const key of primaryKey) {
    if (cols.indexOf(key) < 0) throw new IngestError('primaryKey 里的「' + key + '」不在 columns 中')
  }
  rows.forEach((row, i) => {
    for (const key of primaryKey) {
      if (row[key] === undefined) throw new IngestError('第 ' + String(i + 1) + ' 行缺少主键列「' + key + '」')
    }
  })

  return {
    batchId,
    workbench,
    table,
    mode,
    primaryKey,
    columns: cols,
    rows: rows.map((row) => {
      const out = {}
      cols.forEach((key) => { out[key] = row[key] === undefined ? '' : row[key] })
      return out
    }),
    source: String(raw.source === null || raw.source === undefined ? '' : raw.source).slice(0, 200),
    producedAt: String(raw.producedAt === null || raw.producedAt === undefined ? '' : raw.producedAt).slice(0, 40),
  }
}

/**
 * 内容指纹：同一 batchId 内容变了要重做，内容没变就跳过。
 * @param {object} batch 归一后的批次
 * @returns {string} sha256 前 32 位
 */
export function checksumOf(batch) {
  const payload = JSON.stringify({
    mode: batch.mode,
    primaryKey: batch.primaryKey,
    columns: batch.columns,
    rows: batch.rows,
  })
  return createHash('sha256').update(payload, 'utf8').digest('hex').slice(0, 32)
}

/* ------------------------------------------------------------------ 合并（纯函数） */

/**
 * 主键串：多列用不可见分隔符拼，避免 `a|b` 与 `a` + `|b` 撞车。
 * 全空主键返回空串（= 不具备标识性），调用方按「新行」处理 —— 否则两行空白主键
 * 会被当成同一行互相覆盖。
 * @param {Record<string, string>} row 行
 * @param {string[]} primaryKey 主键列
 * @returns {string} 主键串，全空为 ''
 */
function keyOf(row, primaryKey) {
  const parts = primaryKey.map((key) => String(row[key] === undefined ? '' : row[key]))
  if (parts.every((part) => part === '')) return ''
  return parts.join('\u0001')
}

/**
 * 把批次合并进基线表。
 *
 * 语义：
 *  - `upsert`：按 primaryKey 匹配，命中就只覆盖批次里声明的列（用户其它列不动），没命中就追加；
 *  - `append`：全部追加；给了 primaryKey 时先按主键去重（已存在的跳过，避免重跑重复）；
 *  - `replace`：批次即全表（列也以批次为准）。
 *
 * 纯函数，不改入参，便于单独回归。
 * @param {{columns: string[], rows: Record<string, string>[]}} base 基线表
 * @param {object} batch 归一后的批次
 * @returns {{columns: string[], rows: Record<string, string>[], stats: {added: number, updated: number, unchanged: number, skipped: number, cells: number}}}
 */
export function mergeBatch(base, batch) {
  const stats = { added: 0, updated: 0, unchanged: 0, skipped: 0, cells: 0 }
  const baseColumns = base !== null && base !== undefined && Array.isArray(base.columns) ? base.columns : []
  const baseRows = base !== null && base !== undefined && Array.isArray(base.rows) ? base.rows : []

  if (batch.mode === 'replace') {
    const columns = batch.columns.slice()
    const rows = batch.rows.map((row) => {
      const out = {}
      columns.forEach((key) => { out[key] = row[key] === undefined ? '' : row[key] })
      return out
    })
    stats.added = rows.length
    return { columns, rows, stats }
  }

  const columns = baseColumns.slice()
  batch.columns.forEach((key) => { if (columns.indexOf(key) < 0 && key !== '_id') columns.push(key) })
  const rows = baseRows.map((row) => {
    const out = Object.assign({}, row)
    columns.forEach((key) => { if (out[key] === undefined) out[key] = '' })
    return out
  })

  const primaryKey = batch.primaryKey
  const index = new Map()
  if (primaryKey.length > 0) {
    rows.forEach((row, i) => {
      const key = keyOf(row, primaryKey)
      if (key !== '' && !index.has(key)) index.set(key, i)
    })
  }

  for (const source of batch.rows) {
    const key = primaryKey.length > 0 ? keyOf(source, primaryKey) : ''
    /* upsert 靠主键认行：主键为空的行没有身份，服务端会跳过它。
       本地也一起跳过，免得出现「本地有、在线没有」的分裂。append 不受影响（它只去重不认身份）。 */
    if (batch.mode === 'upsert' && key === '') { stats.skipped += 1; continue }
    const hit = key !== '' && batch.mode === 'upsert' ? index.get(key) : undefined
    if (hit !== undefined) {
      const target = rows[hit]
      let changed = 0
      batch.columns.forEach((col) => {
        const next = source[col] === undefined ? '' : source[col]
        if (String(target[col] === undefined ? '' : target[col]) !== String(next)) {
          target[col] = next
          changed += 1
        }
      })
      if (changed > 0) { stats.updated += 1; stats.cells += changed } else stats.unchanged += 1
      continue
    }
    if (key !== '' && batch.mode === 'append' && index.has(key)) { stats.skipped += 1; continue }
    const row = {}
    columns.forEach((col) => { row[col] = source[col] === undefined ? '' : source[col] })
    rows.push(row)
    if (key !== '') index.set(key, rows.length - 1)
    stats.added += 1
  }
  return { columns, rows, stats }
}

/* ------------------------------------------------------------------ 在线推送 */

/** CSV matrix → 对象行（与 khub-workbench 同形，这里独立实现避免互相引用）。 */
function matrixToRows(matrix) {
  const rows = Array.isArray(matrix) ? matrix : []
  const headers = rows.length === 0 ? [] : (Array.isArray(rows[0]) ? rows[0].map(String) : [])
  const out = []
  for (let i = 1; i < rows.length; i += 1) {
    const line = Array.isArray(rows[i]) ? rows[i] : []
    const row = {}
    headers.forEach((key, idx) => {
      row[key] = line[idx] === undefined || line[idx] === null ? '' : String(line[idx])
    })
    out.push(row)
  }
  return { columns: headers, rows: out }
}

/** 对象行 → CSV matrix。 */
function rowsToMatrix(columns, rows) {
  const cols = Array.isArray(columns) ? columns.map(String) : []
  const list = Array.isArray(rows) ? rows : []
  return [cols].concat(list.map((row) => cols.map((key) => {
    const value = row !== null && typeof row === 'object' ? row[key] : ''
    return value === undefined || value === null ? '' : String(value)
  })))
}

/**
 * 算出「要写哪些格、要追加哪些行」，以及各列在目标表里的下标。
 * @param {{columns: string[], rows: Record<string, string>[]}} online 在线当前表
 * @param {string[]} mirrorColumns 本地列
 * @param {Record<string, string>[]} mirrorRows 本地行
 * @param {string[]} primaryKey 主键列（空则用 _id 匹配）
 * @param {string[]} manageColumns 允许覆盖的列（空则全部列）
 * @returns {{cells: Array<{row: number, col: number, value: string}>, appends: string[][], added: number, updated: number}}
 */
export function planDelta(online, mirrorColumns, mirrorRows, primaryKey, manageColumns) {
  const onlineColumns = Array.isArray(online.columns) ? online.columns : []
  const onlineRows = Array.isArray(online.rows) ? online.rows : []
  const keys = primaryKey.length > 0 ? primaryKey : (onlineColumns.indexOf('_id') >= 0 ? ['_id'] : [])
  const index = new Map()
  if (keys.length > 0) {
    onlineRows.forEach((row, i) => {
      const key = keyOf(row, keys)
      if (key !== '' && !index.has(key)) index.set(key, i)
    })
  }
  /* `_id` 是本地行标识，永远不参与同步：既不当业务列比较，也不能因为它在线缺列就整表覆盖 */
  const managed = (manageColumns.length > 0 ? manageColumns : mirrorColumns)
    .filter((col) => col !== '_id')
  /* 在线还缺某个要管理的业务列：增量补不了列，直接让上层退回整表覆盖 */
  if (managed.some((col) => onlineColumns.indexOf(col) < 0)) {
    return { cells: [], appends: [], added: 0, updated: 0, needMatrix: true }
  }
  const cells = []
  const appends = []
  let updated = 0
  for (const row of mirrorRows) {
    const key = keys.length > 0 ? keyOf(row, keys) : ''
    const hit = key === '' ? undefined : index.get(key)
    if (hit === undefined) {
      /* 追加行必须按**在线表的列顺序**取值：本地镜像可能多出 `_id` 前缀，
         直接拿 mirrorColumns 顺序会把值错位（金额跑到备注里）。 */
      appends.push(onlineColumns.map((col) => (row[col] === undefined ? '' : row[col])))
      continue
    }
    let changed = false
    for (const col of managed) {
      const colIndex = onlineColumns.indexOf(col)
      const current = onlineRows[hit][col] === undefined ? '' : onlineRows[hit][col]
      const next = row[col] === undefined ? '' : row[col]
      if (String(current) !== String(next)) {
        cells.push({ row: hit + 1, col: colIndex, value: next })
        changed = true
      }
    }
    if (changed) updated += 1
  }
  return { cells, appends, added: appends.length, updated, needMatrix: false }
}

/** 服务端 upsert 单次行数上限（与后端 `CsvService.UPSERT_MAX_ROWS` 一致，超了会报「请分批提交」）。 */
export const SERVER_UPSERT_MAX_ROWS = 5000

/**
 * 单列主键：整批交给服务端按主键 upsert（`POST /api/nodes/{id}/csv/upsert`）。
 *
 * 为什么优先走它：服务端在文档锁内「匹配主键 → 只更新传入的列 / 未命中追加」，
 * 插件不必先读整表、也不必自己算差异，一次请求搞定；并发下也不会把别人刚改的
 * 其它行列冲掉。行对象只带批次声明的列，服务端 `replace=false` 就只动这些列。
 * @param {object} options 参数
 * @param {object} options.config 在线配置
 * @param {number|string} options.nodeId CSV 节点 id
 * @param {string} options.key 主键列名（单列）
 * @param {string[]} options.batchColumns 批次声明的列
 * @param {Record<string, string>[]} options.batchRows 本轮批次的行
 * @param {number} [options.chunkRows] 每批行数（再按 5000 上限夹一次）
 * @returns {Promise<object>} 推送结果
 */
async function upsertViaServer(options) {
  const config = options.config
  const nodeId = options.nodeId
  const batchColumns = Array.isArray(options.batchColumns) ? options.batchColumns : []
  const batchRows = Array.isArray(options.batchRows) ? options.batchRows : []
  const limit = Math.min(
    SERVER_UPSERT_MAX_ROWS,
    Number(options.chunkRows) > 0 ? Number(options.chunkRows) : SERVER_UPSERT_MAX_ROWS,
  )
  let inserted = 0
  let updated = 0
  let skipped = 0
  let version = 0
  let matrix = null
  const skippedKeys = []
  for (let i = 0; i < batchRows.length; i += limit) {
    const slice = batchRows.slice(i, i + limit).map((row) => {
      const out = {}
      batchColumns.forEach((col) => { out[col] = row[col] === undefined ? '' : row[col] })
      return out
    })
    let res = null
    try {
      res = await api.upsertCsv(config, nodeId, {
        key: String(options.key || ''),
        rows: slice,
        createMissing: true,
        replace: false,
        baseVersion: null,
      })
    } catch (error) {
      throw new IngestError(
        '在线按主键写入失败：' + String((error && error.message) || error),
        'online-failed',
        Number(error !== null && error !== undefined ? error.status || 502 : 502),
      )
    }
    inserted += Number(res !== null && res !== undefined ? res.inserted || 0 : 0)
    updated += Number(res !== null && res !== undefined ? res.updated || 0 : 0)
    skipped += Number(res !== null && res !== undefined ? res.skipped || 0 : 0)
    if (res !== null && res !== undefined && res.version !== undefined) version = Number(res.version)
    if (res !== null && res !== undefined && Array.isArray(res.matrix)) matrix = res.matrix
    if (res !== null && res !== undefined && Array.isArray(res.skippedKeys)) {
      res.skippedKeys.forEach((it) => skippedKeys.push(String(it)))
    }
  }
  return {
    mode: 'server-upsert',
    version,
    matrix,
    added: inserted,
    updated,
    skipped,
    cells: 0,
    skippedKeys: skippedKeys.slice(0, 20),
    upsertBatches: Math.max(1, Math.ceil(batchRows.length / limit)),
  }
}

/**
 * 这个失败能不能降级成逐格写入（而不是整批失败、进待补推）：
 *  - 404 / 405：在线资料库还没部署 `csv/upsert` 这版接口（旧后端）；
 *  - 「主键列不存在」：用户改过表头，服务端找不到这一列。
 * 两种情况数据都得写进去，只是换条路。
 * @param {any} error 失败对象
 * @returns {boolean} 是否可降级
 */
function canDegradeUpsert(error) {
  if (error === null || error === undefined) return false
  const status = Number(error.status || 0)
  if (status === 404 || status === 405) return true
  const message = String(error.message || '')
  return message.indexOf('主键列不存在') >= 0
}

/**
 * 整表覆盖（replace 模式、补推用）。带 baseVersion 乐观锁，409 重读重写。
 * @param {object} options config / nodeId / columns / rows / retries
 * @returns {Promise<object>} 推送结果
 */
async function pushReplaceMatrix(options) {
  const config = options.config
  const nodeId = options.nodeId
  const columns = Array.isArray(options.columns) ? options.columns : []
  const rows = Array.isArray(options.rows) ? options.rows : []
  const retries = Number(options.retries) >= 0 ? Number(options.retries) : INGEST_DEFAULTS.retries
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let version = 0
    try {
      const current = await api.csv(config, nodeId)
      version = Number(current !== null && current !== undefined && current.version !== undefined ? current.version : 0)
    } catch (error) {
      throw new IngestError('读取在线数据表失败：' + String((error && error.message) || error), 'online-failed', 502)
    }
    try {
      const matrix = rowsToMatrix(columns, rows)
      const result = await api.saveCsvMatrix(config, nodeId, matrix, version === 0 ? null : version)
      const nextVersion = Number(result !== null && result !== undefined && result.version !== undefined ? result.version : version + 1)
      return {
        mode: 'matrix',
        version: nextVersion,
        matrix: result !== null && result !== undefined && Array.isArray(result.matrix) ? result.matrix : matrix,
        added: rows.length,
        updated: 0,
        skipped: 0,
        cells: 0,
      }
    } catch (error) {
      lastError = error
      if (Number(error !== null && error !== undefined ? error.status || 0 : 0) !== 409) {
        throw new IngestError('写入在线数据表失败：' + String((error && error.message) || error), 'online-failed', 502)
      }
      /* 409：别人刚改过，重读一次再写。 */
    }
  }
  throw new IngestError('写入在线数据表持续冲突：' + String((lastError && lastError.message) || '请稍后重试'), 'online-conflict', 409)
}

/**
 * 逐格 + 追加行（多列主键、append、服务端缺主键列时的降级路径）。
 *
 * 变化小（格数 + 新增行 ≤ deltaMax）就走「改单元格 / 追加行」的意图接口，
 * 不动其它行其它列；变化大或要补列才整表覆盖，冲突（409）自动重读重算。
 * `appendOnly` 时只追加、绝不改已有单元格、也绝不整表覆盖 —— 那是 append 模式的语义。
 * @param {object} options config / nodeId / columns / rows / mode / primaryKey / manageColumns / deltaMax / retries / appendOnly
 * @returns {Promise<object>} 推送结果
 */
async function pushDelta(options) {
  const config = options.config
  const nodeId = options.nodeId
  const columns = Array.isArray(options.columns) ? options.columns : []
  const rows = Array.isArray(options.rows) ? options.rows : []
  const mode = String(options.mode || 'upsert')
  const primaryKey = Array.isArray(options.primaryKey) ? options.primaryKey : []
  const manageColumns = Array.isArray(options.manageColumns) ? options.manageColumns : []
  const deltaMax = Number(options.deltaMax) > 0 ? Number(options.deltaMax) : INGEST_DEFAULTS.deltaMax
  const retries = Number(options.retries) >= 0 ? Number(options.retries) : INGEST_DEFAULTS.retries
  const appendOnly = options.appendOnly === true

  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let current = null
    try {
      current = await api.csv(config, nodeId)
    } catch (error) {
      throw new IngestError('读取在线数据表失败：' + String((error && error.message) || error), 'online-failed', 502)
    }
    const version = Number(current !== null && current !== undefined && current.version !== undefined ? current.version : 0)
    const online = matrixToRows(current !== null && current !== undefined ? current.matrix : [])
    const plan = planDelta(online, columns, rows, primaryKey, managedOf(mode, columns, manageColumns))
    if (appendOnly === true) {
      /* append：只追加主键没命中的行，命中行一律不动 */
      plan.cells = []
      plan.updated = 0
      if (plan.added === 0) {
        return { mode: 'none', version, matrix: null, added: 0, updated: 0, skipped: 0, cells: 0 }
      }
      return await writeIncremental({ config, nodeId, plan, version })
    }
    if (plan.needMatrix !== true && plan.cells.length + plan.added <= deltaMax) {
      if (plan.cells.length === 0 && plan.added === 0) {
        return { mode: 'none', version, matrix: null, added: 0, updated: 0, skipped: 0, cells: 0 }
      }
      return await writeIncremental({ config, nodeId, plan, version })
    }
    try {
      const matrix = rowsToMatrix(columns, rows)
      const result = await api.saveCsvMatrix(config, nodeId, matrix, version === 0 ? null : version)
      const nextVersion = Number(result !== null && result !== undefined && result.version !== undefined ? result.version : version + 1)
      return {
        mode: 'matrix',
        version: nextVersion,
        matrix: result !== null && result !== undefined && Array.isArray(result.matrix) ? result.matrix : matrix,
        added: rows.length,
        updated: 0,
        skipped: 0,
        cells: 0,
      }
    } catch (error) {
      lastError = error
      if (Number(error !== null && error !== undefined ? error.status || 0 : 0) !== 409) {
        throw new IngestError('写入在线数据表失败：' + String((error && error.message) || error), 'online-failed', 502)
      }
      /* 409：别人刚改过，重读一次再算。 */
    }
  }
  throw new IngestError('写入在线数据表持续冲突：' + String((lastError && lastError.message) || '请稍后重试'), 'online-conflict', 409)
}

/**
 * 把本地数据推给在线，按模式选最省的那条路。
 *
 * | 场景 | 走法 |
 * | --- | --- |
 * | `replace` | 整表覆盖（带 baseVersion） |
 * | `upsert` + 单列主键 | 服务端按主键 upsert（一次请求，锁内合并） |
 * | `append` | 只追加主键未命中的行（逐行 `POST /csv/row`） |
 * | `upsert` + 多列主键 | 逐格改 + 追加行（服务端只支持单列主键） |
 *
 * 单列主键但在线表头里没有这一列时，自动降级为逐格路径，不让整批失败。
 * @param {object} options 参数
 * @param {object} options.config 在线配置
 * @param {number|string} options.nodeId CSV 节点 id
 * @param {string} [options.mode] 合并模式
 * @param {string[]} [options.primaryKey] 主键列
 * @param {string[]} [options.columns] 镜像列（replace / delta 用）
 * @param {Record<string, string>[]} [options.rows] 镜像行（replace / delta 用）
 * @param {string[]} [options.manageColumns] 允许覆盖的列
 * @param {string[]} [options.batchColumns] 批次声明的列（服务端 upsert 用）
 * @param {Record<string, string>[]} [options.batchRows] 本轮批次的行（服务端 upsert 用）
 * @param {number} [options.chunkRows] 服务端 upsert 每批行数
 * @param {number} [options.deltaMax] 增量阈值
 * @param {number} [options.retries] 冲突重算次数
 * @returns {Promise<{mode: string, version: number, matrix: string[][]|null, added: number,
 *   updated: number, skipped: number, cells: number, fallback?: string, fallbackReason?: string}>}
 */
export async function pushMirrorToOnline(options) {
  const mode = String(options.mode || 'upsert')
  const primaryKey = Array.isArray(options.primaryKey) ? options.primaryKey : []
  const batchRows = Array.isArray(options.batchRows) ? options.batchRows : []

  if (mode === 'replace') return pushReplaceMatrix(options)
  if (mode === 'append') return pushDelta(Object.assign({}, options, { appendOnly: true }))
  if (primaryKey.length === 1 && batchRows.length > 0) {
    try {
      return await upsertViaServer(Object.assign({}, options, { key: primaryKey[0] }))
    } catch (error) {
      if (canDegradeUpsert(error) !== true) throw error
      const fallback = await pushDelta(options)
      return Object.assign(fallback, {
        fallback: 'delta',
        fallbackReason: String((error && error.message) || error),
      })
    }
  }
  return pushDelta(options)
}

/** upsert 只覆盖批次声明的列；append / replace 传空表示全列。 */
function managedOf(mode, columns, manageColumns) {
  if (mode === 'upsert') return manageColumns.length > 0 ? manageColumns : columns
  return []
}

/**
 * 走意图接口：先改单元格，再追加行。每次调用都返回整表视图，最后一次的视图即最终结果。
 * @param {object} options config / nodeId / plan / version
 * @returns {Promise<{mode: string, version: number, matrix: string[][]|null, added: number, updated: number, cells: number}>}
 */
async function writeIncremental(options) {
  const { config, nodeId, plan } = options
  let version = Number(options.version || 0)
  let matrix = null
  for (const cell of plan.cells) {
    const view = await api.updateCell(config, nodeId, cell.row, cell.col, cell.value, null)
    if (view !== null && view !== undefined) {
      if (Array.isArray(view.matrix)) matrix = view.matrix
      if (view.version !== undefined) version = Number(view.version)
    }
  }
  for (const values of plan.appends) {
    const view = await api.appendCsvRow(config, nodeId, values, null, null)
    if (view !== null && view !== undefined) {
      if (Array.isArray(view.matrix)) matrix = view.matrix
      if (view.version !== undefined) version = Number(view.version)
    }
  }
  return {
    mode: 'incremental',
    version,
    matrix,
    added: plan.added,
    updated: plan.updated,
    skipped: 0,
    cells: plan.cells.length,
  }
}

/* ------------------------------------------------------------------ 主流程 */

/**
 * 本地镜像文件路径（与本地工作台同一套布局：`<dataDir>/<工作台>/<表>.csv`）。
 * @param {string} dataDir 工作台数据目录
 * @param {string} workbench 工作台 id
 * @param {string} table 表文件名
 * @returns {string|null} 绝对路径，越界为 null
 */
export function mirrorFileOf(dataDir, workbench, table) {
  const root = String(dataDir === null || dataDir === undefined ? '' : dataDir).trim()
  if (root === '' || !path.isAbsolute(root)) return null
  return safePath(root, path.join(String(workbench), String(table)))
}

/**
 * 读本地镜像；不存在返回 null（交给上层决定是否从在线拉基线）。
 * @param {string} file 镜像绝对路径
 * @returns {{columns: string[], rows: Record<string, string>[], hash: string, mtimeMs: number|null, size: number}|null}
 */
export function readMirrorFile(file) {
  if (file === null || file === undefined) return null
  let parsed
  try { parsed = readCsv(file) } catch (error) {
    throw new IngestError('读取本地镜像失败：' + String((error && error.message) || error), 'read-failed', 500)
  }
  if (parsed.missing === true) return null
  let mtimeMs = null
  let size = 0
  try { const st = fs.statSync(file); mtimeMs = st.mtimeMs; size = st.size } catch { /* 文件刚好被删 */ }
  return { columns: parsed.columns, rows: parsed.rows, hash: fileHash(file), mtimeMs, size, lineEnding: parsed.lineEnding }
}

/**
 * 写入本地镜像（带 `_id` 稳定行标识 + 原子写，外部程序读不到半截文件）。
 * @param {string} file 镜像绝对路径
 * @param {string[]} columns 列
 * @param {Record<string, string>[]} rows 行
 * @param {string} [lineEnding] 换行符（沿用原文件）
 * @returns {{columns: string[], rows: Record<string, string>[], hash: string}} 写入结果
 */
export function writeMirrorFile(file, columns, rows, lineEnding) {
  const withId = ensureRowId(columns, rows)
  try {
    atomicWrite(file, stringifyCsv(withId.columns, withId.rows, lineEnding === '\r\n' ? '\r\n' : '\n'))
  } catch (error) {
    throw new IngestError('写入本地镜像失败：' + String((error && error.message) || error), 'write-failed', 500)
  }
  return { columns: withId.columns, rows: withId.rows, hash: fileHash(file) }
}

/** 在线节点 id：`khub-<id>` + `node-<n>.csv` 才认，其它形状返回 0。 */
export function onlineNodeIdOf(workbench, table) {
  const bench = /^khub-(\d+)$/i.exec(String(workbench || ''))
  const rule = /^node-(\d+)\.csv$/i.exec(String(table || ''))
  if (bench === null || rule === null) return 0
  const id = Number(rule[1])
  return Number.isFinite(id) && id > 0 ? id : 0
}

/**
 * 处理一个批次：落本地镜像 + 推在线 + 记账。
 *
 * 顺序是刻意的：**先落本地**。本地写成功即认为「数据已到」，在线推失败只入待补推队列，
 * 这样断网时任务照样成功、页面照样能读到新数据，联网后自动补齐。
 * @param {object} options 参数
 * @param {string} options.baseDir 插件数据根目录
 * @param {string} [options.dataDir] 工作台数据目录
 * @param {object} options.batch 原始批次（未归一）
 * @param {object|null} [options.config] 在线配置（null 表示不推在线）
 * @param {boolean} [options.online] 是否尝试推在线
 * @param {number} [options.deltaMax] 增量阈值
 * @returns {Promise<object>} 处理结果（含 stats / local / online / warnings）
 */
export async function applyBatch(options) {
  const baseDir = String(options.baseDir || '')
  const dataDir = String(options.dataDir || '')
  const batch = normalizeBatch(options.batch)
  const config = options.config !== null && options.config !== undefined ? options.config : null
  const wantOnline = options.online !== false && config !== null
  const chunkRows = Number(options.chunkRows) > 0 ? Number(options.chunkRows) : INGEST_DEFAULTS.chunkRows

  const state = readState(baseDir)
  const checksum = checksumOf(batch)
  const seen = state.applied[batch.batchId]
  if (seen !== undefined && seen !== null && seen.checksum === checksum) {
    return {
      ok: true,
      skipped: true,
      batchId: batch.batchId,
      reason: '同一 batchId 且内容完全相同，已处理过（幂等跳过）',
      at: String(seen.at || ''),
    }
  }

  const warnings = []
  const file = mirrorFileOf(dataDir, batch.workbench, batch.table)
  const nodeId = onlineNodeIdOf(batch.workbench, batch.table)
  const isOnline = nodeId > 0

  if (file === null) {
    warnings.push(dataDir === ''
      ? '未配置工作台数据目录：本次只推在线，不落本地镜像'
      : '工作台数据目录非法或路径越界：本次只推在线')
  }
  if (isOnline === false && wantOnline === true) {
    /* 本地工作台没有在线节点，跳过在线这一步，不当作错误 */
    warnings.push('本地工作台「' + batch.workbench + '」没有对应的在线节点，只写本地')
  }

  /* 1) 基线：优先本地镜像；没有镜像且在线可用时拉一次在线当基线（保证不丢历史行） */
  let base = { columns: [], rows: [] }
  let lineEnding = '\n'
  if (file !== null) {
    try {
      const mirror = readMirrorFile(file)
      if (mirror !== null && mirror.columns.length > 0) {
        base = { columns: mirror.columns, rows: mirror.rows }
        lineEnding = mirror.lineEnding === '\r\n' ? '\r\n' : '\n'
      }
    } catch (error) { warnings.push(String((error && error.message) || error)) }
  }
  if (base.columns.length === 0 && isOnline === true && wantOnline === true) {
    try {
      const current = await api.csv(config, nodeId)
      const online = matrixToRows(current !== null && current !== undefined ? current.matrix : [])
      if (online.columns.length > 0) base = online
    } catch (error) {
      warnings.push('本地无镜像且在线读取失败，将只按批次建表：' + String((error && error.message) || error))
    }
  }

  /* 2) 分批合并（分块只为控制内存与进度粒度，合并结果与一次合完等价） */
  let merged = { columns: base.columns.slice(), rows: base.rows.slice() }
  const total = { added: 0, updated: 0, unchanged: 0, skipped: 0, cells: 0 }
  const chunks = Math.max(1, Math.ceil(batch.rows.length / chunkRows))
  for (let i = 0; i < chunks; i += 1) {
    const slice = Object.assign({}, batch, { rows: batch.rows.slice(i * chunkRows, (i + 1) * chunkRows) })
    const part = mergeBatch(merged, slice)
    merged = { columns: part.columns, rows: part.rows }
    total.added += part.stats.added
    total.updated += part.stats.updated
    total.unchanged += part.stats.unchanged
    total.skipped += part.stats.skipped
    total.cells += part.stats.cells
  }

  /* 3) 落本地镜像 */
  let local = { written: false, file: file === null ? '' : file, hash: '', rows: merged.rows.length }
  if (file !== null) {
    const wrote = writeMirrorFile(file, merged.columns, merged.rows, lineEnding)
    merged = { columns: wrote.columns, rows: wrote.rows }
    local = { written: true, file, hash: wrote.hash, rows: wrote.rows.length }
  }

  /* 4) 推在线（只推变化；失败入待补推队列，不抛给调用方） */
  const online = { attempted: false, ok: false, mode: 'none', added: 0, updated: 0, skipped: 0, cells: 0, version: 0, error: '', queued: false }
  if (wantOnline === true && isOnline === true) {
    online.attempted = true
    try {
      const pushed = await pushMirrorToOnline({
        config,
        nodeId,
        /* replace / delta 用整份镜像 */
        columns: merged.columns,
        rows: merged.rows,
        /* 服务端 upsert 只发本轮批次的行与列（历史行不必重发） */
        batchColumns: batch.columns,
        batchRows: batch.rows,
        mode: batch.mode,
        primaryKey: batch.primaryKey,
        manageColumns: batch.mode === 'upsert' ? batch.columns : [],
        chunkRows,
        deltaMax: options.deltaMax,
        retries: options.retries,
      })
      online.ok = true
      online.mode = pushed.mode
      online.added = pushed.added
      online.updated = pushed.updated
      online.skipped = Number(pushed.skipped || 0)
      online.cells = pushed.cells
      online.version = pushed.version
      if (pushed.fallback !== undefined) {
        online.fallback = pushed.fallback
        warnings.push('服务端按主键写入降级为逐格增量：' + String(pushed.fallbackReason || ''))
      }
      /* 在线返回的整表就是合并结果：回写镜像，保证「本地 = 在线」，别人的新增也留在本地 */
      if (pushed.matrix !== null && file !== null) {
        const final = matrixToRows(pushed.matrix)
        if (final.columns.length > 0) {
          const wrote = writeMirrorFile(file, final.columns, final.rows, lineEnding)
          merged = { columns: wrote.columns, rows: wrote.rows }
          local = { written: true, file, hash: wrote.hash, rows: wrote.rows.length }
        }
      }
    } catch (error) {
      online.error = String((error && error.message) || error)
      online.queued = true
      warnings.push('在线推送失败，已进入待补推队列：' + online.error)
    }
  }

  /* 5) 记账：成功即记；只有在线推送失败时保留待补推 */
  const pending = readPending(baseDir)
  const pendingKey = batch.workbench + '|' + batch.table
  if (online.queued === true) {
    pending[pendingKey] = {
      workbench: batch.workbench,
      table: batch.table,
      nodeId,
      primaryKey: batch.primaryKey,
      managedColumns: batch.mode === 'upsert' ? batch.columns : [],
      mode: batch.mode,
      batchId: batch.batchId,
      at: new Date().toISOString(),
      attempts: Number((pending[pendingKey] || {}).attempts || 0) + 1,
      lastError: online.error,
    }
    savePending(baseDir, pending)
  } else if (pending[pendingKey] !== undefined) {
    delete pending[pendingKey]
    savePending(baseDir, pending)
  }

  const at = new Date().toISOString()
  state.applied[batch.batchId] = { checksum, at, rows: merged.rows.length, online: online.ok }
  state.lastRun = at
  if (warnings.length > 0) state.lastError = warnings[warnings.length - 1]
  state.recent = state.recent.concat([{
    at,
    batchId: batch.batchId,
    workbench: batch.workbench,
    table: batch.table,
    mode: batch.mode,
    added: total.added,
    updated: total.updated,
    cells: total.cells,
    skipped: total.skipped,
    onlineSkipped: online.skipped,
    rows: merged.rows.length,
    online: online.mode,
    fallback: online.fallback || '',
    ok: online.ok || online.attempted === false,
  }]).slice(-50)
  saveState(baseDir, state)

  return {
    ok: true,
    skipped: false,
    batchId: batch.batchId,
    workbench: batch.workbench,
    table: batch.table,
    mode: batch.mode,
    chunks,
    stats: total,
    local,
    online,
    warnings,
    at,
  }
}

/* ------------------------------------------------------------------ inbox 与补推 */

/**
 * 扫描 `ingest/inbox/` 并逐个处理；成功归档到 done/，失败留到 failed/。
 * @param {object} options baseDir / dataDir / config / online / deltaMax
 * @returns {Promise<{processed: number, skipped: number, failed: number, results: object[]}>}
 */
export async function processInbox(options) {
  const baseDir = String(options.baseDir || '')
  const paths = ensureIngestDirs(baseDir)
  let names = []
  try {
    names = fs.readdirSync(paths.inbox).filter((n) => n.toLowerCase().endsWith('.json')).sort()
  } catch {
    return { processed: 0, skipped: 0, failed: 0, results: [] }
  }
  const results = []
  let processed = 0
  let skipped = 0
  let failed = 0
  for (const name of names) {
    const from = path.join(paths.inbox, name)
    let raw = null
    try {
      raw = JSON.parse(fs.readFileSync(from, 'utf8'))
    } catch (error) {
      failed += 1
      const message = '不是合法 JSON：' + String((error && error.message) || error)
      results.push({ file: name, ok: false, error: message })
      try {
        fs.writeFileSync(path.join(paths.failed, name + '.error.txt'), message + '\n', 'utf8')
        fs.renameSync(from, path.join(paths.failed, name))
      } catch { /* 归档失败下次再试 */ }
      continue
    }
    try {
      const out = await applyBatch(Object.assign({}, options, { batch: raw }))
      results.push(Object.assign({ file: name }, out))
      if (out.skipped === true) skipped += 1
      else processed += 1
      try { fs.renameSync(from, path.join(paths.done, name)) } catch { /* 同批次会因幂等被跳过 */ }
    } catch (error) {
      failed += 1
      const message = String((error && error.message) || error)
      results.push({ file: name, ok: false, error: message, code: error !== null && error !== undefined ? error.code : '' })
      try {
        fs.writeFileSync(path.join(paths.failed, name + '.error.txt'), message + '\n', 'utf8')
        fs.renameSync(from, path.join(paths.failed, name))
      } catch { /* 归档失败下次再试 */ }
    }
  }
  return { processed, skipped, failed, results }
}

/**
 * 补推所有待补推的表：从本地镜像读出最新内容整表推给在线。
 *
 * 为什么补推用整表而不是增量：待推期间本地可能被页面/脚本改过多次，
 * 逐次重算增量成本更高也更容易错；整表一次推平，代价只是带宽。
 * @param {object} options baseDir / dataDir / config
 * @returns {Promise<{flushed: number, failed: number, results: object[]}>}
 */
export async function flushPending(options) {
  const baseDir = String(options.baseDir || '')
  const dataDir = String(options.dataDir || '')
  const config = options.config !== null && options.config !== undefined ? options.config : null
  if (config === null) return { flushed: 0, failed: 0, results: [] }
  const pending = readPending(baseDir)
  const keys = Object.keys(pending)
  const results = []
  let flushed = 0
  let failed = 0
  for (const key of keys) {
    const item = pending[key]
    const nodeId = Number(item.nodeId || 0) > 0 ? Number(item.nodeId) : onlineNodeIdOf(item.workbench, item.table)
    if (nodeId === 0) {
      delete pending[key]
      results.push({ key, ok: false, error: '没有对应的在线节点，已移出队列' })
      failed += 1
      continue
    }
    const file = mirrorFileOf(dataDir, item.workbench, item.table)
    if (file === null) {
      results.push({ key, ok: false, error: '工作台数据目录不可用，保留待补推' })
      failed += 1
      continue
    }
    let mirror = null
    try { mirror = readMirrorFile(file) } catch (error) {
      results.push({ key, ok: false, error: String((error && error.message) || error) })
      failed += 1
      continue
    }
    if (mirror === null) {
      results.push({ key, ok: false, error: '本地镜像不存在，保留待补推' })
      failed += 1
      continue
    }
    try {
      const pushed = await pushMirrorToOnline({
        config,
        nodeId,
        columns: mirror.columns,
        rows: mirror.rows,
        mode: 'replace',
        primaryKey: [],
        manageColumns: [],
        deltaMax: Number(options.deltaMax) > 0 ? Number(options.deltaMax) : INGEST_DEFAULTS.deltaMax,
      })
      if (pushed.matrix !== null) {
        const final = matrixToRows(pushed.matrix)
        if (final.columns.length > 0) writeMirrorFile(file, final.columns, final.rows, mirror.lineEnding)
      }
      delete pending[key]
      flushed += 1
      results.push({ key, ok: true, mode: pushed.mode, version: pushed.version })
    } catch (error) {
      item.attempts = Number(item.attempts || 0) + 1
      item.lastError = String((error && error.message) || error)
      item.at = new Date().toISOString()
      failed += 1
      results.push({ key, ok: false, error: item.lastError })
    }
  }
  savePending(baseDir, pending)
  return { flushed, failed, results }
}

/**
 * 摄入状态：给面板用（inbox 待处理数、待补推数、最近记录）。
 * @param {object} options baseDir / dataDir
 * @returns {object} 状态对象
 */
export function ingestStatus(options) {
  const baseDir = String(options.baseDir || '')
  const dataDir = String(options.dataDir || '')
  const paths = ingestPaths(baseDir)
  let inbox = []
  let failed = []
  try { inbox = fs.readdirSync(paths.inbox).filter((n) => n.toLowerCase().endsWith('.json')).sort() } catch { inbox = [] }
  try { failed = fs.readdirSync(paths.failed).filter((n) => n.toLowerCase().endsWith('.json')).sort() } catch { failed = [] }
  const state = readState(baseDir)
  const pending = readPending(baseDir)
  const appliedCount = Object.keys(state.applied).length
  return {
    ok: true,
    dataDir: dataDir !== '' && localWorkbenchDirError(dataDir) === '' ? dataDir : '',
    dataDirError: dataDir === '' ? '未配置工作台数据目录' : localWorkbenchDirError(dataDir),
    ingestDir: paths.root,
    inboxDir: paths.inbox,
    inboxCount: inbox.length,
    inboxFiles: inbox.slice(0, 20),
    failedCount: failed.length,
    failedFiles: failed.slice(0, 10),
    pendingCount: Object.keys(pending).length,
    pending: Object.keys(pending).map((key) => ({
      key,
      workbench: pending[key].workbench,
      table: pending[key].table,
      attempts: pending[key].attempts,
      lastError: pending[key].lastError,
      at: pending[key].at,
    })),
    appliedCount,
    lastRun: state.lastRun,
    lastError: state.lastError,
    recent: state.recent.slice(-20).reverse(),
    defaults: INGEST_DEFAULTS,
  }
}

/**
 * 镜像兜底读：在线不可用时让 `khub-*` 工作台页面还能读到本机镜像。
 * 响应结构与 `handleKhubWorkbenchDataGet` 一致，前端无需区分。
 * @param {import('node:http').ServerResponse} res 响应
 * @param {URLSearchParams} params workbench / table / hash
 * @param {string} dataDir 工作台数据目录
 * @returns {boolean} 是否已经响应（镜像不存在返回 false，交给上层报错）
 */
export function sendMirrorDataGet(res, params, dataDir) {
  const workbench = String(params.get('workbench') || '')
  const table = String(params.get('table') || '')
  const probeHash = String(params.get('hash') || '')
  const file = mirrorFileOf(dataDir, workbench, table)
  if (file === null) return false
  let mirror = null
  try { mirror = readMirrorFile(file) } catch { return false }
  if (mirror === null) return false
  if (probeHash !== '' && probeHash === mirror.hash) {
    sendJson(res, {
      ok: true, changed: false, workbench, table,
      hash: mirror.hash, mtimeMs: mirror.mtimeMs, size: mirror.size, source: 'mirror',
    })
    return true
  }
  const withId = ensureRowId(mirror.columns, mirror.rows)
  sendJson(res, {
    ok: true,
    workbench,
    table,
    columns: withId.columns,
    rows: withId.rows,
    hash: mirror.hash,
    mtimeMs: mirror.mtimeMs,
    size: mirror.size,
    lineEnding: mirror.lineEnding,
    changed: probeHash !== '',
    source: 'mirror',
  })
  return true
}

/**
 * 镜像兜底写：在线不可用时页面保存写本地，同时挂待补推，联网后自动推到在线。
 * @param {object} payload 页面提交的 {workbench, table, baseHash, columns, rows}
 * @param {string} dataDir 工作台数据目录
 * @param {string} baseDir 插件数据根目录
 * @returns {{ok: boolean, status: number, body: object}}
 */
export function writeMirrorFromPayload(payload, dataDir, baseDir) {
  const workbench = String(payload !== null && payload !== undefined ? payload.workbench || '' : '')
  const table = String(payload !== null && payload !== undefined ? payload.table || '' : '')
  const file = mirrorFileOf(dataDir, workbench, table)
  if (file === null) {
    return { ok: false, status: 400, body: { ok: false, error: '工作台数据目录不可用：' + String(dataDir || '未配置') } }
  }
  const baseHash = String(payload !== null && payload !== undefined ? payload.baseHash || '' : '')
  const current = readMirrorFile(file)
  const currentHash = current === null ? '' : current.hash
  if (currentHash !== baseHash) {
    return {
      ok: false,
      status: 409,
      body: {
        ok: false, code: 'conflict', error: '数据表已在外部被修改，已重新加载，请确认后重试',
        current: current === null ? null : { columns: current.columns, rows: current.rows, hash: current.hash },
      },
    }
  }
  const columns = Array.isArray(payload.columns) && payload.columns.length > 0
    ? payload.columns.map(String)
    : (current === null ? [] : current.columns)
  if (columns.length === 0) {
    return { ok: false, status: 400, body: { ok: false, error: '缺少 columns，无法写入' } }
  }
  if (columns.some((key) => !/^[A-Za-z0-9_\u4e00-\u9fa5]+$/.test(key))) {
    return { ok: false, status: 400, body: { ok: false, error: '字段名只能包含字母、数字、下划线或汉字' } }
  }
  const rows = Array.isArray(payload.rows) ? payload.rows : []
  const merged = mergeColumnsForWrite(columns, rows)
  const wrote = writeMirrorFile(file, columns, merged, current === null ? '\n' : current.lineEnding)
  /* 挂待补推：联网后由 flushPending 整表推平 */
  const nodeId = onlineNodeIdOf(workbench, table)
  if (nodeId > 0) {
    const pending = readPending(baseDir)
    pending[workbench + '|' + table] = {
      workbench, table, nodeId,
      primaryKey: [], managedColumns: [], mode: 'replace',
      batchId: 'offline-write',
      at: new Date().toISOString(),
      attempts: Number((pending[workbench + '|' + table] || {}).attempts || 0),
      lastError: '离线保存，等待联网补推',
    }
    savePending(baseDir, pending)
  }
  return { ok: true, status: 200, body: { ok: true, hash: wrote.hash, columns: wrote.columns, rows: wrote.rows, source: 'mirror' } }
}

/** 按字段名对齐（同 lib/csv.js mergeColumns，这里内联避免多一层导入语义）。 */
function mergeColumnsForWrite(columns, rows) {
  return rows.map((row) => {
    const out = {}
    columns.forEach((key) => {
      const value = row !== null && typeof row === 'object' ? row[key] : ''
      out[key] = value === undefined || value === null ? '' : String(value)
    })
    return out
  })
}

/** 与 lib/workbench.js 的 sendJson 同形。 */
function sendJson(res, body, status) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8')
  try {
    if (typeof res.on === 'function') res.on('error', () => {})
    res.writeHead(Number.isFinite(Number(status)) ? Number(status) : 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    })
    res.end(buf)
  } catch { /* 已被断开：静默放弃 */ }
}

export default {
  INGEST_DEFAULTS,
  IngestError,
  ingestPaths,
  ensureIngestDirs,
  normalizeBatch,
  checksumOf,
  mergeBatch,
  planDelta,
  pushMirrorToOnline,
  mirrorFileOf,
  readMirrorFile,
  writeMirrorFile,
  onlineNodeIdOf,
  applyBatch,
  processInbox,
  flushPending,
  ingestStatus,
  sendMirrorDataGet,
  writeMirrorFromPayload,
}
