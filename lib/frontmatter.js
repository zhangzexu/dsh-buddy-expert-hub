/**
 * dsh-buddy-expert-hub — YAML frontmatter 解析（host 半与构建脚本共用）。
 *
 * 这套解析原本在两个地方各写了一份（`lib/index.js` 解析市场里的 SKILL.md、
 * `scripts/build-connectors.mjs` 生成离线快照），结果同一个「YAML 块标量」缺陷
 * 也各犯了一次：`description: >-` 只取到标符本身，正文整段丢掉。
 * 现在只保留这一份实现，两边都 import 它。
 *
 * 能力范围（够用即可，不做完整 YAML）：
 *  - 顶层与嵌套的 `key: value` 单行标量（嵌套键按扁平化取值，兼容 `metadata:\n  author: x`）；
 *  - 块标量 `key: |` / `key: >` / `key: |-` / `key: >-` / `key: |2` 等，按缩进收集正文；
 *  - 忽略空行、`#` 注释行与 `- ` 列表项。
 *
 * 零依赖，仅使用语言内置能力。
 *
 * @module dsh-buddy-expert-hub/frontmatter
 */

/** 块标量的起始标记：`|` 或 `>`，可带 chomping 指示符（`-`/`+`）与缩进数字。 */
const BLOCK_SCALAR_RE = /^[|>][-+]?\d*$/

/**
 * 去掉标量两端的引号。
 * @param {any} value 原始值
 * @returns {string} 去引号后的值
 */
export function unquote(value) {
  const text = String(value === null || value === undefined ? '' : value).trim()
  if (text.length < 2) return text
  const first = text.charAt(0)
  const last = text.charAt(text.length - 1)
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) return text.slice(1, -1)
  return text
}

/**
 * 判断某个值是不是 YAML 块标量标记（`|` / `>-` / `>`）。
 * @param {any} value 原始值
 * @returns {boolean} 是否块标量标记
 */
export function isBlockScalarMarker(value) {
  return BLOCK_SCALAR_RE.test(String(value === null || value === undefined ? '' : value).trim())
}

/**
 * 收集块标量的缩进正文。
 *
 * 起始行的键在第 `keyLine` 行，正文从下一行开始、必须是缩进行；
 * 一旦遇到顶格行说明块已结束（空块同样如此，绝不能把下一行的键吞进来）。
 *
 * @param {string[]} lines frontmatter 全文按行切分
 * @param {number} keyLine 键所在行号
 * @returns {{ text: string, lastLine: number }} 正文与最后消费的行号
 */
function collectBlockScalar(lines, keyLine) {
  const collected = []
  let indent = -1
  let lastLine = keyLine
  for (let i = keyLine + 1; i < lines.length; i += 1) {
    const body = lines[i]
    if (body.trim() === '') {
      collected.push('')
      lastLine = i
      continue
    }
    const spaces = body.length - body.replace(/^\s+/, '').length
    if (spaces === 0) break
    if (indent < 0) indent = spaces
    if (spaces < indent) break
    collected.push(body.slice(indent))
    lastLine = i
  }
  while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop()
  return { text: collected.join('\n'), lastLine }
}

/**
 * 解析 markdown 顶部的 YAML frontmatter。
 * @param {string} text 文件全文
 * @returns {Record<string, string>} 键值表（块标量已按语义拼成整段文本）
 */
export function parseFrontmatter(text) {
  if (typeof text !== 'string') return {}
  const matched = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (matched === null) return {}
  const lines = matched[1].split(/\r?\n/)
  /** @type {Record<string, string>} */
  const out = {}
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('- ')) continue
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    if (!/^[A-Za-z0-9_-]+$/.test(key)) continue
    if (Object.prototype.hasOwnProperty.call(out, key)) continue
    const rest = line.slice(idx + 1).trim()

    if (BLOCK_SCALAR_RE.test(rest)) {
      const block = collectBlockScalar(lines, i)
      i = block.lastLine
      // `|` 保留换行，`>` 折叠成空格；最终长度由调用方 tidy 截断。
      out[key] = rest.charAt(0) === '|' ? block.text : block.text.replace(/\s*\n\s*/g, ' ').trim()
      continue
    }

    // 块标量正文已在上面整段消费掉；剩下的缩进行是 `metadata:\n  author: x`
    // 这类嵌套键，历史上就是扁平化取值的，保持兼容。
    out[key] = unquote(rest)
  }
  return out
}
