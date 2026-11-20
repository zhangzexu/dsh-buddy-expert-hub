/**
 * dsh-buddy-expert-hub — 智聊闲时回收器（阶段 3，默认关闭）。
 *
 * 方案 2.3 / 4C 的结论：`sessionController` 没有 dispose/evict 方法，插件经它
 * 创建的会话**拿不到 AgentHandle**，因此「主动释放 live agent」只有一种可行路径：
 * 会话必须由 `ctx.agents.create()` 创建、插件自己持有 handle。阶段 0/2 的
 * create 走的是 sessionController（已验证、不能改），所以：
 *
 *  - 回收器维护 `chatKey → lastActiveAt`，超过 idleMinutes 未活动的 chatKey 进入候选；
 *  - 候选若有注册过的 AgentHandle → 调 `handle.dispose()`，计数 recycled；
 *  - 没有 handle（当前默认情况）→ 不 dispose，记一次 recycle-skipped 并返回原因；
 *  - `enabled` 默认 false，是否开启留给运维决策。
 *
 * 会话日志由 session-persistence-jsonl 持久化（方案 2.2 已核实），即便将来真回收，
 * 下次 prompt() 也会 resume，上下文不丢。
 *
 * @module dsh-buddy-expert-hub/zhiliao-recycle
 */

/** 把配置值收敛到安全整数区间。 */
function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

/**
 * 智聊闲时回收器。
 */
export class ZhiliaoRecycler {
  /**
   * @param {{enabled?: boolean, idleMinutes?: number, now?: () => number}} [options] 参数
   */
  constructor(options) {
    const opts = options !== null && typeof options === 'object' ? options : {}
    this.enabled = opts.enabled === true
    this.idleMinutes = clampInt(opts.idleMinutes, 1, 24 * 60, 30)
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now()
    /** @type {Map<string, number>} chatKey → 最后活动时间 */
    this.lastActive = new Map()
    /** @type {Map<string, any>} chatKey → AgentHandle（只有 ctx.agents.create 的会话才有） */
    this.handles = new Map()
    this.recycled = 0
    this.recycleSkipped = 0
    /** 最近一次 sweep 的跳过原因，供 /status 与日志排查。 */
    this.lastSkipReason = ''
  }

  /**
   * 记录一次活动。
   * @param {string} chatKey 分区键
   * @param {number} [at] 时间戳（缺省用 now）
   * @returns {void}
   */
  touch(chatKey, at) {
    const key = String(chatKey || '')
    if (key === '') return
    this.lastActive.set(key, Number.isFinite(Number(at)) ? Number(at) : this.now())
  }

  /**
   * 注册一个 AgentHandle（为阶段 4 预留；当前调用方拿不到 handle）。
   * @param {string} chatKey 分区键
   * @param {{dispose?: Function}|null} handle AgentHandle
   * @returns {void}
   */
  registerHandle(chatKey, handle) {
    const key = String(chatKey || '')
    if (key === '') return
    if (handle === null || handle === undefined) this.handles.delete(key)
    else this.handles.set(key, handle)
  }

  /**
   * 找出空闲超过阈值的 chatKey。
   * @param {number} [now] 当前时间
   * @returns {string[]} 候选 chatKey
   */
  collectIdle(now) {
    const current = Number.isFinite(Number(now)) ? Number(now) : this.now()
    const limitMs = this.idleMinutes * 60 * 1000
    const idle = []
    for (const [key, at] of this.lastActive) {
      if (current - Number(at) >= limitMs) idle.push(key)
    }
    return idle
  }

  /**
   * 执行一轮清扫：能回收就回收，不能就跳过并计数。
   * @param {{onSkip?: (chatKey: string, reason: string) => void, onRecycle?: (chatKey: string) => void}} [hooks] 回调
   * @returns {Promise<{candidates: number, recycled: number, skipped: number}>} 本轮结果
   */
  async sweep(hooks) {
    const result = { candidates: 0, recycled: 0, skipped: 0 }
    if (this.enabled !== true) return result
    const idle = this.collectIdle()
    result.candidates = idle.length
    for (const key of idle) {
      const handle = this.handles.get(key)
      if (handle !== null && handle !== undefined && typeof handle.dispose === 'function') {
        try {
          await handle.dispose()
          this.recycled += 1
          result.recycled += 1
          this.lastSkipReason = ''
          if (hooks !== undefined && typeof hooks.onRecycle === 'function') hooks.onRecycle(key)
        } catch (error) {
          this.recycleSkipped += 1
          result.skipped += 1
          this.lastSkipReason = 'dispose-failed: ' + String((error !== null && typeof error === 'object' && error.message) || error)
          if (hooks !== undefined && typeof hooks.onSkip === 'function') hooks.onSkip(key, this.lastSkipReason)
        }
        this.lastActive.delete(key)
        this.handles.delete(key)
        continue
      }
      // 当前唯一现实分支：方案 2.3 已核实 sessionController 拿不到 AgentHandle。
      this.recycleSkipped += 1
      result.skipped += 1
      this.lastSkipReason = 'no-agent-handle'
      if (hooks !== undefined && typeof hooks.onSkip === 'function') hooks.onSkip(key, this.lastSkipReason)
      this.lastActive.delete(key)
    }
    return result
  }

  /**
   * 回收器观测快照。
   * @returns {{enabled: boolean, idleMinutes: number, tracked: number, handles: number, recycled: number, recycleSkipped: number, lastSkipReason: string}} 统计
   */
  stats() {
    return {
      enabled: this.enabled === true,
      idleMinutes: this.idleMinutes,
      tracked: this.lastActive.size,
      handles: this.handles.size,
      recycled: this.recycled,
      recycleSkipped: this.recycleSkipped,
      lastSkipReason: this.lastSkipReason,
    }
  }
}

export default { ZhiliaoRecycler }
