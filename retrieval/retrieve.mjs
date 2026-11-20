#!/usr/bin/env node
/**
 * 智聊个人资料检索：从「在线资料库(knowledge-hub)」+「个人工作台」中按关键词检索。
 * 由 zhiliao-retrieval skill 调用；走插件本机 HTTP 路由（插件内部已处理资料库鉴权）。
 *
 * 用法：node retrieve.mjs "关键词1 关键词2"
 * 输出：可读文本，AI 看完自然融入回复。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const BASE_DIR = path.join(os.homedir(), '.dsh', 'dsh-buddy-expert-hub')
const ROUTE_PREFIX = '/dsh-buddy-expert-hub'
const keyword = (process.argv.slice(2).join(' ') || '').trim()

function port() {
  try {
    const h = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'zhiliao', 'host.json'), 'utf8'))
    return Number(h.port || 0)
  } catch { return 0 }
}

async function api(route, params = {}) {
  const p = port()
  if (!p) throw new Error('插件 HTTP 端口未就绪')
  const url = new URL('http://127.0.0.1:' + p + ROUTE_PREFIX + route)
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
  const res = await fetch(url, { headers: { Host: '127.0.0.1:' + p } })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  return await res.json()
}

function hits(text, kws) {
  if (kws.length === 0) return true
  const lower = String(text || '').toLowerCase()
  return kws.some((k) => k && lower.includes(k.toLowerCase()))
}

async function searchKb(kws) {
  const out = []
  let spaces = []
  try { spaces = (await api('/khub/spaces')).spaces || [] } catch { return out }
  for (const sp of spaces) {
    for (const kw of kws) {
      let items = []
      try { items = (await api('/khub/search', { spaceId: sp.id, keyword: kw })).items || [] } catch { continue }
      for (const it of items) {
        const name = String(it.name || it.title || '')
        // 跳过页面源码类节点（工作台 HTML 是页面代码，不是数据）
        if (/\.(html|htm)$/i.test(name)) continue
        let snippet = String(it.snippet || '')
        // 有正文节点就取内容（便于 AI 真正用上），限量
        if (it.id !== undefined && it.id !== null && !snippet) {
          try {
            const c = await api('/khub/content', { id: it.id })
            snippet = String((c && (c.content || c.text)) || '').slice(0, 2000)
          } catch {}
        }
        if (hits(name + ' ' + snippet, kws)) {
          out.push({ source: '资料库', space: sp.name, name, snippet: snippet.slice(0, 2000) })
        }
      }
    }
  }
  return out
}

async function searchWorkbench(kws) {
  const out = []
  let list = []
  try { list = (await api('/workbench/list')).workbenches || [] } catch { return out }
  for (const wb of list) {
    for (const t of (wb.tables || [])) {
      let data = null
      try { data = await api('/workbench/data', { workbench: wb.id, table: t.file }) } catch { continue }
      const rows = Array.isArray(data) ? data
        : Array.isArray(data && data.rows) ? data.rows
        : Array.isArray(data && data.data) ? data.data
        : Array.isArray(data && data.matrix) ? data.matrix
        : []
      const matched = []
      for (const row of rows) {
        const line = Array.isArray(row) ? row.join(' ') : Object.values(row || {}).join(' ')
        if (hits(line, kws)) matched.push(Array.isArray(row) ? row.join(' | ') : Object.values(row || {}).join(' | '))
      }
      if (matched.length > 0) {
        out.push({ source: '工作台', workbench: wb.name, table: t.name || t.file, rows: matched.slice(0, 40) })
      }
    }
  }
  return out
}

async function main() {
  if (!keyword) {
    console.log('未指定检索关键词。')
    return
  }
  const kws = keyword.split(/[\s,，]+/).filter(Boolean)
  const [kb, wb] = await Promise.all([searchKb(kws), searchWorkbench(kws)])
  if (kb.length === 0 && wb.length === 0) {
    console.log('在在线资料库和个人工作台中未找到与「' + keyword + '」相关的内容。')
    return
  }
  // 去重：资料库和工作台可能映射到同一份 CSV，去掉重复
  const seen = new Set()
  const uniqKb = []
  for (const r of kb) {
    const key = (r.name || '') + '|' + String(r.snippet || '').slice(0, 100)
    if (seen.has(key)) continue
    seen.add(key)
    uniqKb.push(r)
  }
  const lines = ['以下是从你的资料库和工作台检索到的相关内容，仅供参考，请用你自己的话自然回答，不要生硬罗列或标注来源：', '']
  kb.length = 0
  for (const r of uniqKb) kb.push(r)
  for (const r of kb) {
    lines.push('【资料库 · ' + r.space + ' · ' + r.name + '】')
    if (r.snippet) lines.push(r.snippet)
    lines.push('')
  }
  for (const r of wb) {
    lines.push('【工作台 · ' + r.workbench + ' · ' + r.table + '】')
    for (const row of r.rows) lines.push('- ' + row)
    lines.push('')
  }
  console.log(lines.join('\n').trim())
}

main().catch((e) => console.log('检索失败：' + (e && e.message ? e.message : String(e))))
