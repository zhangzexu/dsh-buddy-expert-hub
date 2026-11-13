# 外观一致性铁律（dsh 通用外观）

> 一句话：**插件自己的每一个颜色都必须来自宿主 dsh 的通用外观 token，不得自建一套配色。**
>
> 这是硬约束，不是建议。后续任何 UI 改动（新面板、新弹窗、新按钮、新状态条）都先按本文件查表再写样式，
> 并由 `_harness/appearance.mjs` 自动把关；不过 harness 的提交视为不合格。

---

## 1. 规则

| # | 规则 | 说明 |
| --- | --- | --- |
| R1 | 颜色只认 `--dsw-alias-*` | 宿主 dsh 的语义 token（底色 / 层级 / 文字 / 边框 / 主色 / 状态色），深浅主题由宿主切换 |
| R2 | 写法固定 `var(--dsw-alias-<语义>, <回退值>)` | 宿主提供 → 跟随宿主；宿主没提供 → 回退值兜底，渲染不塌 |
| R3 | 裸色值只允许 `#fff` 与 `rgba()` | `#fff` 仅用于彩色底上的前景文字；`rgba()` 仅用于阴影 / 遮罩 / 半透明边界 |
| R4 | 唯一登记例外：技能图标色板 | `SKILL_TILE_PALETTE`（10 组 bg/fg，共 20 个色值），属"内容装饰色"，与界面主题无关 |
| R5 | 禁止私有变量体系 | 不再出现 `--wb-*`、`--dshe-color-*` 这类插件自定义颜色变量 |
| R6 | 禁止自造主题 | 不写 `prefers-color-scheme`、不切 `data-theme`、不注入主题脚本、不留"插件主题设置"开关 |
| R7 | 尺寸沿用既有尺度 | 字号 11/11.5/12/12.5/13/14/15px，圆角 6/8/10/12/14px，间距 4/6/8/10/12px；宿主若提供字号 / 圆角 token 再统一接入 |

## 2. token 对照表

| 语义 | token | 用在哪 | 回退值示例 |
| --- | --- | --- | --- |
| 页面底 | `--dsw-alias-bg-base` | 面板根容器、工作台底 | `#fff` |
| 卡片 / 容器底 | `--dsw-alias-bg-layer-1` | 卡片、工具条、侧栏、iframe 容器、输入框 | `#fff` |
| 次级底 | `--dsw-alias-bg-layer-2` | hover 行底、空态底、状态条底、代码块 | `#f6f8fa` |
| hover 实色 | `--dsw-alias-interactive-bg-hover-solid` | 树节点选中底、分段控件选中底、蓝色淡底 | `#e8f0ff` |
| 主文字 | `--dsw-alias-label-primary` | 标题、正文、当前项 | `#1f2328` |
| 次文字 | `--dsw-alias-label-secondary` | 描述、辅助说明、占位、禁用 | `#57606a` |
| 边框 | `--dsw-alias-border-l1` | 卡片边、输入框边、分割线、虚线空态 | `#d0d7de` |
| 主色 | `--dsw-alias-brand-primary` | 主按钮、选中态、链接、焦点圈、开关 | `#0969da` |
| 主色 hover | `--dsw-alias-brand-primary-hover` ⚠️ | 主按钮 hover | `#000` |
| 错误 | `--dsw-alias-state-error-primary` | 报错文字 / 边框 / 淡底 | `#cf222e` |
| 成功 | `--dsw-alias-state-success-primary` ⚠️ | 已连接、校验通过、本地技能点 | `#16a34a` |
| 警示 | `--dsw-alias-state-warning-primary` ⚠️ | 冲突提示、提醒条文字 / 边框 | `#92400e` |

⚠️ 标记的三个 token 是按语义等价的**推测名**：宿主若存在同名 token 就自动跟随，不存在则回退到原值，不影响渲染。
其余九个 token 已在现有界面上实际生效。后续若拿到宿主完整 token 清单，应把推测名替换成确认名，并同步本表。

## 3. 范围边界

| 区域 | 是否受本铁律约束 | 说明 |
| --- | --- | --- |
| 插件主面板（专家 / 专家团 / 技能 / 连接器） | ✅ 必须 | 标签页、卡片、详情抽屉、搜索、按钮、空态、骨架屏 |
| 侧栏入口与独立工作台面板 | ✅ 必须 | 工具条、文件树、分隔条、状态栏、设置弹窗、toast |
| 连接器安装 / 导入 / 文件夹选择弹窗 | ✅ 必须 | 输入框、校验提示、进度态 |
| iframe 里的工作台 HTML | ⚠️ 半约束 | 页面样式由 HTML 自己写；但插件会把宿主 token 下发进页面 `:root`（`kind:"theme"`），页面用 `var(--dsw-alias-*, 回退)` 就自动跟随深浅色。见 §4 |
| 技能卡片图标色板 | ⚠️ 登记例外 | 见 R4 |
| 第三方资源图标（专家 / 连接器头像） | ❌ 不约束 | 远端图片资源，保持原色 |

## 4. iframe（工作台 HTML）怎么跟随

工作台页面在 `sandbox="allow-scripts"` 的 opaque-origin iframe 里，**继承不到宿主的 CSS 变量**。所以由父窗口主动下发：

1. 父窗口读宿主的 `--dsw-alias-*` 快照（11 个语义 token），iframe `ready` 时先发一次，之后每 1s 比对指纹，变了才发 `{ magic:'__wb:1', kind:'theme', payload:{ scheme, tokens } }`。
2. 桥把 `tokens` 写到 iframe 的 `documentElement.style`（同名 `--dsw-alias-*`），并给 `html` 打 `data-dsh-theme="light|dark"`、设置 `color-scheme`。
3. 页面只要写 `var(--dsw-alias-bg-base, #F7F8FA)` 这类带回退的引用，深浅色自动跟随；变量到达前用回退值渲染，不需要切换脚本。
4. 页面需要额外逻辑（重绘 canvas 图表、换 logo）时用 `window.Workbench.onTheme(fn)` / `window.Workbench.theme()`。

约定边界：

- 这条链路**只下发变量**，不注入任何样式表 / 不覆盖页面选择器 —— 页面自己的排版、菜单、圆角仍由 HTML 决定。
- 页面里**禁止写死背景 / 文字 / 边框色**（否则深色外观下整页发白）；这条写进了 `workbench-creator` 技能的 UI 清单第 10 条，由 agent 在生成时保证。
- 实心主色 / 状态色块上的文字用 `var(--dsw-alias-bg-base, #fff)` 反色 —— 深色主题下 `brand-primary` 可能就是白色。
- 参考实现：`docs/workbench-example.html`（`:root` 里做一层 `--app-*` 映射，全站只用变量）。

## 5. 自检

```bash
# 在工作区根目录
node _harness/appearance.mjs
```

断言覆盖：

| 编号 | 断言 |
| --- | --- |
| AP1 | 不存在 `--wb-*` / `--dshe-color-*` 等私有颜色变量 |
| AP2 | 裸色值只允许 `#fff` 与 `rgba()`（色板区间以外） |
| AP9 | 唯一颜色例外就是技能图标色板（必须恰好 20 个色值） |
| AP3 | 面板根容器底色 / 主文字取 `bg-base` / `label-primary` |
| AP4 | 九类语义 token 齐备（主色 / 边框 / 主次文字 / 两级底 / 三状态色） |
| AP5 | 每个 `var(--dsw-alias-*)` 都带逗号回退值 |
| AP6 | 没有 `prefers-color-scheme` / `data-theme` / 主题注入 |
| AP7 | 工作台面板每条规则的颜色都从 token 取 |
| AP8 | 样式里没有自定义属性定义（防止再长出私有变量体系） |
| AP10 | 主色 / 状态色填充上的文字不写死 `#fff`（必须用 `bg-base` 反色） |

## 6. 新增 UI 的流程

1. 先在 §2 查语义 → 找不到合适语义时，用**最接近的层级色**（`bg-layer-2` / `label-secondary`），不要新造颜色。
2. 写成 `var(--dsw-alias-<语义>, <接近当前观感的回退值>)`。
3. 跑 `node _harness/appearance.mjs`，必须 9/9 PASS。
4. 再跑对应的功能 harness + 全量回归。
5. 如果确实需要新 token（现有语义覆盖不了），先在 §2 登记为 ⚠️ 推测名，并在 PR / 提交说明里写清理由与回退值，不能直接写裸色值绕过。
