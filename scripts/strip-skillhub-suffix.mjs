#!/usr/bin/env node
/**
 * 去掉资源仓库技能目录名里的 `__skillhub` 后缀。
 *
 * 背景：`skills/<slug>__skillhub/` 是 SkillHub 下载时带上的目录后缀，而同一批技能里
 * 也有不带后缀的 `<slug>/`。后缀让技能 id / 集合名不统一，也不利于按 slug 对齐。
 * 本脚本把一级技能目录里的这个后缀去掉，**只改目录名，绝不修改任何文件内容**
 * （`SKILL.md`、`_skillhub_meta.json`、`_icon.*` 等全部原样保留）。
 *
 * 用法（在工作区任意目录执行均可）：
 *   node scripts/strip-skillhub-suffix.mjs --root <skills 目录> [--apply] [--suffix __skillhub]
 *
 * 参数：
 *   --root <dir>   必填（或用环境变量 DSH_RESOURCE_SKILLS、或使用相邻的默认资源仓库路径）
 *   --apply        真正执行改名；**默认只预演（dry-run）**，不碰磁盘
 *   --suffix <str> 要去掉的后缀，默认 `__skillhub`
 *
 * 安全约束：
 *  - 只处理 `<root>` 的**一级子目录**，不递归（嵌套目录里没有该后缀，实测 66 个全在一级）；
 *  - 跳过隐藏目录、符号链接、非目录；
 *  - 目标目录已存在时跳过并计入 skipped，绝不覆盖；
 *  - 幂等：第二次运行命中数为 0；
 *  - 在 git 工作树内优先用 `git mv` 保留改名追踪，失败时回落 `fs.renameSync`。
 *
 * 示例：
 *   node scripts/strip-skillhub-suffix.mjs --root E:/JAVA/gitee/dsh-buddy-expert-hub-resource/skills
 *   node scripts/strip-skillhub-suffix.mjs --root E:/JAVA/gitee/dsh-buddy-expert-hub-resource/skills --apply
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = path.resolve(HERE, '..')

/**
 * 解析命令行参数（只认 `--key value` 与布尔开关）。
 * @param {string[]} argv 参数数组
 * @returns {{ root: string, apply: boolean, suffix: string }} 配置
 */
function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const raw = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (!token.startsWith('--')) continue
    const key = token.slice(2)
    if (key === 'apply') {
      raw.apply = true
      continue
    }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      raw[key] = next
      i += 1
    } else {
      raw[key] = true
    }
  }
  const envRoot = typeof process.env.DSH_RESOURCE_SKILLS === 'string'
    ? process.env.DSH_RESOURCE_SKILLS.trim() : ''
  const fallbackRoot = path.resolve(PLUGIN_ROOT, '..', 'dsh-buddy-expert-hub-resource', 'skills')
  const rootValue = typeof raw.root === 'string' && raw.root.trim() !== ''
    ? raw.root.trim()
    : envRoot !== '' ? envRoot : fallbackRoot
  const suffix = typeof raw.suffix === 'string' && raw.suffix.trim() !== ''
    ? raw.suffix.trim() : '__skillhub'
  return { root: path.resolve(rootValue), apply: raw.apply === true, suffix }
}

const { root, apply, suffix } = parseArgs(process.argv.slice(2))

if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error('技能目录不存在或不是目录：' + root)
  console.error('请用 --root <skills 目录> 指定，或设置环境变量 DSH_RESOURCE_SKILLS。')
  process.exit(1)
}
if (suffix === '' || /[\\/]/.test(suffix)) {
  console.error('后缀参数不合法：' + suffix)
  process.exit(1)
}

/** 是否为 git 工作树（用于优先 git mv）。 */
const repoRoot = path.resolve(root, '..')
const useGit = fs.existsSync(path.join(repoRoot, '.git'))

/** @type {Array<{ from: string, to: string }>} */
const planned = []
/** @type {Array<{ dir: string, reason: string }>} */
const skipped = []

let entries
try {
  entries = fs.readdirSync(root, { withFileTypes: true })
} catch (error) {
  console.error('读取技能目录失败：' + String((error && error.message) || error))
  process.exit(1)
}

for (const entry of entries) {
  if (entry.name.startsWith('.')) continue
  if (!entry.isDirectory()) continue
  if (entry.isSymbolicLink()) {
    skipped.push({ dir: entry.name, reason: '符号链接，跳过' })
    continue
  }
  if (!entry.name.endsWith(suffix)) continue
  const target = entry.name.slice(0, -suffix.length)
  if (target === '') {
    skipped.push({ dir: entry.name, reason: '去掉后缀后为空，跳过' })
    continue
  }
  const from = path.join(root, entry.name)
  const to = path.join(root, target)
  if (fs.existsSync(to)) {
    skipped.push({ dir: entry.name, reason: '目标已存在，跳过（不覆盖）：' + target })
    continue
  }
  planned.push({ from, to })
}

console.log('技能目录：' + root)
console.log('模式：' + (apply ? '执行改名 (--apply)' : '预演 (dry-run，不写磁盘)'))
console.log('后缀：' + suffix + '；命中 ' + String(planned.length) + ' 个目录；跳过 ' + String(skipped.length) + ' 个')
for (const item of skipped) console.log('  SKIP  ' + item.dir + ' — ' + item.reason)

if (planned.length === 0) {
  console.log(apply ? '没有需要改名的目录（幂等）。' : '预演完成；加 --apply 执行改名。')
  process.exit(0)
}

if (!apply) {
  for (const item of planned) {
    console.log('  ' + path.basename(item.from) + '  ->  ' + path.basename(item.to))
  }
  console.log('预演完成；确认无误后加 --apply 执行。')
  process.exit(0)
}

let renamed = 0
/** @type {Array<{ dir: string, reason: string }>} */
const failed = []
for (const item of planned) {
  const fromRel = path.relative(repoRoot, item.from).split(path.sep).join('/')
  const toRel = path.relative(repoRoot, item.to).split(path.sep).join('/')
  let done = false
  if (useGit) {
    try {
      execFileSync('git', ['-C', repoRoot, 'mv', '--', fromRel, toRel], { stdio: 'pipe' })
      done = true
    } catch {
      // 目录未被 git 跟踪 / git 不可用时回落到文件系统改名
    }
  }
  if (!done) {
    try {
      fs.renameSync(item.from, item.to)
      done = true
    } catch (error) {
      failed.push({ dir: path.basename(item.from), reason: String((error && error.message) || error) })
      continue
    }
  }
  renamed += 1
  console.log('  RENAME  ' + path.basename(item.from) + '  ->  ' + path.basename(item.to))
}

console.log('\n完成：改名 ' + String(renamed) + ' 个，失败 ' + String(failed.length) + ' 个。')
for (const item of failed) console.log('  FAIL  ' + item.dir + ' — ' + item.reason)
console.log('只改了目录名，未修改任何文件内容。' + (useGit ? ' git 工作树内用 git mv 保留改名追踪；否则请 git add -A 让 git 识别 rename。' : ''))
if (failed.length > 0) process.exit(1)
