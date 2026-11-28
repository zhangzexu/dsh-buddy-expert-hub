# 智聊 WebSocket 协议 v1

插件侧提供长连接服务，聊天工具**主动连接**，dsh 负责鉴权、权限、消息分发。不再需要独立适配层。

## 连接

```
ws://127.0.0.1:18779/ws
```

- 默认只监听 `127.0.0.1`，端口可在设置页改
- **配置入口**：dsh 设置 → Buddy 工作台 → 智聊 → 「WebSocket 长连接」卡片：
  启用开关、监听 IP、端口、clientId、token、群聊是否必须 @
- token 只回「是否已配置」，输入框留空表示保持原值；保存后立即重启 WS 服务生效
- **不再需要身份绑定**：连上几个就显示几个连接，每个连接独立会话
- `docs/zhiliao-ws.example.json` 仅作协议/字段参考，实际配置以设置页为准（存在 `state.settings.zhiliao.ws`）
- 连接建立后**第一帧必须是 `auth`**，否则服务端关闭（1008 Policy Violation）
- 所有消息都是 JSON 文本帧；二进制帧不支持
- 每条请求都带 `requestId`，服务端用同名 `* .ack` / `*.result` + 回显 `requestId` 回答

## 一、鉴权

客户端 → 服务端：

```json
{
  "type": "auth",
  "version": 1,
  "clientId": "wecom-bot",
  "token": "replace-with-your-secret",
  "capabilities": ["message.in", "message.out", "push", "persona", "attachment"]
}
```

服务端 → 客户端：

```json
{
  "type": "auth.ok",
  "clientId": "wecom-bot",
  "serverTime": 1795681715123,
  "permissions": {
    "message.in": true,
    "message.out": true,
    "push": false,
    "persona": true,
    "attachment": true
  }
}
```

失败：

```json
{ "type": "error", "requestId": "auth", "code": "auth.failed", "message": "bad token" }
```

随后服务端关闭连接（1008）。

## 二、入站消息（聊天工具 → dsh）

```json
{
  "type": "message.in",
  "requestId": "c-1001",
  "messageId": "msg-123",
  "chatKey": "direct:u1:bot",
  "senderId": "u1",
  "senderName": "张三",
  "text": "帮我看看这个报错",
  "atBot": true,
  "attachments": [
    { "name": "shot.png", "mime": "image/png", "data": "<base64>" }
  ]
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `requestId` | 是 | 客户端生成的请求 id，回显用 |
| `messageId` | 是 | 消息唯一 id，服务端 24h 去重 |
| `chatKey` | 是 | `direct:<a>:<b>` 或 `group:<id>`，同一会话保持一致 |
| `senderId` | 是 | 权限校验按它算 |
| `text` | 与附件二选一 | 文本内容 |
| `atBot` | 群聊必填 | 群里是否 @ 了机器人 |
| `attachments` | 否 | base64 附件，数量/大小受限制 |

服务端 ACK：

```json
{
  "type": "message.ack",
  "requestId": "c-1001",
  "messageId": "msg-123",
  "accepted": true,
  "queued": true,
  "sessionId": "zhiliao-xxxx",
  "attachments": 1,
  "personaApplied": false
}
```

被权限拒绝（仍然回 ACK，不回 error）：

```json
{
  "type": "message.ack",
  "requestId": "c-1002",
  "messageId": "msg-124",
  "accepted": false,
  "reason": "group-needs-mention"
}
```

`reason` 取值：`adapter-disabled` / `user-denied` / `user-not-allowed` /
`chat-denied` / `chat-not-allowed` / `group-needs-mention` / `text-too-long` /
`duplicate` / `attachment-too-large` / `no-binding`

## 三、出站消息（dsh → 聊天工具）

回复和主动推送都走这个类型，区别只在 `replyTo` 是否为空：

```json
{
  "type": "message.out",
  "messageId": "r-5501",
  "replyTo": "msg-123",
  "chatKey": "direct:u1:bot",
  "text": "图我看过了，问题在这行",
  "attachments": [
    { "name": "chart.png", "mime": "image/png", "bytes": 1024, "data": "<base64>" }
  ],
  "ts": 1795681715123
}
```

客户端可选回执（服务端不依赖它，仅做统计）：

```json
{ "type": "message.out.ack", "messageId": "r-5501", "ok": true }
```

### AI 怎么发图片/文件

dsh 的 agent 在回复正文里单独写一行：

```
图我生成好了
MEDIA:C:/Users/zzx/.dsh/dsh-buddy-expert-hub/zhiliao/work/chart.png
```

服务端会剥掉这一行，把文件读成 base64 放进 `attachments`，并把 `text` 清理成 `图我生成好了`。
只允许读 `attachments.dir` 与 `mediaRoots` 目录内的文件。

### 入站附件怎么给 AI

服务端把 base64 附件写到
`<DSH_HOME>/dsh-buddy-expert-hub/zhiliao/work/inbox/<clientId>/<messageId>/<文件名>`，
然后在送进 agent 的文本末尾追加：

```
[用户发来 1 个附件，可用文件工具直接读取]
- C:/.../inbox/wecom-bot/msg-123/shot.png（image/png，1024 字节）
```

## 四、会话人设（注入上下文）

设置：

```json
{
  "type": "persona.set",
  "requestId": "p-1",
  "chatKey": "direct:u1:bot",
  "name": "运维助手",
  "prompt": "只回答运维问题，答案不超过三句话。"
}
```

查询 / 删除：

```json
{ "type": "persona.get", "requestId": "p-2", "chatKey": "direct:u1:bot" }
{ "type": "persona.delete", "requestId": "p-3", "chatKey": "direct:u1:bot" }
```

服务端返回：

```json
{
  "type": "persona.result",
  "requestId": "p-1",
  "ok": true,
  "chatKey": "direct:u1:bot",
  "persona": {
    "name": "运维助手",
    "prompt": "只回答运维问题，答案不超过三句话。",
    "version": 1795681715123
  }
}
```

行为：该会话**下一条** `message.in` 会在正文前插入一段设定，然后标记已注入；后续不重复，
**改过 prompt 会重新注入一次**。配置 `persona.alwaysInject=true` 可改成每轮都带。

## 五、主动推送

两种用法：

1. **本地 HTTP**（给 dsh 面板/脚本/Agent 用）：

```http
POST http://127.0.0.1:18779/push
x-admin-token: <token>
{
  "chatKey": "direct:u1:bot",
  "text": "日报已生成",
  "atList": ["u2", "u3"],
  "attachments": [{ "name": "daily.txt", "mime": "text/plain", "data": "<base64>" }]
}
```

2. **WS 管理客户端**：capabilities 含 `push` 的客户端可直接发：

```json
{
  "type": "push.send",
  "requestId": "s-1",
  "chatKey": "group:g1",
  "text": "日报已生成",
  "atList": ["u2"],
  "attachments": []
}
```

服务端回：

```json
{ "type": "push.ack", "requestId": "s-1", "ok": true, "messageId": "r-5502" }
```

主动推送**不经过 agent**，直接下发 `message.out`（`replyTo` 为空）。

## 六、心跳与错误

```json
{ "type": "ping", "ts": 1795681715123 }
{ "type": "pong", "ts": 1795681715123 }
```

建议客户端 30 秒一次 ping；服务端 90 秒没收到任何帧会主动断开。

错误帧：

```json
{
  "type": "error",
  "requestId": "c-1001",
  "code": "bad.message",
  "message": "chatKey 格式非法"
}
```

| code | 含义 |
|---|---|
| `auth.failed` | token 错、clientId 未登记、版本不兼容 |
| `auth.required` | 首帧不是 auth |
| `bad.message` | JSON 非法 / 缺字段 / 字段格式错 |
| `permission.denied` | 该客户端无此 capability（如未授权 push） |
| `internal.error` | dsh 侧异常（会话不存在、agent 未就绪等） |

## 七、权限在哪

全部在 dsh（插件）侧，按 `clientId` 配置：

```
capabilities → users.deny → users.allow → chats.deny → chats.allow
→ 群必须 @ → 文本长度
```

`push` 与 `persona` 额外要求 capability，不会成为绕过白名单的后门。

## 八、和旧方式的区别

| | 旧（适配层 HTTP） | 新（插件 WS） |
|---|---|---|
| 谁连谁 | 聊天工具被回调 / webhook 推给适配层 | 聊天工具主动连 dsh |
| 进程 | 额外 Node 进程 | 无，插件内嵌 |
| 鉴权 | HMAC over HTTP | 首帧 token，连接级 |
| 消息 | HTTP JSON | WS JSON 长连接，双向 |
| 主动推送 | `/v1/push` | WS `push.send` 或本地 HTTP `/push` |

迁移时把聊天工具侧的「推 webhook + 收回调」改成「连 WS + 收发帧」即可，JSON 字段基本一致。

---

## 九、连接管理（设置页用）

插件把这些接口挂在自己的 webServer 前缀下（`localRequestGuard` 保护），供设置页连接列表调用：

| 接口 | 说明 |
|---|---|
| `GET /zhiliao/ws/connections` | 连接列表：`{ok, connections:[{id, clientId, connected, connectedAt, disconnectedAt, lastMessageAt, messageCount, chatKeys}]}` |
| `POST /zhiliao/ws/connection-disconnect` | **断开连接**：只断 socket，连接记录保留：`{connectionId}` |
| `POST /zhiliao/ws/persona` | 按连接设置人设（旧接口，兼容）：`{connectionId, chatKey, name, prompt}` |
| `GET /zhiliao/ws/users` | 接收用户列表：`{ok, users:[{receiverId, receiverName, clientIds, requireMention, requireConfirm, persona}]}`，按 **receiverId** 汇总（发送人不出现在列表里） |
| `POST /zhiliao/ws/user-rule` | **按接收用户设置默认规则**：`{receiverId, userName, requireMention, requireConfirm, fileMode}`，其中 requireConfirm 是用户默认 |
| `POST /zhiliao/ws/chat-rule` | **按会话设置 requireConfirm**。单条 `{chatKey, requireConfirm}`（不传 = 清除覆盖）；批量 `{rules:{chatKey:bool}, clear:[chatKey]}` 一次提交全部。ws-server 内部路由 `/chat-rule` |
| `POST /zhiliao/ws/user-delete` | **按接收用户删除**：清该用户的人设/群@规则，从连接记录里移除 receiverId：`{receiverId}` |

行为约定：

- **断开不删除**：连接记录保留，`connected:false` + `disconnectedAt`，刷新页面还能看到；
- **连几个显示几个**：列表按实际 WS 连接生成，不是按配置里的 clientId 预填；
- **连接只提供「断开」**：不删记录；**「删除」是针对用户**——清该用户的人设 / 群 @ 规则，
  连接记录里移除该 senderId，下次该用户发消息重新出现；
- 人设既可以用 WS 帧 `persona.set` 设置，也可以用设置页的 HTTP 接口，效果等价。

设置页「智聊」tab 有三张卡：服务连接（旧 webhook 配置）、WebSocket 长连接（IP / 端口 / clientId / token）、WS 连接列表。
**智聊面板里不再有「身份绑定 / 新增绑定」入口**，取而代之的是「WS 连接」列表和「群聊规则」卡片
（群 @ 开关在这里改），群 @ / 白名单改动对已连接客户端立即生效，不会把连接踢下线。

### 用户与工作空间

- **一个用户 = 一个 senderId = 一个 dsh 工作空间**：WS 入站会按 `senderId` 生成虚拟绑定
  （`userId=senderId`），`zhiliaoWorkDirFor()` 按 userId 建目录，不同用户的文件互不干扰；
- **一个会话 = 一个 chatKey = 一个 dsh 会话**：私聊 `direct:<a>:<b>`、群 `group:<id>`，
  同一会话上下文连续，跨会话隔离；
- **群 @ 规则按用户设置**：面板「用户与群聊规则」卡片列出所有发过消息的 senderId，
  逐人开关「群聊必须 @」；没单独设过才用连接级默认值。改完对已连接客户端立即生效，不会踢下线。

### 用户人设与 skill 压缩包

```http
POST /zhiliao/ws/user-persona
{ "receiverId": "u1", "name": "运维助手", "prompt": "只回答运维问题。",
  "skill": { "name": "skills.zip", "data": "<base64>" } }
```

- **人设按接收用户(receiverId)存**，该接收人下所有发送人的会话共用；改过 prompt 或换过 skill 包后下一条消息重新注入
- `skill` 可选；压缩包必须是合法 zip，解压到 `<DSH_HOME>/dsh-buddy-expert-hub/zhiliao/work/skills/<receiverId>/`
- 安全：纯 Node 读 zip 中央目录做 zip-slip 校验（拒绝绝对路径、盘符、`..`），单包上限 20MB
- 解压后把文件绝对路径写进人设块，agent 可用文件工具直接读
- 面板「用户与群聊规则」里每个用户有「设置人设」按钮，展开表单：名称 / prompt / skill 压缩包
- `GET /zhiliao/ws/users` 会回显 `persona:{name,prompt,skills,archive}`，方便表单回填

---

## 十、接收人 / 发送人与群聊规则

### 语义

dsh 是**接收人**一侧：外部用户（发送人）给 dsh 发消息，dsh 回复。

| 字段 | 含义 | 用途 |
|---|---|---|
| `chatKey` | `direct:<接收人ID>:<发送人ID>` / `group:<群ID>` | 会话键：一个 chatKey = 一个 dsh 会话 |
| `receiverId` / `receiverName` | 接收人（dsh 这一侧） | **工作区**按它划分，目录名用 `receiverName` |
| `senderId` / `senderName` | 发送人（外部用户） | **会话标题**用 `senderName`，如 `张三：你好` |
| `atList` | 本条消息 @ 到的用户 ID 列表 | 含 `receiverId` 即等价于 `atBot:true` |
| `groupName` | 群名称（群聊可选） | **群聊会话标题**用它，没有就用群 ID；私聊标题仍用发送人名称 |
| `atBot` | 兼容字段 | 与 `atList` 任一命中即可 |

`message.in` 示例：

```json
{ "type": "message.in", "requestId": "r1", "messageId": "m1",
  "chatKey": "group:g1", "receiverId": "u1", "receiverName": "我",
  "senderId": "u2", "senderName": "李四", "text": "@我 你看下",
  "atList": ["u1"], "atBot": true }
```

### 群聊行为

- **一个群 = 一个会话**：`group:<群ID>` 固定，上下文连续；
- **未 @ 时交给 AI 判断**：插件会在 prompt 前加「群聊消息，没有直接 @ 你，不需要接话就只输出 `[SKIP]`」，
  AI 输出 `[SKIP]` 时插件静默结束，不回投；
- **强制 @ 模式**：「接收用户 → 修改」里勾「群聊必须 @」后，未 @ 的消息直接拒收（`group-needs-mention`），默认关闭；
- **回复可 @ 多人**：AI 回复文本里写 `@<用户id>`，插件解析成 `atList` 随 `message.out` 下发，
  例如 `好的，@u2 你来看下，@u3 也一起` → `atList:["u2","u3"]`。

### 工作区与会话命名

- 工作区目录：`<DSH_HOME>/dsh-buddy-expert-hub/zhiliao/work/<接收人名称||接收人ID>/`
- 会话标题：私聊 `<发送人名称>：<摘要>`；群聊 `<群名称||群ID>：<摘要>`（避免群内不同发送人来回改标题）

### `/智聊` 指令（AI 结果投到会话）

三个入口，语法一致：

**A. dsh 命令面板**（输入 `/` 弹出列表，搜「智聊」）—— 插件通过 `ctx.inject(['commands'])`
注册斜杠命令，handler 直接调本地 `/push`：

```
/智聊 @u2 今天的日报已生成
/智聊 group:g1 @u2 发到指定群
```

- 智聊会话里**不用写 chatKey**（按 `agent.id` 反查），其他会话必须写目标；
- 返回 `{kind:'success', text:'已发送到 ...'}` 或 `{kind:'error', text:'...'}`。

**B. 智聊聊天窗口**（WS `message.in`，走回投通道）

**C. dsh 对话框里直接对 AI 说**（AI 自己 curl `/push`）

```
/智聊 帮我总结今天的待办
/智聊 @u2 @u3 同步一下进度
/智聊 group:g1 @u2 发到指定群
```

行为：

1. 指令前缀不参与 AI 输入，正文交给 AI；
2. AI 在**当前会话**里处理（上下文连续、人设生效）；
3. 处理完把结果投到目标会话——**不写目标就是当前会话**（dsh 对话框里 = 该会话对应的智聊 chatKey），
   写了 `group:xxx` / `direct:a:b` 就投到那个；
4. `@uid` 可写多个，随 `message.out.atList` 下发；
5. 正文为空或目标 chatKey 非法 → 不投递。

> **dsh 侧实现**：插件会把「推送命令 + 当前会话 chatKey + 管理令牌」写进会话的隐藏上下文。
>
> ⚠️ **Windows 乱码坑**：不要把中文直接写在 `curl -d '...'` 里——命令行按系统代码页（GBK）传参，
> 服务端按 UTF-8 解析就会变成 `???`。正确做法是先写 UTF-8 文件再 `--data-binary @文件`：
>
> ```bash
> # 1) 把请求体写成 UTF-8 文件 push.json
> # 2) 发送（命令里只有 ASCII）
> curl.exe -s -X POST http://127.0.0.1:18779/push \
>   -H "content-type: application/json" -H "x-admin-token: <令牌>" \
>   --data-binary @push.json
> ```
>
> - 智聊会话：chatKey 已自动填好，用户不用管；
> - 非智聊会话（如 dsh 面板新建的会话）：没有默认 chatKey，AI 会先向用户确认目标；
> - **最稳的是命令面板的 `/zhiliao` 命令**——插件内直接推送，完全不过命令行。
>
> **推送脚本（推荐给 AI 用）**：
>
> ```bash
> node ~/.dsh/dsh-buddy-expert-hub/zhiliao-push.mjs <chatKey> <正文文件> [@uid ...] [--image <图片路径>] [--mode binary|base64]
> ```
>
> - 正文从 UTF-8 文件读，命令行里只有 ASCII，中文不会乱码；
> - `--image` 会把图片/文件放进附件（png/jpg/gif/webp 自动识别 mime）；
> - `--mode binary`：走 `POST /push-binary`，body 是**原始字节**；服务端存到
>   `<BASE_DIR>/zhiliao/files/`，下发的附件带 `url`（`GET /file/<name>` 取原始字节）**且不带 base64 `data`**；
> - `--mode base64`（默认）：附件带 `data`（base64）；
> - 服务端两道护栏：`text` 含 `??` 回 `text-garbled`，`text` 是二进制回 `text-looks-binary`。
>
> **多文件一次推送**（`/zhiliao` 命令与脚本都走这条）：
>
> ```jsonc
> POST /push-binary?chatKey=group:g1
> content-type: application/json
> {
>   "chatKey": "group:g1",
>   "text": "发个图",
>   "atList": ["u2", "u3"],
>   "files": [
>     {"name": "a.png", "mime": "image/png", "data": "<base64>"},
>     {"name": "b.png", "mime": "image/png", "data": "<base64>"}
>   ]
> }
> ```
>
> 服务端把每个文件落盘转成 URL，然后**一次 `pushOut`** 下发：
>
> ```json
> {"type":"message.out","text":"发个图",
>  "attachments":[{"name":"a.png","mime":"image/png","bytes":70,"url":"http://host:port/file/f-xxx.png","mode":"binary"}, ...],
>  "atList":["u2","u3"]}
> ```
>
> 兼容：`/push-binary` 的 raw body 单文件模式（query 带 `chatKey/name/mime/textFile/at`）继续可用。
> `/push`（JSON + base64）继续可用；若该接收用户配了 binary，服务端会把附件自动转成 URL 形态。
>
> **附件文件保留期**：落在 `<BASE_DIR>/zhiliao/files/` 的文件按 mtime 清理，默认保留 **7 天**；
> 可在面板「WebSocket 长连接 → 附件保留天数」配置（1–365 天，**改后重启服务生效**）。
> 服务启动时清一次，之后按保留天数周期性清理（通过 `cleanupOldFiles()` 手动触发）。
> 超过 7 天的旧 URL 会失效，客户端若要长期留存请在收到后自行下载。

### 主动推送的约束

- **只投给在线客户端**：服务端遍历当前已鉴权的连接推送，对方没连就发不出去（不落库、不重试）。
  需要可靠送达，客户端应自己实现离线补拉（记住 chatKey 的本地游标）。
- **权限**：HTTP `/push` 需要请求头 `x-admin-token`（= 「WebSocket 客户端」卡片里的管理令牌，
  未单独设置时回落到内部共享密钥）；WS `push.send` 需要连接具备 `push` capability，
  且受 `chats.allow` 白名单约束。
- **@ 多人**：`atList` 支持一次 @ 多个用户，原样下发到 `message.out.atList`。
- **消息 id**：服务端生成 `p-` 前缀 id，回包里的 `messageId` 可用于日志对账。
- **典型用法**：定时任务跑完推日报、Agent 主动提醒、外部系统事件通知——都调这个接口即可。
