/**
 * zhiliao-server WebSocket 客户端。
 *
 * 优先使用运行时全局 WebSocket（Node 22 / Electron 44）；不可用时用 node:net/tls
 * 实现最小 RFC6455 客户端（文本帧、掩码、ping/pong、close），不引入 npm 依赖。
 *
 * 协议：
 *  客户端连上后发 {"type":"AUTH","apiKey":"sk_..."}
 *  服务端回 {"type":"AUTH_SUCCESS","userId":..,"aiId":..}
 *  心跳 {"type":"PING"} / {"type":"PONG"}
 *  下行 {"type":"MSG","convKey":"s_1_2","data":{...}}
 */

import net from 'node:net'
import tls from 'node:tls'
import { randomBytes } from 'node:crypto'

const HEARTBEAT_MS = 30000
const WATCHDOG_MS = 60000
const MAX_BACKOFF_MS = 5000
const SLOW_RETRY_MS = 5000

/**
 * 断线重连退避：快速重试 0.5s→1s→2s→3s→5s，之后保持 5s。
 * 服务器重启后能尽快恢复；认证失败（如 key 失效）也不会退到分钟级，
 * 用户重新填对 key 后能马上连上。
 */
export function backoffDelay(attempts) {
  const n = Math.max(1, Math.floor(Number(attempts) || 1))
  const steps = [500, 1000, 2000, 3000, 5000]
  return n <= steps.length ? steps[n - 1] : SLOW_RETRY_MS
}

function maskKey(apiKey) {
  const key = String(apiKey || '')
  if (key === '') return ''
  if (key.length <= 8) return '****'
  return key.slice(0, 3) + '****' + key.slice(-4)
}

function encodeFrame(opcode, payload) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload || ''), 'utf8')
  const len = data.length
  let header
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | len])
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  const mask = randomBytes(4)
  const masked = Buffer.alloc(len)
  for (let i = 0; i < len; i += 1) masked[i] = data[i] ^ mask[i % 4]
  return Buffer.concat([header, mask, masked])
}

/** 最小 RFC6455 客户端（仅在全局 WebSocket 不可用时使用）。 */
class NetWebSocket {
  constructor(url) {
    this.url = new URL(url)
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.handshaken = false
    this.closed = false
    this.onopen = null
    this.onmessage = null
    this.onclose = null
    this.onerror = null
  }

  connect() {
    const isTls = this.url.protocol === 'wss:'
    const port = Number(this.url.port || (isTls ? 443 : 80))
    const options = { host: this.url.hostname, port }
    this.socket = isTls ? tls.connect(options) : net.connect(options)
    this.socket.on('connect', () => this.sendHandshake())
    this.socket.on('data', (chunk) => this.onData(chunk))
    this.socket.on('close', () => this.finish())
    this.socket.on('error', (error) => {
      if (typeof this.onerror === 'function') this.onerror(error)
      this.finish()
    })
  }

  sendHandshake() {
    const key = randomBytes(16).toString('base64')
    const path = this.url.pathname || '/'
    const lines = [
      'GET ' + path + (this.url.search || '') + ' HTTP/1.1',
      'Host: ' + this.url.host,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: ' + key,
      'Sec-WebSocket-Version: 13',
      '',
      '',
    ]
    this.socket.write(lines.join('\r\n'))
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    if (!this.handshaken) {
      const end = this.buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      const headerText = this.buffer.slice(0, end).toString('latin1')
      this.buffer = this.buffer.slice(end + 4)
      if (!/^HTTP\/1\.1 101/i.test(headerText)) {
        if (typeof this.onerror === 'function') this.onerror(new Error('WebSocket handshake failed'))
        this.close()
        return
      }
      this.handshaken = true
      if (typeof this.onopen === 'function') this.onopen()
    }
    this.parseFrames()
  }

  parseFrames() {
    while (this.buffer.length >= 2) {
      const first = this.buffer[0]
      const second = this.buffer[1]
      const opcode = first & 0x0f
      const masked = (second & 0x80) !== 0
      let len = second & 0x7f
      let offset = 2
      if (len === 126) {
        if (this.buffer.length < 4) return
        len = this.buffer.readUInt16BE(2)
        offset = 4
      } else if (len === 127) {
        if (this.buffer.length < 10) return
        const big = this.buffer.readBigUInt64BE(2)
        if (big > BigInt(16 * 1024 * 1024)) { this.close(); return }
        len = Number(big)
        offset = 10
      }
      let mask = null
      if (masked) {
        if (this.buffer.length < offset + 4) return
        mask = this.buffer.slice(offset, offset + 4)
        offset += 4
      }
      if (this.buffer.length < offset + len) return
      let payload = this.buffer.slice(offset, offset + len)
      this.buffer = this.buffer.slice(offset + len)
      if (mask !== null) {
        const out = Buffer.alloc(payload.length)
        for (let i = 0; i < payload.length; i += 1) out[i] = payload[i] ^ mask[i % 4]
        payload = out
      }
      if (opcode === 0x01 && typeof this.onmessage === 'function') {
        this.onmessage({ data: payload.toString('utf8') })
      } else if (opcode === 0x09) {
        this.sendRaw(0x0a, payload)
      } else if (opcode === 0x08) {
        this.close()
        return
      }
    }
  }

  sendRaw(opcode, payload) {
    if (this.socket === null || this.closed) return false
    try {
      this.socket.write(encodeFrame(opcode, payload))
      return true
    } catch {
      return false
    }
  }

  send(text) {
    return this.sendRaw(0x01, text)
  }

  close() {
    if (this.closed) return
    this.closed = true
    try { this.socket?.end() } catch { /* ignore */ }
    this.finish()
  }

  finish() {
    if (this.closed !== true) this.closed = true
    try { this.socket?.destroy() } catch { /* ignore */ }
    if (typeof this.onclose === 'function') this.onclose()
  }
}

export class ZhiliaoWsClient {
  /**
   * @param {{url: string, apiKey: string, onMessage?: Function, onAuth?: Function, onStatus?: Function}} opts
   */
  constructor(opts) {
    const o = opts !== null && typeof opts === 'object' ? opts : {}
    this.url = String(o.url || '')
    this.apiKey = String(o.apiKey || '')
    this.onMessage = typeof o.onMessage === 'function' ? o.onMessage : () => {}
    this.onAuth = typeof o.onAuth === 'function' ? o.onAuth : () => {}
    this.onStatus = typeof o.onStatus === 'function' ? o.onStatus : () => {}
    this.socket = null
    this.stopped = false
    this.attempts = 0
    this.reconnectTimer = null
    this.heartbeatTimer = null
    this.watchdogTimer = null
    this.lastSeen = 0
    this.authenticated = false
  }

  connect() {
    if (this.stopped) return
    this.cleanupSocket()
    this.authenticated = false
    this.lastSeen = Date.now()
    const url = String(this.url || '').replace(/\/+$/, '') + '/ws'
    const useGlobal = typeof globalThis.WebSocket === 'function'
    try {
      if (useGlobal) {
        this.socket = new globalThis.WebSocket(url)
        this.socket.onopen = () => this.handleOpen()
        this.socket.onmessage = (event) => this.handleText(event.data)
        this.socket.onerror = () => { /* onclose 会处理重连 */ }
        this.socket.onclose = () => this.handleClose()
      } else {
        this.socket = new NetWebSocket(url)
        this.socket.onopen = () => this.handleOpen()
        this.socket.onmessage = (event) => this.handleText(event.data)
        this.socket.onerror = () => { /* onclose 会处理重连 */ }
        this.socket.onclose = () => this.handleClose()
        this.socket.connect()
      }
    } catch (error) {
      this.onStatus({ connected: false, authenticated: false, error: String((error && error.message) || error) })
      this.scheduleReconnect()
    }
  }

  handleOpen() {
    this.send({ type: 'AUTH', apiKey: this.apiKey })
    this.startHeartbeat()
    this.onStatus({ connected: true, authenticated: false, attempts: this.attempts })
  }

  handleText(raw) {
    this.lastSeen = Date.now()
    let frame = null
    try { frame = JSON.parse(String(raw || '')) } catch { return }
    if (frame === null || typeof frame !== 'object') return
    if (frame.type === 'AUTH_SUCCESS') {
      this.authenticated = true
      this.attempts = 0
      this.onAuth(frame)
      this.onStatus({ connected: true, authenticated: true, attempts: 0, userId: frame.userId, aiId: frame.aiId })
      return
    }
    // 认证失败（key 失效/被重置）：记录原因，供面板提示用户重新填 Key；仍继续重连
    if (frame.type === 'AUTH_FAIL') {
      this.authenticated = false
      const msg = String(frame.message || 'API Key 认证失败')
      this.onStatus({ connected: true, authenticated: false, authFailed: true, authError: msg, attempts: this.attempts })
      return
    }
    if (frame.type === 'PONG') return
    if (frame.type === 'MSG') {
      this.onMessage(frame)
    }
  }

  send(value) {
    if (this.socket === null) return false
    try {
      const text = typeof value === 'string' ? value : JSON.stringify(value)
      if (typeof this.socket.send === 'function') {
        this.socket.send(text)
        return true
      }
    } catch { /* ignore */ }
    return false
  }

  startHeartbeat() {
    this.clearHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this.send({ type: 'PING' })
    }, HEARTBEAT_MS)
    this.watchdogTimer = setInterval(() => {
      if (Date.now() - this.lastSeen > WATCHDOG_MS) {
        this.onStatus({ connected: false, authenticated: false, error: 'watchdog timeout' })
        this.closeSocket()
        this.scheduleReconnect()
      }
    }, 5000)
  }

  clearHeartbeat() {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer)
    if (this.watchdogTimer !== null) clearInterval(this.watchdogTimer)
    this.heartbeatTimer = null
    this.watchdogTimer = null
  }

  handleClose() {
    this.authenticated = false
    this.clearHeartbeat()
    this.onStatus({ connected: false, authenticated: false, attempts: this.attempts })
    this.scheduleReconnect()
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer !== null) return
    this.attempts += 1
    const delay = backoffDelay(this.attempts)
    this.onStatus({ connected: false, authenticated: false, attempts: this.attempts, retryInMs: delay, apiKey: maskKey(this.apiKey) })
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  cleanupSocket() {
    this.clearHeartbeat()
    try {
      if (this.socket !== null && typeof this.socket.close === 'function') this.socket.close()
    } catch { /* ignore */ }
    this.socket = null
  }

  closeSocket() {
    this.cleanupSocket()
  }

  stop() {
    this.stopped = true
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.cleanupSocket()
    this.onStatus({ connected: false, authenticated: false, stopped: true })
  }

  stats() {
    return {
      connected: this.socket !== null && this.authenticated === true,
      authenticated: this.authenticated,
      attempts: this.attempts,
      apiKeyMasked: maskKey(this.apiKey),
    }
  }
}

export { NetWebSocket, encodeFrame }

export default { ZhiliaoWsClient, NetWebSocket, encodeFrame }
