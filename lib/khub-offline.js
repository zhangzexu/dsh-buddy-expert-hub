/**
 * 在线工作台的本地离线缓存。
 *
 * 为什么需要：在线资料库断开后，`/workbench/list` 拿不到 catalog、`/workbench/html` 拿不到 HTML，
 * 于是**整个在线工作台从面板里消失**——即使数据镜像还在也打不开。
 * 这里缓存三样东西，让断网时工作台「照常在列表里、照常能打开」：
 *   1. 工作台清单（workbenches / folders / spaces）
 *   2. 注入好桥脚本的 HTML（含 KB 适配器，离线时原样返回即可）
 *   3. 数据 CSV 镜像（在 ingest.js 的 syncMirrorFromOnline 里，另算）
 *
 * 缓存目录：`<baseDir>/offline/`，与 ingest / repo 平级。
 * 只在在线成功时写，读缓存失败一律静默回落，绝不影响在线模式。
 */

import fs from 'node:fs'
import path from 'node:path'
import { safePath } from './workbench.js'

/** 缓存根目录，目录不存在也没关系（读时静默返回 null）。 */
function offlineDir(baseDir) {
  return path.join(String(baseDir === null || baseDir === undefined ? '' : baseDir), 'offline')
}

function cachePath(baseDir, name) {
  return path.join(offlineDir(baseDir), name)
}

/** 写 JSON 缓存（原子写：tmp → rename，避免读到半截文件）。 */
function writeJsonCached(file, value) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = file + '.' + String(process.pid) + '.' + Date.now() + '.tmp'
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), 'utf8')
    fs.renameSync(tmp, file)
  } catch (error) {
    try { fs.unlinkSync(tmp) } catch { /* 清理失败不覆盖原始错误 */ }
    throw error
  }
}

/** 读 JSON 缓存，不存在 / 坏掉都返回 null。 */
function readJsonCached(file) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const out = JSON.parse(text)
    return out !== null && typeof out === 'object' ? out : null
  } catch {
    return null
  }
}

/**
 * 缓存在线工作台清单。
 * @param {object} payload buildKhubWorkbenchList 的返回值
 * @param {string} baseDir 插件数据根目录
 */
export function saveCatalogCache(payload, baseDir) {
  if (payload === null || payload === undefined || !Array.isArray(payload.workbenches)) return
  try {
    writeJsonCached(cachePath(baseDir, 'catalog.json'), {
      savedAt: new Date().toISOString(),
      workbenches: payload.workbenches,
      folders: Array.isArray(payload.folders) ? payload.folders : [],
      spaces: Array.isArray(payload.spaces) ? payload.spaces : [],
    })
  } catch { /* 缓存失败静默 */ }
}

/**
 * 读缓存的在线工作台清单（断网时用）。
 * @param {string} baseDir 插件数据根目录
 * @returns {{workbenches: object[], folders: object[], spaces: object[]}|null}
 */
export function loadCatalogCache(baseDir) {
  return readJsonCached(cachePath(baseDir, 'catalog.json'))
}

/**
 * 缓存注入后的在线工作台 HTML。
 * @param {string} workbenchId 工作台 id（khub-<nodeId>）
 * @param {string} html 已注入 BRIDGE_SOURCE + KB 适配器的完整 HTML
 * @param {string} baseDir 插件数据根目录
 */
export function saveHtmlCache(workbenchId, html, baseDir) {
  const id = String(workbenchId || '')
  if (id === '' || typeof html !== 'string' || html === '') return
  /* 文件名只接受安全字符，避免 workbench id 里有路径分隔符时越界。 */
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return
  const file = safePath(offlineDir(baseDir), 'html/' + id + '.html')
  if (file === null) return
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = file + '.' + String(process.pid) + '.' + Date.now() + '.tmp'
    fs.writeFileSync(tmp, html, 'utf8')
    fs.renameSync(tmp, file)
  } catch { /* 缓存失败静默 */ }
}

/**
 * 读缓存的在线工作台 HTML。
 * @param {string} workbenchId 工作台 id
 * @param {string} baseDir 插件数据根目录
 * @returns {string|null} 完整 HTML（含已注入的桥）
 */
export function loadHtmlCache(workbenchId, baseDir) {
  const id = String(workbenchId || '')
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return null
  const file = safePath(offlineDir(baseDir), 'html/' + id + '.html')
  if (file === null) return null
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** 清掉某工作台的 HTML 缓存（在线内容更新后可由调用方主动失效）。 */
export function invalidateHtmlCache(workbenchId, baseDir) {
  const id = String(workbenchId || '')
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) return
  const file = safePath(offlineDir(baseDir), 'html/' + id + '.html')
  if (file === null) return
  try { fs.unlinkSync(file) } catch { /* 本来就没有 */ }
}
