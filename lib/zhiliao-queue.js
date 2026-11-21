/**
 * dsh-buddy-expert-hub — 智聊分区串行队列 + 全局并发闸（阶段 3）。
 *
 * 设计目标（对应方案 4C）：
 *  - **同 chatKey 严格串行**：一个私聊对 / 一个群各自一条 FIFO，busy 标记保证
 *    同会话不会出现两个 turn 交错（dsh 会话上下文是单线程的）；
 *  - **区内按 seq 升序**：HuLa 的 seq 是 createTime 毫秒，乱序到达也按消息时间处理；
 *    没有 seq 的消息按到达顺序排在带 seq 的之后，避免它们插队；
 *  - **全局并发闸**：同时最多 N 个 turn（默认 16），超出在各自区内排队；
 *  - **背压而非丢消息**：每 chatKey 默认 20 条、全局默认 1000 条，满了 enqueue
 *    返回 not-accepted，由调用方转 HTTP 429，让 HuLa 按阶段 1 的退避重试；
 *  - **异常不卡队列**：任务用 Promise.finally 释放 busy 与并发槽位，任务抛错不会
 *    让某个 chatKey 永久 busy。
 *
 * 纯内存、零依赖；不做持久化（崩溃重放由 dedupe + HuLa 重试兜底，见阶段 3 说明）。
 *
 * @module dsh-buddy-expert-hub/zhiliao-queue
 */

/** 把配置值收敛到安全整数区间。 */
function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

/**
 * 智聊分区串行队列。
 */
export class ZhiliaoQueue {
  /**
   * @param {{maxConcurrent?: number, perKeyLimit?: number, globalLimit?: number}} [options] 队列参数
   */
  constructor(options) {
    const opts = options !== null && typeof options === 'object' ? options : {}
    this.maxConcurrent = clampInt(opts.maxConcurrent, 1, 256, 16)
    this.perKeyLimit = clampInt(opts.perKeyLimit, 1, 10000, 20)
    this.globalLimit = clampInt(opts.globalLimit, 1, 100000, 1000)
    /** close() 时对每个未执行任务回调一次（用于把 dedupe 标 failed，让上游重试）。 */
    this.onDiscard = typeof opts.onDiscard === 'function' ? opts.onDiscard : null
    /** @type {Map<string, {items: Array<{task: Function, seq: number|null, order: number}>, busy: boolean}>} */
    this.partitions = new Map()
    this.queued = 0
    this.inflight = 0
    this.arrival = 0
    this.idleWaiters = []
    this.closed = false
    this.pumpScheduled = false
  }

  /**
   * 区间内排序：都有 seq 按 seq；带 seq 的排在无 seq 之前；都无 seq 按到达顺序。
   * @param {{seq: number|null, order: number}} a 条目 a
   * @param {{seq: number|null, order: number}} b 条目 b
   * @returns {number} 排序值
   */
  static compare(a, b) {
    if (a.seq !== null && b.seq !== null) {
      if (a.seq !== b.seq) return a.seq - b.seq
      return a.order - b.order
    }
    if (a.seq !== null) return -1
    if (b.seq !== null) return 1
    return a.order - b.order
  }

  /**
   * 入队一个任务。
   * @param {string} chatKey 分区键
   * @param {Function} task 无参异步任务
   * @param {{seq?: number}} [meta] 元数据（seq 用于区内排序）
   * @returns {{accepted: true, position: number}|{accepted: false, reason: string}} 入队结果
   */
  enqueue(chatKey, task, meta) {
    if (typeof task !== 'function') throw new TypeError('task 必须是函数')
    if (this.closed) return { accepted: false, reason: 'closed' }
    if (this.queued + this.inflight >= this.globalLimit) return { accepted: false, reason: 'global-limit' }
    const key = String(chatKey || '')
    let part = this.partitions.get(key)
    if (part === undefined) {
      part = { items: [], busy: false }
      this.partitions.set(key, part)
    }
    if (part.items.length >= this.perKeyLimit) return { accepted: false, reason: 'key-limit' }
    const metaObject = meta !== null && typeof meta === 'object' ? meta : {}
    const seq = Number(metaObject.seq)
    const item = { task, seq: Number.isFinite(seq) ? seq : null, order: this.arrival++, meta: metaObject }
    // 二分插入，保持区内有序（避免大 key 全量 sort）。
    let lo = 0
    let hi = part.items.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (ZhiliaoQueue.compare(part.items[mid], item) <= 0) lo = mid + 1
      else hi = mid
    }
    part.items.splice(lo, 0, item)
    this.queued += 1
    const position = lo + 1
    this.schedulePump()
    return { accepted: true, position }
  }

  /**
   * 延后到微任务再调度：同一批同步入队（例如一次 webhook 突发）全部落位后再排序取任务，
   * 否则第一条会在后到的更小 seq 入队前就开跑，区内排序失效。
   * @returns {void}
   */
  schedulePump() {
    if (this.pumpScheduled === true || this.closed === true) return
    this.pumpScheduled = true
    queueMicrotask(() => {
      this.pumpScheduled = false
      this.pump()
    })
  }

  /**
   * 调度：在并发闸内按分区取下一个可执行任务。
   * @returns {void}
   */
  pump() {
    if (this.closed) return
    while (this.inflight < this.maxConcurrent) {
      let pickedKey = ''
      let pickedPart = null
      for (const [key, part] of this.partitions) {
        if (part.busy !== true && part.items.length > 0) {
          pickedKey = key
          pickedPart = part
          break
        }
      }
      if (pickedPart === null) break
      const item = pickedPart.items.shift()
      this.queued -= 1
      this.inflight += 1
      pickedPart.busy = true
      Promise.resolve()
        .then(() => item.task())
        .catch((error) => {
          // 任务自身负责记账；这里只保证队列不死，并把 chatKey/msgId/原因留进日志。
          const msgId = item.meta !== null && typeof item.meta === 'object' ? String(item.meta.msgId || '') : ''
          // eslint-disable-next-line no-console
          console.warn('[zhiliao-queue] 任务执行失败 chatKey=' + pickedKey + ' msgId=' + msgId + '：'
            + String((error !== null && typeof error === 'object' && error.message) || error))
        })
        .finally(() => {
          pickedPart.busy = false
          this.inflight -= 1
          if (pickedPart.items.length === 0) this.partitions.delete(pickedKey)
          this.schedulePump()
          this.notifyIdle()
        })
    }
  }

  /** 唤醒所有等待队列清空的 drain() 调用者。 */
  notifyIdle() {
    if (this.inflight !== 0 || this.queued !== 0) return
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const resolve of waiters) resolve()
  }

  /**
   * 等队列彻底清空（测试 / 优雅退出用）。
   * @returns {Promise<void>} 清空时 resolve
   */
  drain() {
    if (this.inflight === 0 && this.queued === 0) return Promise.resolve()
    return new Promise((resolve) => { this.idleWaiters.push(resolve) })
  }

  /**
   * 队列观测快照。
   * @returns {{activeChatKeys: number, queued: number, inflight: number, maxConcurrent: number, perKeyLimit: number, globalLimit: number}} 统计
   */
  stats() {
    let activeChatKeys = 0
    for (const part of this.partitions.values()) {
      if (part.busy === true || part.items.length > 0) activeChatKeys += 1
    }
    return {
      activeChatKeys,
      queued: this.queued,
      inflight: this.inflight,
      maxConcurrent: this.maxConcurrent,
      perKeyLimit: this.perKeyLimit,
      globalLimit: this.globalLimit,
    }
  }

  /**
   * 停止接收新任务：已在飞的任务跑完；**排队中的任务不静默丢弃**，逐个交给
   * `onDiscard`（调用方用来把 dedupe 标 failed，让上游重试），然后清空队列。
   * 之后 `drain()` 在空队列上立即 resolve，不会 HANG。
   * @returns {void}
   */
  close() {
    if (this.closed === true) return
    this.closed = true
    for (const part of this.partitions.values()) {
      for (const item of part.items) {
        this.queued -= 1
        try {
          if (this.onDiscard !== null) this.onDiscard(item.meta)
        } catch { /* 丢弃回调失败不能阻塞退出 */ }
      }
      part.items.length = 0
    }
    this.notifyIdle()
  }
}

export default { ZhiliaoQueue }
