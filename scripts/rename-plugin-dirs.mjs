#!/usr/bin/env node
/**
 * rename-plugin-dirs.mjs —— 把资源仓库里的 `.codebuddy-plugin` 目录批量改名为
 * `.buddy-hub-plugin`（专家 / 专家团清单目录）。
 *
 * 插件本身已同时兼容两种目录名（见 lib/index.js 的 PLUGIN_DIR_NAMES），
 * 这个脚本只负责把仓库里的旧目录名一次性迁到新名。
 *
 * 用法（默认 dry-run，只打印不改动）：
 *   node scripts/rename-plugin-dirs.mjs E:/JAVA/gitee/dsh-buddy-expert-hub-resource
 *   node scripts/rename-plugin-dirs.mjs E:/JAVA/gitee/dsh-buddy-expert-hub-resource --apply
 *
 * 安全策略：
 *  - 只处理**目录**，普通文件同名不动；
 *  - 目标已存在 `.buddy-hub-plugin` 时跳过（不覆盖、不合并）；
 *  - 逐条 fs.renameSync（同盘原子），失败单独报告不中断；
 *  - 不改任何文件内容，只改目录名。
 *
 * 零 npm 依赖。
 */

import fs from 'node:fs'
import path from 'node:path'

const OLD_NAME = '.codebuddy-plugin'
const NEW_NAME = '.buddy-hub-plugin'

/** 递归找出所有名为 oldName 的目录（不跟随符号链接）。 */
function findDirs(root, name, out = []) {
  let entries
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    /* 符号链接一律不进入：避免跨盘 / 循环 / 误改仓库外内容。 */
    if (entry.isSymbolicLink()) continue
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === name) out.push(full)
      findDirs(full, name, out)
    }
  }
  return out
}

const args = process.argv.slice(2)
const target = args.find((a) => !a.startsWith('-'))
const apply = args.includes('--apply') || args.includes('-a')

if (target === undefined || target.trim() === '') {
  console.error('用法：node scripts/rename-plugin-dirs.mjs <资源仓库根目录> [--apply]')
  console.error('  不加 --apply 是预演（只打印，不改动）')
  process.exit(2)
}

const root = path.resolve(target)
if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
  console.error('目录不存在或不是目录：' + root)
  process.exit(2)
}

const dirs = findDirs(root, OLD_NAME)
console.log('扫描根目录：' + root)
console.log('发现 ' + String(dirs.length) + ' 个 ' + OLD_NAME + ' 目录' + (apply ? '' : '（预演模式，不改动）'))
console.log('')

let renamed = 0
let skipped = 0
let failed = 0

for (const dir of dirs) {
  const parent = path.dirname(dir)
  const to = path.join(parent, NEW_NAME)
  const rel = path.relative(root, dir)
  if (fs.existsSync(to)) {
    skipped += 1
    console.log('  跳过（目标已存在）：' + rel)
    continue
  }
  if (!apply) {
    renamed += 1
    console.log('  将改名：' + rel)
    continue
  }
  try {
    fs.renameSync(dir, to)
    renamed += 1
    console.log('  已改名：' + rel)
  } catch (error) {
    failed += 1
    console.error('  失败：' + rel + ' —— ' + String((error && error.message) || error))
  }
}

console.log('')
console.log(
  (apply ? '完成' : '预演完成') +
  '：' + String(renamed) + ' 个' + (apply ? '已改名' : '待改名') +
  '，' + String(skipped) + ' 个跳过，' + String(failed) + ' 个失败'
)
if (!apply && renamed > 0) {
  console.log('确认无误后加 --apply 真正执行：')
  console.log('  node scripts/rename-plugin-dirs.mjs "' + root + '" --apply')
}
process.exit(failed > 0 ? 1 : 0)
