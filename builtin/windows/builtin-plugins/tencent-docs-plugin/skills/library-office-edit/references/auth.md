# WorkBuddy 资料库文档鉴权说明

> 本 skill 运行在 `tencent-docs-plugin` 插件中，只处理 WorkBuddy 资料库已有文档。
> 鉴权**不读取**宿主注入的腾讯文档个人版 / 企业版票据（`TDOC_OAUTH_ACCESS_TOKEN` / `TDOC_ONEID_ACCESS_TOKEN`），
> **不走 OAuth 授权页**，统一使用资料库 get-drive-token 返回的 MCP token。
>
> 调用入口是 `tencentdocs.py`（纯 Python 3 标准库实现，跨平台，Windows 无需 bash/curl）。
> 默认走系统代理（读 `HTTP_PROXY` / `HTTPS_PROXY` 环境变量），可加 `--no-proxy` 绕过。

## 资料库链路的 Python 启动隔离（WorkBuddy Windows）

所有命令都带 `--document-url '<资料库链接>'`，执行时需要为当前子进程清空宿主注入的 `PYTHONPATH`：

```bash
PYTHONPATH= python3 tencentdocs.py tdoc_init --document-url '<资料库链接>'
PYTHONPATH= python3 tencentdocs.py tdoc_call <service> <tool> [json_args] --document-url '<资料库链接>'
```

- 宿主 shim 的 `sitecustomize` 会在 skill 代码执行前调用 `tempfile.gettempdir()`，
  其 `%TEMP%` 可写性探针可能触发 Windows 安全中心拦截。
- 这不是 skill 写临时文件，也不是 get-drive-token 失败。
- 清空 `PYTHONPATH` 不会清除 `X_IDE_IS_CLOUDSTUDIO`、`WORKBUDDY_CONFIG_DIR` 等本链路依赖的变量。
- 不要改用其他解释器或 `-S`，也不要清空全部环境变量。
- 手工使用 PowerShell 时，先执行 `Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue`。

## 鉴权机制

| 文档来源 | 票据来源 | MCP header |
| --- | --- | --- |
| WorkBuddy 资料库文档 | get-drive-token 返回的 `accessToken` | `X-Mcp-Token: <accessToken>` + `X-App-Id: <按 edition + 域名区分的环境 ID，见下>` |

- 资料库 token **只放在 `X-Mcp-Token`**，不放进 `Authorization`，也不叠加 Bearer / OneID header。
- token 只在当前进程内存中使用，**不输出、不写盘**；每次执行脚本都会重新获取，无需缓存或手动刷新。
- get-drive-token 同时返回第三方 `fileId`，脚本将其**强制注入**为目标工具的 `file_id`；
  文档 MCP 服务负责把第三方 `fileId` 转换为内部 ID，无需调用 `manage.resolve_third_file_id`。
- MCP 请求**不跟随 HTTP 重定向**，避免把资料库 token 带到其他主机。

### `X-App-Id` 取值

`X-App-Id` 由两个维度共同确定：
get-drive-token 响应的 `edition` 字段区分产品线，`--document-url` 域名区分生产 / 测试环境。

| edition | 资料库文档域名 | 环境 | `X-App-Id` |
| --- | --- | --- | --- |
| `toc`（网盘 C 端） | `www.workbuddy.cn` | 生产环境 | `f419a0b1-ffbf-4ba8-8c2e-98035c82688c` |
| `toc`（网盘 C 端） | `staging.workbuddy.cn` | 测试环境 | `4aeacfde-821d-49df-898f-8ed1c49a42d9` |
| `tob`（SaaS 端） | `www.workbuddy.cn` | 生产环境 | `a08c9e6f-0521-41f5-a364-a3c323c5024a` |
| `tob`（SaaS 端） | `staging.workbuddy.cn` | 测试环境 | `e033a430-24b1-4bfa-b429-4e66d7b48e26` |

- 取值由脚本自动完成，**不要手动传或替换 App-ID**。
- `edition` 不是 `toc` / `tob` 时报 `library_file_id_invalid_edition`；
  域名无法对应生产 / 测试环境时报 `library_file_id_invalid_url`。

### 资料库链接校验

- 只接受 HTTPS 链接，hostname **精确**为 `www.workbuddy.cn` 或 `staging.workbuddy.cn`；
  不使用字符串后缀模糊匹配，避免误识别钓鱼域名（如 `www.workbuddy.cn.evil.com`）。
- 路径必须**恰好**为 `/space/d/<nodeId>`；`nodeId` 只允许字母、数字、`_`、`-`，长度 1~256。
- 链接末段是资料库 `nodeId`，**不是** `file_id`；不要自行截取后当作 `file_id` 传参。
- 不满足以上条件时，脚本在发起任何网络请求前直接返回 `library_file_id_invalid_url` / `library_file_id_invalid_node`。

### 资料库 token 查询的环境分流

| WorkBuddy 运行环境 | 判断方式 | 请求方式 |
| --- | --- | --- |
| CodeBuddy 沙箱 | `X_IDE_IS_CLOUDSTUDIO` 为真值（`1` / `true` / `yes` / `y` / `on` / `enabled`） | POST `http://spaceengine.agent-gateway.auth-proxy.local/_internal/spaceengine/space/api/agent/v1/get-drive-token` |
| WorkBuddy 客户端 | 非沙箱 | 通过 `workbuddy_ipc` 的 `wb.request/http.fetch` 传递 POST path 和 `body_b64`，目标 host 与身份由宿主裁决 |

请求与响应约定：

- 请求体固定为 `{"nodeId":"<链接末段>"}`。
- 响应顶层若带 `code` / `retcode` 且不为 `0` / `OK`，视为业务失败，报 `library_token_rejected`。
- 响应必须为 `{"data":{"accessToken":..., "expiresIn":..., "fileId":..., "edition":...}}` 结构：
  - `accessToken`：非空字符串；
  - `expiresIn`：正整数；
  - `fileId`：非空第三方文件 ID；
  - `edition`：`toc` 或 `tob`。
- 沙箱目标地址固定；客户端只向宿主传 path 和请求体，避免把宿主身份发送到任意 URL。

客户端 WBIPC 通道说明：

- 宿主端点信息读取自 `$WORKBUDDY_CONFIG_DIR/wbipc/endpoint.json`（默认 `~/.workbuddy/wbipc/endpoint.json`）。
- 握手为双向证明、服务端先自证；对端无法自证时报 `library_token_wbipc_untrusted` 并**中止**，不会降级。
- 宿主需开放 `wb.request` 管道及其 `http.fetch` 方法，否则报 `library_token_wbipc_unavailable`。
- `workbuddy_ipc` 随 skill 目录 vendor，仅依赖标准库，不依赖宿主预装。

## 调用流程（AI Agent 必读）

### 1. 环境检查（首次调用前执行一次即可）

```bash
PYTHONPATH= python3 tencentdocs.py tdoc_init --document-url 'https://www.workbuddy.cn/space/d/xxx'
```

| 输出 | 处理方式 |
| --- | --- |
| `READY` | 链接合法且已获取资料库 token，继续执行业务 |
| `ERROR:library_file_id_*` | 资料库链接或 edition 不合法，见下方错误说明 |
| `ERROR:library_token_*` | 按错误信息检查 WorkBuddy 运行环境、宿主通道、nodeId 或资料库接口响应 |

> 资料库文档必须把用户提供的原始链接保留到每次脚本调用；
> `tdoc_init` / `tdoc_list` / `tdoc_schema` / `tdoc_call` 都**必须**传 `--document-url`，缺失时命令直接报错。
> 不需要、也不要预先单独解析 `file_id`：`tdoc_call` 会在同一次执行中取票并注入，额外的解析调用只会增加耗时。

### 2. 查工具参数定义（调用前必做，勿猜参数）

只有文档品类不明时，才先用同一链接调用 `manage.query_file_info` 查看 `ext`，再按品类选择 endpoint。

```bash
PYTHONPATH= python3 tencentdocs.py tdoc_schema <service> <tool> --document-url '<原始资料库链接>'
```

- 输出该工具的描述与参数（`✓`=必填）；`file_id` 由脚本注入，无需填写。
- **调用任何工具前必须先执行本步骤**，按返回的参数名 / 类型 / 必填项构造 `json_args`，严禁凭记忆或猜测拼参数。
- 需要原始 JSON Schema 时加 `--raw`；不确定工具名时先 `tdoc_list <service>`。

### 3. 调用任意 MCP 工具

```bash
PYTHONPATH= python3 tencentdocs.py tdoc_call <service> <tool> [json_args] --document-url '<原始资料库链接>'
```

参数说明：

- `<service>` ∈ `{library-office-edit, doc-mcp, sheet-mcp, slide-mcp}`，按工具品类选择 endpoint。
- `<tool>` 工具名（小写蛇形或带点号）。
- `[json_args]` 工具参数 JSON 对象字符串，按 `tdoc_schema` 的定义传；**无需填写 `file_id`**，传了也会被覆盖。
- `--document-url` **必填**；脚本自动调用 get-drive-token，并将第三方 `fileId` 注入为 `file_id`。
- 不要把资料库链接放进 `json_args` 代替 `--document-url`，脚本不会从参数字段中识别链接。

示例：

```bash
# 主服务：文档信息 / 内容读取
PYTHONPATH= python3 tencentdocs.py tdoc_call library-office-edit manage.query_file_info '{}' --document-url '<链接>'
PYTHONPATH= python3 tencentdocs.py tdoc_call library-office-edit manage.get_content '{}' --document-url '<链接>'

# Word 文档精细编辑
PYTHONPATH= python3 tencentdocs.py tdoc_call doc-mcp get_outline '{}' --document-url '<链接>'

# Excel 表格精细编辑
PYTHONPATH= python3 tencentdocs.py tdoc_call sheet-mcp get_sheet_info '{}' --document-url '<链接>'

# 幻灯片精细编辑
PYTHONPATH= python3 tencentdocs.py tdoc_call slide-mcp slide_get_info '{}' --document-url '<链接>'
```

> 以上 `'{}'` 只为演示调用形式，实际参数以 `tdoc_schema` 返回为准。
> 在 `doc-mcp` / `sheet-mcp` / `slide-mcp` 上，工具名**不带** `doc.` / `sheet.` 前缀；
> `slide_` 是工具名本身的一部分。

### 4. 列出某个 endpoint 上的所有工具（tools/list）

```bash
PYTHONPATH= python3 tencentdocs.py tdoc_list <service> --document-url '<原始资料库链接>'
```

- 原样返回 JSON-RPC 响应，工具列表在 `result.tools[]`，每个包含 `name` / `description` / `inputSchema`。
- 脚本**不过滤工具**（与原 skill 一致），实际可用范围由服务端对资料库 token 的鉴权决定；
  本 skill 只用于已有文档的读写，创建 / 空间管理等工具即使出现在列表里也不要调用。

### 可选参数

| 参数 / 环境变量 | 说明 |
| --- | --- |
| `--no-proxy` | 本次请求绕过系统代理 |
| `--timeout <秒>` | MCP 请求超时，默认取 `TDOC_HTTP_TIMEOUT` 或 120；get-drive-token 最长 10 秒 |
| `TDOC_DEBUG=1` / `WORKBUDDY_TDOC_DEBUG=1` | 在 stderr 输出取票链路（沙箱 / WBIPC）调试信息，不输出 token |
| `TDOC_API_BASE_URL` | 覆盖 MCP endpoint 根地址（默认 `https://saas.docs.qq.com`），仅联调测试环境时使用 |

## 4 个 MCP endpoint 路由说明

| service 名 | endpoint | 适用工具 |
| --- | --- | --- |
| `library-office-edit` | `https://saas.docs.qq.com/api/v6/open/agent/mcp` | `manage.query_file_info` / `manage.get_content` |
| `doc-mcp` | `https://saas.docs.qq.com/api/v6/doc/mcp` | Word 文档精细编辑 |
| `sheet-mcp` | `https://saas.docs.qq.com/api/v6/sheet/mcp` | Excel 表格精细编辑 |
| `slide-mcp` | `https://saas.docs.qq.com/api/v6/slide/mcp` | 幻灯片精细编辑：`slide_*` 系列 |

> - endpoint 复用腾讯文档 SaaS 端；`library-office-edit` 只是脚本内的主服务名，
>   用于与同插件 `tencent-saas-docs` skill 区分，传 `tencent-saas-docs` 会报 `unknown_service`。
> - 选择规则：`slide_*` 走 `slide-mcp`，doc 精细编辑走 `doc-mcp`，sheet 精细编辑走 `sheet-mcp`，
>   其余已有文档工具走 `library-office-edit`。

## 错误说明

| 错误 | 含义 | 处理 |
| --- | --- | --- |
| `ERROR:library_file_id_invalid_url` | 不是允许的资料库 HTTPS 域名、路径不是 `/space/d/<nodeId>`，或无法识别环境 | 确认使用用户提供的原始资料库链接 |
| `ERROR:library_file_id_invalid_node` | `nodeId` 含非法字符或超长 | 确认链接完整未被截断 / 改写 |
| `ERROR:library_file_id_invalid_edition` | get-drive-token 返回的 `data.edition` 不是 `toc` / `tob` | 检查资料库接口版本，确认已下发 `edition` |
| `ERROR:library_token_wbipc_not_workbuddy` | 未找到 WorkBuddy 客户端宿主通道 | 在 WorkBuddy 客户端内运行并确认已登录 |
| `ERROR:library_token_wbipc_untrusted` | 宿主 IPC 端点无法自证身份 | 已中止请求；重启 WorkBuddy 客户端后重试，**不要**绕过 |
| `ERROR:library_token_wbipc_consent_required` | 宿主在，但未授权 | 请用户在 WorkBuddy 客户端完成授权后重试 |
| `ERROR:library_token_wbipc_unavailable` | 缺少 vendor 模块，或宿主未开放 `wb.request/http.fetch` | 确认 skill 目录完整，或升级 WorkBuddy 客户端 |
| `ERROR:library_token_wbipc_failed` | 宿主通道连接或请求失败 | 稍后重试，持续失败检查客户端状态 |
| `ERROR:library_token_http_failed` | 沙箱 auth-proxy 或资料库接口 HTTP 失败 | 检查沙箱网络、接口路由和服务状态 |
| `ERROR:library_token_rejected` | 资料库接口返回业务错误码 | 按 `code` / `msg` 检查 `nodeId` 与用户对该文档的访问权限 |
| `ERROR:library_token_invalid_response` | get-drive-token 响应格式不符合约定 | 确认 `data` 下含 `accessToken` / `expiresIn` / `fileId` / `edition` |
| `ERROR:tool_not_found` | `tdoc_schema` 查询的工具不在该 endpoint | 用 `tdoc_list <service>` 确认工具名与所属 endpoint |
| `ERROR:unknown_service` | service 名不在白名单 | 改用 `library-office-edit` / `doc-mcp` / `sheet-mcp` / `slide-mcp` |
| `ERROR:bad_args_json` | args 不是合法 JSON 对象 | 检查 `[json_args]` 是否为合法 `{...}` 字符串 |
| `ERROR:http_failed` | 访问 MCP endpoint 失败（HTTP 状态码与服务端原始报文输出到 stderr） | 检查网络与代理；公司网络下超时可尝试 `--no-proxy` 或设置 `HTTPS_PROXY` |
| `ERROR:non_json_response` / `ERROR:invalid_response` / `ERROR:jsonrpc_error` | MCP 响应异常 | 保留错误信息反馈，必要时 `TDOC_DEBUG=1` 重试定位 |
| `Token 鉴权失败 / 400006` | 服务端认为资料库 token 无效 | token 每次调用都会重新获取，重试一次；仍失败检查文档访问权限与 App-ID 环境 |
| `需要升级专业版 / 400014` | 当前操作需要升级专业版 | 引导用户升级：https://saas.docs.qq.com/scenario/saas-website-payment.html |
