---
description: "斜杠命令带附件传输（/zhiliao 发图/发文件）的实现方法、踩坑记录与复查清单。"
kind: "implementation-note"
---

# 斜杠命令带附件传输：实现与踩坑记录

> 适用场景：插件注册 dsh 斜杠命令，命令需要接收 composer 拖入的图片/文件，
> 并把附件以「二进制 URL」形态投给外部 IM 客户端。
> 这是 **v5.45–v5.79 连续踩坑后的定稿**，下次做同类功能按本文复查，别再逐个试错。

## 一、最终架构（一条消息，多个附件）

```
用户拖附件 + /zhiliao @u2 发个图
        │
        ▼  宿主 dsh-commands 准入（input.attachments === true）
invocation.attachments = [ImageBlock | FileBlock, ...]
        │
        ▼  handler 用 ctx.attachments 把持久引用解析成字节
tasks = [{name, buf}, ...]
        │
        ▼  一次 POST /push-binary（JSON 多文件）
服务端逐个落盘 → 换成 URL → 一次 pushOut
        │
        ▼  WS 推给在线客户端
{"type":"message.out","text":"发个图","attachments":[
  {"name":"a.png","mime":"image/png","bytes":70,"url":"http://host:port/file/f-xxx.png","mode":"binary"}, ...]}
```

**关键原则**：正文和所有附件在**同一条** `message.out` 里，不拆多条。

---

## 二、命令注册（宿主侧）

### 2.1 官方字段是 `input.attachments`

来源：`deepseek-ai/deepseek-harness`

- `packages/client/ui-commands/src/client/service.ts`：

```ts
if (envelope.attachments > 0 && desc.input.attachments !== true) refuseAttachments()
```

- `docs/subsystems/commands.zh.md`：

```ts
interface CommandInputDescriptor {
  readonly hint: string
  readonly attachments?: boolean   // ← 就是这个
}
```

**错误写法**（我一开始全试过，宿主一律不认，报 `/{command} 不接受附件，请先移除附件`）：

```js
acceptsAttachments: true,   // ❌ 顶层
attachments: true,          // ❌ 顶层
```

**正确写法**：

```js
const def = {
  name: 'zhiliao',
  description: '把内容发送到智聊会话',
  input: {
    hint: '[@uid ...] 正文，或直接拖图片/文件',
    attachments: true,       // ✅ 官方字段
  },
  handler: (invocation) => run(invocation),
}
```

### 2.2 invocation 里的附件结构

```ts
interface CommandInvocation {
  readonly rawInput: string
  readonly attachments: readonly (ImageBlock | FileBlock)[]
  readonly agent: Agent
  readonly signal: AbortSignal
}
interface FileBlock { type: 'file'; attachment: FileAttachmentRef }
interface ImageBlock { type: 'image'; attachment: ImageAttachmentRef }
```

**注意**：`FileBlock` 给的是**持久引用**，不是字节，也不是本地路径。

---

## 三、读取附件字节（cordis 附件服务）

### 3.1 服务访问：必须 inject，且回调参数是 Context

源码 `packages/attachment/attachment/src/index.ts`：

```ts
declare module '@deepseek-ai/cordis' {
  interface Context { attachments: AttachmentStore }
}
```

三个坑，逐个踩过：

| 写法 | 报错 | 原因 |
|---|---|---|
| 裸读 `ctx.attachments` | `cannot get property "attachments" without inject` | cordis 要求先声明 inject |
| `ctx.inject(['attachments'], svc => zhiliaoAttachments = svc)` | `cannot get property "readFileStream" without inject` | **回调参数是注入后的 Context，不是服务** |
| ✅ `ctx.inject(['attachments'], scope => zhiliaoAttachments = scope.attachments)` | — | 正确 |

**定稿**：

```js
let attachmentSvc = null
ctx.inject(['attachments'], (scope) => {
  attachmentSvc = scope !== null && scope !== undefined && scope.attachments !== null
    && scope.attachments !== undefined ? scope.attachments : null
})
```

### 3.2 三级读取兜底

`FileAttachmentRef` 未必能拿到主机路径，按下面顺序读：

```js
// ① 主机路径（同步方法，用 await 包以兼容 Promise 风格的包装）
let hp = ''
if (typeof svc.fileHostPath === 'function') hp = String((await svc.fileHostPath(ref)) || '')
if (hp === '' && typeof svc.imageHostPath === 'function') hp = String((await svc.imageHostPath(ref)) || '')
if (hp !== '' && fs.existsSync(hp)) buf = fs.readFileSync(hp)

// ② 官方流式读取（任何后端都支持）
if (!Buffer.isBuffer(buf) && typeof svc.readFileStream === 'function') {
  const chunks = []
  for await (const chunk of svc.readFileStream(ref)) chunks.push(Buffer.from(chunk))
  if (chunks.length > 0) buf = Buffer.concat(chunks)
}

// ③ 图片：readImage 返回 verified bytes
if (!Buffer.isBuffer(buf) && typeof svc.readImage === 'function') {
  const stored = await svc.readImage(ref)
  if (stored && stored.data) buf = Buffer.isBuffer(stored.data) ? stored.data : Buffer.from(stored.data)
}
```

**必须校验**：拿不到字节时**不要读 `.length`**。我踩过 `buf: null` 导致 `Cannot read properties of null (reading 'length')`，
异常冒到网关被包装成 `gateway/internal`，排查方向全错。直接返回明确错误：

```js
if (!Buffer.isBuffer(task.buf)) {
  return { kind: 'error', text: '附件只有引用，拿不到文件字节；请用 --file <本地路径> 发送' }
}
```

---

## 四、推送链路

### 4.1 地址：绝不写死 127.0.0.1

服务可能绑在局域网地址（`ws.host = 192.168.50.180`），写死回环会 `ECONNREFUSED` → AI 看到 `fetch failed` 就误判「服务挂了」。

统一 helper（`lib/index.js:zhiliaoWsBaseUrl`）：

```js
function zhiliaoWsBaseUrl(cfg) {
  const z = cfg?.ws ?? cfg
  const host = z?.host || '127.0.0.1'
  const port = z?.port || 18779
  const safe = host === '0.0.0.0' || host === '' || host === '::' ? '127.0.0.1' : host
  return `http://${safe}:${port}`
}
```

**所有**面板代理和脚本都要用它。曾经只改了 `/push`、`/users` 两处，漏了 `/connections`、`/user-rule`、
`/user-persona`、`/persona`、`/internal/reply`、`baseUrl` 和批量循环，共 8 处，导致面板一直 `ws-service-unreachable`。

另外服务端在非回环 host 下会额外开一个 `127.0.0.1:PORT` TCP 代理转发，兜住 AI 自己生成 curl 时写死的回环地址。

### 4.2 令牌：从 host.json 取，不从 state 取

`internalSecret` 有默认常量值但 `state.json` 里可能是空的，脚本读 state 会拿到空 token → 403。
`zhiliaoClaimHostLock()` 把实际生效的 `adminToken` 写进 `host.json`，脚本和命令都从这里读（`zhiliaoAdminToken()`）。

### 4.3 一次请求带全部附件

```http
POST /push-binary?chatKey=group:g1
content-type: application/json
x-admin-token: <token>

{
  "chatKey": "group:g1",
  "text": "发个图",
  "atList": ["u2", "u3"],
  "files": [
    {"name":"a.png","mime":"image/png","data":"<base64>"},
    {"name":"b.png","mime":"image/png","data":"<base64>"}
  ]
}
```

服务端逐个存盘 → 换成 URL → **一次** `pushOut`。raw body 单文件模式保留兼容。

**正文中文**：命令里的正文是字符串，不能直接塞 query。写入 UTF-8 临时文件后传 `textFile`；
或走 JSON 模式的 `text` 字段。正文只挂第一条，避免重复。

### 4.4 附件形态由用户配置决定

「接收用户 → 修改 → AI 推送文件的方式」：

- `base64`：附件带 `data`
- `binary`：附件带 `url` + `mode:"binary"`，**无 `data`**

服务端 `/push` 有兜底：若接收用户配了 binary，收到 base64 附件也会落盘转 URL。
群聊拿不到 receiverId 时用「任一用户配了 binary」兜底（内存映射 `chatOwners` 不可靠）。

---

## 五、文件生命周期与连接保活

- **落盘目录**：`<BASE_DIR>/zhiliao/files/`，文件名 `f-<ts>-<rand><ext>`
- **下载**：`GET|HEAD /file/<name>`，`content-type` 按 mime，`no-store`，防路径穿越
- **清理**：按 mtime 保留 N 天（默认 7，面板可配 1–365），启动时清一次 + 周期清理；
  `close()` 里清定时器。**超过保留期的 URL 会 404**
- **WS 保活**：服务端必须**主动发 ping**（空闲 30s，opcode 0x9），否则只收不发的客户端会在
  90s 后被心跳踢掉（表现为「发图后断连」）。超时放宽到 180s
- **审计**：`<BASE_DIR>/zhiliao/ws-audit.jsonl`（尾 200 行），`close` 记 reason/lastSeenMsAgo/chatKey

---

## 六、复查清单（下次做同类功能逐条过）

- [ ] 命令定义用 `input.attachments: true`，不是顶层字段
- [ ] inject 回调里取 `scope.attachments`，不是把回调当服务
- [ ] 附件 ref 走三级读取，读不到字节时**不碰 `.length`**
- [ ] 所有 HTTP 调用走 `zhiliaoWsBaseUrl(cfg)`，grep 确认没有写死的 `127.0.0.1:<port>`
- [ ] 罗列表：`/connections`、`/user-rule`、`/user-persona`、`/persona`、`/internal/reply`、`baseUrl`、批量循环 —— 全查
- [ ] 多附件一次 POST、一条 `message.out`，正文和 @ 只挂第一条
- [ ] 中文正文走 UTF-8 文件或 JSON `text`，不经命令行
- [ ] binary / base64 两种配置都测；群聊场景单独测（receiverId 拿不到）
- [ ] 附件文件有保留期和清理；客户端知道 URL 会过期
- [ ] WS 服务端主动 ping；只收不发的客户端 40s 存活测试
- [ ] 运行 `_harness/zhiliao-e2e-mock.mjs`、`_harness/zhiliao-ws.mjs`、`npm run check`

## 七、排障速查

| 现象 | 根因 | 查法 |
|---|---|---|
| `/{cmd} 不接受附件，请先移除附件` | 没声明 `input.attachments` | 看命令 def |
| `cannot get property "X" without inject` | 裸读服务 / 回调参数用错 | 改成 `ctx.inject([...], scope => scope.X)` |
| `gateway/internal: ... reading 'length'` | 自己 handler 里 null.length | 先查自己的 Buffer 校验 |
| `fetch failed` | 地址写死回环，服务绑在局域网 IP | `netstat -ano \| grep <pid>` 看实际监听 |
| 403 / 空 token | 从 state 读 secret，实际值在 host.json | 看 `zhiliaoAdminToken()` |
| 面板 `ws-service-unreachable` | 漏改某个代理的地址 | grep `127.0.0.1:' + String(*.ws.port)` |
| 只收到一个附件 | 只处理了 `tasks[0]` | 检查是否一次 pushOut 带全量 |
| 收到 base64 而不是 url | 该用户 fileMode 不是 binary / 群聊兜底没命中 | 看 `/users` 的 fileMode |
| 发完图客户端断连 | 服务端没主动 ping，心跳超时 | 看 `ws-audit.jsonl` 的 `lastSeenMsAgo` |
| 旧下载 URL 404 | 超过保留期被清理 | 看 `fileRetainDays` |
