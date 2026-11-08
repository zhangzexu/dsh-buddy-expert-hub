# 腾讯文档插件（tencent-docs-plugin）

腾讯文档官方 MCP 插件，封装了 C 端（`docs.qq.com`）和 SaaS 端（`saas.docs.qq.com`）两个 skill，根据用户身份自动选择合适的 skill 调用对应 MCP 服务。

## 插件结构

```
tencent-docs-plugin/
├── .codebuddy-plugin/plugin.json    # 插件清单
├── PLUGIN.md                         # 本文件，路由说明
├── shared/                           # 两个 skill 真正共用的内容
│   └── smartcanvas/template/         # MDX 参考模板（C 端 / B 端 smartcanvas.md 共用）
└── skills/
    ├── tencent-docs/                 # C 端 skill（docs.qq.com）
    │   ├── SKILL.md                  # 入口：导航 + 场景路由 + 调用约定
    │   ├── tencentdocs.py            # tdoc_init/tdoc_call/tdoc_list 入口（纯 Python 标准库，跨平台）
    │   ├── manage.md / smartcanvas.md                    # 各品类精炼工具表
    │   ├── smartsheet/README.md + *_format.md / formula.md / link_and_lookup_fields.md  # 智能表格工具表与参数格式规范
    │   ├── doc|sheet|slide/{create,edit}.md             # 各品类创建/编辑工具表
    │   ├── smartcanvas/mdx_references.md                # MDX 语法规范
    │   ├── references/{auth,diagram,space,ocr,aipage}_*.md  # 鉴权与独有能力参考
    │   └── ocr.js / aipage_pack.js / import_file.py  # 辅助脚本
    └── tencent-saas-docs/            # SaaS 端及 WorkBuddy 资料库 skill
        ├── workbuddy_library.py       # 资料库 token、第三方 ID 与内部 file_id 转换
        └── 其余结构同上，但无 OCR / aipage 辅助脚本与参考（SaaS 不提供这些能力）
```

> doc 专业排版模板、docengine/slideengine 详细工具参考、smartcanvas 模板等公共内容统一放在
> `shared/`，两个 skill 通过相对路径 `../../shared/...` 引用，避免重复维护。

调用方式（CodeBuddy 命名空间规则）：

- C 端 skill：`/tencent-docs-plugin:tencent-docs`
- SaaS 端 skill：`/tencent-docs-plugin:tencent-saas-docs`

## 鉴权说明（环境变量驱动，不落盘）

插件**完全依赖宿主（Workbuddy 等连接器）注入的环境变量**完成鉴权，**不走 OAuth 授权页面**，也**不依赖任何外部命令行工具（无 curl / mcporter / npm）**：调用入口 `tencentdocs.py` 用 Python 3 标准库（`urllib`）调用 MCP HTTP/JSON-RPC 协议，跨平台（Windows / macOS / Linux），所有票据只在调用时通过 HTTP header 即时透传，**不落盘**：

| 环境变量 | 含义 | 透传 header |
|---|---|---|
| `TDOC_OAUTH_ACCESS_TOKEN` | C 端 OAuth access token（个人用户） | `Authorization: Bearer <token>` |
| `TDOC_ONEID_ACCESS_TOKEN` | SaaS 端 OneID access token（企业用户） | `X-Oneid-Access-Token: <token>` |

- WorkBuddy 资料库文档：从 `/space/d/<nodeId>` 提取 nodeId，沙箱通过 auth-proxy、客户端通过 WBIPC POST get-drive-token；将返回的 `accessToken` 以 `X-Mcp-Token: <accessToken>` 传递，返回的第三方 `fileId` 直接作为目标工具的 `file_id` 参数注入。

> 二者可同时存在（双票场景）；服务端 `mcp_dualtoken_middleware` 已支持。

## skill 路由策略（如何选择正确的 skill）

本插件包含 C 端（`tencent-docs`）和 SaaS 端（`tencent-saas-docs`）两个 skill，分别对应
`docs.qq.com` 和 `saas.docs.qq.com` 两个域，SaaS skill 还负责 WorkBuddy 资料库文档。两个 skill 的工具集高度一致，但调用的服务域不同，
**选错 skill 会导致操作到错误域的文档或鉴权失败**。调用前请按以下优先级判断应使用哪个 skill：

### 1. 按文档来源判断（最可靠，优先使用）

如果已知目标文档的链接或来源域，必须按文档域选择 skill，不受当前仅有的身份类型影响：

- `docs.qq.com` 下的个人版文档：使用 `tencent-docs`。
- `saas.docs.qq.com` 下的企业版文档：使用 `tencent-saas-docs`。
- `www.workbuddy.cn` 或 `staging.workbuddy.cn` 下的资料库文档（路径 `/space/d/<nodeId>`）：使用 `tencent-saas-docs`，调用脚本时传 `--document-url <原始链接>`；插件会自动转换内部 `file_id`。

例如预期是编辑/查看C端个人版（`docs.qq.com`）文档，则优先使用 `tencent-docs` skill；
预期是编辑/查看企业版（`saas.docs.qq.com`）文档，则优先使用 `tencent-saas-docs` skill。
预期是编辑/查看Workbuddy资料库文档（`www.workbuddy.cn` / `staging.workbuddy.cn`），则使用 `tencent-saas-docs` skill。资料库链接不能走网页剪藏。

当且仅当只有一个 token，且 token 对应的身份来源与文档来源域不匹配时，该文档称为**跨域链接**。跨域链接仍必须优先使用文档来源域对应的 skill：

| 当前唯一身份 | 目标文档来源 | 路由结果 |
|---|---|---|
| `TDOC_OAUTH_ACCESS_TOKEN`（个人 OAuth） | `saas.docs.qq.com`（企业版） | `tencent-saas-docs` |
| `TDOC_ONEID_ACCESS_TOKEN`（企业 OneID） | `docs.qq.com`（个人版） | `tencent-docs` |

例如：

- 当且仅当只有一个 `TDOC_OAUTH_ACCESS_TOKEN`，但预期编辑/查看企业版（`saas.docs.qq.com`）文档时，优先使用 `tencent-saas-docs` skill。
- 当且仅当只有一个 `TDOC_ONEID_ACCESS_TOKEN`，但预期编辑/查看 C 端个人版（`docs.qq.com`）文档时，优先使用 `tencent-docs` skill。

> **跨域鉴权说明（重要）**：服务端底层接口已支持跨域 token，`mcp_dualtoken_middleware` 可识别并处理以下两种跨域场景：
>
> - 仅有 `TDOC_ONEID_ACCESS_TOKEN`（企业 OneID）→ 访问 `docs.qq.com`（C 端）文档：选 `tencent-docs` skill，`tencentdocs.py` 会在请求 header 中带 `X-Oneid-Access-Token`，服务端完成跨域鉴权。
> - 仅有 `TDOC_OAUTH_ACCESS_TOKEN`（个人 OAuth）→ 访问 `saas.docs.qq.com`（B 端）文档：选 `tencent-saas-docs` skill，`tencentdocs.py` 会在请求 header 中带 `Authorization: Bearer`，服务端完成跨域鉴权。
>
> **不要因 token 类型与目标域不匹配而拒绝操作、报错或要求用户重新授权**；`tencentdocs.py` 会把所有存在的 token 一并透传，服务端自动选用合适的那个。

### 2. 按用户身份判断（文档来源不明且仅单票时）

只有在无法判断文档来源、且只有一个 token 时，才按 token 类型选择：

- 仅有 `TDOC_OAUTH_ACCESS_TOKEN`（个人 OAuth）→ `tencent-docs`
- 仅有 `TDOC_ONEID_ACCESS_TOKEN`（企业 OneID）→ `tencent-saas-docs`

### 3. 双票同时存在时的处理

两个 token（`TDOC_OAUTH_ACCESS_TOKEN` + `TDOC_ONEID_ACCESS_TOKEN`）同时存在时，按操作类型分两种情况：

**3.1 操作有明确目标文档**（编辑 / 查看 / 搜索 / 移动某篇已知文档）
→ 必须按上述规则 1，根据文档来源选择 skill；`tencentdocs.py` 会把两个 token 一并透传，由服务端决定使用哪一个。

**3.2 操作不需要文档 id 或 url**（如创建文档、导入文件、列举最近文档等无具体目标的操作）
→ **必须先使用 AskUserQuestion 询问用户**：「检测到个人版和企业版账号均可用，请选择本次操作使用的账号：
  个人版（docs.qq.com）还是企业版（saas.docs.qq.com）？」
  按用户选择使用对应 skill，**不要替用户默认选择**。

> 注意：两个 skill 操作的是不同域的文档。即使是跨域链接，也必须使用文档来源域对应的 skill；选择错误的域可能命中错误数据或导致鉴权失败。

### 4. 创建类操作的例外：禁止跨域（重要）

上述规则 1 的"跨域链接优先按文档来源域路由"**仅适用于已有文档的操作**（查看 / 编辑 / 搜索 / 移动 / 删除等）。
**所有创建类工具是唯一例外**：服务端在业务逻辑层对跨域创建做了显式拦截，必须严格路由到 token 所属域。

创建操作本身不存在"目标文档来源域"，因此**只能跟随 token 走**，规则 1 不适用：

| 当前唯一身份 | 创建操作必须使用 skill |
|---|---|
| 仅 `TDOC_OAUTH_ACCESS_TOKEN`（个人 OAuth） | `tencent-docs`（C 端） |
| 仅 `TDOC_ONEID_ACCESS_TOKEN`（企业 OneID） | `tencent-saas-docs`（SaaS 端） |

即使用户口头表达"在企业版里新建一个文档"，若当前只有个人 OAuth token，也**不能**改用
`tencent-saas-docs` 去创建，而应告知用户当前账号无企业版创建权限。

**受此约束的创建类工具（完整清单，含所有品类）：**

| 工具名 | 用途 |
|---|---|
| `manage.create_file` | 创建任意品类文件（doc / sheet / slide / form / mind / flowchart / smartcanvas / smartsheet / board）；带 `space_id` 时在空间内创建 |
| `create_space_node` | 在知识库空间内创建节点（文件夹 / 文档 / 链接） |
| `slide.create_slide` | 创建幻灯片 |
| `create_space` | 创建知识库空间 |
| `create_with_markdown`（doc-mcp） | 用 Markdown 创建 docs 文档 |
| `create_doc_with_html`（doc-mcp） | 用 HTML 创建 docs 文档 |
| `create_smartcanvas_by_mdx` | 用 MDX / Markdown 创建智能文档 |
| `create_mind_by_markdown` | 创建思维导图 / 脑图 |
| `flowchart.create_by_mermaid` | 用 Mermaid 创建流程图 |

> 判断方法：**任何"凭空产生新文档 / 新空间 / 新节点"的工具都属于创建类**，一律不得跨域。
> 注意 `manage.create_file` 是兜底入口，能创建上表所有品类，因此它是最高频触发跨域拦截的工具。

**收到跨域创建拦截错误时的处理**：服务端返回错误码 `404001`，错误信息为
`跨域禁止创建：当前登录账号与本次操作的目标域不一致，不允许跨账号体系创建文档。请切换为对应域的账号后重试，不要改用其他 skill 重试。`
此时**必须直接把该提示转达给用户，并明确禁止改用另一个 skill 重试**——重试同样会被拦截，只会浪费轮次。

> 再次强调：此约束**只针对创建类工具**。查看、编辑、搜索、删除等操作跨域完全正常，仍按规则 1 按文档来源域路由，不要因本节而拒绝跨域编辑。

> 路由策略后续会迭代细化。

## 4 个 MCP endpoint（两个 skill 均按此路由）

每个 skill 内部按工具品类路由到 4 个不同的 MCP endpoint，写类工具仅在特定 endpoint 上提供。
C 端走 `docs.qq.com`，SaaS 端走 `saas.docs.qq.com`：

| 服务名 | C 端 endpoint | SaaS 端 endpoint | 工具范围 |
|---|---|---|---|
| 主服务 | `docs.qq.com/openapi/mcp` | `saas.docs.qq.com/api/v6/open/agent/mcp` | 通用工具（manage / smartcanvas / smartsheet / scrape，C 端另含 OCR） |
| `slide-mcp` | `docs.qq.com/api/v6/slide/mcp` | `saas.docs.qq.com/api/v6/slide/mcp` | `slide_*` 系列幻灯片精细编辑 |
| `doc-mcp` | `docs.qq.com/api/v6/doc/mcp` | `saas.docs.qq.com/api/v6/doc/mcp` | doc 系列 Word 文档精细编辑（工具名无 `doc.` 前缀） |
| `sheet-mcp` | `docs.qq.com/api/v6/sheet/mcp` | `saas.docs.qq.com/api/v6/sheet/mcp` | sheet 系列 Excel 精细编辑（工具名无 `sheet.` 前缀） |

> 主服务的 service 名：C 端为 `tencent-docs`，SaaS 端为 `tencent-saas-docs`；endpoint 由 `tencentdocs.py` 的 `API_BASE` 按端切换（各 skill 内置）。

## 安装与运行

```bash
# 本地测试
codebuddy --plugin-dir ./tencent-docs-plugin

# 调用 skill（tencentdocs.py 纯 Python 标准库，跨平台，无需预装任何外部工具）
/tencent-docs-plugin:tencent-docs
/tencent-docs-plugin:tencent-saas-docs
```

> 调用入口 `tencentdocs.py` 仅依赖 Python 3 标准库（`urllib`），Windows / macOS / Linux 通用，默认走系统代理（`HTTP_PROXY` / `HTTPS_PROXY`），可加 `--no-proxy` 绕过；`import_file.py` 复用它完成本地文件上云。skill 里的 Node.js 脚本（`ocr.js` / `aipage_pack.js`）在调用 MCP 工具时会内部调起 `python3 tencentdocs.py tdoc_call`。本插件不依赖 curl / mcporter / npm 全局包。
