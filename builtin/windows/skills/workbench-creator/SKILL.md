---
name: workbench-creator
description: 创建/修改「个人工作台」HTML + 外置 CSV 数据视图的唯一权威规则。当用户在对话框用 @ 选择工作台模板、或明确要求创建/修改个人工作台时使用；内含创建步骤、菜单声明 schema、桥 API、CAS/409、刷新列表、创建前一次性偏好询问与扁平化 UI 自检清单。
category: workbench
tags: [workbench, html, csv, flat-ui]
user-invocable: true
disable-model-invocation: false
---

# 个人工作台创建规则（唯一权威正文）

本技能是「个人工作台」创建与修改方法的唯一权威规则来源。工作台扩展只提供只读接口与数据读写代理；HTML 页面与外置 CSV 由你（dsh agent）按本规则生成并直接落盘。

## 1. 何时使用 / 护栏

- 仅在用户明确要求创建或修改个人工作台，或在对话框用 `@` 选中工作台模板触发创建指令时加载并执行本技能。
- 无关对话完全忽略本技能：不解析规则、不生成任何文件、不输出任何工作台文本。
- 同一会话只加载一次；一次会话内连续创建多个工作台时复用已加载的规则，不重复加载、不重复问询。
- 本规则正文只用于指导生成，绝不回显到对话框，也不写进用户消息。

## 2. 创建前一次性偏好询问

生成任何文件之前，用宿主的 `ask_user_question` 工具**一次问 3 个问题**（最多 1 轮，不追问）：

| # | 问题 | 选项 | 跳过默认 |
| --- | --- | --- | --- |
| 1 | 形态用途 | 记录台账 / 看板 / 表单驱动 / 统计仪表盘 | 记录台账 |
| 2 | 增改表单 | 弹窗 / 行内 / 顶部常驻 / 抽屉；同轮另问「字段是否按模板预置」（默认预置、允许增删） | 弹窗 + 按模板预置 |
| 3 | 数据目录 | 沿用全局 / 自定义绝对路径 | 沿用全局 |

- 用户跳过、超时、或工具不可用：**全部按上表默认继续创建**，不中断、不报错、不追问。
- `ask_user_question` 不可用时，退化为**一条自然语言一次性提问**（把 3 题合并进一条消息一次问完），仍是最多 1 轮；无回答即按默认。
- `@` 指令已带绝对路径时跳过第 3 题，直接使用该路径。
- **页面菜单与排版由你实现，深浅色由宿主决定**：导航菜单、布局、字号、圆角全部由你生成的 HTML 自己写；但**配色必须跟随宿主 dsh 的通用外观**，不要问用户「要浅色还是深色」，也不要写 `menuStyle` / `theme` 字段。插件会在页面就绪后把宿主外观变量下发进页面（见第 5 段 `theme()` / `onTheme`），你只要在 CSS 里用这些变量即可。
- 表单形态、字段预置结果体现在生成的 HTML 与 `tables[].fields[]` 中，不新增其它声明字段。

## 3. 落盘位置（两个不同 root）

- **HTML**：`$DSH_HOME/dsh-buddy-expert-hub/workbench/<id>.html`。目录取自 `GET /settings` 响应里的 `workbenchHtmlDir`；取不到时回落到上述默认路径。
- **CSV**：`<数据目录>/<id>/<tables[].file>`。数据目录沿用全局设置，或使用用户自定义的绝对路径。
- 两个 root 完全不同，绝不把 HTML 写进数据目录、也绝不把 CSV 写进 HTML 目录。
- 工作台扩展**不提供 HTML 写接口**：HTML 由你按本规则生成后直接落盘；CSV 由桥在首次读写时按字段创建。
- 生成完成后提示用户点「刷新列表」即生效，**无需重启进程**（列表每次请求都重新扫描 HTML 目录）。

## 4. 菜单声明 schema

在 HTML 的 `<head>` 内放一个 JSON 载体（只读字符串提取 + 白名单校验，绝不执行 HTML）：

```html
<script type="application/json" id="workbench-menu">
{ "version": 1, "id": "reading-log", "name": "读书记录", "tables": [], "menu": [] }
</script>
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `version` | number | 否 | 缺省 1 |
| `id` | string | 是 | 小写字母/数字/连字符，1–64 位，建议与 HTML 文件名一致 |
| `name` | string | 是 | 展示名 |
| `icon` | string | 否 | 图标名 |
| `tables[].file` | string | 是 | 无路径的 CSV 文件名 |
| `tables[].fields[].key` | string | 是 | 字段名，字母/数字/下划线 |
| `tables[].fields[].label` | string | 否 | 展示名，缺省取 key |
| `tables[].fields[].type` | string | 否 | string / number / date / boolean / enum，缺省 string |
| `tables[].fields[].required` | boolean | 否 | 缺省 false |
| `tables[].fields[].default` | scalar | 否 | 缺省空串 |
| `tables[].fields[].options` | string[] | 否 | enum 类型的候选项 |
| `menu[]` | object[] | 否 | 可选，仅供页面自身导航参考；**插件不渲染**，页面菜单必须写在 HTML body 里 |

- `_id` 列由后端自动补齐，不要在 `fields[]` 里重复声明。
- JSON 文本内如需出现 `</script>`，必须写成 `\u003c/script\u003e`，否则会提前闭合载体标签。
- 载体标签必须是 `<script type="application/json" id="workbench-menu">` 这一形式。
- **菜单必须在 HTML 里**：页面内的导航菜单、按钮、标签页都写在 `<body>` 中由页面自己渲染和控制；插件不会代画任何页面内按钮。
- 插件只做两件事：左侧列出工作台文件（HTML + 它下面的 CSV 数据表）、右侧把该 HTML 整页铺满显示。
- 因此不需要 `menuStyle` / `theme` 之类的字段；写了也会被忽略。

## 5. 桥 API（只用注入的 window.Workbench）

- 页面只能使用注入的 `window.Workbench`，不得自己 `fetch` 任何数据接口：iframe 是 opaque origin，使用 `sandbox="allow-scripts"`，没有同源权限。
- `ready()`：通知父窗口页面就绪，返回 Promise。
- `read({ table })`：读一张表，返回 `{ columns, rows, fields, hash, ... }`。
- `write({ table, baseHash, columns, rows })`：按乐观并发写回，返回 `{ hash, columns, rows }`。
- `onData(fn)`：订阅父窗口的 `push` 消息。回调**必须先判断 `Array.isArray(payload && payload.rows)`，不成立就忽略**（父窗口可能发其它类型的推送），否则会把非数据推送误当数据刷新。
- `onConflict(fn)`：订阅 `conflict` 消息。
- `theme()`：返回当前宿主外观 `{ scheme: 'light'|'dark', tokens: {...} }`，插件自动维护，不需要主动请求。
- `onTheme(fn)`：订阅宿主外观变化（注册时若已收到外观会**立即回调一次**）。只有需要额外逻辑（重绘图表、换 logo、切图片）时才用；纯 CSS 直接写变量即可。
- 每次请求 5 秒超时；失败要给用户可读的轻提示，不要静默吞掉。
- `push` = 外部改动或数据刷新通知；`conflict` = 写入被乐观并发校验拒绝。

## 6. CAS / 409 / 冲突态

- `hash = sha256(磁盘 CSV 原始字节)`，由后端计算并随读响应返回；`mtimeMs` / `size` 只做轮询预检。
- 写回必须带上次读到的 `baseHash`；后端按「工作台 + 表」串行写入、队列内二次校验、临时文件改名原子落盘。
- 外部改动 CSV 时父窗口会自动 `push`，页面应重新读取并刷新表格。
- `baseHash` 与磁盘不一致时返回 409 并带 `current`（当前磁盘数据）。此时展示**非阻断**的顶部横幅「数据表已在外部被修改，已重新加载」+「重试 / 放弃」两个操作。
- 不静默覆盖用户编辑、不打断正在输入的表单、不弹模态框；「放弃」保留用户当前输入或回到只读态，由你按场景选一种并保持一致。

## 7. 扁平化 UI 10 条自检清单

生成 HTML 后逐条核对：

1. **配色**：单主色 + 中性灰阶，最多 1 个强调色；禁渐变 / 拟物 / 纹理 / 图片背景；阴影最多 1 层 `0 1px 2px rgba(0,0,0,.06)`。所有颜色都写成 `var(--dsw-alias-<语义>, <浅色回退>)`，浅色回退参考值：背景 `#F7F8FA`、卡片 `#FFFFFF`、主文字 `#1F2329`、次文字 `#646A73`、边框 `#E5E6EB`、主色 `#2B5AED`。**不要写死任何背景 / 文字 / 边框色**，否则深色主题下整页会发白。
2. **间距**：4px 基数栅格（4 / 8 / 12 / 16 / 24 / 32）；卡片内边距 16–24；区块间距 24；控件高 32 / 40。
3. **字号**：基准 14px；标题只 18 / 20 / 24 三级；行高 1.5；字重只 400 / 500 / 600；中文系统字体栈优先。
4. **控件形态**：圆角 4–8px 全局统一；按钮只「主（实心）/ 次（描边）/ 文字」三种；无 3D 凸起、无内阴影；输入框 1px 描边 + focus 主色 ring。
5. **表单布局**：单列优先、标签在上、一行 ≤2 字段；必填用 `* ` 前缀标注；校验错误就地红字提示、不用 `alert`；主操作按钮右对齐。
6. **空态**：图标 + 一句说明 + 恰好 1 个主操作「添加第一条记录」，无数据时表格区不白屏。
7. **冲突态**：按第 6 段实现非阻断顶部横幅 +「重试 / 放弃」，不打断输入。
8. **同步态**：「已保存」「数据表已更新」用轻提示，2s 自动消失，不弹模态。
9. **响应式 / 无障碍**：`min-width:0`、表格横向滚动、窄屏单列；交互元素带 `aria-label`、键盘可聚焦、文字对比度 ≥4.5:1。
10. **深浅色自适应（必须）**：插件会把宿主通用外观变量下发到本页 `:root`，并给 `html` 打 `data-dsh-theme="light|dark"`。页面一律用变量，不写死颜色：
    - 底 `--dsw-alias-bg-base`、卡片 `--dsw-alias-bg-layer-1`、次级底 / hover `--dsw-alias-bg-layer-2`、选中底 `--dsw-alias-interactive-bg-hover-solid`
    - 主文字 `--dsw-alias-label-primary`、次文字 `--dsw-alias-label-secondary`、边框 `--dsw-alias-border-l1`
    - 主色 `--dsw-alias-brand-primary`、错误 `--dsw-alias-state-error-primary`、成功 `--dsw-alias-state-success-primary`、警示 `--dsw-alias-state-warning-primary`
    - **实心主色 / 状态色块上的文字用 `var(--dsw-alias-bg-base, #fff)` 做反色**（深色主题下主色可能就是白色，写死 `#fff` 会变成白底白字）。
    - 示例：`body{background:var(--dsw-alias-bg-base,#F7F8FA);color:var(--dsw-alias-label-primary,#1F2329)}`。
    - 变量到达前用回退值渲染、到达后自动变，**不需要写切换脚本**；只有需要额外逻辑（重绘 canvas 图表、换 logo）时才用 `window.Workbench.onTheme(fn)`。
    - 需要纯 CSS 分支时用 `html[data-dsh-theme="dark"] .xxx{...}`，但优先用变量，不要维护两套颜色。

## 8. 完成与自检

- 逐条对照第 7 段的 10 条清单，缺一条就补齐再交付。
- 确认页面**没有写死颜色**：背景 / 文字 / 边框全部走 `var(--dsw-alias-*, 回退值)`，深色主题下不出现白底白字、不刺眼。
- 确认菜单声明是合法 JSON、字段都在白名单内、`</script>` 已写成 `\u003c/script\u003e`。
- 确认 HTML 与 CSV 分别落在第 3 段的两个 root 下。
- 最后提示用户点「刷新列表」即可看到新工作台，无需重启进程。
- **不把本规则正文、schema 说明或任何提示词回显到对话框**；对话框只保留用户的简短描述与 chip。
