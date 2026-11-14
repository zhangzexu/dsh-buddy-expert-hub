/**
 * 生成 DSH 插件市场索引（format 1）—— 让插件能被 DSH 的「发现」页收录。
 *
 * 索引是一个 JSON 文档，DSH 的 pluginMarket 读取它并用
 * `@deepseek-ai/dsh-plugin-market-index` 的 `parseMarketIndex` 校验；
 * 校验通过后，用户在 Discover / 设置里把这个 JSON 的 http(s) 地址加进索引源即可看到本插件。
 *
 * 用法：node scripts/build-market-index.mjs [--timestamp <unix 秒>]
 * 输出：market/index.json（LF、两空格缩进、以换行结尾）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8')

const pkg = JSON.parse(read('package.json'))
const en = JSON.parse(read('locale/en.json')).meta
const zh = JSON.parse(read('locale/zh.json')).meta
const iconSvg = read('icon.svg')

/** 内联 icon 上限（DSH 的 MAX_INLINE_ICON_BYTES）是解码后 32 KiB。 */
const INLINE_ICON_MAX_BYTES = 32 * 1024

const iconBytes = Buffer.from(iconSvg, 'utf8')
if (iconBytes.length > INLINE_ICON_MAX_BYTES) {
  throw new Error('icon.svg 超过 32 KiB，无法作为内联 icon 收录')
}
const iconDataUrl = 'data:image/svg+xml;base64,' + iconBytes.toString('base64')

/** `--timestamp <秒>` 覆盖发布时间，便于复现；默认当前时间。 */
function publishTimestamp() {
  const index = process.argv.indexOf('--timestamp')
  if (index >= 0 && process.argv[index + 1] !== undefined) {
    const value = Number(process.argv[index + 1])
    if (!Number.isInteger(value) || value <= 0) throw new Error('--timestamp 需为正整数 Unix 秒')
    return value
  }
  return Math.floor(Date.now() / 1000)
}

const index = {
  format: 1,
  title: { en: 'Buddy plugin index', zh: 'Buddy 插件索引' },
  description: {
    en: 'Plugins built for DeepSeek Harness by the Buddy workspace.',
    zh: '为 DeepSeek Harness 编写的 Buddy 工作区插件。'
  },
  metadata: {
    categories: {
      productivity: { title: { en: 'Productivity', zh: '效率' } }
    },
    labels: {},
    sortKeys: {}
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: en.title, zh: zh.title },
      description: { en: en.description, zh: zh.description },
      icon: iconDataUrl,
      metadata: {
        category: 'productivity',
        keywords: Array.isArray(pkg.keywords) ? pkg.keywords.slice() : [],
        labels: [],
        sortKeys: {}
      },
      versions: [
        {
          version: pkg.version,
          publishTimestamp: publishTimestamp(),
          /* 从 npm 安装：不写 registry 就用客户端配置的默认 registry。 */
          source: { type: 'npm' },
          engines: {}
        }
      ]
    }
  ]
}

const outDir = path.join(REPO, 'market')
fs.mkdirSync(outDir, { recursive: true })
const outFile = path.join(outDir, 'index.json')
fs.writeFileSync(outFile, JSON.stringify(index, null, 2) + '\n', 'utf8')
console.log('已生成 ' + path.relative(REPO, outFile) + '（' + pkg.name + '@' + pkg.version + '）')
