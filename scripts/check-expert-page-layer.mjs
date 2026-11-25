#!/usr/bin/env node
/**
 * 专家包「工作台页面数据层」守门（挂进 npm run check）。
 *
 * 为什么要有这一步：工作台页面反复出现同一类故障（页面空白 / 翻页没反应 /
 * 面板有数资料库没数 / 报「缺少 id」），根因都是数据层写法不对。解决办法不是写更长的规范，
 * 而是给专家包一份**整段可复制的数据层** + 一个**静态自检脚本**，并在这里守住它们没被改坏。
 *
 * 检查项：
 *   X1 两版专家包都有 references/data-layer.js，且含 7 个关键结构
 *   X2 两版专家包都有 scripts/check_page_layer.mjs
 *   X3 用 check_page_layer.mjs 扫「模板自身包成的页面」，必须全 PASS（≥8 项）
 *   X4 跑 verify_template.mjs 模板自证，必须全 PASS（≥8 项）
 *   X5 agent 正文里确实要求「整段复制模板 + 跑自检」（否则 agent 不会照做）
 *
 * 探测不到专家包时整体 SKIP（退出码 0）：插件仓库可以脱离专家包单独发布。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOME = os.homedir()

/* 候选专家包位置：先看源码仓库（E 盘维护的那份），再看运行时安装副本 */
const CANDIDATES = [
  process.env.DSH_EXPERT_SOURCE || '',
  'E:/JAVA/gitee/dsh-buddy-expert-hub-resource/experts/khub-workbench-builder',
  path.join(HOME, '.dsh', 'dsh-buddy-expert-hub', 'repo', 'experts', 'khub-workbench-builder'),
].filter((p) => p !== '')

const existing = CANDIDATES.filter((p) => {
  try { return fs.statSync(p).isDirectory() } catch { return false }
})

const report = []
const ck = (name, ok, detail) => {
  report.push({ name, ok, detail: detail === undefined ? '' : String(detail) })
  return ok
}

const REQUIRED_LAYER = [
  ['withTimeout', 'function withTimeout'],
  ['readSeed', 'function readSeed'],
  ['navToSeedPage', 'function navToSeedPage'],
  ['restoreScroll', 'function restoreScroll'],
  ['rowsOfPage', 'function rowsOfPage'],
  ['保留原查询参数', 'seed(Table|Page|Size)'],
  ['不永久熔断说明', 'BRIDGE_DEAD'],
]

let skipped = false
if (existing.length === 0) {
  skipped = true
  console.log('SKIP  未找到专家包（可设 DSH_EXPERT_SOURCE 指定），数据层守门跳过')
} else {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-layer-'))
  for (const root of existing) {
    const label = root.startsWith(HOME) ? '已安装版' : '源码版'
    const layerPath = path.join(root, 'skills', 'khub-workbench-spec', 'references', 'data-layer.js')
    const checkPath = path.join(root, 'skills', 'khub-workbench-spec', 'scripts', 'check_page_layer.mjs')
    const agentPath = path.join(root, 'agents', 'khub-workbench-builder.md')

    const layer = fs.existsSync(layerPath) ? fs.readFileSync(layerPath, 'utf8') : ''
    const missing = REQUIRED_LAYER.filter(([, needle]) => !layer.includes(needle)).map(([name]) => name)
    ck(label + ' 数据层模板完整', layer !== '' && missing.length === 0,
      layer === '' ? '文件不存在' : (missing.length === 0 ? '' : '缺少 ' + missing.join('/')))

    ck(label + ' 有静态自检脚本', fs.existsSync(checkPath) && fs.readFileSync(checkPath, 'utf8').includes('L7'),
      checkPath)

    /* X3：把模板包成最小页面，跑真正的自检脚本 —— 证明「模板自身合格」 */
    if (layer !== '' && fs.existsSync(checkPath)) {
      const probe = path.join(tmpDir, 'probe-' + path.basename(root) + '.html')
      fs.writeFileSync(probe, '<!DOCTYPE html><html><body><script>\n' + layer + '\n</script></body></html>', 'utf8')
      const run = spawnSync(process.execPath, [checkPath, probe], { encoding: 'utf8' })
      const out = String(run.stdout || '') + String(run.stderr || '')
      const passLine = (out.match(/合计\s+(\d+)\s+PASS\s*\/\s*(\d+)\s+FAIL/) || [])
      const pass = Number(passLine[1] || 0)
      const fail = Number(passLine[2] || 0)
      ck(label + ' 模板自身通过静态自检', run.status === 0 && pass >= 8 && fail === 0,
        out.trim().split('\n').slice(-1)[0] || ('exit=' + String(run.status)))
    }

    /* X5：跑模板自证脚本（零依赖，验逻辑而不只是写法） */
    const verifyPath = path.join(root, 'skills', 'khub-workbench-spec', 'scripts', 'verify_template.mjs')
    ck(label + ' 有模板自证脚本', fs.existsSync(verifyPath), verifyPath)
    if (fs.existsSync(verifyPath)) {
      const run2 = spawnSync(process.execPath, [verifyPath], { encoding: 'utf8' })
      const out2 = String(run2.stdout || '') + String(run2.stderr || '')
      /* 结果行是最后一条「合计 N PASS / M FAIL」；脚本里其它检查项的详情文案也可能含这几个字，
         必须取最后一次匹配，否则会把 V1 详情里的「8 PASS」当成总分。 */
      const all2 = [...out2.matchAll(/合计\s+(\d+)\s+PASS\s*\/\s*(\d+)\s+FAIL/g)]
      const line2 = all2.length > 0 ? all2[all2.length - 1] : []
      const pass2 = Number(line2[1] || 0)
      const fail2 = Number(line2[2] || 0)
      ck(label + ' 模板自证通过（' + String(pass2) + ' PASS）', run2.status === 0 && pass2 >= 8 && fail2 === 0,
        out2.trim().split('\n').slice(-1)[0] || ('exit=' + String(run2.status)))
    }

    const agent = fs.existsSync(agentPath) ? fs.readFileSync(agentPath, 'utf8') : ''
    ck(label + ' agent 正文要求复制模板并自检',
      agent.includes('data-layer.js') && agent.includes('check_page_layer.mjs'))
  }
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

if (!skipped) {
  for (const r of report) console.log((r.ok ? 'PASS  ' : 'FAIL  ') + r.name + (r.detail ? ' — ' + r.detail : ''))
  const failed = report.filter((r) => !r.ok).length
  console.log('\n合计 ' + String(report.length - failed) + ' PASS / ' + String(failed) + ' FAIL')
  process.exit(failed === 0 ? 0 : 1)
}
process.exit(0)
