---
name: zhiliao-integration
description: "把你的聊天客户端接入 dsh 智聊（WebSocket 长连接）。用户要求接入自己的 IM/聊天工具、让 AI 把消息和文件推送到聊天客户端、排查连接不上或收不到消息时使用。提供连接鉴权、收发消息、文件传输、排障的完整步骤。"
description_zh: "接入自己的聊天客户端到 dsh 智聊：WS 连接、鉴权、收发消息与文件"
description_en: "Connect your own chat client to dsh Zhiliao via WebSocket: auth, messaging, files"
version: 1.0.0
allowed-tools: Read, Write, Edit, Bash, Grep, Glob
display_name: "智聊客户端接入"
display_name_en: "Zhiliao Client Integration"
---

# 智聊客户端接入

把**你自己的聊天客户端**（企业微信 / 飞书 / 自研 IM / 机器人）接入 dsh 智聊，让 AI 能把消息和文件推到你的聊天里。

原理：你的客户端**主动连** dsh 内置的 WebSocket 服务，首帧鉴权，之后双向收发 JSON 帧。
不依赖独立适配层，不需要身份绑定。

## 第一步：在 dsh 面板开启并配置

dsh → 设置 → Buddy 工作台 → 智聊 → 「WebSocket 长连接」卡片：

| 字段 | 填什么 |
|---|---|
| 启用 WS 长连接 | 勾选 |
| 监听 IP | 客户端和 dsh 同一台机器填 `127.0.0.1`；不同机器填 dsh 所在机器的局域网 IP（如 `192.168.50.180`） |
| 端口 | 默认 `18779` |
| clientId | 给客户端起个名字，如 `my-chat-bot`（鉴权用） |
| token | 填一个随机串（鉴权用，保存后只显示「已配置」） |
| 附件保留天数 | 默认 7 天，1–365 可配 |

点「保存 WS 设置」。**host/port/启用变化需要重启服务，clientId/token 改完立即生效。**

## 第二步：客户端连接

连 `ws://<监听IP>:<端口>/ws`（**路径必须是 `/ws`**）。

首帧发 auth：

```json
{"type":"auth","clientId":"my-chat-bot","token":"<你填的token>",
 "capabilities":["message.in","message.out","push","persona","attachment"]}
```

成功回 `{"type":"auth.ok", ...}`；失败回 `error` 帧 `code:"auth.failed"`。

**保活**：服务端每 30 秒主动发 WebSocket ping（opcode 0x9），客户端按协议回 pong 即可。只收不发、且不回 pong 的客户端会被断开。

## 第三步：收发消息

### 用户消息 → AI（客户端发 `message.in`）

```json
{
  "type": "message.in",
  "requestId": "m-001",
  "messageId": "m-001",
  "chatKey": "group:g1",
  "senderId": "u1",
  "senderName": "张三",
  "receiverId": "bot",
  "receiverName": "我的机器人",
  "text": "帮我查下今天的订单",
  "atBot": true,
  "atList": []
}
```

- `chatKey`：`group:<群ID>` 表示群聊，`direct:<对方>:<我方>` 表示私聊
- `atBot`：群里是否 @ 了机器人（面板勾了「群聊必须 @」时需要）
- 服务端回 `message.ack`，AI 处理完通过 `message.out` 回复

### AI 回复 → 客户端（收 `message.out`）

```json
{
  "type": "message.out",
  "messageId": "r-16b922c9-172",
  "chatKey": "group:g1",
  "text": "今天一共 42 单",
  "attachments": [],
  "atList": []
}
```

**带文件时**：

```json
{
  "type": "message.out",
  "text": "sql 文件发你了",
  "attachments": [
    {"name":"report.sql","mime":"application/octet-stream","bytes":128993,
     "url":"http://192.168.50.180:18779/file/f-mx05555h-1b78edb2.sql","mode":"binary"}
  ]
}
```

- `attachments[].name` 是**真实文件名**，直接拿来展示
- `mode:"binary"` → 用 `GET url` 拿原始字节；没有这个字段时附件带 `data`（base64）
- **URL 有保留期**（默认 7 天），要长期保存请收到后自行下载

## 第四步（可选）：让 AI 主动推送

不经过用户消息，直接让 AI 推一条：

```bash
node ~/.dsh/dsh-buddy-expert-hub/zhiliao-push.mjs <chatKey> <正文文件> [@uid ...] [--image <图片路径>]
```

正文写进 UTF-8 文件再传，避免命令行中文乱码。返回 JSON 里 `delivered:true` 表示有客户端收到。

也可以在 dsh 里用斜杠命令发：

```
/zhiliao @u2 发个图
```

直接拖图片/文件到输入框即可。

## 接收用户配置（面板「接收用户」卡片）

客户端发过消息后，会自动出现在「接收用户」列表，点「修改」可设：

- 人设 / skill 压缩包
- AI 推送文件的方式：`binary`（URL，体积小）或 `base64`
- 群聊是否必须 @ 机器人
- 发送消息是否需要用户确认（用户默认 + 会话级覆盖）

## 排障

| 现象 | 检查 |
|---|---|
| 连不上 `/ws` | 路径必须是 `/ws`；用 `netstat -ano \| findstr 18779` 看实际监听地址 |
| `auth.failed` | clientId / token 和面板填的不一致 |
| 收不到 `message.out` | 面板「在线连接」是否显示你的客户端；没显示就是没鉴权成功 |
| 客户端连上又断 | 是否在回 pong；服务端空闲 30 秒发 ping，180 秒无响应才断 |
| 收到 base64 不是 URL | 该接收用户的 fileMode 配成了 base64，在面板改 |
| 附件 URL 404 | 超过「附件保留天数」被清理 |
| 推送返回 `no-client-online` | 服务正常，只是没有在线客户端；让用户先连上 |

## 完整协议文档

更详细的帧格式、管理接口、命令附件实现见插件内文档：

- `docs/zhiliao-integration.md` —— 接入指南（配置、接口、排障）
- `docs/zhiliao-ws-protocol.md` —— WS 协议细节
- `docs/zhiliao-command-attachments.md` —— 命令带附件的实现与踩坑
