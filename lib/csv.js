/**
 * dsh-buddy-expert-hub — 零依赖 CSV 读写：RFC4180 引号转义、字段内逗号/换行、UTF-8 BOM、CRLF/LF、原子写。
 * @module dsh-buddy-expert-hub/csv
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

/** 解析 CSV 文本；列数与表头不一致时抛错。 */
export function parseCsv(raw) {
  let text = String(raw === null || raw === undefined ? '' : raw)
  const bom = text.charCodeAt(0) === 0xFEFF
  if (bom) text = text.slice(1)
  const lineEnding = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n'
  const lines = []
  let row = [], field = '', quoted = false, i = 0
  while (i < text.length) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        quoted = false; i++; continue
      }
      field += ch; i++; continue
    }
    if (ch === '"' && field === '') { quoted = true; i++; continue }
    if (ch === ',') { row.push(field); field = ''; i++; continue }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      lines.push(row); row = []; i++; continue
    }
    field += ch; i++
  }
  if (quoted) throw new Error('CSV 引号未闭合')
  if (field !== '' || row.length > 0) { row.push(field); lines.push(row) }
  while (lines.length > 0 && lines[lines.length - 1].every((v) => v === '')) lines.pop()
  if (lines.length === 0) return { columns: [], rows: [], lineEnding, bom }
  const columns = lines[0].map(String)
  const rows = []
  for (let n = 1; n < lines.length; n += 1) {
    const cells = lines[n]
    if (cells.length !== columns.length) {
      throw new Error('CSV 第 ' + String(n + 1) + ' 行列数 ' + String(cells.length) + ' 与表头 ' + String(columns.length) + ' 不一致')
    }
    const obj = {}
    columns.forEach((key, idx) => { obj[key] = cells[idx] })
    rows.push(obj)
  }
  return { columns, rows, lineEnding, bom }
}

function escapeCell(value) {
  const s = value === null || value === undefined ? '' : String(value)
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

/** 序列化；写回沿用原文件的换行风格。 */
export function stringifyCsv(columns, rows, lineEnding) {
  const eol = lineEnding === '\r\n' ? '\r\n' : '\n'
  const out = [columns.map(escapeCell).join(',')]
  rows.forEach((row) => out.push(columns.map((key) => escapeCell(row[key])).join(',')))
  return out.join(eol) + eol
}

/** 按字段名对齐列的合并写：新列留空，已有列按 key 取值（不按位置）。 */
export function mergeColumns(nextColumns, nextRows) {
  return nextRows.map((row) => {
    const out = {}
    nextColumns.forEach((key) => {
      out[key] = row[key] === undefined || row[key] === null ? '' : String(row[key])
    })
    return out
  })
}

/** 稳定行标识：缺失时生成随机 _id，不改动已有 _id。 */
export function ensureRowId(columns, rows) {
  const hasId = columns.includes('_id')
  const cols = hasId ? columns.slice() : ['_id'].concat(columns)
  const out = rows.map((row) => {
    const copy = Object.assign({}, row)
    if (hasId && typeof copy._id === 'string' && copy._id !== '') return copy
    copy._id = randomBytes(8).toString('hex')
    return copy
  })
  return { columns: cols, rows: out }
}

/** 读取 CSV 文件；不存在时返回空表。 */
export function readCsv(file) {
  let buf
  try { buf = fs.readFileSync(file) } catch (error) {
    if (error !== null && error.code === 'ENOENT') {
      return { columns: [], rows: [], lineEnding: '\n', bom: false, missing: true }
    }
    throw error
  }
  const text = buf.toString('utf8')
  if (text.indexOf('\uFFFD') >= 0) throw new Error('CSV 不是有效 UTF-8 编码，请转码后重试')
  return Object.assign(parseCsv(text), { missing: false })
}

/** tmp -> rename 原子写，避免外部程序读到半截文件。 */
export function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.' + String(process.pid) + '.' + String(Date.now()) + '.' + randomBytes(4).toString('hex') + '.tmp'
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx' })
    fs.renameSync(tmp, file)
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch { /* 清理失败不覆盖原始错误 */ }
    throw error
  }
}

export default { parseCsv, stringifyCsv, mergeColumns, ensureRowId, readCsv, atomicWrite }
