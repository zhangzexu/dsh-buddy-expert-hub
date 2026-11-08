---
name: brief-compose
description: |
  短篇文档创作（目标篇幅 <1000 字）：从零撰稿 → 生成 HTML → html-to-doc 转 .docx → present_files 预览。
category: capability
tags: [brief-compose, short-form, html-to-doc, docx]
user-invocable: false
disable-model-invocation: true
---

# brief-compose Skill

**何时走**：无已有文档 + 创作动词（写/起草/撰写/生成/重写）+ 模型判断目标篇幅 <1000 字。

> **⛔ 工作流锁定**：一旦判定任务属于本 skill，**无视**其他 skill 与子 Agent，**严格按本文从头到尾执行**；无需再读其他skill。

---

## 篇幅判据

创作动词已命中、且非编辑意图时，满足任一即走本工作流：

- 用户给出 X 字且 X < 1000
- 「短篇 / 千字以内 / 简版」等表述
- 体裁为简介 / 通知 / 备忘录 / 工作小结等典型短篇

显式长篇（≥1000 字、万字、研报、论文等）→ 未命中本 skill，回到 `tdoc-orchestrator` SKILL.md 走常规编排。
---

## 原则

1. **强制流程（速览）**（完整命令见文末「强制流程」）：
   - ① 撰稿 + 生成 HTML
   - ② 调用 html-to-doc 插入
   - ③ `present_files`
2. **中间产物不展示**：`.html` 不得 `present_files`、不得在回复里贴 HTML 正文；只有最终 `.docx` 可展示。
3. **失败如实报错**：HTML 无 `<body>` → 终止并提示；用户明确要求新建空白文档时允许转换；其他创作请求若 body 无可渲染正文，必须重新生成 HTML。**禁止**静默降级到常规 full_pipeline 编排。
4. **最终交付**：`.docx` 生成后**必须立即** `present_files` 打开预览，无例外。
5. **输出路径**：工作流开始时调用 `resolve_output_docx_path.py`，将返回的 `output_docx_path` 用于 html-to-doc 与 `present_files`。

---

## 输出路径（`output_docx_path`）

```bash
python3 <plugin_root>/scripts/wb/local/resolve_output_docx_path.py \
  --workspace <workspace> \
  [--user-path "<路径>"] [--filename "<主题>.docx"]
```

**不传 `--request-id`**（brief-compose 不走 pipeline 隔离目录）。默认落盘 `<workspace>/output/<文件名>.docx`。

### 中间 HTML 路径（`output_html_path`）

**中间 HTML 固定写到 workspace 下**，禁止落在用户 `--user-path` 目录（Documents / 桌面等真实目录），避免污染用户目录。

派生规则（**与 `--user-path` 是否传入无关，统一适用**）：

```
output_html_path = <workspace>/output/brief-compose/<stem>.html
```

其中 `<stem>` = `output_docx_path` 文件名去掉 `.docx` 后缀。

| `output_docx_path` | `output_html_path` |
|--------------------|--------------------|
| `/Users/x/Documents/通知.docx` | `<workspace>/output/brief-compose/通知.html` |
| `<workspace>/output/通知.docx` | `<workspace>/output/brief-compose/通知.html` |

> **理由**：当 `--user-path` 指向用户真实目录时，docx 是用户期望的最终交付物；HTML 仅是 docx 转换的中间产物，不应出现在用户目录。`workspace/output/brief-compose/` 是 workspace 内部目录，随使用周期清理即可。

## HTML 生成

按用户创作指令撰写正文，输出**完整 HTML 文件**（`<!DOCTYPE html>`、`<head>` 含 `charset`、内嵌 `<style>` 均可，UTF-8、无 BOM）。篇幅控制在用户给出的 X 字以内。

**最低要求**：必须有 `<body>` 且含实际正文；用户明确要求新建空白文档时例外。其他创作请求若生成后 body 无可渲染正文，必须重新生成 HTML，禁止转换或交付空 docx。

**其余版式**（标题层级、段落样式、是否用表格分栏等）由模型自行决定，无固定骨架。

### 字体与字号建议

字号请用 **`pt`（磅）**，**不要用 `px`**。`html-to-doc` 按 pt 写入 Word；常见误用 `13px` 在 Word 里约 **9.5pt**，正文偏小。

| 层级 | 建议字号 | 建议字体 |
|------|----------|----------|
| 正文 `p` / `li` / `td` | **12pt**（默认） | 宋体 / SimSun |
| 一级标题 `h1` | 18–22pt | 黑体 / SimHei |
| 二级标题 `h2` | 14–16pt | 黑体 / SimHei |
| 三级标题 `h3` | 12–14pt | 黑体 / SimHei |
| 辅助说明、落款 | 10–10.5pt | 宋体 / SimSun |

- 用户未指定字号时，正文**默认 12pt**，不要小于 **10.5pt**。
- 因转换器**块级 CSS 不继承**（见下节），`font-size` / `font-family` 须写在各 `p`、`h1`、`h2`、`li`、`td` 等块级元素上，不要只写在 `body` 上。

```

---

## HTML → docx 转换约束（仅引擎硬限制）

以下规则来自 `html-to-doc` 转换器能力边界；**违反会导致 docx 排版错乱或信息丢失**，其余 HTML/CSS 写法不受限。

### 1. 禁止 Grid / 定义列表

- **禁** `display:grid` / `grid-template-*` → 多列对齐改用 `<table>`
- **禁** `<dl>/<dt>/<dd>` → 键值对改用两列 `<table>`

### 2. 块级 CSS 不继承

转换器**不做**块级样式继承。父元素上的 `text-align` / `font-family` / `color` / `font-size` **不会**下发到子 `<p>` / `<h1>` 等；需要生效的样式请写在各块级元素自身上。

### 3. `<hr>` 装饰线

`<hr>` 在 docx 中只能变成**满版下边框**，无法保留居中短线/定宽装饰线；不要用 `<hr>` 做标题区装饰分隔。

### 4. 左边框段落

带 `border-left` 的块，文字开头加 `&nbsp;&nbsp;`（Word 左边框无可靠间距）。

### 5. 多段落底纹块

整块底纹 + 多段落富文本 → 用裸单列 `<table><tr><td>…</td></tr></table>`，不要用多个 `<div>` 拼底纹。

### 6. 分节 / 页眉页脚（仅需要时）

- 需要分页结构：顶层 `<section role="...">`（无 section 则单节）
- 需要页码/页眉：`<style>` 内 `@page` 子集（`counter(page)` / `counter(pages)` / `string-set` + `STYLEREF`）
- **不支持** `@page :first`、`@page { size }` 等扩展语法（忽略 + warning）
- 需要封面时用户须明确要求；配合 `@page cover { … content: none }` + `section[role="cover"] { page: cover; }`

### 7. 可选扩展标签（用了才需遵守其契约）

| 标签 / 属性 | 说明 |
|-------------|------|
| `<div data-component="callout\|divider\|section-marker\|data-card">` | 装饰组件 |
| `<span data-docx-field="..." data-placeholder="...">` | 转 docx 书签；同 HTML 内唯一，匹配 `^[A-Za-z][A-Za-z0-9_-]{0,63}$` |
| `<meta name="docx-page-size" content="A4">` | 声明页面尺寸（默认 A4） |

---

## HTML → docx 转换（html-to-doc）

短文档同样走 `html-to-doc`，与 S3 主链路同源（同一脚本）。

1. 一键转换（create/open/save 全在脚本内，自包含）：
   `python3 <skill>/scripts/convert_doc.py`
   `  --html <本技能生成的 HTML> --output <output_docx_path> --no-preflight --no-verify`
   （脚本内：create → open → insert → save 直接写交付路径 → verify；`--no-*` 为工作流默认快通道，排查产物问题时去掉）
2. 成功后 `present_files(<output_docx_path>)` 打开成品预览（唯一一次 present；脚本失败不得 present）
- 成功：脚本退出码 0，交付文件在 `output_docx_path`
- 失败：如实返回错误（脚本 JSON `error`），禁止静默降级到常规 full_pipeline 编排

---

## 强制流程

```
① 确定 output_docx_path（调用 resolve_output_docx_path.py，§输出路径）并预建父目录
② 撰稿 + 生成 HTML
   · 按用户创作指令撰写正文，自行排版
   · 遵守上文「字体与字号建议」与「HTML → docx 转换约束」
   · 写到 `<workspace>/output/brief-compose/<stem>.html`（**固定在 workspace 内**，不要写到 `output_docx_path` 同目录，避免 `--user-path` 指向用户真实目录时污染；具体派生见上节「中间 HTML 路径」）

③ HTML → DOCX
   · 按上文「HTML → docx 转换」：convert_doc.py（全流程在脚本内）

④ 预览
   · 脚本成功后 present_files(<output_docx_path>) 打开成品预览；脚本失败不得 present
```

未 `present_files` 即结束 = 工作流未完成。

---

## 异常处理

| 场景 | 处理 |
|------|------|
| HTML 无 `<body>` | 终止，提示用户 |
| 用户明确要求新建空白文档且 body 无可渲染正文 | 允许转换 |
| 其他创作请求且 body 无可渲染正文 | 重新生成 HTML，禁止交付空 docx |
| html-to-doc 失败 | 返回源 HTML 路径 + 错误，提示手动另存 |
| 用户事后要改内容/样式 | 属**下一轮请求**，转 `workbuddy-office-routing` |
| 用户事后要全文重新美化 | 未命中本 skill，回到 `tdoc-orchestrator` SKILL.md 走 `beautify_only` |
