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
 *  2. 入口与清单文件存在且被覆盖：`lib/index.js`、`lib/client.js`、`cordis.patch.yml`；
 *  3. `builtin/` 目录存在且被 `files` 覆盖 —— 内置技能（`builtin/<platform>/skills`）
 *     是随包发布的只读资源，漏了它「启用内置技能」装完就是 0 个技能。
 *
 * 说明：插件**不再内置任何连接器数据**（原来的 `data/connectors.json` 与 `data/icons`
 * 已删除，连接器改从资源仓库 `connectors/` 读取），因此这里不再校验 `data/` 目录。
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
 * npm 的 `files` 语义：条目是文件则精确匹配，是目录则覆盖其下全部内容，
 * 含通配符的条目（如 `builtin/**​/skills/**`）按 glob 前缀匹配 —— 本插件用它
 * 只发布技能子树、排除宿主资源目录。
 * @param {string} relativePath 相对插件根目录的 POSIX 路径
 * @param {string[]} entries files 白名单
 * @returns {boolean} 是否覆盖
 */
function globToRegExp(entry) {
  /* 单遍扫描：`**` → `.*`、`*` → `[^/]*`，其余字符转义。
     不能先替换 `**` 再替换 `*` —— 会把刚插入的 `.*` 里的 `*` 再改写一遍。 */
  const special = '.+^${}()|[]\\'
  let out = ''
  for (let i = 0; i < entry.length; i += 1) {
    const ch = entry[i]
    if (ch === '*') {
      if (entry[i + 1] === '*') {
        out += '.*'
        i += 1
      } else {
        out += '[^/]*'
      }
    } else if (special.includes(ch)) {
      out += '\\' + ch
    } else {
      out += ch
    }
  }
  return new RegExp('^' + out + '$')
}

function isCovered(relativePath, entries) {
  for (const raw of entries) {
    const entry = String(raw).replace(/\\/g, '/').replace(/\/+$/, '')
    if (entry === '') continue
    if (entry === relativePath) return true
    if (relativePath.startsWith(entry + '/')) return true
    if (entry.includes('*') && globToRegExp(entry).test(relativePath)) return true
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
for (const required of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml']) {
  const absolute = path.join(PLUGIN_ROOT, required)
  if (!fs.existsSync(absolute)) failures.push('缺少发布必需文件：' + required)
  if (!isCovered(required, files)) failures.push('files 未覆盖发布必需文件：' + required)
}

if (verbose) {
  console.log('files =', JSON.stringify(files))
  for (const relative of libFiles) console.log('  lib 文件：', relative, isCovered(relative, files) ? 'OK' : 'MISSING')
}

// 3. builtin/ 内置技能目录：只发布「技能」子树（builtin/**/skills/**），
//    不发布 mcps/ 与插件运行时目录（dist/bin/prebuilds/core/agents/hooks）——
//    后者是宿主资源，本插件不读，打进去会让包体从 10MB 膨胀到 90MB+。
const builtinDir = path.join(PLUGIN_ROOT, 'builtin')
if (!fs.existsSync(builtinDir) || !fs.statSync(builtinDir).isDirectory()) {
  failures.push('内置技能目录未纳入发布包：缺少 builtin/ 目录（装完会缺技能）')
} else {
  const platforms = fs.readdirSync(builtinDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  if (platforms.length === 0) failures.push('内置技能目录为空：builtin/ 下没有任何平台目录（装完会缺技能）')

  /** 抽样：平台技能目录下第一个技能的 SKILL.md */
  const sampleOf = (dir) => {
    let names
    try {
      names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      return null
    }
    for (const name of names) {
      if (fs.existsSync(path.join(dir, name, 'SKILL.md'))) return name
    }
    return null
  }

  let skillsChecked = 0
  for (const platform of platforms) {
    const skillsDir = path.join(builtinDir, platform, 'skills')
    const first = sampleOf(skillsDir)
    if (first !== null) {
      const relative = 'builtin/' + platform + '/skills/' + first + '/SKILL.md'
      skillsChecked += 1
      if (!isCovered(relative, files)) failures.push('files 未覆盖内置技能：' + relative)
    }
    /* 插件来源的技能同理必须进包（只进 skills 子树，不进插件运行时目录） */
    const pluginsDir = path.join(builtinDir, platform, 'builtin-plugins')
    let plugins = []
    try {
      plugins = fs.readdirSync(pluginsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      plugins = []
    }
    for (const plugin of plugins) {
      const firstSkill = sampleOf(path.join(pluginsDir, plugin, 'skills'))
      if (firstSkill === null) continue
      const relative = 'builtin/' + platform + '/builtin-plugins/' + plugin + '/skills/' + firstSkill + '/SKILL.md'
      skillsChecked += 1
      if (!isCovered(relative, files)) failures.push('files 未覆盖内置插件技能：' + relative)
      break
    }
    /* 反向：宿主资源目录不能被打进包 */
    for (const heavy of ['mcps', 'builtin-plugins']) {
      if (heavy === 'builtin-plugins') continue
      const probe = 'builtin/' + platform + '/' + heavy + '/probe/x.bin'
      if (isCovered(probe, files)) failures.push('files 错误地把宿主资源打进包：' + probe + '（包体会膨胀到 90MB+）')
    }
    const runtimeProbe = 'builtin/' + platform + '/builtin-plugins/demo/dist/probe.mjs'
    if (isCovered(runtimeProbe, files)) failures.push('files 错误地把插件运行时打进包：' + runtimeProbe)
  }
  if (skillsChecked === 0) failures.push('builtin/ 下没有找到任何技能目录（缺少 SKILL.md，装完会缺技能）')
}

if (failures.length > 0) {
  for (const failure of failures) console.error('FAIL  ' + failure)
  process.exit(1)
}
console.log('PASS  package.json files 覆盖 ' + String(libFiles.length) + ' 个 lib 文件与全部清单文件（含 builtin 内置技能目录，仅技能子树）')
