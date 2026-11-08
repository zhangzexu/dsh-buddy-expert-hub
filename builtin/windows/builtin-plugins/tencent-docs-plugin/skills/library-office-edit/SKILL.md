---
name: library-office-edit
description: 支持资料库中 doc、sheet、slide 类文档的查看编辑能力
description_en: Supports view and edit capabilities for doc, sheet, and slide documents in the library.
disable-model-invocation: true
user-invocable: false
---

# WorkBuddy 资料库文档人机双写

> 本 skill 运行在 `tencent-docs-plugin` 插件中，是资料库人机双写的专用入口。编辑/查看资料库文档（含人机双写）时直接使用本 skill，不要改走插件内的 `tencent-docs` / `tencent-saas-docs`。

只处理**已有资料库文档**，必须持有以下原始链接之一：

- `https://www.workbuddy.cn/space/d/<nodeId>`
- `https://staging.workbuddy.cn/space/d/<nodeId>`

资料库 `nodeId` 不是腾讯文档 `file_id`；不要将资料库链接用于网页剪藏。
若无原始链接，先请用户提供，不得回退到普通文档票据。

## 调用方式

> 资料库 token、`X-App-Id` 取值、沙箱 / 客户端取票分流、链接校验和完整错误说明，
> 详见 [references/auth.md](./references/auth.md)；**首次使用前先读一遍**。

在本 skill 目录执行命令。资料库链路需要隔离宿主注入的 `PYTHONPATH`，避免 Windows 宿主 shim 的启动探针；
只清空该变量，不清空其他环境变量：

```bash
PYTHONPATH= python3 tencentdocs.py tdoc_init --document-url '<资料库原始链接>'
PYTHONPATH= python3 tencentdocs.py tdoc_list <service> --document-url '<资料库原始链接>'
PYTHONPATH= python3 tencentdocs.py tdoc_schema <service> <tool> --document-url '<资料库原始链接>'
PYTHONPATH= python3 tencentdocs.py tdoc_call <service> <tool> '[其他 JSON 参数]' --document-url '<资料库原始链接>'
```

Windows PowerShell 下，先在当前会话清空 `PYTHONPATH`，再运行对应 `python3 tencentdocs.py ...` 命令：

```powershell
Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue
```

脚本只依赖 Python 3 标准库和同目录自带的 `workbuddy_ipc` 模块。

| service | 用途 | 品类说明 |
| --- | --- | --- |
| `library-office-edit` | 已有文档信息 / 内容读取 | [manage.md](./manage.md) |
| `doc-mcp` | Word 文档内容阅读/编辑（如 `get_outline`、`insert_markdown`） | [doc/edit.md](./doc/edit.md) |
| `sheet-mcp` | 在线表格内容阅读/编辑（如 `get_sheet_info`、`get_cell_data`、`set_range_value`） | [sheet/edit.md](./sheet/edit.md) |
| `slide-mcp` | 幻灯片内容阅读/编辑（`slide_*` 工具） | [slide/edit.md](./slide/edit.md) |

> `library-office-edit` 是本脚本内**主 endpoint 的 service 名**，
> 实际请求 `https://saas.docs.qq.com/api/v6/open/agent/mcp`。
> 它与同插件 `tencent-saas-docs` skill 的 service 名不同，
> 本脚本只认 `library-office-edit`。

### 鉴权与 `file_id` 注入

- 每次调用（含 `tdoc_call`）都**必须**传原始 `--document-url`，`json_args` 只填其余工具参数；
  无需预先单独解析 `file_id`。
- 脚本从链接取 `nodeId`，调用资料库 `get-drive-token`，
  获取 `accessToken`、第三方 `fileId` 和 `edition`。
- `X-App-Id` 由 `edition`（toc / tob）和链接域名（生产 / 测试）共同确定。
- 请求头使用 `X-Mcp-Token` + `X-App-Id`；第三方 `fileId` 强制注入为 `file_id`，
  服务端自行转换内部 ID。
- 不要自行换参、解析内部 ID，也不要使用普通 OAuth / OneID 票据。
- 资料库 token 不输出、不写盘。
- `X-App-Id` 对照表与沙箱 / 客户端取票方式见 [references/auth.md](./references/auth.md)。

## 能力总览

### A. 文档信息 / 内容读取 ·（`library-office-edit`）

查询资料库文档元信息、读取全文内容、上传图片（获取 `image_id`），见 [manage.md](./manage.md)。
文件列表、搜索、移动、删除、权限、导入导出、空间管理均**不在本 skill 范围**。

> **`file_id` 来源**：始终由 `--document-url` 经 get-drive-token 注入，
> 不从选区或用户输入中获取。

### B. 文档内容操作（按品类分 3 类）

每个品类的工具清单、用法、**所属 endpoint** 见对应子文档（仅编辑已有文档）：

| 品类 | 说明 | service | 工具说明 |
| --- | --- | --- | --- |
| **doc** | 在线文档（Word 类） | `doc-mcp` | [doc/edit.md](./doc/edit.md) |
| **sheet** | 在线表格（Excel 类） | `sheet-mcp` | [sheet/edit.md](./sheet/edit.md) |
| **slide** | 幻灯片（PPT 类） | `slide-mcp` | [slide/edit.md](./slide/edit.md) |

> - 智能文档（smartcanvas）、智能表格（smartsheet）不在本 skill 范围内，
>   相关需求改用同插件的 `tencent-saas-docs`。
> - 品类说明复用自 `tencent-saas-docs` 并按资料库场景精简；
>   本 skill 自带全部文件，不依赖 `tencent-saas-docs` 是否启用。

> ⚠️ **doc / sheet / slide 别用主服务的转发工具**——一律走对应 engine endpoint
> （`doc-mcp` / `sheet-mcp` / `slide-mcp`），主服务的同名转发是阉割子集，能力不全。

## 核心规则

- **只处理已有资料库文档**：创建文件、空间管理、文件删除 / 导入、网页剪藏都不在范围内；
  即使这类工具出现在 `tdoc_list` 结果中也不要调用。
- **资料库 ID 不可混用**：链接末段是资料库 `nodeId`，不是 `file_id`；
  选区里的 `fileId` 也不能覆盖脚本注入的 `file_id`。
- **先定品类再选工具**：品类不明时先用 `manage.query_file_info` 查 `ext`，
  再路由到对应品类工具集；严禁用 A 品类工具改 B 品类文档。
- **🚨 PPT / 幻灯片编辑强制走 `slide-mcp`**：编辑已有 PPT 必须用 `slide_*` 工具
  （见 [slide/edit.md](./slide/edit.md)）；**严禁**用 doc / 主服务通用工具改 PPT，
  它们不支持 shape_id / page_index / 母版等结构。
- **调用前先查参数**：工具名和参数以 `tdoc_list` / `tdoc_schema` 实时返回为准，
  不要凭示例或记忆拼参数。
- **先读后写、写后核对**：编辑前按需读取目标位置和内容，写入后复查结果。
- **保留选区标识**：有选区时保留 sheet / view / record / field 等原始 ID，不要编造。
- **优先批量写入**：对同一文档连续 3 次及以上写入时，必须用批量接口一次提交
  （如 `set_range_value` / 批量插入类），严禁单条循环调用。
- **失败不乱切 skill**：保留原始链接和错误信息排查，
  不要改用 `tencent-docs` / `tencent-saas-docs`，
  也不要盲换 `file_id` / `file_url` / `node_id`、App-ID 重试。
- **找不到能力先上报**：用户需求无对应工具时，静默调用 `report_unsupported_feature`
  （`{"feature":"..."}`，走 `library-office-edit`）上报后再说明，不要臆造调用。
- **工具清单以服务端为准**：本文档工具表可能滞后，
  权威来源是各 endpoint 的 `tdoc_list <service>`。

## 常见错误码

> 完整错误列表（含各 `library_token_wbipc_*` 细分）见 [references/auth.md](./references/auth.md)。

| 错误码 | 类型 | 处理 |
| --- | --- | --- |
| `library_file_id_invalid_url` / `library_file_id_invalid_node` | 资料库链接不合法 | 确认域名为 `www` / `staging.workbuddy.cn`，路径为 `/space/d/<nodeId>` |
| `library_file_id_invalid_edition` | get-drive-token 返回的 `edition` 不是 toc / tob | 检查资料库接口版本 |
| `library_token_wbipc_*` | 客户端宿主通道不可用、未授权或不可信 | 确认在 WorkBuddy 客户端内运行、已登录授权，客户端版本支持 `wb.request/http.fetch` |
| `library_token_http_failed` | 沙箱 auth-proxy 或资料库接口请求失败 | 检查沙箱网络、接口路由和服务状态 |
| `library_token_rejected` | 资料库接口返回业务错误码 | 按 `code` 检查 `nodeId` 和用户对该文档的访问权限 |
| `library_token_invalid_response` | get-drive-token 响应结构不符合约定 | 确认 `data` 下含 `accessToken` / `expiresIn` / `fileId` / `edition` |
| `tool_not_found` | `tdoc_schema` 查询的工具不在该 endpoint | 用 `tdoc_list <service>` 确认工具名与所属 endpoint |
| `unknown_service` | service 名不在白名单 | 改用 `library-office-edit` / `doc-mcp` / `sheet-mcp` / `slide-mcp` |
| `bad_args_json` | `json_args` 不是合法 JSON 对象 | 检查参数是否为合法 `{...}` 字符串 |
| `http_failed` | 访问 MCP endpoint 失败 | 检查网络与代理，可尝试 `--no-proxy` |
| `400001` / `-32603` | 参数校验错误 | 按 `tdoc_schema` 重新核对参数 |
| `400006` | Token 鉴权失败 | 资料库 token 每次调用都会重新获取，重试一次；仍失败则检查文档访问权限 |
| `400007` / `400014` | 调用次数已耗尽 / 需要升级专业版 | 引导升级：https://saas.docs.qq.com/scenario/saas-website-payment.html |
| `-32601` | 接口不存在 | 用 `tdoc_list <service>` 确认工具名 |
