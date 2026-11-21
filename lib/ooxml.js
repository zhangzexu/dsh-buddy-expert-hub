/**
 * 轻量 OOXML 读写（docx / xlsx / pptx），零依赖：zip 用 Node 自带 zlib 实现。
 *
 * 设计取舍与在线版 BUILTIN 编辑器一致：**只改文本 / 单元格值，其余 XML 原样保留**，
 * 所以 Word 的版式、PowerPoint 的排版都不会被重建破坏；Excel 同样保留公式、样式与
 * 其它工作表结构，只替换被编辑单元格的值。
 *
 * @module dsh-buddy-expert-hub/ooxml
 */
import zlib from 'node:zlib'

/* ------------------------------------------------------------------ */
/* ZIP：读（支持 store / deflate）与写（统一 deflate）                     */
/* ------------------------------------------------------------------ */

/**
 * 解析 zip 为「文件名 → 内容」。
 * @param {Buffer} buf zip 字节
 * @returns {Map<string, Buffer>} 条目表
 */
export function unzip(buf) {
  /* 从尾部找 End of Central Directory（EOCD 签名 0x06054b50） */
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 66560; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('不是合法的 zip / OOXML 文件')
  const total = buf.readUInt16LE(eocd + 10)
  let ptr = buf.readUInt32LE(eocd + 16)
  const out = new Map()
  for (let i = 0; i < total; i += 1) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) break
    const method = buf.readUInt16LE(ptr + 10)
    const compSize = buf.readUInt32LE(ptr + 20)
    const nameLen = buf.readUInt16LE(ptr + 28)
    const extraLen = buf.readUInt16LE(ptr + 30)
    const commentLen = buf.readUInt16LE(ptr + 32)
    const localOff = buf.readUInt32LE(ptr + 42)
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen)
    /* 本地头长度可变，必须按本地头里的长度跳过文件名与 extra */
    const lNameLen = buf.readUInt16LE(localOff + 26)
    const lExtraLen = buf.readUInt16LE(localOff + 28)
    const dataStart = localOff + 30 + lNameLen + lExtraLen
    const raw = buf.subarray(dataStart, dataStart + compSize)
    if (!name.endsWith('/')) {
      out.set(name, method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw))
    }
    ptr += 46 + nameLen + extraLen + commentLen
  }
  return out
}

/**
 * 把「文件名 → 内容」写回 zip。统一用 deflate；目录条目自动补。
 * @param {Map<string, Buffer|string>} files 条目表（字符串按 UTF-8 处理）
 * @returns {Buffer} zip 字节
 */
export function zip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, value] of files) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
    const comp = zlib.deflateRawSync(data)
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) /* UTF-8 文件名 */
    local.writeUInt16LE(8, 8) /* deflate */
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBuf, comp)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(comp.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)

    offset += local.length + nameBuf.length + comp.length
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(files.size, 8)
  eocd.writeUInt16LE(files.size, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralBuf, eocd])
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/* ------------------------------------------------------------------ */
/* XML 小工具                                                          */
/* ------------------------------------------------------------------ */
export function decodeXml(text) {
  return String(text)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')
}

export function encodeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/* ------------------------------------------------------------------ */
/* DOCX：按段落读写文本（保留 run 格式）                                    */
/* ------------------------------------------------------------------ */

/**
 * 读出文档段落文本。
 * @param {Map<string, Buffer>} entries zip 条目
 * @returns {{ kind: 'doc', paragraphs: string[] }}
 */
export function readDocx(entries) {
  const file = entries.get('word/document.xml')
  if (file === undefined) throw new Error('不是有效的 Word 文档（缺少 word/document.xml）')
  const xml = file.toString('utf8')
  const paragraphs = []
  /* 自闭合 <w:p/> 也是空段落，必须一并收进来 */
  const re = /<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g
  let m
  while ((m = re.exec(xml)) !== null) {
    const texts = []
    const tre = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g
    let t
    while ((t = tre.exec(m[0])) !== null) texts.push(decodeXml(t[1]))
    paragraphs.push(texts.join(''))
  }
  return { kind: 'doc', paragraphs }
}

/**
 * 用新段落文本回写 document.xml。
 * 一段里可能有多个 run：把整段文本写进第一个 <w:t>，其余清空，格式取第一个 run 的。
 * @param {Map<string, Buffer>} entries zip 条目
 * @param {string[]} paragraphs 段落文本
 * @returns {Map<string, Buffer>} 新的 zip 条目
 */
export function writeDocx(entries, paragraphs) {
  const file = entries.get('word/document.xml')
  if (file === undefined) throw new Error('不是有效的 Word 文档（缺少 word/document.xml）')
  let xml = file.toString('utf8')
  let index = 0
  xml = xml.replace(/<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g, (block) => {
    const text = paragraphs[index] === undefined ? null : paragraphs[index]
    index += 1
    if (text === null) return block
    if (/^<w:p(?:\s[^>]*)?\/>$/.test(block)) {
      const open = block.replace(/\/>$/, '>')
      return open + '<w:r><w:t xml:space="preserve">' + encodeXml(text) + '</w:t></w:r></w:p>'
    }
    let used = false
    const next = block.replace(/<w:t(\s[^>]*)?>[\s\S]*?<\/w:t>/g, (node, attrs) => {
      if (used) return '<w:t xml:space="preserve"></w:t>'
      used = true
      const keep = attrs !== undefined && /xml:space/.test(attrs) ? attrs : ' xml:space="preserve"'
      return '<w:t' + keep + '>' + encodeXml(text) + '</w:t>'
    })
    if (used) return next
    /* 整段没有 <w:t>（纯图片/空段）：插入一个最小 run */
    return block.replace(/<\/w:p>$/, '<w:r><w:t xml:space="preserve">' + encodeXml(text) + '</w:t></w:r></w:p>')
  })
  const out = new Map(entries)
  out.set('word/document.xml', Buffer.from(xml, 'utf8'))
  return out
}

/* ------------------------------------------------------------------ */
/* XLSX：按工作表读写单元格值                                              */
/* ------------------------------------------------------------------ */

function sheetPaths(entries) {
  const names = []
  const workbook = entries.get('xl/workbook.xml')
  if (workbook !== undefined) {
    const xml = workbook.toString('utf8')
    const re = /<sheet[^>]*name="([^"]*)"[^>]*r:id="([^"]*)"[^>]*\/>/g
    let m
    while ((m = re.exec(xml)) !== null) names.push({ name: decodeXml(m[1]), rid: m[2] })
  }
  const rels = entries.get('xl/_rels/workbook.xml.rels')
  const relMap = {}
  if (rels !== undefined) {
    const xml = rels.toString('utf8')
    const re = /<Relationship[^>]*Id="([^"]*)"[^>]*Target="([^"]*)"[^>]*\/>/g
    let m
    while ((m = re.exec(xml)) !== null) relMap[m[1]] = m[2].replace(/^\/?xl\//, '')
  }
  return names.map((it, i) => {
    const target = relMap[it.rid]
    return { name: it.name || 'Sheet' + String(i + 1), path: target === undefined ? null : 'xl/' + target }
  })
}

function sharedStrings(entries) {
  const file = entries.get('xl/sharedStrings.xml')
  if (file === undefined) return []
  const xml = file.toString('utf8')
  const out = []
  const re = /<si>([\s\S]*?)<\/si>/g
  let m
  while ((m = re.exec(xml)) !== null) {
    const texts = []
    const tre = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g
    let t
    while ((t = tre.exec(m[1])) !== null) texts.push(decodeXml(t[1]))
    out.push(texts.join(''))
  }
  return out
}

/**
 * 读出工作簿（每个工作表一张字符串矩阵）。
 * @param {Map<string, Buffer>} entries zip 条目
 * @returns {{ kind: 'sheet', sheets: Array<{ name: string, rows: string[][] }> }}
 */
export function readXlsx(entries) {
  const sheets = sheetPaths(entries)
  const sst = sharedStrings(entries)
  const result = []
  for (const sheet of sheets) {
    if (sheet.path === null || entries.get(sheet.path) === undefined) {
      result.push({ name: sheet.name, rows: [] })
      continue
    }
    const xml = entries.get(sheet.path).toString('utf8')
    const rows = []
    const rre = /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g
    let rm
    while ((rm = rre.exec(xml)) !== null) {
      const rowIndex = Number(rm[1]) - 1
      const cells = []
      const cre = /<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g
      let cm
      while ((cm = cre.exec(rm[2])) !== null) {
        const attrs = String(cm[1] === undefined ? cm[2] : cm[1])
        const inner = cm[3] === undefined ? '' : cm[3]
        const ref = /r="([A-Z]+)\d+"/.exec(attrs)
        const colIndex = ref === null ? cells.length : columnIndex(ref[1])
        const type = /t="([^"]*)"/.exec(attrs)
        let value = ''
        if (type !== null && type[1] === 's') {
          const v = /<v>([\s\S]*?)<\/v>/.exec(inner)
          const idx = v === null ? -1 : Number(v[1])
          value = sst[idx] === undefined ? '' : sst[idx]
        } else if (type !== null && type[1] === 'inlineStr') {
          const texts = []
          const tre = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g
          let t
          while ((t = tre.exec(inner)) !== null) texts.push(decodeXml(t[1]))
          value = texts.join('')
        } else {
          const v = /<v>([\s\S]*?)<\/v>/.exec(inner)
          value = v === null ? '' : decodeXml(v[1])
        }
        while (cells.length < colIndex) cells.push('')
        cells[colIndex] = value
      }
      while (rows.length < rowIndex) rows.push([])
      rows[rowIndex] = cells
    }
    result.push({ name: sheet.name, rows })
  }
  return { kind: 'sheet', sheets: result }
}

function columnIndex(letters) {
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function columnName(index) {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

/**
 * 把矩阵写回工作表：只替换有值的单元格，保留公式 / 样式 / 其它行列。
 * 字符串统一写成 inlineStr，避免污染 sharedStrings（多单元格共享同一串）。
 * @param {Map<string, Buffer>} entries zip 条目
 * @param {Array<{ name: string, rows: string[][] }>} sheets 工作表矩阵
 * @returns {Map<string, Buffer>} 新的 zip 条目
 */
export function writeXlsx(entries, sheets) {
  const paths = sheetPaths(entries)
  const out = new Map(entries)
  sheets.forEach((sheet, i) => {
    const target = paths[i]
    if (target === undefined || target.path === null || entries.get(target.path) === undefined) return
    let xml = entries.get(target.path).toString('utf8')
    const rows = Array.isArray(sheet.rows) ? sheet.rows : []
    xml = xml.replace(/<row[^>]*r="(\d+)"[^>]*>[\s\S]*?<\/row>/g, (block, rno) => {
      const rowIndex = Number(rno) - 1
      const values = rows[rowIndex]
      if (values === undefined) return block
      let next = block
      let cellIndex = 0
      next = next.replace(/<c\b[^>]*\/>|<c\b[^>]*>[\s\S]*?<\/c>/g, (cell) => {
        const ref = /r="([A-Z]+)\d+"/.exec(cell)
        const col = ref === null ? cellIndex : columnIndex(ref[1])
        cellIndex = col + 1
        /* 公式单元格保留原样：写值会丢掉 <f>，公式由 Excel 自己算 */
        if (/<f[ >]/.test(cell)) return cell
        const raw = values[col]
        if (raw === undefined) return cell
        const text = String(raw)
        const attrs = /<c\b([^>]*)>/.exec(cell) === null ? '' : /<c\b([^>]*)>/.exec(cell)[1]
        const base = attrs.replace(/\st="[^"]*"/g, '')
        const keepStyle = base
        const isNumber = text !== '' && /^-?\d+(\.\d+)?$/.test(text)
        if (text === '') return '<c' + keepStyle + '></c>'
        if (isNumber) return '<c' + keepStyle + '><v>' + text + '</v></c>'
        return '<c' + keepStyle + ' t="inlineStr"><is><t xml:space="preserve">' + encodeXml(text) + '</t></is></c>'
      })
      return next
    })
    out.set(target.path, Buffer.from(xml, 'utf8'))
  })
  return out
}

/* ------------------------------------------------------------------ */
/* PPTX：只读（按页取文本）                                                */
/* ------------------------------------------------------------------ */
export function readPptx(entries) {
  const slides = []
  const names = [...entries.keys()]
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(/(\d+)/.exec(a)[1]) - Number(/(\d+)/.exec(b)[1]))
  for (const name of names) {
    const xml = entries.get(name).toString('utf8')
    const texts = []
    const re = /<a:t>([\s\S]*?)<\/a:t>/g
    let m
    while ((m = re.exec(xml)) !== null) texts.push(decodeXml(m[1]))
    slides.push(texts)
  }
  return { kind: 'pptx', slides }
}

/**
 * 判断文件类型并读出可编辑模型。
 * @param {Buffer} buf 文件字节
 * @param {string} name 文件名
 * @returns {{ kind: string, [key: string]: any }} 模型
 */
export function readOffice(buf, name) {
  const entries = unzip(buf)
  const lower = String(name || '').toLowerCase()
  if (lower.endsWith('.docx') || lower.endsWith('.docm')) return readDocx(entries)
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) return readXlsx(entries)
  if (lower.endsWith('.pptx') || lower.endsWith('.ppsx')) return readPptx(entries)
  throw new Error('内置编辑器只支持 docx / xlsx / pptx；旧格式（.doc/.xls/.ppt）请用「下载」后用本地 Office 编辑')
}

/**
 * 按模型回写 OOXML 字节。
 * @param {Buffer} buf 原文件字节
 * @param {string} name 文件名
 * @param {any} model 编辑后的模型
 * @returns {Buffer} 新文件字节
 */
export function writeOffice(buf, name, model) {
  const entries = unzip(buf)
  const lower = String(name || '').toLowerCase()
  if (lower.endsWith('.docx') || lower.endsWith('.docm')) {
    return zip(writeDocx(entries, Array.isArray(model.paragraphs) ? model.paragraphs : []))
  }
  if (lower.endsWith('.xlsx') || lower.endsWith('.xlsm')) {
    return zip(writeXlsx(entries, Array.isArray(model.sheets) ? model.sheets : []))
  }
  throw new Error('该类型暂不支持保存')
}
