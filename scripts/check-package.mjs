#!/usr/bin/env node
/**
 * 发布前自检：`package.json` 的 `files` 白名单必须覆盖每一个运行时需要的文件。
 *
 * 背景：`lib/frontmatter.js` 曾经只建在磁盘上、没进 `files`，`npm pack` 出来的包里没有它，
 * 而 `lib/index.js` 又会 `import './frontmatter.js'` —— 装完直接加载失败。
 * 这类「新建了 lib/ 下的文件但忘了发布」的坑已经踩过一次，这里做成脚本卡住。
 *
 * 判据（任一不满足即退出码 1）：
 *  1. `lib/` 下的每个 .js 都被 `files` 里的某条规则覆盖（整目录 `lib` 或精确文件名）；
 *  2. 入口与清单文件存在且被覆盖：`lib/index.js`、`lib/client.js`、`cordis.patch.yml`、
 *     `data/connectors.json`；
 *  3. `data/icons` 被覆盖（连接器图标随包发布）。
 *
 * 用法：node scripts/check-package.mjs [--verbose]
 * 零依赖，仅使用 node: 内置模块。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(HERE, '..')
const verbose = process.argv.includes('--verbose')

/**
 * 判断某个相对路径是否被 files 规则覆盖。
 * npm 的 `files` 语义：条目是文件则精确匹配，是目录则覆盖其下全部内容。
 * @param {string} relativePath 相对插件根目录的 POSIX 路径
 * @param {string[]} entries files 白名单
 * @returns {boolean} 是否覆盖
 */
function isCovered(relativePath, entries) {
  for (const raw of entries) {
    const entry = String(raw).replace(/\\/g, '/').replace(/\/+$/, '')
    if (entry === '') continue
    if (entry === relativePath) return true
    if (relativePath.startsWith(entry + '/')) return true
  }
  return false
}

/**
 * 递归列出目录下所有指定后缀的文件（相对插件根目录）。
 * @param {string} dir 绝对目录
 * @param {string} suffix 后缀
 * @returns {string[]} 相对路径列表
 */
function listFiles(dir, suffix) {
  /** @type {string[]} */
  const out = []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...listFiles(absolute, suffix))
      continue
    }
    if (entry.name.endsWith(suffix)) {
      out.push(path.relative(PLUGIN_ROOT, absolute).replace(/\\/g, '/'))
    }
  }
  return out
}

const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'))
const files = Array.isArray(pkg.files) ? pkg.files : []
const failures = []

// 1. lib/ 下所有 .js 都要进包
const libFiles = listFiles(path.join(PLUGIN_ROOT, 'lib'), '.js').sort()
for (const relative of libFiles) {
  if (!isCovered(relative, files)) failures.push('files 未覆盖运行时文件：' + relative)
}
if (libFiles.length === 0) failures.push('lib/ 下没有找到任何 .js 文件（路径异常？）')

// 2. 必需的入口 / 清单
for (const required of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'data/connectors.json']) {
  const absolute = path.join(PLUGIN_ROOT, required)
  if (!fs.existsSync(absolute)) failures.push('缺少发布必需文件：' + required)
  if (!isCovered(required, files)) failures.push('files 未覆盖发布必需文件：' + required)
}

// 3. 图标目录随包发布（可以暂时为空，但不允许被排除）
if (!isCovered('data/icons/placeholder', files)) failures.push('files 未覆盖 data/icons')

if (verbose) {
  console.log('files =', JSON.stringify(files))
  for (const relative of libFiles) console.log('  lib 文件：', relative, isCovered(relative, files) ? 'OK' : 'MISSING')
}

if (failures.length > 0) {
  for (const failure of failures) console.error('FAIL  ' + failure)
  process.exit(1)
}
console.log('PASS  package.json files 覆盖 ' + String(libFiles.length) + ' 个 lib 文件与全部清单文件')
