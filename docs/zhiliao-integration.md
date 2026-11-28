---
description: "dsh-buddy-expert-hub 智聊（WebSocket 长连接）功能接入指南：配置、连接、鉴权、收发消息、发文件、面板接口。"
kind: "integration-guide"
---

# 智聊功能接入指南

> 面向：IM 客户端开发者、需要调用智聊推送的 AI / 脚本、二次开发者。
> 插件版本基线：**2.1.101**。
> 实现细节与踩坑记录见 [`zhiliao-command-attachments.md`](./zhiliao-command-attachments.md)。

## 0. 一句话理解

聊天工具（IM 客户端）**主动连** dsh 内置的 WebSocket 服务，完成 auth 后即可双向收发 JSON 帧；
dsh 侧由插件负责鉴权、权限、人设注入和把消息交给 AI。不依赖独立适配层，不需要身份绑定。

---

## 1. 开启与配置

入口：dsh → 设置 → Buddy 工作台 → 智聊 tab → 「WebSocket 长连接」卡片。

| 字段 | 说明 | 默认 |
|---|---|---|
| 启用 WS 长连接 | 总开关 | 关 |
| 监听 IP | 服务绑定地址，局域网客户端填本机 IP | `127.0.0.1` |
| 端口 | WS 监听端口 | `18779` |
| clientId | 客户端标识，auth 时用 | 空 |
| token | 客户端密钥（不回显明文，留空保持原值） | 空 |
| 附件保留天数 | 1–365，改后需重启服务 | `7` |

保存后服务随插件启动；`host/port/启用/adminToken` 变化才重启 WS 服务，`clientId/token/群@/白名单` 动态生效。

**幂等提示**：服务绑非回环地址（如 `192.168.50.180`）时，会自动在 `127.0.0.1:<port>` 开一个 TCP 代理转发，
所以本机脚本写死回环地址也能用。

---

## 2. 连接与鉴权

### 2.1 建连

```
ws://<host>:<port>/ws
```

**路径必须是 `/ws`**，其它路径直接 404。

### 2.2 首帧 auth

```json
{"type":"auth","clientId":"wecom-bot","token":"<面板配置的 token>",
 "capabilities":["message.in","message.out","push","persona","attachment"]}
```

服务端回：

```json
{"type":"auth.ok","clientId":"wecom-bot","serverTime":1795829141178,
 "permissions":{"message.in":true,"message.out":true,"push":true,"persona":true,"attachment":true}}
```

失败回 `error` 帧 `code: "auth.failed"` 并断开。同一 clientId 只保留一条记录，重连会复用。

### 2.3 保活

- 服务端**主动发 ping**（空闲 30s，标准 opcode `0x9`），客户端按 WebSocket 协议自动回 pong
- 超过 180s 没收到任何帧才断开
- **客户端不要只收不发且不处理 ping**，否则会被剔除

---

## 3. 收发消息

### 3.1 客户端 → dsh：`message.in`

```json
{
  "type": "message.in",
  "requestId": "m-123",
  "messageId": "m-123",
  "chatKey": "group:g1",
  "senderId": "u1",
  "senderName": "张三",
  "receiverId": "bot",
  "receiverName": "机器人",
  "text": "帮我发个图",
  "atList": ["bot"],
  "attachments": []
}
```

服务端回 `message.in.ack`，AI 处理完后通过 `message.out` 回复。

### 3.2 dsh → 客户端：`message.out`

```json
{
  "type": "message.out",
  "ts": 1795830811205,
  "messageId": "p-620798a1-96a",
  "chatKey": "group:g1",
  "text": "发个图",
  "attachments": [
    {"name":"icon.png","mime":"image/png","bytes":2482,
     "url":"http://192.168.50.180:18779/file/f-mwzs0y49-809bd29d.png","mode":"binary"}
  ],
  "atList": []
}
```

**附件两种形态**：

| 配置 | 字段 | 客户端处理 |
|---|---|---|
| `base64` | `data`（base64 字符串） | 自己解码 |
| `binary`（默认推荐） | `url` + `mode:"binary"`，**无 `data`** | `GET url` 拿原始字节 |

**发送前确认（requireConfirm）** 支持两级：

| 级别 | 设置位置 | 优先级 |
|---|---|---|
| 会话级 | 面板「接收用户 → 修改 → 会话级覆盖」：下拉选会话 → 选状态，可连续设置多个，**点保存一起生效** | 高 |
| 用户默认 | 面板「接收用户 → 修改 → 发送消息需要用户确认」 | 低（回退） |

会话没设覆盖时跟随用户默认；设了覆盖（含 false）以会话为准。`message.in` 转发的 `requireConfirm`
字段就是最终生效值（会话优先、用户回退）。

下载接口：`GET|HEAD /file/<name>`，返回 `content-type` 按 mime、`cache-control: no-store`。
存储名保持随机格式 `f-<时间戳>-<随机><扩展名>`（URL 不变）；**真实文件名在 `attachments[].name` 里**，
中文文件名也会保留。**URL 有保留期（默认 7 天），过期 404**，要长期留存请收到后自行下载。

---

## 4. 主动推送（不经过 AI）

### 4.1 AI 最终回复内联文件（首选）

让 AI 在**给用户的最终回复正文**里另起一行写：

```
MEDIA: C:/Users/zzx/Desktop/report.sql
```

服务端会把该文件作为附件，**随这条回复一次下发**（正文里 MEDIA 行会被剥掉）：

```json
{"type":"message.out","text":"sql文件发你了，收一下",
 "attachments":[{"name":"report.sql","url":"http://host:port/file/f-xxx.sql","mode":"binary"}]}
```

- 可多行写多个 `MEDIA:` 行；路径后**紧跟正文也可以**（如 `MEDIA: C:/a.sql在，收下`），
  服务端会用「最长存在文件」回退匹配把路径切出来；  **MEDIA 行及之前的是 AI 铺垫，不发给用户**，只保留路径后面的那一句作为正文；
  如果路径后面没写字，则回退保留 MEDIA 前那句（正文不会为空）
- 允许路径：桌面 / 下载 / 文档 / 临时目录 / 智聊工作目录（其它路径会被拒绝并保留原文）
- 配了 binary 的用户自动转 URL；配 base64 则带 `data`
- **不要**再调脚本单独推一遍，否则客户端会收到两条（一条脚本推送 + 一条最终回复）

### 4.2 用推送脚本（文件不在允许路径或超限时）

```bash
node ~/.dsh/dsh-buddy-expert-hub/zhiliao-push.mjs <chatKey> <正文文件> [@uid ...] \
  [--image <图片路径>] [--mode binary|base64]
```

- 正文从 **UTF-8 文件**读，命令行里只有 ASCII，中文不会乱码
- `--image` 可重复传多个文件
- `--mode binary`：服务端落盘下发 URL；`--mode base64`：附件带 data
- 返回 JSON：

```json
{"ok":true,"delivered":true,"sent":1,"mode":"binary",
 "url":"http://192.168.50.180:18779/file/f-xxx.png","messageId":"p-..."}
```

| 字段 | 含义 |
|---|---|
| `ok` | 接口受理成功 |
| `delivered` | 是否有在线客户端收到 |
| `sent` | 实际送达连接数 |
| `warning: "no-client-online"` | **服务正常**，只是没有在线客户端；不要重试、不要说服务挂了 |

### 4.3 用斜杠命令（面板里带附件）

```
/zhiliao @u2 发个图
```

直接拖图片/文件到输入框即可。命令声明了 `input.attachments: true`，宿主允许带附件。
多文件会在**一条** `message.out` 里下发。

其它写法：

```
/zhiliao group:g1 日报见附件 --file C:/Windows/Temp/report.pdf --mode binary
/zhiliao @u2 @u3 请查收        # 多人 @
```

### 4.4 直接调 HTTP（高级）

```http
POST /push-binary?chatKey=group:g1
content-type: application/json
x-admin-token: <host.json 里的 adminToken>

{"chatKey":"group:g1","text":"发个图","atList":["u2"],
 "files":[{"name":"a.png","mime":"image/png","data":"<base64>"},
          {"name":"b.png","mime":"image/png","data":"<base64>"}]}
```

服务端逐个存盘 → URL → **一次** `pushOut`。

单文件 raw 模式仍兼容：

```http
POST /push-binary?chatKey=group:g1&name=a.png&mime=image/png&textFile=C:/tmp/body.txt
content-type: application/octet-stream
<body: 原始字节>
```

`POST /push` 是 base64 模式（附件带 `data`）；若接收用户配了 binary，服务端会自动转成 URL。

---

## 5. 管理 HTTP 接口

面板路径前缀 `<插件 webServer>`，服务端路径前缀 `ws://host:port`（HTTP 同端口）。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/zhiliao/status` | 状态概览（不回密钥） |
| GET/POST | `/zhiliao/settings` | 读/写配置（密钥只回是否已配置） |
| GET | `/zhiliao/ws/connections` | 在线连接列表 |
| DELETE | `/zhiliao/ws/connections?id=` | 断开指定连接 |
| GET | `/zhiliao/ws/users` | 接收用户列表（含 fileMode 配置） |
| POST | `/zhiliao/ws/user-rule` | 用户默认规则（fileMode / requireMention / requireConfirm） |
| POST | `/zhiliao/ws/chat-rule` | 会话级 requireConfirm。单条 `{chatKey, requireConfirm}`（不传 = 清除覆盖）；批量 `{rules:{chatKey:bool}, clear:[chatKey]}`，一次提交全部生效 |
| POST | `/zhiliao/ws/user-persona` | 用户级人设 |
| POST | `/zhiliao/ws/persona` | 全局人设 |
| POST | `/zhiliao/ws/push` | base64 推送 |
| POST | `/zhiliao/ws/push-binary` | 二进制推送 |

鉴权：管理接口需 `x-admin-token`，令牌从 `host.json` 的 `adminToken` 取（**不要从 state 读**）。

---

## 6. 故障速查

| 现象 | 原因 / 处理 |
|---|---|
| 连不上 `/ws` | 路径必须是 `/ws`；检查 host/port 是否监听正确地址 |
| `auth.failed` | clientId 未登记或 token 不匹配 |
| `fetch failed` / `ECONNREFUSED` | 地址写死回环但服务绑局域网 IP；用 `/push-binary` 的 helper 或走回环代理 |
| `no-client-online`、`sent:0` | **服务正常**，没有在线客户端，让用户先连 WS |
| 收到 base64 而不是 url | 该接收用户 fileMode 是 base64；在「接收用户」里改 |
| 只收到一个附件 | 老版本 bug，2.1.79+ 已修为一条消息多附件 |
| 附件 URL 404 | 超过 `fileRetainDays`，被 mtime 清理 |
| 客户端连上又断 | 看 `ws-audit.jsonl` 的 `close.reason` / `lastSeenMsAgo` |
| 面板 `ws-service-unreachable` | 某个面板代理地址写死回环，grep 检查 |
| `/{cmd} 不接受附件` | 命令没声明 `input.attachments: true` |

审计日志：`<BASE_DIR>/zhiliao/ws-audit.jsonl`（尾部 200 行）。

---

## 7. 相关文件

| 文件 | 作用 |
|---|---|
| `docs/zhiliao-ws-protocol.md` | WS 帧协议细节 |
| `docs/zhiliao-command-attachments.md` | 命令带附件的实现与踩坑 |
| `lib/zhiliao-ws-server.js` | WS 服务、鉴权、推送、文件落盘与清理 |
| `lib/index.js` | 命令注册、`zhiliaoWsBaseUrl`、面板代理、推送脚本模板 |
| `lib/client.js` | 设置页面板 |
| `_harness/zhiliao-e2e-mock.mjs` | 主链路回归（82 项） |
| `_harness/zhiliao-ws.mjs` | WS 服务回归（51 项） |

## 8. 给使用者的接入 Skill

插件包内附带了一个**面向使用者**的 Skill：

```
skills/zhiliao-integration/SKILL.md
```

用户可以引用这个 Skill，让 AI 按标准流程把自己的聊天客户端接进来（配置面板 → WS 连接鉴权 →
收发消息 → 文件传输 → 排障），不需要读源码。Skill 随 npm 包一起发布（`package.json` 的 `files` 含 `skills/**`）。

> **维护约定**：改上述代码时，必须同步更新本文档、`docs/zhiliao-command-attachments.md`、
> `docs/zhiliao-ws-protocol.md`、项目内开发者 Skill `.workbuddy/skills/zhiliao-integration/SKILL.md`，
> 以及随包发布的用户 Skill `skills/zhiliao-integration/SKILL.md`。
