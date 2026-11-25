/**
 * 大 CSV 的行偏移索引 + 分页读取。
 *
 * 与 Spring 端 CsvLargeStore 同一套思路：只记每行起始字节（100 万行 = 8MB），
 * 之后按页 seek 只读需要的那几行，绝不把整表解析成对象数组
 * （100 万行 × 几列的对象在 Node 里能吃掉 1GB+）。
 *
 * 只把 `\n` 当行分隔（引号内的不算），与 csv.js 的解析器对 CRLF 的处理一致：
 * CRLF 里的 `\r` 留在行尾，解析时当作普通字符；孤立的 `\r`（早期 Mac）不支持。
 */

import fs from 'node:fs'
import { parseCsv, escapeCell, atomicWrite } from './csv.js'

/** 超过这个字节数就按「大文件」分页返回：5MB 约 8 万行，小文件仍走原来的全量路径。 */
export const LARGE_BYTES = 5 * 1024 * 1024

/** 索引缓存：file -> { mtimeMs, size, offsets }。文件改动（mtime/size 变化）自动重建。 */
const cache = new Map()
const CACHE_MAX = 6

/**
 * 取（或重建）行索引。
 * @param {string} file CSV 绝对路径
 * @returns {{ offsets: Float64Array, size: number, mtimeMs: number, totalLines: number }}
 */
export function ensureIndex(file) {
  const st = fs.statSync(file)
  const hit = cache.get(file)
  if (hit !== undefined && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    return hit
  }
  const offsets = scanOffsets(file, st.size)
  const entry = { offsets, size: st.size, mtimeMs: st.mtimeMs, totalLines: Math.max(0, offsets.length - 1) }
  cache.set(file, entry)
  while (cache.size > CACHE_MAX) {
    const first = cache.keys().next()
    if (first.done === true) break
    cache.delete(first.value)
  }
  return entry
}

/** 文件索引失效（写入后调用，避免读到旧偏移）。 */
export function invalidateIndex(file) {
  cache.delete(file)
}

/**
 * 扫描行首字节偏移。
 * @param {string} file 文件路径
 * @param {number} size 文件大小
 * @returns {Float64Array} offsets[i] = 第 i 行起始字节；末尾哨兵 = 文件大小
 */
function scanOffsets(file, size) {
  if (size === 0) return Float64Array.of(0, 0)
  const starts = [0]
  const fd = fs.openSync(file, 'r')
  try {
    const chunk = Buffer.allocUnsafe(1 << 16)
    let pos = 0
    let inQuotes = false
    let read = 0
    while ((read = fs.readSync(fd, chunk, 0, chunk.length, pos)) > 0) {
      for (let i = 0; i < read; i += 1) {
        const byte = chunk[i]
        if (byte === 34) { /* " */
          inQuotes = !inQuotes
        } else if (byte === 10 && inQuotes === false) { /* \n */
          const next = pos + i + 1
          if (next < size) starts.push(next)
        }
      }
      pos += read
    }
  } finally {
    fs.closeSync(fd)
  }
  starts.push(size)
  return Float64Array.from(starts)
}

/** 读文件中一段字节。 */
function readRange(file, start, length) {
  if (length <= 0) return Buffer.alloc(0)
  const out = Buffer.allocUnsafe(length)
  const fd = fs.openSync(file, 'r')
  try {
    let read = 0
    while (read < length) {
      const n = fs.readSync(fd, out, read, length - read, start + read)
      if (n <= 0) break
      read += n
    }
    return read === length ? out : out.subarray(0, read)
  } finally {
    fs.closeSync(fd)
  }
}

/** 表头（0 = 表头行）。 */
export function readHeaders(file, index) {
  if (index.totalLines <= 0) return []
  const bytes = readRange(file, index.offsets[0], index.offsets[1] - index.offsets[0])
  const parsed = parseCsv(bytes.toString('utf8'))
  return parsed.columns.length > 0 ? parsed.columns : []
}

/**
 * 按数据行分页读取（不含表头）。
 * @param {string} file 文件
 * @param {object} index ensureIndex 的返回值
 * @param {number} fromDataRow 起始数据行（0 起）
 * @param {number} count 最多多少行
 * @returns {Array<Record<string, string>>} 该页的行对象
 */
export function readPage(file, index, fromDataRow, count) {
  const total = Math.max(0, index.totalLines - 1)
  const from = Math.max(0, Math.min(fromDataRow, total))
  const to = Math.max(from, Math.min(from + count, total))
  if (to <= from) return []
  /* offsets[0] 是表头，所以数据行 i 对应下标 i+1。 */
  const start = index.offsets[from + 1]
  const end = index.offsets[to + 1]
  /* 🔴 必须把表头行拼在切片前面再交给 parseCsv：
     parseCsv 会把「输入的第一行」当表头，只切数据行的话首行会被吃掉，
     于是每页少一行、列名变成第一行的值（实测踩过）。 */
  const headerText = readRange(file, index.offsets[0], index.offsets[1] - index.offsets[0]).toString('utf8')
  const pageText = readRange(file, start, end - start).toString('utf8')
  const parsed = parseCsv(headerText + pageText)
  return parsed.rows
}

/** 数据行总数。 */
export function dataRowCount(index) {
  return Math.max(0, index.totalLines - 1)
}

/** 按位置把一组单元格序列化成一行 CSV（RFC4180 转义）。 */
function serializeLine(values) {
  return (values || []).map((v) => escapeCell(v === null || v === undefined ? '' : String(v))).join(',')
}

/**
 * 读指定行（0 = 表头）的单元格数组。
 * @returns {string[]} 该行值
 */
export function readLine(file, index, lineNo) {
  if (lineNo < 0 || lineNo >= index.totalLines) return []
  const start = index.offsets[lineNo]
  const end = index.offsets[lineNo + 1]
  const parsed = parseCsv(readRange(file, start, end - start).toString('utf8'))
  return parsed.columns.length > 0 ? parsed.columns : []
}

/**
 * 把第 lineNo 行替换成 values，原子写回（head + 新行 + tail）。
 *
 * 百万行时是「重写整个文件」（58MB ≈ 数百毫秒），换来的是**不需要把全表读进内存**；
 * 等长修改的就地覆写在 Node 侧收益不大，先保持简单可靠。
 *
 * @returns {number} 新文件字节数
 */
export function writeLine(file, index, lineNo, values) {
  if (lineNo < 0 || lineNo >= index.totalLines) {
    throw new Error('行不存在：' + lineNo)
  }
  const size = index.size
  const from = index.offsets[lineNo]
  const to = index.offsets[lineNo + 1]
  const head = readRange(file, 0, from)
  const tail = readRange(file, to, size - to)
  const line = Buffer.from(serializeLine(values) + '\n', 'utf8')
  const next = Buffer.concat([head, line, tail])
  atomicWrite(file, next)
  invalidateIndex(file)
  return next.length
}
