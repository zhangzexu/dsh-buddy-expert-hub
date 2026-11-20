/**
 * remote-config.js —— 「远程配置」加载的解析与规范化（纯函数，零 npm 依赖）。
 *
 * 用户在设置页输入一个 http(s) JSON 地址，或上传一个 JSON 文件；插件读取后按
 * 白名单把「设置页用到的参数」覆盖到当前设置上；没加载（或清除）时用本地/默认设置。
 *
 * 职责边界：
 *  - 本模块只做「结构校验 + 白名单规范化」，产出一份干净的 patch；
 *  - 真正的写入 state.settings、副作用（数据源失效 / 队列重启）、持久化在 index.js；
 *  - 语义校验函数（isValidSourceUrl / isValidBaseUrl 等）由 index.js 注入，避免循环依赖。
 *
 * 安全边界：
 *  - webhookSecret / internalSecret 等智聊密钥不支持远程覆盖（明文 http 下发签名密钥
 *    等于把伪造权限交给任何能访问该 URL 的人）；
 *  - khub.clientSecret / khub.apiKey 按用户要求支持远程下发，但**只写加密文件
 *    credentials.enc**，绝不进 state.json；空串表示「不改动」而非「删除」（避免误删）；
 *  - builtinSkills 涉及实际安装/卸载技能（重副作用），只允许本地手动切换。
 *
 * 字段范围：示例与字段说明只列**设置页 UI 上可见可改**的字段。解析层保留少量已不再
 * 文档化的字段（workbench.order / zhiliao.queue 等）以兼容历史下发的配置，不破坏既有部署。
 */

/** 远程配置元信息默认值（持久化在 state.remoteConfig，不属于用户设置本身）。 */
export const DEFAULT_REMOTE_CONFIG_META = Object.freeze({
  source: '', // 'url' | 'upload' | ''
  url: '', // source==='url' 时的地址
  filename: '', // source==='upload' 时的文件名
  loadedAt: null, // ISO 时间字符串
  appliedFields: [], // 已成功覆盖的字段点分路径
})

/** 支持远程覆盖的字段说明（只列 UI 可见字段；设置页展示 + 示例生成共用一份）。 */
export const REMOTE_CONFIG_FIELD_DOCS = Object.freeze([
  { path: 'sourceUrl', label: '资源仓库地址', type: 'string', note: 'git 地址或本机资源目录；留空忽略，恢复请用清除' },
  { path: 'sourceBranch', label: '资源仓库分支', type: 'string', note: '留空表示跟随远端默认分支' },
  { path: 'skillhubUrl', label: 'SkillHub 地址', type: 'string', note: '默认 https://api.skillhub.cn；留空也回落该地址' },
  { path: 'workbench.dataDir', label: '个人工作台数据目录', type: 'string', note: '须为本机已存在的绝对路径；空串表示清除' },
  { path: 'workbench.syncMs', label: '工作台检查间隔', type: 'number', note: '500–60000 毫秒，越界自动收敛' },
  { path: 'khub.baseUrl', label: '在线资料库服务地址', type: 'string', note: '留空表示不使用在线资料库' },
  { path: 'khub.clientId', label: '在线资料库客户端 ID', type: 'string', note: '非敏感字段，可远程下发' },
  { path: 'khub.clientSecret', label: '在线资料库客户端密钥', type: 'string', note: '写入本地加密文件；留空表示不改动。明文 http 下发请自行评估风险' },
  { path: 'khub.apiKey', label: '在线资料库 API Key', type: 'string', note: '写入本地加密文件；留空表示不改动。明文 http 下发请自行评估风险' },
  { path: 'khub.enabled', label: '在线优先开关', type: 'boolean', note: '需先配置好服务端地址与密钥才真正生效' },
  { path: 'zhiliao.replyBaseUrl', label: '智聊服务端地址', type: 'string', note: 'http(s) 地址；留空表示清除' },
  { path: 'zhiliao.enabled', label: '启用智聊', type: 'boolean', note: '' },
  { path: 'about.repoUrl', label: '仓库地址', type: 'string', note: '关于与反馈页/点 Star 用；留空回落插件内置地址' },
  { path: 'about.starUrl', label: '点 Star 地址', type: 'string', note: '留空表示跟随仓库地址' },
  { path: 'about.feedbackUrl', label: '反馈问题地址', type: 'string', note: '留空表示使用「仓库地址 + /issues」' },
])

/** 明确被忽略的敏感字段（用于生成警告，提醒用户不要写错位置）。 */
const SENSITIVE_PATHS = [
  'webhookSecret', 'internalSecret',
  'zhiliao.webhookSecret', 'zhiliao.internalSecret',
  'builtinSkills',
  /* 顶层写 clientSecret / apiKey 是错误位置（应写在 khub 下），保留提示。 */
  'clientSecret', 'apiKey',
]

/** 工作台 id 形状（与 index.js 的 WORKBENCH_ID_SHAPE 同一条规则）。 */
const WORKBENCH_ID_SHAPE = /^[a-z0-9][a-z0-9-]{0,63}$/

function clampInt(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 剥离 JSON 文本里的注释（双斜杠行注释与斜杠星号块注释），让下载示例可以带中文说明。
 * 用状态机跟踪字符串边界，确保 `https://` 这类 URL 里的 `//` 不被误伤。
 * @param {string} text 可能带注释的 JSON 文本
 * @returns {string} 可交给 JSON.parse 的纯 JSON 文本
 */
export function stripJsonComments(text) {
  if (typeof text !== 'string') return ''
  let out = ''
  let inString = false
  let escaped = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const next = i + 1 < text.length ? text[i + 1] : ''
    if (inLine) {
      if (ch === '\n' || ch === '\r') { inLine = false; out += ch }
      continue
    }
    if (inBlock) {
      if (ch === '*' && next === '/') { inBlock = false; i += 1 }
      else if (ch === '\n' || ch === '\r') out += ch
      continue
    }
    if (inString) {
      out += ch
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; out += ch; continue }
    if (ch === '/' && next === '/') { inLine = true; i += 1; continue }
    if (ch === '/' && next === '*') { inBlock = true; i += 1; continue }
    out += ch
  }
  return out
}

/**
 * 生成带中文说明的示例配置文本（LF 结尾）。前端直接展示，避免两端各维护一份示例。
 * 只含 UI 可见字段；密钥留空（下载后按需填写，避免示例自带假密钥）。
 * 注释在加载时由 stripJsonComments 剥离，用户改完直接上传也能解析。
 * @returns {string} 带注释的 JSON 示例
 */
export function sampleConfigText() {
  return [
    '{',
    '  // 远程配置示例：改完可直接上传，或把文件内容放到 http(s) 地址后填 URL 加载',
    '  // 说明：留空字符串表示「不改动 / 使用默认」；密钥留空表示不覆盖本地已保存的密钥',
    '  // 安全：密钥会明文经过网络，请只对可信的配置地址使用',
    '',
    '  // 资源仓库地址（git 仓库 URL 或本机绝对路径）；留空忽略',
    '  "sourceUrl": "https://gitcode.com/zzx_2446/dsh-buddy-expert-hub-resource.git",',
    '  // 资源仓库分支；留空跟随远端默认分支（不要写死 main/master）',
    '  "sourceBranch": "",',
    '  // SkillHub 地址；默认 https://api.skillhub.cn，留空回落默认',
    '  "skillhubUrl": "https://api.skillhub.cn",',
    '',
    '  // 个人工作台',
    '  "workbench": {',
    '    // 数据目录：本机已存在的绝对路径；空串表示清除（无通用默认值）',
    '    "dataDir": "",',
    '    // 检查间隔（毫秒），500–60000，越界自动收敛到 2000',
    '    "syncMs": 2000',
    '  },',
    '',
    '  // 在线资料库',
    '  "khub": {',
    '    // 服务地址；留空表示不使用在线资料库',
    '    "baseUrl": "",',
    '    // 客户端 ID（非敏感，可远程下发）',
    '    "clientId": "",',
    '    // 客户端密钥：写入本地加密文件；留空表示不改动（不要明文分享本文件）',
    '    "clientSecret": "",',
    '    // 用户 API Key：写入本地加密文件；留空表示不改动',
    '    "apiKey": "",',
    '    // 在线优先开关；需先配好地址与密钥才真正生效',
    '    "enabled": true',
    '  },',
    '',
    '  // 智聊',
    '  "zhiliao": {',
    '    // 智聊服务端地址（http(s)）；留空表示清除',
    '    "replyBaseUrl": "",',
    '    // 启用智聊',
    '    "enabled": true',
    '  },',
    '',
    '  // 关于与反馈页的链接',
    '  "about": {',
    '    // 仓库地址；留空回落插件内置地址',
    '    "repoUrl": "https://github.com/zhangzexu/dsh-buddy-expert-hub",',
    '    // 点 Star 地址；留空跟随仓库地址',
    '    "starUrl": "",',
    '    // 反馈问题地址；留空使用「仓库地址 + /issues」',
    '    "feedbackUrl": "https://github.com/zhangzexu/dsh-buddy-expert-hub/issues"',
    '  }',
    '}',
  ].join('\n') + '\n'
}

/**
 * 把解析出的 JSON 对象规范化为可应用的 patch。
 *
 * @param {any} raw 已 JSON.parse 的值
 * @param {{ isValidSourceUrl?:Function, isValidBranchName?:Function, isValidHttpUrl?:Function, isValidBaseUrl?:Function, localWorkbenchDirError?:Function }} validators 由 index.js 注入的语义校验函数
 * @returns {{ ok:boolean, error:string|null, patch:object, appliedFields:string[], warnings:string[], ignoredFields:string[] }}
 */
export function normalizeRemoteConfig(raw, validators) {
  const v = isObject(validators) ? validators : {}
  const warnings = []
  const appliedFields = []
  const ignoredFields = []
  const patch = {}

  /* 支持两种形态：直接的字段对象，或 { settings: {...} } 包裹。 */
  let root = raw
  if (isObject(raw) && isObject(raw.settings)) root = raw.settings
  if (!isObject(root)) {
    return {
      ok: false,
      error: '配置内容必须是 JSON 对象（也可包在 settings 字段里）',
      patch: {}, appliedFields: [], warnings: [], ignoredFields: [],
    }
  }

  const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)
  const warn = (path, reason) => warnings.push(path + '：' + reason)
  const mark = (path) => appliedFields.push(path)
  const checkHttp = (val) => typeof v.isValidHttpUrl === 'function' ? v.isValidHttpUrl(val) : /^https?:\/\/[^\s]+$/i.test(val)

  /* 敏感字段单独提示，避免用户误以为已生效。带点的路径只在对应子对象存在时提示，
     避免「有 khub 对象就误报 khub.clientSecret」（该字段现已支持）。 */
  for (const path of SENSITIVE_PATHS) {
    if (has(root, path)) ignoredFields.push(path)
    else if (path === 'zhiliao.webhookSecret' && isObject(root.zhiliao) && has(root.zhiliao, 'webhookSecret')) ignoredFields.push(path)
    else if (path === 'zhiliao.internalSecret' && isObject(root.zhiliao) && has(root.zhiliao, 'internalSecret')) ignoredFields.push(path)
  }

  // ---- 资源仓库 ----
  if (has(root, 'sourceUrl')) {
    const val = typeof root.sourceUrl === 'string' ? root.sourceUrl.trim() : ''
    if (val === '') warn('sourceUrl', '空值已忽略；恢复默认请用「清除远程配置」')
    else if (typeof v.isValidSourceUrl === 'function' && !v.isValidSourceUrl(val)) warn('sourceUrl', '不是合法的仓库地址或本机目录')
    else { patch.sourceUrl = val; mark('sourceUrl') }
  }
  if (has(root, 'sourceBranch')) {
    const val = typeof root.sourceBranch === 'string' ? root.sourceBranch.trim() : ''
    if (val === '') { patch.sourceBranch = ''; mark('sourceBranch') }
    else if (typeof v.isValidBranchName === 'function' && !v.isValidBranchName(val)) warn('sourceBranch', '分支名非法，已忽略')
    else { patch.sourceBranch = val; mark('sourceBranch') }
  }
  if (has(root, 'skillhubUrl')) {
    const val = typeof root.skillhubUrl === 'string' ? root.skillhubUrl.trim() : ''
    if (val === '') { patch.skillhubUrl = ''; mark('skillhubUrl') }
    else if (!checkHttp(val)) warn('skillhubUrl', '不是合法的 http(s) 地址')
    else { patch.skillhubUrl = val; mark('skillhubUrl') }
  }

  // ---- 个人工作台（order/autoSync 已不在示例展示，但保留解析以兼容历史配置）----
  if (isObject(root.workbench)) {
    const wb = {}
    const rawWb = root.workbench
    if (has(rawWb, 'dataDir')) {
      const dir = typeof rawWb.dataDir === 'string' ? rawWb.dataDir.trim() : ''
      if (dir === '') { wb.dataDir = null; mark('workbench.dataDir') }
      else if (typeof v.localWorkbenchDirError === 'function' && v.localWorkbenchDirError(dir) !== '') {
        warn('workbench.dataDir', v.localWorkbenchDirError(dir))
      } else { wb.dataDir = dir; mark('workbench.dataDir') }
    }
    if (has(rawWb, 'syncMs')) {
      if (typeof rawWb.syncMs !== 'number' || !Number.isFinite(rawWb.syncMs)) warn('workbench.syncMs', '必须是数字')
      else { wb.syncMs = clampInt(rawWb.syncMs, 500, 60000, 2000); mark('workbench.syncMs') }
    }
    if (has(rawWb, 'order')) {
      if (!Array.isArray(rawWb.order)) warn('workbench.order', '必须是字符串数组')
      else {
        wb.order = rawWb.order.filter((id) => typeof id === 'string' && WORKBENCH_ID_SHAPE.test(id)).slice(0, 500)
        mark('workbench.order')
      }
    }
    if (has(rawWb, 'autoSync')) {
      if (typeof rawWb.autoSync !== 'boolean') warn('workbench.autoSync', '必须是布尔值')
      else { wb.autoSync = rawWb.autoSync; mark('workbench.autoSync') }
    }
    if (Object.keys(wb).length > 0) patch.workbench = wb
  } else if (has(root, 'workbench')) {
    warn('workbench', '必须是对象')
  }

  // ---- 在线资料库（密钥只写加密文件，空串=不改动）----
  if (isObject(root.khub)) {
    const kh = {}
    const rawKh = root.khub
    if (has(rawKh, 'baseUrl')) {
      const base = typeof rawKh.baseUrl === 'string' ? rawKh.baseUrl.trim() : ''
      if (base === '') { kh.baseUrl = ''; mark('khub.baseUrl') }
      else if (typeof v.isValidBaseUrl === 'function' && !v.isValidBaseUrl(base)) warn('khub.baseUrl', '不是合法的服务地址')
      else { kh.baseUrl = base; mark('khub.baseUrl') }
    }
    if (has(rawKh, 'clientId')) {
      kh.clientId = typeof rawKh.clientId === 'string' ? rawKh.clientId.trim().slice(0, 120) : ''
      mark('khub.clientId')
    }
    for (const key of ['clientSecret', 'apiKey']) {
      if (!has(rawKh, key)) continue
      const val = typeof rawKh[key] === 'string' ? rawKh[key].trim() : ''
      if (val === '') warn('khub.' + key, '留空表示不改动密钥；如需清除请在设置页操作')
      else { kh[key] = val.slice(0, 500); mark('khub.' + key) }
    }
    if (has(rawKh, 'enabled')) {
      if (typeof rawKh.enabled !== 'boolean') warn('khub.enabled', '必须是布尔值')
      else { kh.enabled = rawKh.enabled; mark('khub.enabled') }
    }
    if (Object.keys(kh).length > 0) patch.khub = kh
  } else if (has(root, 'khub')) {
    warn('khub', '必须是对象')
  }

  // ---- 智聊（密钥类字段忽略；queue/recycle 保留解析仅兼容历史配置）----
  if (isObject(root.zhiliao)) {
    const zl = {}
    const rawZl = root.zhiliao
    if (has(rawZl, 'testMode')) {
      if (typeof rawZl.testMode !== 'boolean') warn('zhiliao.testMode', '必须是布尔值')
      else { zl.testMode = rawZl.testMode; mark('zhiliao.testMode') }
    }
    if (has(rawZl, 'enabled')) {
      if (typeof rawZl.enabled !== 'boolean') warn('zhiliao.enabled', '必须是布尔值')
      else { zl.enabled = rawZl.enabled; mark('zhiliao.enabled') }
    }
    for (const key of ['replyBaseUrl', 'internalBaseUrl']) {
      if (!has(rawZl, key)) continue
      const base = typeof rawZl[key] === 'string' ? rawZl[key].trim().replace(/\/+$/, '').slice(0, 300) : ''
      if (base !== '' && !checkHttp(base)) warn('zhiliao.' + key, '不是合法的 http(s) 地址')
      else { zl[key] = base; mark('zhiliao.' + key) }
    }
    if (isObject(rawZl.queue)) {
      zl.queue = {
        maxConcurrent: clampInt(rawZl.queue.maxConcurrent, 1, 256, 16),
        perKeyLimit: clampInt(rawZl.queue.perKeyLimit, 1, 10000, 20),
        globalLimit: clampInt(rawZl.queue.globalLimit, 1, 100000, 1000),
      }
      mark('zhiliao.queue')
    } else if (has(rawZl, 'queue')) {
      warn('zhiliao.queue', '必须是对象')
    }
    if (isObject(rawZl.recycle)) {
      zl.recycle = {
        enabled: rawZl.recycle.enabled === true,
        idleMinutes: clampInt(rawZl.recycle.idleMinutes, 1, 1440, 30),
      }
      mark('zhiliao.recycle')
    } else if (has(rawZl, 'recycle')) {
      warn('zhiliao.recycle', '必须是对象')
    }
    if (Object.keys(zl).length > 0) patch.zhiliao = zl
  } else if (has(root, 'zhiliao')) {
    warn('zhiliao', '必须是对象')
  }

  // ---- 关于与反馈（点 Star / 反馈地址）----
  if (isObject(root.about)) {
    const about = {}
    const rawAbout = root.about
    for (const key of ['repoUrl', 'starUrl', 'feedbackUrl']) {
      if (!has(rawAbout, key)) continue
      const val = typeof rawAbout[key] === 'string' ? rawAbout[key].trim().slice(0, 500) : ''
      if (val === '') { about[key] = ''; mark('about.' + key) }
      else if (!checkHttp(val)) warn('about.' + key, '不是合法的 http(s) 地址')
      else { about[key] = val; mark('about.' + key) }
    }
    if (Object.keys(about).length > 0) patch.about = about
  } else if (has(root, 'about')) {
    warn('about', '必须是对象')
  }

  return {
    ok: appliedFields.length > 0,
    error: appliedFields.length === 0 ? '配置里没有可识别的设置项（或全部非法）' : null,
    patch, appliedFields, warnings, ignoredFields,
  }
}
