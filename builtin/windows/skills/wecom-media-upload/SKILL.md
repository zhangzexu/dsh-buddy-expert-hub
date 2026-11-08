---
name: wecom-media-upload
description: >
  通过 A2ASendMessage 给企业微信聊天 Agent 发送本地文件（文件/图片/语音/视频）前，必须先用本 Skill 上传到企业微信 third_aibot 媒体库，再把上传返回的 media_url 放进 attachments，作为独立的文件 part 与文本一起发送。
user-invocable: false
disable-model-invocation: false
metadata:
  scope: workspace
  integration: workbuddy-wecom-media
---

# 企业微信媒体上传（给企业微信聊天 Agent 发本地文件的前置流程）

当你准备通过 `A2ASendMessage` 向企业微信聊天 Agent 发送**本地文件**（文件 / 图片 / 语音 / 视频）时，
**必须先执行本 Skill**。`A2ASendMessage` 只会把 `attachments[].url` 原样转发成一个文件 part——它不上传、
不托管、不转换任何东西，因此 URL 必须是远端能直接 `GET` 到的地址。企业微信侧的可拉取地址只能通过
`third_aibot` 媒体库换取：上传成功后接口直接返回 `media_url`。流程固定为：

```text
本地文件 → third_aibot 媒体上传 → media_url
        → A2ASendMessage(message=文字, attachments[].url=media_url) → 企业微信聊天 Agent
```

文字和文件在线上是**两个独立的 part**（`text` part + `url` file part），不要把链接拼进文字里。

**不要因为涉及文件就改走 `wecom-unified` 的消息/媒体 reference 或 `wecomcli-*` 技能。** 发消息这条路归企业微信聊天 Agent，本 Skill 只负责把
文件换成链接。

**企业微信聊天 Agent 的 id 不要写死。** 它的 id 和显示名归企业微信，会变；每次调用都从 `A2AGetAgentCard`
描述里的 `<available_A2A_agents>` 现取（那份清单来自实时发现），把方括号里的 `[id]` 原样抄进
`agent_id`。不要沿用本文档、旧对话或记忆里的任何 id——过期 id 会回 `AGENT_NOT_FOUND`，那不代表
通道不可用，重新读清单即可。

> 何时**不需要**本 Skill：消息不带文件（纯文本），或你手里已经有一个远端可直接访问、且不含企业微信
> 凭证的公网 URL。除此之外，给企业微信聊天 Agent 发本地文件一律先走这里。

## 接口地址已内联在本文档里（不要去 shell 查环境变量）

上传走宿主注入的本地代理。本 Skill **不猜测、不拼域名、不改环境后缀、不自己换票**：

| 变量 | 用途 |
| --- | --- |
| `WECOM_MEDIA_UPLOAD_BASE_URL` | 媒体上传接口 Base URL（形如 `http://127.0.0.1:<端口>/a2a/upstream/<hash>`） |
| `WECOM_MEDIA_API_EXTRA_QUERY` | 附加到每个上传请求上的额外 query（测试环境为 `_freego=wwfinal`；未配置就当空） |

下文出现的 `${WECOM_MEDIA_UPLOAD_BASE_URL}` 等占位符，**在本文档加载时就已被替换成实际值**——你现在读到的
就是可以直接用的地址，照抄即可。

**不要用 Bash / shell 去读这两个变量。** 它们注入在宿主拉起的 CLI 进程环境里，工具调用起的那个 shell 读不到，
`echo $WECOM_MEDIA_UPLOAD_BASE_URL` 必然是空的——**空不代表未配置**，据此停止或改走别的路径都是错的。
唯一的判定标准：如果下文正文里还字面写着 `${WECOM_MEDIA_UPLOAD_BASE_URL}` 这个占位符本身，才说明宿主没注入；
只要已经是一个 `http://127.0.0.1:...` 地址，就直接拿它发请求。

若 `WECOM_MEDIA_API_EXTRA_QUERY` 替换后为空，就当它为空处理（不要保留 `${...}` 占位符去发请求）。

**凭证纪律**：不要在请求里拼 `user_access_token` / `access_token`。本地代理会附上当前换票，测试环境会加 `_freego=wwfinal`。不得在对话、终端输出、生成文档或 Skill 执行报告中展示完整请求 URL 或任何票据。上传返回的 `media_url` 本身不含凭证，构造给远端 Agent 的 url **绝不能**再补凭证参数，也**不要**再拼下载地址或 `media_id`。

## 必需输入

开始上传前，确认已具备：

1. 本地源文件的绝对路径，且文件可读。
2. 本文档里的 `WECOM_MEDIA_UPLOAD_BASE_URL` 已经是一个 `http://127.0.0.1:...` 地址（不是占位符）。不要去 shell 复核。
3. 用户要发给企业微信聊天 Agent 的文字指令（作为文本 Part）。

## 校验源文件（同时取定 meta）

1. 确认路径存在、是普通可读文件，并在此**一次性取定**后续要用的全部 meta：

   | meta | 取值 | 用在 |
   | --- | --- | --- |
   | 源文件名 | 本地文件名（如 `report.pdf`） | 直传 multipart 的 `filename`、`attachments[].filename` |
   | 真实 MIME | 由本地文件判定（如 `application/pdf`、`image/png`、`audio/amr`、`video/mp4`） | 直传 multipart 的 `Content-Type`、`attachments[].media_type` |
   | 字节大小 | 本地文件大小 | 上限校验、完成报告 |

   这三项**只从本地文件取**，上传前就定好，之后不再改写、不再从接口响应回读。

2. 依据下表确定 `media_type` 与大小上限；所有文件必须大于 5 字节。

   | media_type | 说明 | 大小上限 | 格式要求 |
   | --- | --- | --- | --- |
   | `image` | 图片 | 10 MB | JPG、PNG |
   | `voice` | 语音 | 2 MB，时长 ≤ 60s | AMR、silk |
   | `video` | 视频 | 10 MB | MP4 |
   | `file` | 普通文件 | 100 MB（10MB 以内直传，超过走分片） | 无限制 |

3. 文件超过对应类型的大小上限：发送前停止并说明约束，不暴露文件内容。

不得静默修改文件类型或转码。任何会改变文件内容或格式的转换，必须先征得用户同意。

文件 **≤ 10MB 走下面的直传**；**> 10MB 走「分片上传」**。

## 直传

单次请求传完整个文件，全程走本地代理（不要自己拼凭证）。`<TYPE>` 用上一步确定的 `media_type`：

```http
POST ${WECOM_MEDIA_UPLOAD_BASE_URL}/media/upload?media_type=<TYPE>&${WECOM_MEDIA_API_EXTRA_QUERY}
Content-Type: multipart/form-data
```

`${WECOM_MEDIA_API_EXTRA_QUERY}` 为空时不要拼多余的 `?` 或 `&`。multipart 表单中必须包含名为 `media` 的
文件字段；`filename` 用源文件名——企业微信会用它作为文件对外展示的名称：

```http
Content-Disposition: form-data; name="media"; filename="report.pdf"
Content-Type: application/pdf

<文件二进制>
```

只有响应同时满足 `errcode: 0` 和非空 `media_url` 才算成功：

```json
{ "errcode": 0, "errmsg": "ok", "type": "file", "media_url": "<media_url>", "created_at": 1690000000, "size": 12345 }
```

`media_url` 的用法、以及为什么要忽略响应里的 `type`，与分片上传完全一致，见「完成上传」小节末尾的三条说明。

## 分片上传

**前置条件**：仅在文件超出直传上限（普通文件 10MB）时才走这条路；普通文件分片上限 100MB。

全程走同一套本地代理（不要自己拼凭证）。

### 1. 初始化

`filename` / `content_type` / `media_type` / `total_size` **全部放 query**，不要再塞进 JSON body
（旧文档曾写成 body，服务端已改到 query）。

```http
POST ${WECOM_MEDIA_UPLOAD_BASE_URL}/media/multipart_upload_initiate?content_type=application/pdf&media_type=file&total_size=52428800&filename=a.pdf&${WECOM_MEDIA_API_EXTRA_QUERY}
Content-Type: application/json
```

`${WECOM_MEDIA_API_EXTRA_QUERY}` 为空时不要拼多余的 `?` 或 `&`。`media_type` 取上一步确定的
类型（`image` / `voice` / `video` / `file`），`content_type` 用文件真实 MIME。body 不要带这些字段。

成功响应后才能继续：

```json
{ "errcode": 0, "upload_token": "<upload_token>", "part_size": 16777216, "total_parts": 4, "expires_at": 1690000000 }
```

确认 `part_size`、`total_parts` 均为正数。按服务端返回的 `part_size` 把文件切成连续字节块，`part_number` 从 `1`
开始，到 `total_parts` 结束。

### 2. 逐片上传

按顺序上传每一个分片：

```http
POST ${WECOM_MEDIA_UPLOAD_BASE_URL}/media/multipart_upload_part?upload_token=<upload_token>&part_number=<n>&${WECOM_MEDIA_API_EXTRA_QUERY}
Content-Type: application/octet-stream
Content-Length: <当前分片字节数>

<分片二进制>
```

每片都必须返回 `errcode: 0`；校验返回的 `part_number` 与所发分片一致、`size` 与当前分片字节数一致。
所有分片成功之前不得调用完成接口。

### 3. 完成上传

```http
POST ${WECOM_MEDIA_UPLOAD_BASE_URL}/media/multipart_upload_complete?upload_token=<upload_token>&${WECOM_MEDIA_API_EXTRA_QUERY}
Content-Length: 0
```

只有响应 `errcode: 0` 且 `media_url` 非空才算成功：

```json
{ "errcode": 0, "errmsg": "ok", "type": "file", "media_url": "<media_url>", "created_at": 1690000000, "size": 52428800 }
```

- `media_url` 就是 `attachments[].url` 要填的值，本身不含凭证。响应里**没有** `media_id`，不要引用或伪造它，
  也不要再拼下载 Base URL。
- **响应里除 `media_url` 外的字段都不参与构造 `attachments[]`。** `type` 恒为 `file` 之类的粗粒度值，不代表
  真实媒体类型；`media_type` 用「校验源文件」里取定的真实 MIME。
- 仅记录非敏感的 `created_at` 与总 `size`。

## 通过 A2ASendMessage 发送

**文字和文件必须是两个独立的 part，不要把链接拼进正文。** `message` 只放用户要说的话，文件放进
`attachments[]`——工具会把它们展开成一个 `text` part 加每个附件一个 `url` file part，正是企业微信 A2A 约定的
请求体形状：

```json
{
  "agent_id": "<从 A2AGetAgentCard 描述里 <available_A2A_agents> 抄来的企业微信聊天 Agent 的 [id]>",
  "message": "<要发给收件人的正文原文>",
  "attachments": [
    {
      "url": "<media_url>",
      "filename": "<源文件名>",
      "media_type": "application/pdf"
    }
  ]
}
```

上面这份入参在线上会变成**一条**消息、两个 part：

```text
parts: [ { text: "<要发给收件人的正文原文>", mediaType: "text/plain" },
         { url: "<media_url>", filename: "<源文件名>", mediaType: "application/pdf" } ]
```

- **`message` 是给 agent 的委派请求**，必须同时说清**发给谁**和**要发的文字原文**（把用户原话原样引在里面）。
  用户说「发『你真好』并附上这张图」，`message` 写成「发给我自己（吴俊涛）本人单聊，内容是「你真好」」，图片放
  `attachments[]`。只写「发送图片给我自己」而丢掉正文，agent 会不知道该说什么，回过来反问。
- **默认一条消息发完。** 独立 part 不等于独立消息：正文和所有附件放进**同一个** `A2ASendMessage`，由工具拆成多个
  part。**只有用户明确要求分开发**（如「文字和文件分两条发」）才拆成多次调用；用户没提就一律一条，附件再多也一样。
- 截至 2026-09-01，企业微信聊天 Agent 会收下两个 part，但**不会合并成一条**投递，而是回复「一次只能发一条，
  纯文本或图片二选一」。如实把这个回复转达给用户、由用户决定，**不要**因为它这么说就自己拆成两次调用——这是企业微信侧
  的能力缺口，在我们这边绕过去只会把它藏起来。
- `filename` 和 `media_type` 用「校验源文件」里取定的值，不要在这里重新判定，也不要取上传响应里的 `type`。
- **拿到 `media_url` 就直接发送，不要验证它可不可访问。** 禁止对 `media_url` 发 `GET` / `HEAD` / `curl`，禁止
  为验证起本地服务或下载回环。该地址由企业微信侧签发，只有目标 Agent 在其网络内可拉取，本机探测失败不代表地址无效，
  探测成功也不增加任何保证——只会白白拖长链路。
- 多个文件各自走一遍上传，`attachments` 里放多个元素，仍然只发一条消息。
- 发送后按 `A2ASendMessage` 自身的说明处理返回状态（非终态需立即调 `A2AGetTask` 轮询）。二次确认 / 中断态恢复
  由企业微信后台独立链路触发，本 Skill 不再调 `A2ASendMessage` 恢复，只继续轮询即可。
- 不得把带凭证参数的上传地址传给远端 Agent；只传上传返回的 `media_url`。

## 失败处理

- 路径无效、类型不符或超过对应类型的大小上限：发送前停止并说明约束，不暴露文件内容。
- `errcode != 0`、缺失 `media_url` 或上传被拒绝：不得报告成功；仅报告非敏感错误码/信息，并修正输入后重试。
- 直传与分片按大小分流，**不要**互为兜底：直传失败不要改走分片，分片失败也不要把大文件塞进直传。
- `A2ASendMessage` 回 `Operation failed`（上游 HTTP 400）：远端按文件 part 声明的 `media_type` 放行，2026-09-01
  实测只接受 `image/png` 和 `image/jpeg`，`text/*` / `application/pdf` / `video/*` / `audio/*` 一律 400，且确定性
  复现，**不是瞬时故障，重试无用**。如实说明企业微信侧暂不支持该文件类型即可。**禁止**改走 `wecom-unified` 的消息/媒体 reference 或 `wecomcli-*`——发消息这条
  路归企业微信聊天 Agent，换通道等于把能力缺口藏起来。
- 单个分片失败：仅在接口允许时重试该分片；不得对不完整上传调用完成接口。
- `upload_token` 过期：重新初始化分片上传，不复用旧 token。
- 本文档里的 `WECOM_MEDIA_UPLOAD_BASE_URL` **仍是字面占位符**（宿主没注入）：停止并说明未配置企业微信媒体接口，
  不要猜测域名。shell 里 `echo` 出来是空的**不算**这种情况，不要因此停下。

## 完成报告

上传完成后，**必须**把以下三项明确交给上层 AI——它们是构造 `attachments[]` 的直接依据（每个文件一组，
多个文件给多组）：

| 交付字段 | 取值 | 对应 attachments 字段 |
| --- | --- | --- |
| 媒体 MIME 类型 | 「校验源文件」取定的真实 MIME | `attachments[].media_type` |
| 媒体 url | 上传返回的 `media_url`（不含凭证） | `attachments[].url` |
| 文件名 | 「校验源文件」取定的源文件名 | `attachments[].filename` |

再附带报告总字节数与上传 / A2A 发送结果与状态。
不得报告 access token、upload token、完整上传请求 URL 或文件二进制内容。
