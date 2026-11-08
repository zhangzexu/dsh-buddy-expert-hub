# 腾讯文档私有化/专享版鉴权说明（插件版）

> 本 skill 运行在 `tencent-private-docs-plugin` 插件中，**不再走 OAuth 授权流程，也不依赖 mcporter（Node.js）**，
> 所有票据由宿主通过环境变量注入，由 `tencentdocs.py` 在调用时通过 HTTP header 透传到服务端，**不落盘**。
>
> 调用入口是 `tencentdocs.py`（纯 Python 3 标准库实现，跨平台，Windows 无需 bash/curl）。默认走系统代理
> （读 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量），可加 `--no-proxy` 绕过。

## 环境域名（打包注入，不走环境变量）

插件内所有 URL 使用 `${TENCENT_DOCS_DOMAIN}` 占位符表示当前环境域名，由**打包流程在按客户打包时
替换为实际域名**（WorkBuddy 专享版一个客户一份包）。运行时不读取域名环境变量，也不做任何默认
域名兜底：占位符未被替换时，`tencentdocs.py` 的所有命令会直接报 `ERROR:no_domain` 退出。

## 环境变量

| 环境变量 | 含义 | 说明 |
|---|---|---|
| `TDOC_ONEID_ACCESS_TOKEN` | OneID access token（票据） | 由宿主注入，透传 header `X-Oneid-Access-Token` |
| `TDOC_HTTP_TIMEOUT` | 可选，HTTP 超时秒数 | 默认 `120` |
| `TDOC_DEBUG` | 可选，置 `1` 时输出调试日志到 stderr | 排障用 |

## 鉴权机制

| 票据来源 | MCP header |
|---|---|
| `TDOC_ONEID_ACCESS_TOKEN` | `X-Oneid-Access-Token: <token>` |

票据由宿主（客户端 / 连接器）注入，`tencentdocs.py` 只在内存里即时透传，**不写入任何文件**；
票据无效或过期时服务端返回 `400006`，由宿主刷新票据后重试，不要要求用户重新走 OAuth 授权。

## 调用流程（AI Agent 必读）

### 1. 环境检查（首次调用前执行一次即可）

```bash
python3 tencentdocs.py tdoc_init
```

| 输出 | 处理方式 |
| --- | --- |
| `READY` | 环境就绪，继续执行业务 |
| `ERROR:no_token` | 宿主未注入 `TDOC_ONEID_ACCESS_TOKEN`，请先完成腾讯文档授权后重试 |

### 2. 查工具参数定义（调用前必做，勿猜参数）

```bash
python3 tencentdocs.py tdoc_schema <service> <tool>
```

输出该工具的描述与参数（`✓`=必填）。**调用任何工具前必须先执行本步骤**，按返回的参数名/类型/必填项
构造 `json_args`，**严禁凭记忆或猜测拼参数**。需要原始 JSON Schema 时加 `--raw`。

### 3. 调用任意 MCP 工具

```bash
python3 tencentdocs.py tdoc_call <service> <tool> [json_args]
```

参数说明：

- `<service>` ∈ `{tencent-private-docs, slide-mcp, doc-mcp, sheet-mcp}`，按工具品类选择对应 endpoint
- `<tool>` 工具名（小写蛇形或带点号）
- `[json_args]` 工具参数 JSON 字符串，**按上一步 `tdoc_schema` 的定义传**

示例：

```bash
# 通用工具（manage / smartcanvas / smartsheet / scrape 等）
python3 tencentdocs.py tdoc_call tencent-private-docs manage.recent_online_file '{"num":10}'
python3 tencentdocs.py tdoc_call tencent-private-docs create_smartcanvas_by_mdx '{"title":"hello","mdx":"# hi"}'

# 幻灯片精细编辑（slide_* 系列）
python3 tencentdocs.py tdoc_call slide-mcp slide_add_shape '{"file_id":"...","page_index":0,...}'

# Word 文档精细编辑（insert_* / find_* 等）
python3 tencentdocs.py tdoc_call doc-mcp insert_markdown '{"file_id":"...","idx":0,"markdown":"..."}'

# Excel 表格精细编辑（set_cell_value / add_sheet 等）
python3 tencentdocs.py tdoc_call sheet-mcp set_cell_value '{"file_id":"...","sheet_id":"...","row":0,"col":0,"value_type":"STRING","string_value":"hi"}'
```

> ⚠️ 注意：在 `slide-mcp` / `doc-mcp` / `sheet-mcp` 3 个独立 endpoint 上，工具名**不带前缀**
> （如 `set_cell_value` 而不是 `sheet.set_cell_value`；`insert_markdown` 而不是 `doc.insert_markdown`；
> `slide_add_shape` 这里 `slide_` 是工具名本身的一部分不是服务名前缀）。调用前可用
> `tdoc_list <service>` 查看该 endpoint 上的真实工具名。

### 4. 列出某个 endpoint 上的所有工具（tools/list）

```bash
python3 tencentdocs.py tdoc_list <service>
```

示例：

```bash
python3 tencentdocs.py tdoc_list tencent-private-docs   # 主入口通用工具
python3 tencentdocs.py tdoc_list slide-mcp              # slide_* 工具
python3 tencentdocs.py tdoc_list doc-mcp                # doc 工具（insert_* / find_* / replace_* 等）
python3 tencentdocs.py tdoc_list sheet-mcp              # sheet 工具（set_cell_value / add_sheet 等）
```

返回原始 JSON-RPC 响应，工具列表在 `result.tools[]`，每个包含 `name` / `description` / `inputSchema`。

## 4 个 MCP endpoint 路由说明

| service 名 | endpoint | 适用工具 |
| --- | --- | --- |
| `tencent-private-docs` | `https://${TENCENT_DOCS_DOMAIN}/api/v6/open/agent/mcp` | 通用工具：`manage.*` / `create_*` / `smartcanvas.*` / `smartsheet.*` / `scrape_url` 等 |
| `slide-mcp` | `https://${TENCENT_DOCS_DOMAIN}/api/v6/slide/mcp` | 幻灯片精细编辑：`slide_*` 系列 |
| `doc-mcp` | `https://${TENCENT_DOCS_DOMAIN}/api/v6/doc/mcp` | Word 文档精细编辑：`doc.*` 系列 |
| `sheet-mcp` | `https://${TENCENT_DOCS_DOMAIN}/api/v6/sheet/mcp` | Excel 表格精细编辑：`sheet.*` 系列 |

> 选择规则：**所有 `slide_*` 工具走 `slide-mcp`，所有 `doc.*` 工具走 `doc-mcp`，所有 `sheet.*` 工具走
> `sheet-mcp`，其余通用工具一律走 `tencent-private-docs`**。详见 SKILL.md 的"场景路由表"。

## 错误说明

| 错误 | 含义 | 处理 |
| --- | --- | --- |
| `ERROR:no_domain` | 插件内 `${TENCENT_DOCS_DOMAIN}` 占位符未被替换 | 该包未完成域名注入，需由打包流程重新打包 |
| `ERROR:no_token` | 环境变量 `TDOC_ONEID_ACCESS_TOKEN` 为空 | 由宿主环境注入票据后重试 |
| `ERROR:unknown_service` | service 名不在白名单 | 改用 `tencent-private-docs / slide-mcp / doc-mcp / sheet-mcp` 之一 |
| `ERROR:bad_args_json` | args 不是合法 JSON 对象 | 检查 `[json_args]` 是否为合法 `{...}` 字符串 |
| `ERROR:tool_not_found` | 工具名不在该 endpoint 上 | 用 `tdoc_list <service>` 确认真实工具名 |
| `ERROR:http_failed` | 网络/HTTP 请求失败 | 检查网络与代理；公司网络下若超时可尝试加 `--no-proxy` 或设置 `HTTPS_PROXY` |
| `Token 鉴权失败 / 400006` | 服务端返回票据无效 | 由宿主环境刷新票据后重试 |
