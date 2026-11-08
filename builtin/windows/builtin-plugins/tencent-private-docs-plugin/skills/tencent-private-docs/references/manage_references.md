# 腾讯文档 MCP 工具完整参考

本文件包含腾讯文档 MCP 中 文件管理类（ManageAgentApi）相关工具的完整 API 说明，支持文件的增删改查、文件搜索、文档权限设置、上传下载、网页剪藏等能力。

---
## 目录
- [文件列表查询](#文件列表查询)
  - [manage.list_file](#managelist_file)
- [文件搜索](#文件搜索)
  - [manage.search_file](#managesearch_file)
  - [manage.ai_search_file](#manageai_search_file)
- [文档创建操作](#文档创建操作)
  - [manage.create_file](#managecreate_file)
- [文档内容获取](#文档内容获取)
  - [manage.get_content](#manageget_content)
- [文档信息查询](#文档信息查询)
  - [manage.query_file_info](#managequery_file_info)
- [文档重命名](#文档重命名)
  - [manage.rename_file_title](#managerename_file_title)
- [文档权限管理](#文档权限管理)
  - [manage.get_privilege](#manageget_privilege)
  - [manage.set_privilege](#manageset_privilege)
  - [manage.batch_query_permission](#managebatch_query_permission)
- [文档移动操作](#文档移动操作)
  - [manage.move_file](#managemove_file)
- [文档复制操作](#文档复制操作)
  - [manage.copy_file](#managecopy_file)
- [文档删除操作](#文档删除操作)
  - [manage.delete_file](#managedelete_file)
- [上传与导入操作](#上传与导入操作)
  - [manage.apply_upload](#manageapply_upload)
  - [manage.complete_upload](#managecomplete_upload)
  - [manage.query_task](#managequery_task)
- [下载与导出操作](#下载与导出操作)
  - [manage.apply_download](#manageapply_download)
- [图片上传](#图片上传)
  - [manage.upload_image](#manageupload_image)
- [网页剪藏](#网页剪藏)
  - [manage.scrape_url](#managescrape_url)
  - [manage.scrape_progress](#managescrape_progress)
- [典型工作流示例](#典型工作流示例)

---

## 文件列表查询

### manage.list_file

**功能**：获取文件列表，支持多种列表类型（我的文档、最近浏览、收藏、回收站、共享等）。

**使用场景**：
- 查看我的文档列表
- 查看最近浏览的文档
- 查看收藏列表
- 查看回收站文件

**请求参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|-----|------|
| `list_type` | integer | ✅ | 列表类型：1-我的文档(MY_DOC)，2-最近浏览(RECENT)，3-收藏(STAR)，4-回收站(TRASH)，5-共享空间(COLLABORATION_LIST)，6-与我共享(SHARED) |
| `offset` | integer | | 拉取列表的起点，从0开始，默认0 [≥0] |
| `count` | integer | | 单次拉取的最大文件数量，最大为20，为0或不传时默认为20 [范围: 0~20] |
| `order_by` | integer | | 排序条件：0-查看时间(默认)，1-修改时间，2-文件名，3-删除时间，5-星标时间，6-创建时间 |
| `descending` | boolean | | 是否为降序，仅支持 MY_DOC、RECENT、STAR、TRASH、SHARED 列表类型 |
| `parent_id` | string | | 上级文件夹ID，仅 MY_DOC 列表类型支持 |
| `filter` | object | | 列表筛选条件，MY_DOC、RECENT、STAR、SHARED 支持，包含 `include_ext`、`exclude_ext`、`include_folder`、`exclude_link` 等字段 |
| `trash_filter` | object | | 回收站筛选条件，仅 TRASH 列表类型支持，包含 `type` 字段（0-文件，1-空间） |

**返回字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `files[].file_id` | string | 文档ID |
| `files[].name` | string | 文件名称 |
| `files[].ext` | string | 文件类型（doc、sheet、slide 等） |
| `files[].is_folder` | boolean | 是否为文件夹 |
| `files[].doc_url` | string | 文档访问链接 |
| `files[].create_time` | uint64 | 创建时间（Unix 时间戳，秒） |
| `files[].modify_time` | uint64 | 最后修改时间（Unix 时间戳，秒） |
| `finish` | boolean | 是否拉取完成，`false` 表示还有更多数据 |

**调用示例（查询我的文档）**：

```json
{
  "list_type": 1,
  "offset": 0,
  "count": 20
}
```

**调用示例（查询最近浏览，按修改时间降序）**：

```json
{
  "list_type": 2,
  "offset": 0,
  "count": 20,
  "order_by": 1,
  "descending": true
}
```

**调用示例（查询指定文件夹下的文件）**：

```json
{
  "list_type": 1,
  "parent_id": "folder_abc123",
  "offset": 0,
  "count": 20
}
```

**返回示例**：

```json
{
  "files": [
    {
      "file_id": "folder_001",
      "name": "项目文档",
      "ext": "",
      "is_folder": true,
      "doc_url": ""
    },
    {
      "file_id": "doc_001",
      "name": "会议纪要",
      "ext": "doc",
      "is_folder": false,
      "doc_url": "https://${TENCENT_DOCS_DOMAIN}/doc/DV2h5cWJ0R1lQb0lH"
    }
  ],
  "finish": false
}
```

> **注意**：
> - `is_folder=true` 的条目为文件夹，其 `file_id` 可作为 `parent_id` 继续查询子目录内容
> - 当 `finish=false` 时，需增大 `offset` 参数值进行翻页查询

---

## 文件搜索

### manage.search_file

**功能**：根据关键词搜索云文档，返回匹配关键词的文档列表，正文搜索需要VIP或专业版。

**使用场景**：
- 搜索文档标题包含指定关键字的文档
- 搜索文档正文内容

**请求参数**：

| 参数 | 类型 | 必填 | 说明                                                                           |
|------|------|-----|------------------------------------------------------------------------------|
| `tag_info` | object | ✅ | 匹配标签信息，包含 `tag_type`（1-标题，2-拥有者昵称，3-正文）、`from`（起始条目编号）、`size`（单次返回条目个数 [>0]） |
| `pattern` | string | ✅ | 搜索关键词 [长度≥1]                                                                 |
| `sort_rules` | object | ✅ | 结果排序规则，包含 `sort_by`（0-访问时间，1-修改时间，2-创建时间）、`asc`（是否升序）                        |
| `owner_filter` | object | | 拥有者过滤，包含 `is_owner`（是否是拥有者创建的文件）                                             |
| `ext_filter` | object | | 品类过滤，包含 `extension`（文件品类列表，详见下方 FileExt 说明）                                  |
| `folder_filter` | object | | 目录过滤，包含 `is_folder`（是否是目录）                                                   |
| `range` | object | | 结果时间范围，包含 `range_by`、`time_begin`、`time_end`                                 |
| `link_filter` | object | | 快捷方式过滤，包含 `is_link`                                                          |
| `list_filter` | object | | 列表种类过滤，包含 `list_type`                                                        |
| `space_filter` | object | | 协作空间过滤，包含 `is_space`                                                         |
| `need_space_folder` | boolean | | 是否需要空间文件夹                                                                    |

**FileExt 枚举值说明**（`ext_filter.extension` 字段取值，必须传整数，禁止传字符串名称如 `"smartcanvas"`）：

| 枚举值 | 整数 | 说明 |
|--------|------|------|
| `EXT_ALL` | 0 | 不过滤（返回所有品类） |
| `EXT_TENCENT_DOC` | 1 | 腾讯文档（在线 Word） |
| `EXT_TENCENT_SHEET` | 2 | 腾讯表格（在线 Excel） |
| `EXT_TENCENT_SLIDE` | 3 | 腾讯幻灯片（在线 PPT） |
| `EXT_TENCENT_FORM` | 4 | 腾讯收集表 |
| `EXT_PDF` | 5 | PDF 文件 |
| `EXT_SMART_CANVAS` | 6 | 智能文档 |
| `EXT_SMART_SHEET` | 7 | 智能表格 |
| `EXT_MIND` | 8 | 思维导图 |
| `EXT_FLOWCHART` | 9 | 流程图 |
| `EXT_BOARD` | 10 | 白板 |
| `EXT_OFD` | 11 | OFD 文件 |
| `EXT_DOC` | 12 | Word 类（.doc/.docx/.wps 等） |
| `EXT_SHEET` | 13 | Excel 类（.xls/.xlsx/.csv 等） |
| `EXT_PPT` | 14 | PPT 类（.ppt/.pptx/.dps 等） |

**返回字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `result[].file_data_list[].file_id` | string | 文档ID |
| `result[].file_data_list[].file_name` | string | 文档标题 |
| `result[].file_data_list[].doc_url` | string | 文档链接 |
| `result[].file_data_list[].ext` | string | 文件类型 |
| `result[].highlight` | string | 匹配字段高亮 |
| `next` | int64 | 下一次拉取的起始位置 |
| `total` | int64 | 总数 |
| `is_over` | boolean | 搜索条目是否结束 |

**调用示例（按标题搜索）**：

```json
{
  "tag_info": {
    "tag_type": 1,
    "from": 0,
    "size": 20
  },
  "pattern": "MCP",
  "sort_rules": {
    "sort_by": 1,
    "asc": false
  }
}
```

**返回示例**：

```json
{
  "result": [
    {
      "file_data_list": [
        {
          "file_id": "sheet_1",
          "file_name": "MCP工具说明",
          "doc_url": "https://${TENCENT_DOCS_DOMAIN}/sheet/sheet_file_id_1",
          "ext": "sheet"
        }
      ],
      "highlight": "MCP"
    }
  ],
  "next": 20,
  "total": 1,
  "is_over": true
}
```

---

### manage.ai_search_file

**功能**：AI语义搜索文件，支持自然语言查询，返回语义相关的文档列表。

**使用场景**：
- 用自然语言描述查找相关文档
- 搜索文档内容片段

**请求参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|-----|------|
| `query` | string | ✅ | 搜索文本 [长度≥1] |
| `need_segments` | boolean | | 是否需要返回召回的内容片段，默认 false |

**返回字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `search_results[].index` | int32 | 搜索引文序号 |
| `search_results[].title` | string | 搜索引文标题 |
| `search_results[].url` | string | 搜索引文链接 |
| `search_results[].content` | string | 搜索引文正文 |
| `search_results[].file_id` | string | 文件ID |
| `search_results[].ext` | string | 文件扩展名 |
| `search_results[].source` | string | 搜索源 |
| `search_results[].public_time` | string | 内容发布时间 |

**调用示例**：

```json
{
  "query": "项目进度报告",
  "need_segments": true
}
```

**返回示例**：

```json
{
  "search_results": [
    {
      "index": 1,
      "title": "Q3项目进度报告",
      "url": "https://${TENCENT_DOCS_DOMAIN}/doc/DtDywXFgYFru",
      "content": "本季度项目整体进度...",
      "file_id": "DtDywXFgYFru",
      "ext": "doc"
    }
  ]
}
```

---

## 文档创建操作

### manage.create_file

**功能**：创建腾讯云文档，支持创建多种类型的文档。

**使用场景**：
- 在指定文件夹下创建新的在线文档（如文档、表格、幻灯片等）
- 传入 `space_id` 时，在知识库空间中创建文档节点

**请求参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|-----|------|
| `title` | string | ✅ | 文件名称，长度不超过36字符 [长度≤36] |
| `type` | string | ✅ | 文件类型，详见下方取值说明 |
| `parent_id` | string | | 目标文件夹ID。不传 `space_id` 时表示个人文件夹ID；传入 `space_id` 时表示空间父节点ID；为空则在个人首页或空间根路径创建 |
| `space_id` | string | | 知识库空间ID，传入时在空间中创建节点 |
| `link_node` | object | | 空间链接节点配置，`type` 为 `SPACE_LINK` 时必填，包含 `link_url`（必填）和 `link_description` |

**type 取值说明**：

| 值 | 含义 |
|----|------|
| `DOC` | Word 文档 |
| `SHEET` | 表格 |
| `SLIDE` | 幻灯片 |
| `FORM` | 收集表 |
| `MIND` | 思维导图 |
| `FLOW_CHART` | 流程图 |
| `SMART_CANVAS` | 智能文档 |
| `SMART_SHEET` | 智能表格 |
| `FOLDER` | 文件夹 |
| `SPACE_LINK` | 空间链接（需传 `space_id`） |

**返回字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `file_id` | string | 文件ID |
| `doc_url` | string | 文件链接 |
| `name` | string | 文件名称 |
| `ext` | string | 文件类型 |

**调用示例**：

```json
{
  "title": "项目计划",
  "type": "DOC"
}
```

**调用示例（在指定文件夹下创建表格）**：

```json
{
  "title": "数据统计",
  "type": "SHEET",
  "parent_id": "folder_abc123"
}
```

**返回示例**：

```json
{
  "file_id": "doc_1234567890",
  "doc_url": "https://${TENCENT_DOCS_DOMAIN}/doc/DV2h5cWJ0R1lQb0lH",
  "name": "项目计划",
  "ext": "doc"
}
```

---

## 文档内容获取

### manage.get_content

**功能**：获取文件的文本内容和标题。

**使用场景**：
- 读取文档的纯文本内容
- 获取文档标题

**请求参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|-----|------|
| `file_id` | string | ✅ | 文件ID [长度≥1] |

**返回字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `content` | string | 文件内容 |
| `title` | string | 文件标题 |

**调用示例**：

```json
{
  "file_id": "DtDywXFgYFru"
}
```

**返回示例**：

```json
{
  "content": "这是文档的正文内容...",
  "title": "项目计划"
}
```

---

## 文档信息查询

### manage.query_file_info

**功能**：查询在线腾讯文档基础信息，支持查询文档状态、创建人、创建时间、最后修改人、最后修改时间、文档 owner 等信息。

**使用场景**：
- 查询文档的基本元数据（类型、创建人、修改时间等）
- 判断某个 file_id 是否属于空间内文件（通过返回的 `collaboration_space_id` 是否为空判断）
- 判断某个 file_id 是否为文件夹

**请求参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|-----|------|
| `file_id` | string | ✅ | 文档ID [长度≥1] |
| `need_policy` | boolean | | 是否需要权限策略信息 |
| `need_user_info` | boolean | | 是否需要用户信息 |
| `need_collaboration_space_info` | boolean | | 是否需要协作空间信息 |
| `need_user_space` | boolean | | 是否需要用户空间信息 |
| `need_entry` | boolean | | 是否需要入口信息 |
| `need_domain_id` | boolean | | 是否需要域名ID信息 |

**返回字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `file.file_id` | string | 文档ID |
| `file.name` | string | 文档名称 |
| `file.ext` | string | 文档类型，如 `doc`、`sheet`、`slide`、`smart_canvas`、`smart_sheet` 等 |
| `file.doc_url` | string | 文档访问链接 |
| `file.status` | integer | 文档状态（0-正常，1-已删除，2-回收站，等） |
| `file.create_time` | uint64 | 文档创建时间，Unix 时间戳（秒） |
| `file.creator_name` | string | 文档创建人名称 |
| `file.modify_time` | uint64 | 文档最后修改时间，Unix 时间戳（秒） |
| `file.modifier_nick` | string | 文档最后修改人名称 |
| `file.owner_name` | string | 文档 owner 的名称 |
| `file.collaboration_space_id` | string | 协作空间ID，为空时表示首页文档 |
| `file.is_folder` | boolean | 是否是文件夹 |

**调用示例**：

```json
{
  "file_id": "DtDywXFgYFru"
}
```

**返回示例**：

```json
{
  "file": {
    "file_id": "DtDywXFgYFru",
    "name": "项目计划",
    "ext": "smart_canvas",
    "doc_url": "https://${TENCENT_DOCS_DOMAIN}/doc/DtDywXFgYFru",
    "status": 0,
    "create_time": 1713600000,
    "creator_name": "张三",
    "modify_time": 1713686400,
    "modifier_nick": "李四",
    "owner_name": "张三",
    "collaboration_space_id": "",
    "is_folder": false
  }
}
```

> **注意**：`collaboration_space_id` 为空表示该文件在个人首页，不为空则表示该文件在对应协作空间内。

---

## 文档重命名

### manage.rename_file_title

**功能**：根据云文档ID更新文档标题。

**使用场景**：
- 将文档标题更新为新名称

**请求参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|-----|------|
| `file_id` | string | ✅ | 文档ID [长度≥1] |
| `title` | string | ✅ | 新文件名称 [长度≤36] |

**调用示例**：

```json
{
  "file_id": "DtDywXFgYFru",
  "title": "MCP重命名"
}
```

**返回示例**：

```json
{}
```

---

## 文档权限管理

### manage.get_privilege

**功能**：根据文档ID查询文档权限策略。

**使用场景**：
- 查看文档当前的权限状态
- 在设置权限前先查询当前状态，避免重复设置

**请求参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|-----|------|
| `file_id` | string | ✅ | 文档ID [长度≥1] |

**返回字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `file_id` | string | 文档ID |
| `policy` | integer | 权限策略：6-企业内可读(INTERNAL_READ)，7-企业内可编辑(INTERNAL_EDIT) ，8-需要协作人员审批(COLLAB_APPROVE)，7-需要管理员审批(ADMIN_APPROVE)|

**调用示例**：

```json
{
  "file_id": "DtDywXFgYFru"
}
```

**返回示例**：

```json
{
  "file_id": "DtDywXFgYFru",
  "policy": 6
}
```

---

### manage.set_privilege

**功能**：根据文档ID设置文档权限。当前仅支持设置为 INTERNAL_READ(6)、INTERNAL_EDIT(7)、COLLAB_APPROVE(8)、ADMIN_APPROVE(9) 四种权限。

**使用场景**：
- 设置文档为企业内可读，支持多人协作

**请求参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|-----|------|
| `file_id` | string | ✅ | 文档ID [长度≥1] |
| `policy` | integer | ✅ | 权限策略：6-企业内可读、7-企业内可编辑、8-需要协作人员审批、9-需要管理员审批 |

**调用示例（设置所有人可读）**：

```json
{
  "file_id": "DtDywXFgYFru",
  "policy": 7
}
```

**返回示例**：

```json
{}
```

---

### manage.batch_query_permission

**功能**：批量查询文档权限，一次最多查询20个文档的权限信息。

**使用场景**：
- 批量检查多个文档的读写权限

**请求参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|-----|------|
| `file_ids` | []string | ✅ | 批量文档ID列表，一次最多20个 |

**返回字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `ret` | int32 | 业务响应码 |
| `msg` | string | 业务返回码描述 |
| `data[].file_id` | string | 文档ID |
| `data[].is_owner` | boolean | 是否文档所有者 |
| `data[].read_enable` | boolean | 是否允许查看 |
| `data[].edit_enable` | boolean | 是否允许编辑 |
| `data[].download_enable` | boolean | 是否禁止查看者复制、保存、打印 |
| `data[].clone_enable` | boolean | 是否可以创建副本 |
| `data[].watermark_enable` | boolean | 是否允许设置水印 |

**调用示例**：

```json
{
  "file_ids": ["DtDywXFgYFru", "doc_abc123"]
}
```

**返回示例**：

```json
{
  "ret": 0,
  "msg": "ok",
  "data": [
    {
      "file_id": "DtDywXFgYFru",
      "is_owner": true,
      "read_enable": true,
      "edit_enable": true,
      "download_enable": true,
      "clone_enable": true,
      "watermark_enable": false
    }
  ]
}
```

---

## 文档移动操作

### manage.move_file

**功能**：将文件移动到指定的文件夹下。

**使用场景**：
- 将文件移动到根目录
- 将文件移动到某个文件夹下

**请求参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|-----|------|
| `file_id` | string | ✅ | 文件ID [长度≥1] |
| `target_folder_id` | string | | 移动的目标文件夹ID，为空时移动到根目录 |

**调用示例**：

```json
{
  "file_id": "doc_abc123",
  "target_folder_id": "folder_xyz"
}
```

**返回示例**：

```json
{}
```

---

## 文档复制操作

### manage.copy_file

**功能**：为指定文档生成一个副本文档。

**使用场景**：
- 基于现有文档创建副本，用于修改或备份
- 将文档复制到指定文件夹下

**请求参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|-----|------|
| `file_id` | string | ✅ | 源文件ID [长度≥1] |
| `title` | string | | 副本标题，长度不超过36字符 [长度≤36] |
| `parent_id` | string | | 目标文件夹ID，为空时复制到当前文件所在文件夹 |

**返回字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `file_info.file_id` | string | 副本文档ID |
| `file_info.name` | string | 副本文档名称 |
| `file_info.doc_url` | string | 副本文档链接 |

**调用示例（生成副本到当前目录）**：

```json
{
  "file_id": "DtDywXFgYFru"
}
```

**调用示例（生成副本到指定目录并重命名）**：

```json
{
  "file_id": "DtDywXFgYFru",
  "title": "项目计划-副本",
  "parent_id": "folder_abc123"
}
```

**返回示例**：

```json
{
  "file_info": {
    "file_id": "DtDywXFgYFru_copy",
    "name": "项目计划-副本",
    "doc_url": "https://${TENCENT_DOCS_DOMAIN}/doc/DtDywXFgYFru_copy"
  }
}
```

---

## 文档删除操作

### manage.delete_file

**功能**：删除首页列表文件到回收站，或删除空间内的节点文件。

**使用场景**：
- 删除首页中的源文件
- 删除空间内的节点（支持仅删除当前节点或递归删除所有子节点）

**请求参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|-----|------|
| `file_id` | string | ✅ | 文件ID [长度≥1] |
| `delete_type` | integer | | **仅对首页文件有效**，首页文件所属的列表类型：1-全部文档根目录(ALL_DOC)，3-与我共享(SHARED)，4-最近浏览(HISTORY) |
| `remove_type` | integer | | **仅对空间节点有效**，空间节点删除类型：1-仅删除当前节点(CURRENT，默认)，2-删除当前节点及所有子节点(ALL，⚠️ 谨慎使用) |

**调用示例（删除首页源文件）**：

```json
{
  "file_id": "doc_abc123",
  "delete_type": 1
}
```

**调用示例（删除空间节点，仅删除当前节点）**：

```json
{
  "file_id": "node_abc123",
  "remove_type": 1
}
```

**调用示例（删除空间节点及所有子节点）**：

```json
{
  "file_id": "node_abc123",
  "remove_type": 2
}
```

**返回示例**：

```json
{}
```

---

## 上传与导入操作

### manage.apply_upload

**功能**：申请上传链接，传入文件名称、文件大小、扩展名和MD5值，返回COS上传链接和相关信息。客户端根据返回的COS上传链接将文件上传后，再调用 `manage.complete_upload` 完成导入。

**使用场景**：
- 将本地文件上传并导入为云文档（两步流程：申请上传 → 上传文件 → 完成上传）

**请求参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|-----|------|
| `file_size` | uint64 | ✅ | 文件大小，单位为字节(bytes) [>0] |
| `ext` | string | ✅ | 文件扩展名，如 `docx`、`xlsx` [长度≥1] |
| `name` | string | ✅ | 文件名（含后缀），如 `report.docx` [长度≥1] |
| `md5` | string | ✅ | 文件的MD5哈希值 [长度≥1] |
| `parent_id` | string | | 父目录ID，为空时上传到根目录 |

**返回字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `upload_url` | string | COS上传链接，客户端需使用HTTP PUT方法将文件二进制内容上传到此URL |
| `obj_key` | string | COS对象键，调用 `manage.complete_upload` 时需传入 |
| `expire_time` | uint64 | 上传凭证过期时间（毫秒时间戳） |
| `task_id` | string | 上传任务ID，调用 `manage.complete_upload` 时需传入 |
| `uniq_file_name` | string | 唯一文件名（若重名则返回新的文件名） |

**调用示例**：

```json
{
  "file_size": 36752,
  "ext": "docx",
  "name": "report.docx",
  "md5": "f2c4890b5e6fc6abba5f69e1c4fced99"
}
```

**返回示例**：

```json
{
  "upload_url": "https://cos.ap-guangzhou.myqcloud.com/import/...",
  "obj_key": "import/abc123def456",
  "expire_time": 1713686400000,
  "task_id": "drivetask_414b0637da6b4eb097acc6d43e337e1c"
}
```

---

### manage.complete_upload

**功能**：上传完成，传入文件信息和COS对象键，触发文件导入为云文档。前置条件：需先调用 `manage.apply_upload` 获取上传链接，并将文件上传到COS后再调用此接口。

**使用场景**：
- 配合 `manage.apply_upload` 完成两步导入

**请求参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|-----|------|
| `name` | string | ✅ | 文件名（含后缀），需与 `apply_upload` 时传入的一致 [长度≥1] |
| `ext` | string | ✅ | 文件后缀名，需与 `apply_upload` 时传入的一致 [长度≥1] |
| `file_size` | uint64 | ✅ | 文件大小，单位为字节(bytes) [>0] |
| `md5` | string | ✅ | 文件的MD5哈希值，需与 `apply_upload` 时传入的一致 [长度≥1] |
| `obj_key` | string | ✅ | COS对象键，由 `manage.apply_upload` 返回 [长度≥1] |
| `task_id` | string | ✅ | 上传任务ID，由 `manage.apply_upload` 返回 [长度≥1] |

**返回字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `file_id` | string | 文件ID |
| `tencent_doc_url` | string | 腾讯文档URL |
| `parent_id` | string | 父目录ID |
| `task_id` | string | 上传任务ID |
| `status` | integer | 上传状态（参考 DriveStatus 枚举） |

**调用示例**：

```json
{
  "name": "report.docx",
  "ext": "docx",
  "file_size": 36752,
  "md5": "f2c4890b5e6fc6abba5f69e1c4fced99",
  "obj_key": "import/abc123def456",
  "task_id": "drivetask_414b0637da6b4eb097acc6d43e337e1c"
}
```

**返回示例**：

```json
{
  "file_id": "DjVlDHwqVVzs",
  "tencent_doc_url": "https://${TENCENT_DOCS_DOMAIN}/doc/DjVlDHwqVVzs",
  "task_id": "drivetask_414b0637da6b4eb097acc6d43e337e1c",
  "status": 5
}
```

---

### manage.query_task

**功能**：查询上传/导入/导出任务的状态和进度。每隔3-5秒轮询一次，当 `progress=100` 时表示任务完成。

**使用场景**：
- 调用 `manage.complete_upload` 后轮询查询导入状态
- 调用 `manage.apply_download` 后轮询查询导出状态
- 任务完成后获取生成的云文档 ID 和访问链接

**请求参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|-----|------|
| `task_id` | string | ✅ | 任务ID [长度≥1] |

**返回字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `task_id` | string | 任务ID |
| `progress` | int32 | 任务进度百分比（0-100） |
| `file_id` | string | 任务完成后的云文档ID |
| `file_type` | string | 文档类型 |
| `title` | string | 文档标题 |
| `url` | string | 文档访问链接（导出任务完成后为下载链接，有效期约30分钟） |
| `parent_id` | string | 父目录ID |
| `can_cancel` | boolean | 是否可以取消 |

**调用示例**：

```json
{
  "task_id": "drivetask_414b0637da6b4eb097acc6d43e337e1c"
}
```

**返回示例（进行中）**：

```json
{
  "task_id": "drivetask_414b0637da6b4eb097acc6d43e337e1c",
  "progress": 25
}
```

**返回示例（完成）**：

```json
{
  "task_id": "drivetask_414b0637da6b4eb097acc6d43e337e1c",
  "progress": 100,
  "file_id": "DjVlDHwqVVzs",
  "title": "report",
  "url": "https://${TENCENT_DOCS_DOMAIN}/doc/DjVlDHwqVVzs"
}
```

---

## 下载与导出操作

### manage.apply_download

**功能**：根据云文档 ID 发起导出任务，返回导出任务 ID。需配合 `manage.query_task` 轮询查询导出进度（建议间隔3-5秒），导出完成后通过 `url` 字段获取下载链接（带签名的临时URL，有效期约30分钟）。

**使用场景**：
- 将云端在线文档导出为本地 docx/xlsx/pptx 文件
- 备份云文档到本地

**请求参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|-----|------|
| `file_id` | string | ✅ | 云文档ID [长度≥1] |
| `export_type` | integer | | 导出方式：0-默认（不含附件，即.docx/.xlsx/.pptx等），1-品类+附件，2-仅导出附件，3-仅导出文本 |

**返回字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `task_id` | string | 导出任务ID，用于调用 `manage.query_task` 查询进度 |

**调用示例**：

```json
{
  "file_id": "DAJpzYoLEpWS"
}
```

**返回示例**：

```json
{
  "task_id": "144115210435508643_0e15f9be-a2ed-b40a-27c2-10561b7c5072"
}
```

> **注意**：导出完成后通过 `manage.query_task` 获取的 `url` 为带签名的临时下载链接，有效期约 30 分钟，需及时下载。可通过 `curl -L -o <本地路径> "<url>"` 命令保存到本地。

---

## 图片上传

### manage.upload_image

**功能**：上传图片到指定文档，返回 image_id，可用于后续在文档中插入图片。

**使用场景**：
- 上传图片后获取 image_id，再调用文档插入图片接口

**请求参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|-----|------|
| `image_base64` | string | ✅ | 图片的base64编码内容 [长度≥1] |
| `file_name` | string | | 图片文件名 |

**返回字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `image_id` | string | 上传成功后返回的imageID，可用于文档插入图片操作 |

**调用示例**：

```json
{
  "image_base64": "iVBORw0KGgoAAAANSUhEUgAA...",
  "file_name": "screenshot.png"
}
```

**返回示例**：

```json
{
  "image_id": "img_abc123def456"
}
```

---

## 网页剪藏

### manage.scrape_url

**功能**：将指定网页内容剪藏为腾讯文档，返回异步任务ID。需配合 `manage.scrape_progress` 轮询查询进度。

**使用场景**：
- 将网页内容保存为云文档

**请求参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|-----|------|
| `url` | string | ✅ | 要剪藏的网页URL地址 [长度≥1] |

**返回字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `task_id` | string | 异步任务ID，用于调用 `manage.scrape_progress` 查询进度 |

**调用示例**：

```json
{
  "url": "https://example.com/article"
}
```

**返回示例**：

```json
{
  "task_id": "scrape_task_abc123"
}
```

---

### manage.scrape_progress

**功能**：查询网页剪藏任务进度。

**使用场景**：
- 调用 `manage.scrape_url` 后轮询查询剪藏状态
- 剪藏完成后获取生成的云文档 ID 和访问链接

**请求参数**：

| 参数 | 类型 | 必填 | 说明 |
|------|------|-----|------|
| `task_id` | string | ✅ | 异步任务ID（由 `manage.scrape_url` 返回）[长度≥1] |

**返回字段**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `code` | integer | 进度码：0-未知，1-进行中(RUNNING)，2-成功(SUCCESS)，3-失败(FAILED) |
| `title` | string | 网页标题 |
| `file_id` | string | 文档唯一标识符（成功时返回） |
| `file_url` | string | 文档访问链接（成功时返回） |
| `text_content` | string | 文本内容（HTML 或 Markdown 格式，仅特定任务成功时返回） |

**调用示例**：

```json
{
  "task_id": "scrape_task_abc123"
}
```

**返回示例（进行中）**：

```json
{
  "code": 1,
  "title": ""
}
```

**返回示例（完成）**：

```json
{
  "code": 2,
  "title": "示例文章标题",
  "file_id": "DjVlDHwqVVzs",
  "file_url": "https://${TENCENT_DOCS_DOMAIN}/doc/DjVlDHwqVVzs"
}
```


## 典型工作流示例

### 工作流一：查询文件列表并创建文档

```
步骤 1：获取文件夹列表
 → manage.list_file（list_type=1，查询我的文档，is_folder=true 的条目为文件夹）

步骤 2：创建指定品类文档
 → manage.create_file（传入文件夹 file_id 作为 parent_id 和文件类型）
```

### 工作流二：按关键字搜索文件

```
步骤 1：搜索文档
 → manage.search_file（传入 tag_info.tag_type=1 按标题搜索，pattern 为关键词）

步骤 2：处理数据
 → 从返回的 result[].file_data_list 中获取所需的文档信息
```

### 工作流三：给指定文档生成副本到指定目录

```
步骤 1：获取文件夹列表
 → manage.list_file（list_type=1，获取 is_folder=true 的文件夹 file_id）

步骤 2：按照指定文档ID生成副本
 → manage.copy_file（传入 parent_id 和待生成副本的 file_id）
```

### 工作流四：根据关键词搜索后删除文档

```
步骤 1：搜索文档
 → manage.search_file（传入用户指定的关键词，获取文档 file_id）

步骤 2：删除文档
 → manage.delete_file（传入指定的 file_id）
```

### 工作流五：将本地文件导入为云文档

> **推荐方式**：执行 `import_file.py` 脚本，自动完成 MD5 计算、调用 `manage.apply_upload` 获取上传链接、上传文件到 COS 三步，输出结果后直接调用 `manage.complete_upload` 触发导入。

```
步骤 1：使用脚本完成预导入和上传（推荐）
 → 执行 python3 import_file.py <文件路径>
 → 脚本自动：计算文件 MD5 和大小 → 调用 manage.apply_upload 获取上传链接 → PUT 上传文件到 COS
 → 成功后输出 OBJ_KEY、FILE_NAME、FILE_EXT、FILE_MD5、FILE_SIZE、TASK_ID

步骤 2：调用上传完成接口
 → manage.complete_upload（传入 task_id、file_size、obj_key、name、ext、md5）
 → 返回 file_id 和 tencent_doc_url

步骤 3：轮询查询任务进度（如需确认导入完成）
 → manage.query_task（传入 task_id）
 → 每隔 3-5 秒轮询一次，直到 progress=100 或返回错误
```

**手动分步执行（不使用脚本）**：
```
步骤 1：计算文件信息
 → 使用 md5sum/md5 计算文件 MD5
 → 使用 stat 获取文件大小（字节）

步骤 2：申请上传链接
 → manage.apply_upload（传入 name、file_size、ext、md5）
 → 返回 upload_url、obj_key 和 task_id

步骤 3：上传文件到 COS
 → curl -X PUT -H "Content-Type: application/octet-stream" --data-binary "@<文件路径>" "<upload_url>"

步骤 4：触发完成上传
 → manage.complete_upload（传入 task_id、file_size、obj_key、name、ext、md5）
 → 返回 file_id 和 tencent_doc_url

步骤 5：轮询查询任务进度（可选）
 → manage.query_task（传入 task_id）
 → 每隔 3-5 秒轮询一次，直到 progress=100
```

### 工作流六：将云文档导出到本地

```
步骤 1：发起导出任务
 → manage.apply_download（传入 file_id）
 → 返回 task_id

步骤 2：轮询查询导出进度
 → manage.query_task（传入 task_id）
 → 每隔 3-5 秒轮询一次，直到 progress=100 或返回错误
 → 导出完成后获取 url（临时下载链接）

步骤 3：下载文件到本地
 → 使用 curl 或其他 HTTP 工具下载文件
 → curl -L -o <本地保存路径> "<url>"
```

> **注意事项**：
> - 导出的下载链接（url）为带签名的临时 URL，有效期约 30 分钟，需及时下载
> - 导出的文件格式取决于原始文档类型（doc→docx，sheet→xlsx，slide→pptx 等）

### 工作流七：创建文档并设置分享权限

```
步骤 1：创建文档
 → manage.create_file（传入标题和文件类型）
 → 返回 file_id 和 doc_url

步骤 2：设置文档权限
 → manage.set_privilege（传入 file_id 和 policy）
 → policy=2 设置所有人可读，policy=3 设置所有人可编辑

步骤 3：分享文档链接
 → 将步骤 1 返回的 doc_url 分享给相关人员
```

### 工作流八：查询文档权限后按需调整

```
步骤 1：查询文档当前权限
 → manage.get_privilege（传入 file_id）
 → 返回 policy：6-企业内可读、7-企业内可编辑、8-需要协作人员审批、9-需要管理员审批

步骤 2：根据需要调整权限
 → 如果 policy 不符合预期，调用 manage.set_privilege（传入 file_id 和目标 policy）
```

### 工作流九：网页剪藏

```
步骤 1：发起网页剪藏
 → manage.scrape_url（传入 url）
 → 返回 task_id

步骤 2：轮询查询剪藏进度
 → manage.scrape_progress（传入 task_id）
 → 每隔 3-5 秒轮询一次，直到 code=2（SUCCESS）或 code=3（FAILED）
 → 剪藏完成后获取 file_id 和 file_url
```

### 工作流十：移动文件

```
步骤 1：查询目标文件夹信息（可选）
 → manage.query_file_info（传入 target_folder_id）
 → 确认目标文件夹存在

步骤 2：移动文件
 → manage.move_file（传入 file_id 和 target_folder_id）
```
