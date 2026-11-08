---
name: html-to-doc
description: 将 HTML 整份转换为 .docx——一键脚本 scripts/convert_doc.py 自包含全流程：预检 → create → open → insert_html_content → save 直接写交付路径（产物即位，无中间拷贝）→ verify，结果 JSON 在 stdout 末行、error 标注失败阶段，失败即如实报错；preflight/verify 两步校验可经 --no-preflight/--no-verify 跳过（工作流默认快通道）；调用方在脚本成功后 present 成品。触发词：HTML 转 docx、HTML 转 Word、灌入文档、insert_html_content、生成 docx。
description_en: "Convert a complete HTML document into a .docx file. The one-shot script scripts/convert_doc.py handles everything: preflight, create, open, insert_html_content, save (directly to the delivery path, no intermediate copy), and verify. Result JSON on the last stdout line. The caller presents the finished file only after the script succeeds (no more blank placeholder preview). No fallback path: fail honestly."
author: Tencent Docs
version: "0.1.0"
category: capability
agent: doc-converter
tags: [html-to-doc, insert_html_content, docx, mcp]
user-invocable: false
disable-model-invocation: true
---

<!-- S3 转换一次 insert_html_content 完成。规范冲突时以本 SKILL 为准。 -->

# html-to-doc Skill

> **定位**：本地通道 S3 的**主转换实现**，主入口 `scripts/convert_doc.py`。

---

## 1. 前置

- `python3`
- MCP 文档服务可用：端点经环境变量配置（`editor_sdk_port` 端口；服务启用鉴权时设
  `editor_sdk_token`）；工具集含 `doc_` 前缀的文档工具与 **common 类**（无前缀）
- 所有调用通过本 skill `scripts/edsdk.py` 封装脚本完成（HTTP 直连 MCP 端点）：
  ```bash
  python3 <skill>/scripts/edsdk.py list doc    # 验通：能列出 doc_ 工具即 OK
  ```

### 🔴 禁止自行拉起文档服务（曾导致单篇文档耗时 30 分钟）

**不要**用 `subprocess.Popen` 拉起服务进程，**不要**另起新端口——
文档服务由运行环境提供，**直接复用**即可。
实测代价：服务进程启动需嵌入 doc/slide 大体积资源；某次任务因反复拉起服务
**21 次**、每次轮询等待最多 60 秒，累计 **18 分钟**空耗，而真正插入文档只用了 22 秒。

> ⚠️ **工具类别分布（防止误判服务缺工具）**：工具按前缀分类——`doc_` /
> `sheet_` / `slide_`，以及 **common 类（无前缀）**。
> **`create_doc` / `open_file` / `save_file` / `close_file` / `find` 等都是 common 类**，
> `list doc` 里看不到它们，需 `list common` 或不带类别 `list` 查看全量。
> **绝不要因 `list doc` 中没有 `create_doc` 而判断服务缺工具**——common 工具一直都在。


---

## 2. 核心流程

```
⓪ 一键转换（create → open → insert → save 直接写交付路径 → verify 全在脚本内；
      │          工作流默认 --no-preflight --no-verify 跳过两步校验走快通道）
      │             python3 <skill>/scripts/convert_doc.py
      │               --html <S2的HTML文件> --output <output_docx_path>
      │               --no-preflight --no-verify     ← 工作流默认（跳过预检与出门校验；
      │                                                 排查产物问题或需严格校验时去掉）
      │               [--require-page-furniture]   ← 启用 preflight 时：用户要求页眉页脚/页码/封面时必传
      │               [--require-toc]              ← 启用 verify 时：用户要求目录时必传
      │           · 退出码 0（stdout 末行 JSON success=true）→ 产物 docx 已直接
      │             落在 output_docx_path（无中间拷贝）→ 调用方 present 成品
      │           · 退出码 1 → JSON error 标注失败阶段（preflight/convert/verify），
      │             preflight/verify 字段含具体 issues——如实报告；直接重跑本脚本
      │             （每次 create 新文档，不依赖上次会话状态），再败 → 如实报错（附 issues），
      │             禁止带缺陷交付
```

## 2.1 调用规范（`doc_insert_html_content` 及配套工具）

> 正常链路一律走 ⓪ 的 `convert_doc.py`；本章工具级细节**仅用于脚本失败的排查复现**。
> 参数以 MCP 工具 schema 实时返回为准。

### 通道约束

- 所有 MCP 调用经 `scripts/edsdk.py` 封装完成；仅调用服务实际提供的工具。
- **不要凭记忆拼参数**——必填项与字段语义以该工具的 schema 实时返回为准；
  用到哪个工具才查哪个，不预先拉全量。
- 整份 HTML 单次插入（`idx=0` 一次写入）。

### 调用方式（`edsdk.py` 三条命令）

| 命令 | 作用 |
|---|---|
| `python3 <skill>/scripts/edsdk.py list [doc\|common]` | 列出工具（工具名 + 一句话描述）；可按前缀类别过滤 |
| `python3 <skill>/scripts/edsdk.py schema <工具名>` | **按需**查单个工具的完整参数（required + 各字段说明）——调用前必做 |
| `python3 <skill>/scripts/edsdk.py call <工具名> [k=v ...] [--json '{...}'] [--json-file args.json]` | 调用工具 |

入参写法：`key=value`（值优先按 JSON 解析：数字 / 布尔 / 数组 / 对象 / null，
失败则当字符串）；复杂 / 长文本参数（如 `html_text`）用 `--json '{...}'` 或
`--json-file args.json`（与 `key=value` 合并，同名键以后者为准）。

**调用前自检（缺一不可）**：

- ☑ 已对**本次要用的工具**跑过 `edsdk.py schema <工具名>`（用到哪个查哪个，不预拉全量）
- ☑ 已确认全部必填字段（`doc_insert_html_content`：`file_id` / `idx` / `html_text`）
- ☑ 已确认位置语义（`idx` 为 DOC 坐标，恒为 `idx=0`；不传
  `paragraph_index` 或手算字符数）
- ☑ 若拿不到有效索引，绝不静默默认 0（见「位置与索引规则」）

### 接口列表（一句话摘要，仅用于选工具）

| 工具 | 关键参数 | 说明 |
|---|---|---|
| `create_doc` | — | **common 类**（无 doc_ 前缀，`list` 或 `list common` 可见）：从空白模板新建，返回 `file_id` |
| `open_file` | `file_path` | **common 类**：打开已有本地文件 |
| `doc_insert_html_content` | `file_id`、`idx`、`html_text` | 在 `idx` 处插入 HTML 富文本（S2 的 HTML 文件产物，单次插入） |
| `doc_get_last_operable_pos` | `file_id` | 取当前文档真实末尾 `position`（缺 `last_edit_index` 时兜底用） |
| `save_file` | `file_id`、`file_path` | **common 类**：落盘 .docx |
| `close_file` | `file_id` | **common 类**：释放编辑器会话（防池污染，见「文档标识与会话」） |

> ⚠️ 不要凭记忆拼参数。`doc_insert_html_content` 的必填项与字段语义以
> `schema doc_insert_html_content` 实时返回为准。


### 文档标识与会话

> **🔴 create_doc 与 doc_insert_* 返回结构不同，解析要分开处理**
>
> - `create_doc`：`file_id` / `file_path` 在 JSON-RPC result 的**顶层字段**
>   （自写 driver 直调 RPC 时必须取顶层，不在 `content[0].text` 里）；经
>   `edsdk.py call` 输出为文本行 `file_id=xxx, file_path=...`，按等号提取。
> - `doc_insert_*` 系列：关键索引在 content 文本（JSON）里，按 JSON 解析。
>

> **🔴 编辑器会话用完必须 close_file（防池污染劣化引擎）**
>
> 每次 `create_doc` 占一个编辑器槽位；**反复创建不关闭会耗尽池并劣化引擎行为**
> （实测：debug 期间堆积 72 个未关闭编辑器后引擎返回异常；清理后恢复）。
> driver 收尾（save/verify 完成或异常退出）必须 `close_file(file_id)`；
> 整体重跑前若怀疑池污染，可批量 close 清理。
>

### 返回值解析

> **🔴 返回值是 JSON 文本，解析必须走 JSON（实测翻车案例）**
>
> 工具返回是 **JSON 字符串（`"key":value` 冒号格式）**。若自写脚本解析返回值，
> **必须用 JSON 解析器**（或至少按冒号格式的正则），**禁止按 `key=value` 等号格式写正则**——
> 等号正则匹配不到任何字段、`last_idx` 会**静默回落到 0**，后续追加插入会以
> `idx=0` 落到**文档开头**（实测 2026-09-15：目录被插到封面前，即此因）。
>
> 标准解析（照抄，勿自造）：
> ```python
> import json, re
> def get_idx(tool_output_text):
>     # 引擎返回为 JSON 文本；双保险同时支持 JSON 与冒号正则
>     try:
>         d = json.loads(tool_output_text)
>         if "last_edit_index" in d: return d["last_edit_index"]
>     except Exception: pass
>     m = re.search(r'"last_edit_index"\s*:\s*(\d+)', tool_output_text)
>     if m: return int(m.group(1))
>     return None   # 拿不到时绝不能默认 0！按下方「缺失规则」兜底
> ```
> **拿不到 `last_edit_index` 时返回 None 并走兜底，绝不能静默用 0。**
>

### 位置与索引规则

- `idx=0` 一次插入，无链式追加场景。
- 返回值语义（`last_edit_index` / `position` 可能不同值、链式追加锚点、
  缺失时的处理）**以工具 schema 描述为准**——schema 已完整声明：
  追加一律用 `last_edit_index`；缺失（插入内容未产生实际块）则沿用上一个
  有效值，勿用 `position`。
- 🛡️ 防御性铁律：任何情况下拿不到有效索引，**绝不能静默默认 0**（内容会
  落到文档开头）——调 `doc_get_last_operable_pos` 查真实末尾。

---

## 2.2 预览与落盘注意事项（通用）

1. **不 `save_file` 预览一定是空的** —— 内容只在服务端内存里，
   预览面板读的是磁盘文件。插入后必须 save 才能预览。
2. **save_file 不关闭引擎会话**（实测 2026-09-16：save 后继续 insert 正常）。
   若插入报 `document is not open`（会话被引擎回收等场景），先用 `open_file`
   重新打开同一路径，拿到新的 `file_id` 再继续。

---

---

## 3. 输入 / 输出契约

### 输入

| 参数 | 来源 | 说明 |
|---|---|---|
| `--html` | `html_output_path` | doc-formatter 输出的** HTML 文件** |
| `--output` | `pipeline-state.yaml` 的 `output_docx_path` | 落盘绝对路径 |

### 输出（结果 JSON，stdout 末行）

```yaml
success: boolean
docx_path: string | null        # 成功时的 .docx 路径（save 直写交付路径，无中间拷贝）
chunks: int | null              # 实际插入的块数（引擎返回解析）
preflight: object | null        # preflight 子对象（含 issues；@page 相关提示记录在此，非顶层 warnings）
verify: object | null           # verify 子对象（含 issues 与 S-1~S-7 校验明细）
aigc_tag: object | null         # AIGC 隐标写入结果
error: string | null            # 失败时格式 "[stage] msg"（stage ∈ preflight / convert / verify）
```

> 契约以 `scripts/convert_doc.py` 实际输出为准：**无** `file_id` / `warnings` / `fallback_used` 字段（历史版本的 `ConvertResult` 字段已随引擎替换移除）。

---

## 4. 失败处理

**S3 唯一实现是本 skill（MCP 工具 `doc_insert_html_content`）。任何情况下都不得改用
其他实现构造 .docx，失败即如实报错，不存在任何兜底分支。**

| 情况 | 处理 |
|---|---|
| MCP 文档服务不可达 | `error=[convert] ...`，如实返回错误 + 提示文档服务连接状态，**不降级到其他实现** |
| `create_doc` 失败 | 同上 |
| 插入失败 | `success=false`，`error=[convert] ...`（源 HTML 路径即调用方传入的 `--html`，如实报错） |
| `save_file` 失败 | `success=false`，`error=[convert] ...`；脚本内 finally 已尝试 `close_file` 清理会话（不回传 `file_id`） |

失败统一通过结果 JSON 的 `error` 字段标注阶段（`[preflight]` / `[convert]` / `[verify]`），退出码 1。
