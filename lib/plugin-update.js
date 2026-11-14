/**
 * dsh-buddy-expert-hub — 插件自身的在线升级：查 npm 最新版、下载、校验、替换、回滚。
 *
 * 零依赖：tarball 是 gzip + tar，这里用 node:zlib 解压、自己解 tar（含 ustar prefix 与 pax 长路径）。
 *
 * 安全边界（都可被测试断言）：
 *  1. 只认 http(s) registry，默认 npm 官方；tarball 主机必须与 registry 同主机，不接受任意地址；
 *  2. 必须通过 registry 给出的 `dist.integrity`（sha512）校验，校验不过直接丢弃 staging；
 *  3. 解包条目必须以 `package/` 开头且不含 `..`，单包解压上限 64 MiB；
 *  4. 解包后校验 package.json 的 name / version 与目标一致；
 *  5. 覆盖前先整目录备份到 `<root>.bak-<from>-<ts>`，任一步失败从备份回滚；
 *  6. 覆盖时跳过 `.git`、`node_modules` 与既有备份目录，绝不删除用户数据。
 *
 * 局限（文档里也写明）：覆盖正在运行的 .js 在 Windows 上可能 EBUSY；此时会回滚并返回可读错误，
 * 提示改用 `dsh plugin --profile <p> add <name>@<version>` 重装。
 * @module dsh-buddy-expert-hub/plugin-update
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

/** 插件根目录（lib/ 的上一级）。 */
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 默认 registry；可用设置里的 `updateRegistry` 覆盖。 */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

/** 单个版本包解压后的上限，防 zip bomb。 */
const MAX_TARBALL_BYTES = 64 * 1024 * 1024

/** 覆盖时跳过的目录名。 */
const SKIP_DIRS = new Set(['.git', 'node_modules'])

/**
 * 读自身元数据（包名 / 版本 / 仓库地址）。
 * @returns {{ name: string, version: string, repoUrl: string, homepage: string }} 元数据
 */
export function readSelfMeta() {
  const pkg = readJson(path.join(PLUGIN_ROOT, 'package.json'))
  return {
    name: typeof pkg.name === 'string' ? pkg.name : 'dsh-buddy-expert-hub',
    version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
    repoUrl: normalizeRepoUrl(pkg.repository) || 'https://github.com/zhangzexu/dsh-buddy-expert-hub',
    homepage: typeof pkg.homepage === 'string' ? pkg.homepage : ''
  }
}

/**
 * `repository` 字段既可能是字符串也可能是 `{ url }`，统一成可点击的 web 地址。
 * @param {any} repository package.json 的 repository 字段
 * @returns {string} 规范化的 https 地址；无法识别时返回 ''
 */
function normalizeRepoUrl(repository) {
  const raw = typeof repository === 'string'
    ? repository
    : (repository !== null && typeof repository === 'object' && typeof repository.url === 'string' ? repository.url : '')
  if (raw === '') return ''
  const trimmed = raw.trim()
  const scp = trimmed.match(/^git@([^:]+):(.+?)(?:\.git)?\/?$/)
  if (scp !== null) return 'https://' + scp[1] + '/' + scp[2].replace(/\.git$/, '')
  const plain = trimmed.match(/^(?:git\+)?(https?:\/\/[^\s]+?)(?:\.git)?\/?$/)
  if (plain !== null) return plain[1].replace(/\.git$/, '')
  return ''
}

/**
 * 规范化 registry 地址：只允许 http(s)、去掉尾部斜杠、拒绝带凭据。
 * @param {string} value 候选地址
 * @returns {string} 规范化后的地址
 */
export function normalizeRegistry(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (text === '') return DEFAULT_REGISTRY
  let url
  try {
    url = new URL(text)
  } catch {
    throw new Error('registry 地址不合法：' + text)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('registry 只支持 http(s)：' + text)
  if (url.username !== '' || url.password !== '') throw new Error('registry 地址不能带凭据')
  return url.href.replace(/\/+$/, '')
}

/** 读 JSON 文件；失败抛错（升级路径要求明确失败，不做静默兜底）。 */
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

/**
 * 比较两个 SemVer（支持 prerelease），返回 -1 / 0 / 1。
 * @param {string} left 左版本
 * @param {string} right 右版本
 * @returns {number} 比较结果
 */
export function compareVersion(left, right) {
  const parse = (value) => {
    const matched = String(value).trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
    if (matched === null) return null
    return {
      core: [Number(matched[1]), Number(matched[2]), Number(matched[3])],
      pre: matched[4] === undefined ? [] : matched[4].split('.')
    }
  }
  const a = parse(left)
  const b = parse(right)
  if (a === null || b === null) return 0
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] > b.core[i] ? 1 : -1
  }
  /* 正式版 > 预发布版；同为预发布时逐段比较（数字段按数值、其余按字典序）。 */
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const length = Math.max(a.pre.length, b.pre.length)
  for (let i = 0; i < length; i += 1) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const nx = /^\d+$/.test(x)
    const ny = /^\d+$/.test(y)
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) > Number(y) ? 1 : -1
    } else if (nx !== ny) {
      return nx ? -1 : 1
    } else if (x !== y) {
      return x > y ? 1 : -1
    }
  }
  return 0
}

/**
 * 带超时的 fetch，返回 Response。
 * @param {string} url 地址
 * @param {number} timeoutMs 超时
 * @param {RequestInit} init 额外参数
 * @returns {Promise<Response>} 响应
 */
async function fetchWithTimeout(url, timeoutMs, init) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, Object.assign({}, init, { signal: controller.signal }))
  } finally {
    clearTimeout(timer)
  }
}

/** 内存里的检查结果缓存（同一版本反复检查不重复打 registry）。 */
let checkCache = null

/**
 * 清掉检查缓存（升级成功后调用）。
 * @returns {void}
 */
export function resetUpdateCache() {
  checkCache = null
}

/**
 * 查 npm registry 的最新版本。
 * @param {{ registry?: string, timeoutMs?: number, force?: boolean }} options 参数
 * @returns {Promise<{ current: string, latest: string, hasUpdate: boolean, publishedAt: string, registry: string, tarball: string, integrity: string }>} 结果
 */
export async function checkUpdate(options) {
  const settings = options !== null && typeof options === 'object' ? options : {}
  const meta = readSelfMeta()
  const registry = normalizeRegistry(settings.registry)
  const cacheKey = registry + '|' + meta.version
  if (settings.force !== true && checkCache !== null && checkCache.key === cacheKey &&
      Date.now() - checkCache.at < 5 * 60 * 1000) {
    return checkCache.value
  }
  const url = registry + '/' + encodeURIComponent(meta.name) + '/latest'
  let response
  try {
    response = await fetchWithTimeout(url, settings.timeoutMs === undefined ? 15000 : settings.timeoutMs, {
      headers: { Accept: 'application/json' }
    })
  } catch (error) {
    throw new Error('无法连接 registry（' + registry + '）：' + String((error && error.message) || error))
  }
  if (response.status === 404) throw new Error('registry 上没有这个包：' + meta.name)
  if (!response.ok) throw new Error('registry 返回 ' + String(response.status) + '，暂时无法检查更新')
  const doc = await response.json()
  const latest = typeof doc.version === 'string' ? doc.version : ''
  if (latest === '') throw new Error('registry 返回的版本号为空')
  const integrity = doc.dist !== null && typeof doc.dist === 'object' && typeof doc.dist.integrity === 'string'
    ? doc.dist.integrity
    : ''
  const tarball = doc.dist !== null && typeof doc.dist === 'object' && typeof doc.dist.tarball === 'string'
    ? doc.dist.tarball
    : ''
  if (integrity === '' || tarball === '') throw new Error('registry 缺少 dist.tarball / dist.integrity，无法安全升级')
  const value = {
    current: meta.version,
    latest,
    hasUpdate: compareVersion(latest, meta.version) > 0,
    publishedAt: typeof doc.publishTime === 'string' ? doc.publishTime : '',
    registry,
    tarball,
    integrity
  }
  checkCache = { key: cacheKey, at: Date.now(), value }
  return value
}

/**
 * 下载并校验一个 tarball。
 * @param {string} tarballUrl 下载地址
 * @param {string} integrity registry 给出的 integrity（sha512-...）
 * @param {number} timeoutMs 超时
 * @returns {Promise<Buffer>} 包体
 */
async function downloadTarball(tarballUrl, integrity, timeoutMs) {
  const url = new URL(tarballUrl)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('tarball 地址只支持 http(s)')
  if (url.username !== '' || url.password !== '') throw new Error('tarball 地址不能带凭据')
  let response
  try {
    response = await fetchWithTimeout(url.href, timeoutMs)
  } catch (error) {
    throw new Error('下载新版本失败：' + String((error && error.message) || error))
  }
  if (!response.ok) throw new Error('下载新版本失败：HTTP ' + String(response.status))
  const buffer = Buffer.from(await response.arrayBuffer())
  if (buffer.length === 0) throw new Error('下载到的包体为空')
  if (buffer.length > MAX_TARBALL_BYTES) throw new Error('包体超过 ' + String(MAX_TARBALL_BYTES) + ' 字节，拒绝解包')
  verifyIntegrity(buffer, integrity)
  return buffer
}

/**
 * 按 registry 的 `sha512-<base64>` 校验；格式不认识时直接拒绝。
 * @param {Buffer} buffer 包体
 * @param {string} integrity integrity 字符串
 * @returns {void}
 */
export function verifyIntegrity(buffer, integrity) {
  const matched = String(integrity).trim().match(/^(sha512|sha256|sha1)-([A-Za-z0-9+/=]+)$/)
  if (matched === null) throw new Error('registry 的 integrity 格式无法识别')
  const algo = matched[1]
  const expected = matched[2]
  const actual = crypto.createHash(algo).update(buffer).digest('base64')
  if (actual !== expected) throw new Error('安装包校验失败（' + algo + ' 不一致），已放弃本次升级')
}

/**
 * 解 tar（gzip 已在外层解开），支持 ustar prefix 与 pax 长路径。
 * @param {Buffer} tar tar 字节
 * @param {string} destRoot 解到哪个目录
 * @returns {number} 写出的文件数
 */
export function extractTar(tar, destRoot) {
  let offset = 0
  let count = 0
  let paxPath = ''
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = readCString(header, 0, 100)
    const size = parseOctal(readCString(header, 124, 12))
    const type = String.fromCharCode(header[156] === 0 ? 48 : header[156])
    const prefix = readCString(header, 345, 155)
    const dataStart = offset + 512
    const data = tar.subarray(dataStart, Math.min(dataStart + size, tar.length))
    offset = dataStart + Math.ceil(size / 512) * 512
    if (type === 'x' || type === 'g') {
      /* pax 扩展头：下一条目用它给的 path（长路径用这个）。 */
      const text = data.toString('utf8')
      const matched = text.match(/(?:^|\n)\d+ path=([^\n]+)\n/)
      if (matched !== null) paxPath = matched[1]
      continue
    }
    if (type === 'L') {
      paxPath = readCString(data, 0, data.length)
      continue
    }
    const relative = paxPath !== '' ? paxPath : (prefix !== '' ? prefix + '/' + name : name)
    paxPath = ''
    const safe = safeRelative(relative)
    if (safe === '') continue
    const target = path.join(destRoot, safe)
    if (!target.startsWith(destRoot + path.sep)) throw new Error('包内路径越界：' + relative)
    if (type === '5') {
      fs.mkdirSync(target, { recursive: true })
      continue
    }
    if (type !== '0' && type !== '\u0000') continue
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, data)
    count += 1
  }
  return count
}

/**
 * 把 tar 内路径规范化成安全的相对路径；越界 / 绝对路径返回 ''。
 * @param {string} raw tar 里的名字
 * @returns {string} 安全相对路径（POSIX）
 */
function safeRelative(raw) {
  const normalized = String(raw).replace(/\\/g, '/').replace(/^\.\//, '')
  if (normalized === '' || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) return ''
  if (normalized.split('/').some((part) => part === '..')) return ''
  return normalized
}

/** 读 C 字符串（到 NUL 或长度上限）。 */
function readCString(buffer, start, length) {
  const slice = buffer.subarray(start, start + length)
  const end = slice.indexOf(0)
  return (end < 0 ? slice : slice.subarray(0, end)).toString('utf8')
}

/** 读 tar 的八进制数字段。 */
function parseOctal(text) {
  const trimmed = String(text).replace(/[^0-7]/g, '')
  return trimmed === '' ? 0 : parseInt(trimmed, 8)
}

/**
 * 递归复制目录。
 * @param {string} from 源
 * @param {string} to 目标（不存在则创建）
 * @param {{ skipDirs?: Set<string>, onlyExistingRoot?: boolean }} options 选项
 * @returns {number} 复制的文件数
 */
function copyTree(from, to, options) {
  const settings = options !== null && typeof options === 'object' ? options : {}
  const skipDirs = settings.skipDirs instanceof Set ? settings.skipDirs : new Set()
  let count = 0
  const walk = (src, dest) => {
    fs.mkdirSync(dest, { recursive: true })
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      if (entry.isDirectory() && skipDirs.has(entry.name)) continue
      const srcPath = path.join(src, entry.name)
      const destPath = path.join(dest, entry.name)
      if (entry.isDirectory()) walk(srcPath, destPath)
      else if (entry.isFile()) {
        /* 先写临时文件再 rename：同目录 rename 是原子的，避免写一半留下坏文件。 */
        const temp = destPath + '.tmp-' + String(process.pid)
        fs.copyFileSync(srcPath, temp)
        fs.renameSync(temp, destPath)
        count += 1
      }
    }
  }
  walk(from, to)
  return count
}

/**
 * 一键升级：查最新版 → 下载 → 校验 → 解包 → 备份 → 覆盖 → 失败回滚。
 * @param {{ registry?: string, version?: string, timeoutMs?: number, dryRun?: boolean }} options 参数
 * @returns {Promise<{ from: string, to: string, files: number, backup: string, dryRun: boolean }>} 结果
 */
export async function applyUpdate(options) {
  const settings = options !== null && typeof options === 'object' ? options : {}
  const meta = readSelfMeta()
  const info = await checkUpdate({ registry: settings.registry, timeoutMs: settings.timeoutMs, force: true })
  const wanted = typeof settings.version === 'string' && settings.version !== '' ? settings.version : info.latest
  if (wanted !== info.latest) throw new Error('目标版本 ' + wanted + ' 不是 registry 上的最新版 ' + info.latest + '，请重新检查')
  if (info.hasUpdate !== true) throw new Error('当前已是最新版本 ' + meta.version)
  const tarballHost = new URL(info.tarball).host
  const registryHost = new URL(info.registry).host
  if (tarballHost !== registryHost) {
    throw new Error('tarball 主机（' + tarballHost + '）与 registry（' + registryHost + '）不一致，拒绝下载')
  }
  const buffer = await downloadTarball(info.tarball, info.integrity, settings.timeoutMs === undefined ? 60000 : settings.timeoutMs)
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hub-update-'))
  try {
    const tar = zlib.gunzipSync(buffer)
    const files = extractTar(tar, staging)
    if (files === 0) throw new Error('解包后没有任何文件')
    const packedRoot = path.join(staging, 'package')
    const packedPkg = readJson(path.join(packedRoot, 'package.json'))
    if (packedPkg.name !== meta.name) throw new Error('包名不一致（' + String(packedPkg.name) + '），拒绝覆盖')
    if (packedPkg.version !== wanted) throw new Error('包内版本（' + String(packedPkg.version) + '）与目标 ' + wanted + ' 不一致')
    if (settings.dryRun === true) {
      return { from: meta.version, to: wanted, files, backup: '', dryRun: true }
    }
    const backup = PLUGIN_ROOT + '.bak-' + meta.version + '-' + String(Date.now())
    copyTree(PLUGIN_ROOT, backup, { skipDirs: new Set(['node_modules']) })
    try {
      const written = copyTree(packedRoot, PLUGIN_ROOT, { skipDirs: SKIP_DIRS })
      resetUpdateCache()
      return { from: meta.version, to: wanted, files: written, backup, dryRun: false }
    } catch (error) {
      try {
        copyTree(backup, PLUGIN_ROOT, { skipDirs: SKIP_DIRS })
      } catch {
        /* 回滚也失败：保留备份目录，让用户手动恢复 */
      }
      throw new Error('覆盖文件失败，已尝试回滚到 ' + meta.version + '：' + String((error && error.message) || error))
    }
  } finally {
    try {
      fs.rmSync(staging, { recursive: true, force: true })
    } catch {
      /* 临时目录清理失败不影响结果 */
    }
  }
}
