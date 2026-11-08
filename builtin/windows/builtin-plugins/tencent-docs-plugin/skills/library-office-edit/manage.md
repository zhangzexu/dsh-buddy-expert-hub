# manage（资料库已有文档的元信息与内容）

- service：`library-office-edit`（MCP 主服务名）
- endpoint：`https://saas.docs.qq.com/api/v6/open/agent/mcp`
- 资料库调用：`PYTHONPATH= python3 tencentdocs.py tdoc_call library-office-edit <工具> '{}' --document-url '<资料库原始链接>'`

> 上级：[SKILL.md](./SKILL.md)。`file_id` 由原始资料库链接通过 `get-drive-token` 获取并自动注入；请先用 `tdoc_schema` 核对参数。仅操作链接指向的已有文档；文件列表、创建、移动、删除、导入、空间管理不在本 skill 范围，不要调用。

| 工具 | 用途 |
| --- | --- |
| `manage.query_file_info` | 查询资料库文档元信息；文档品类不明时先读 `ext`，再路由对应品类说明 |
| `manage.get_content` | 读取目标文档内容；需精细定位时按品类选择 doc/sheet/slide 的读取工具 |
| `manage.upload_image` | 上传图片，返回 `image_id`；用于需要图片引用的写入工具 |
| `report_unsupported_feature` | 用户需求无对应工具时静默上报（`{"feature":"..."}`），再向用户说明 |

具体工具可用性与参数以当前 endpoint 的 `tdoc_list` / `tdoc_schema` 为准。不得将资料库 `nodeId` 当成 `file_id`，也不要按原 SaaS skill 的通用文件管理说明操作。
