/**
 * dsh-buddy-expert-hub — 在线资料库 ↔ 工作台适配层 + `/khub/*` 数据路由。
 *
 * 设计原则（用户定调「在线数据为主、本地仅备用」）：
 *  - 在线可用时，/workbench/list|html|data 全部由本模块服务；任何一步失败，
 *    上层 index.js 直接回落 lib/workbench.js 的本地实现，前端零改动、零感知；
 *  - 不修改 lib/workbench.js 一行，本地兜底链路原样保留；
 *  - 在线 HTML 用资料库自带的 window.KB 协议，插件 iframe 注入的是 window.Workbench。
 *    这里注入一层 KB→Workbench 适配器：KB.getCsv/updateCell 等最终都走父桥的
 *    read/write（父桥只需放宽「允许 iframe 指定 table」），数据写回在线 CSV。
 *  - 在线 CSV 的 version 当作插件的 hash（统一前缀 `v`），沿用现有 CAS / 409 语义。
 *
 * @module dsh-buddy-expert-hub/khub-workbench
 */

import { BRIDGE_SOURCE } from './workbench-bridge.js'
import { sendHtml } from './workbench.js'
import {
  KhubError, api, configReady, probe, collectCatalog, khubBinary,
} from './knowledge-hub.js'

/** catalog 缓存：树 + CSV 表头都不常变，20 秒内复用，避免每次轮询打 N 个请求。 */
const CATALOG_TTL_MS = 20000
let catalogCache = { at: 0, key: '', data: null }

/**
 * 取在线工作台清单（带缓存）。
 * @param {object} config 运行时配置
 * @returns {Promise<object>} collectCatalog 的结果
 */
export async function getCatalog(config) {
  if (!configReady(config)) throw new KhubError('在线资料库未配置或未启用', 'not-configured')
  const key = config.baseUrl + '|' + config.apiKey
  const now = Date.now()
  if (catalogCache.data !== null && catalogCache.key === key && now - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.data
  }
  const data = await collectCatalog(config)
  catalogCache = { at: now, key, data }
  return data
}

/** 写操作后清空缓存，保证下一次 list / html 读到新节点。 */
export function invalidateCatalog() {
  catalogCache = { at: 0, key: '', data: null }
}

/** 按 id 找在线工作台；找不到抛 404 级错误。 */
function findWorkbench(catalog, id) {
  const list = Array.isArray(catalog.workbenches) ? catalog.workbenches : []
  const found = list.find((w) => String(w.id) === String(id))
  if (found === undefined) throw new KhubError('工作台不存在：' + String(id), 'not-found', 404)
  return found
}

/** 按虚拟文件名找 CSV 表；找不到抛 404 级错误。 */
function findTable(workbench, tableName) {
  const tables = Array.isArray(workbench.tables) ? workbench.tables : []
  const found = tables.find((t) => String(t.file) === String(tableName))
  if (found === undefined) throw new KhubError('数据表不存在：' + String(tableName), 'not-found', 404)
  return found
}

/** 与 lib/workbench.js 的 sendJson 同形：统一 {ok,...} 响应。 */
function sendJson(res, body, status) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8')
  res.writeHead(Number(status || 200), {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
  })
  res.end(buf)
}

/** version → 插件 hash。 */
export function versionHash(version) {
  const n = Number(version)
  return 'v' + String(Number.isFinite(n) ? n : 0)
}

/** 插件 hash → baseVersion（供在线乐观锁）。 */
function baseVersionOf(hash) {
  const match = /^v(\d+)$/.exec(String(hash || ''))
  return match === null ? null : Number(match[1])
}

/** CSV matrix → 插件 rows（对象数组，key 用表头原文）。 */
function matrixToRows(matrix) {
  const rows = Array.isArray(matrix) ? matrix : []
  if (rows.length <= 1) return { columns: rows.length === 1 ? rows[0].map(String) : [], rows: [] }
  const headers = (rows[0] || []).map(String)
  const out = []
  for (let i = 1; i < rows.length; i++) {
    const line = Array.isArray(rows[i]) ? rows[i] : []
    const row = {}
    headers.forEach((h, idx) => { row[h] = line[idx] === undefined || line[idx] === null ? '' : String(line[idx]) })
    out.push(row)
  }
  return { columns: headers, rows: out }
}

/** 插件 columns + rows → CSV matrix。 */
function rowsToMatrix(columns, rows) {
  const cols = Array.isArray(columns) ? columns.map(String) : []
  const list = Array.isArray(rows) ? rows : []
  return [cols].concat(list.map((row) => cols.map((key) => {
    const value = row !== null && typeof row === 'object' ? row[key] : ''
    return value === undefined || value === null ? '' : String(value)
  })))
}

/**
 * GET /workbench/list（在线）。结构与本地版一致，额外给 source / spaces 供 UI 提示。
 * @param {import('node:http').ServerResponse} res
 * @param {object} config 运行时配置
 * @param {number} syncIntervalMs 同步间隔
 */
export async function handleKhubWorkbenchList(res, config, syncIntervalMs) {
  const catalog = await getCatalog(config)
  sendJson(res, {
    ok: true,
    source: 'online',
    workbenches: catalog.workbenches,
    errors: catalog.errors,
    spaces: catalog.spaces.map((s) => ({ id: s.id, name: s.name, type: s.type, nodeCount: s.nodeCount })),
    htmlDir: config.baseUrl,
    dataDir: config.baseUrl,
    dataDirReady: true,
    syncIntervalMs: Number(syncIntervalMs) > 0 ? Number(syncIntervalMs) : 2000,
  })
}

/**
 * 生成注入到在线 HTML 的 window.KB 适配脚本。
 *
 * 直接复用 BRIDGE_SOURCE 暴露的 window.Workbench.read/write，不自己实现 postMessage，
 * 因此父桥只需支持 payload.table 覆盖当前表；kind 白名单、主题下发、冲突推送全部沿用。
 *
 * @param {object} workbench 在线工作台条目
 * @returns {string} 可直接放进 <script> 的 JS
 */
export function kbAdapterSource(workbench) {
  const tables = (Array.isArray(workbench.tables) ? workbench.tables : []).map((t) => ({
    id: Number(t.nodeId),
    name: String(t.name || t.file),
    nodeType: 'CSV',
    file: String(t.file),
  }))
  const payload = {
    nodeId: Number(workbench.nodeId || 0),
    spaceId: Number(workbench.spaceId || 0),
    spaceName: String(workbench.spaceName || ''),
    name: String(workbench.name || ''),
    tables,
  }
  const injected = JSON.stringify(payload).replace(/</g, '\\u003c')
  return String.raw`
(function () {
  var CTX = ${injected};
  var cache = {};                       // file -> { matrix, version, name }
  var listeners = {};
  function W() {
    if (!window.Workbench || typeof window.Workbench.read !== 'function') {
      return Promise.reject(new Error('插件桥未就绪（Workbench.read 不可用）'));
    }
    return window.Workbench;
  }
  function tableOf(id) {
    var num = Number(id);
    for (var i = 0; i < CTX.tables.length; i++) {
      if (CTX.tables[i].id === num || CTX.tables[i].file === String(id)) return CTX.tables[i];
    }
    return CTX.tables[0] || null;
  }
  function toMatrix(snapshot) {
    var cols = snapshot && Array.isArray(snapshot.columns) ? snapshot.columns.map(String) : [];
    var rows = snapshot && Array.isArray(snapshot.rows) ? snapshot.rows : [];
    return [cols].concat(rows.map(function (r) {
      return cols.map(function (c) { return r && r[c] !== undefined && r[c] !== null ? String(r[c]) : ''; });
    }));
  }
  function versionOf(snapshot) {
    var m = /^v(\d+)$/.exec(String((snapshot && snapshot.hash) || ''));
    return m ? Number(m[1]) : 1;
  }
  function readCsv(id) {
    var t = tableOf(id);
    if (t === null) return Promise.reject(new Error('本工作台没有挂载 CSV 数据表'));
    return W().read({ table: t.file }).then(function (s) {
      var matrix = toMatrix(s);
      var version = versionOf(s);
      var name = t.name;
      cache[t.file] = { matrix: matrix, version: version, name: name, nodeId: t.id };
      return {
        nodeId: t.id, name: name, version: version,
        headers: matrix[0] || [], matrix: matrix,
        rowCount: Math.max(0, matrix.length - 1), colCount: (matrix[0] || []).length,
        text: matrix.map(function (r) { return r.join(','); }).join('\n')
      };
    });
  }
  function writeMatrix(id, matrix, version) {
    var t = tableOf(id);
    if (t === null) return Promise.reject(new Error('本工作台没有挂载 CSV 数据表'));
    var headers = (matrix[0] || []).map(String);
    var rows = [];
    for (var r = 1; r < matrix.length; r++) {
      var line = matrix[r] || [], obj = {};
      headers.forEach(function (h, c) { obj[h] = line[c] === undefined || line[c] === null ? '' : String(line[c]); });
      rows.push(obj);
    }
    return W().write({
      table: t.file, baseHash: 'v' + String(version), columns: headers, rows: rows
    }).then(function (res) {
      var next = versionOf(res) || (Number(version) + 1);
      cache[t.file] = { matrix: matrix, version: next, name: t.name, nodeId: t.id };
      return { version: next, size: JSON.stringify(matrix).length };
    });
  }
  function mutate(id, fn, version) {
    var t = tableOf(id);
    var cached = t !== null ? cache[t.file] : null;
    var base = cached ? cached.matrix.map(function (r) { return r.slice(); }) : null;
    if (base === null) {
      return readCsv(id).then(function (d) {
        var m = fn(d.matrix.map(function (r) { return r.slice(); }));
        return writeMatrix(id, m, d.version);
      });
    }
    var m = fn(base.map(function (r) { return r.slice(); }));
    return writeMatrix(id, m, Number(version) || cached.version);
  }
  function emit(name, data) {
    (listeners[name] || []).forEach(function (fn) { try { fn(data); } catch (e) {} });
    (listeners['*'] || []).forEach(function (fn) { try { fn({ event: name, data: data }); } catch (e) {} });
  }
  window.KB = {
    embedded: true,
    standalone: false,
    getContext: function () { return Promise.resolve(CTX); },
    listChildren: function () { return Promise.resolve(CTX.tables.map(function (t) { return { id: t.id, name: t.name, nodeType: 'CSV' }; })); },
    getContent: function () { return Promise.resolve({ content: document.documentElement.outerHTML, version: 1 }); },
    saveContent: function () { return Promise.reject(new Error('在线 HTML 请在资料库中编辑')); },
    getCsv: readCsv,
    readTable: readCsv,
    updateCell: function (id, row, col, value, version) {
      return mutate(id, function (m) {
        if (!m[0]) m[0] = [];
        for (var r = 0; r <= Number(row); r++) if (!m[r]) m[r] = m[0].map(function () { return ''; });
        m[Number(row)][Number(col)] = String(value);
        return m;
      }, version);
    },
    appendRow: function (id, values, version) {
      return mutate(id, function (m) { m.push((values || []).map(String)); return m; }, version);
    },
    deleteRow: function (id, index, version) {
      return mutate(id, function (m) { if (m.length > Number(index) + 1) m.splice(Number(index) + 1, 1); return m; }, version);
    },
    addColumn: function (id, name, version) {
      return mutate(id, function (m) {
        m.forEach(function (r, i) { r.push(i === 0 ? String(name || '新列') : ''); });
        return m;
      }, version);
    },
    deleteColumn: function (id, index, version) {
      return mutate(id, function (m) { m.forEach(function (r) { r.splice(Number(index), 1); }); return m; }, version);
    },
    on: function (name, fn) {
      if (typeof fn !== 'function') return function () {};
      if (!listeners[name]) listeners[name] = [];
      listeners[name].push(fn);
      return function () { KB.off(name, fn); };
    },
    off: function (name, fn) {
      if (!listeners[name]) return;
      listeners[name] = listeners[name].filter(function (f) { return f !== fn; });
    },
    toast: function (text) { emit('toast', { message: String(text || '') }); }
  };
  /* 主题：在线 HTML 自带的 :root 变量映射到宿主 token，深浅色自动跟随。
     放在 </head> 前，保证优先级高于页面自身 <style> 里的同名变量。 */
  var themeStyle = document.createElement('style');
  themeStyle.textContent = ':root{--bg:var(--dsw-alias-bg-base,#f5f7fb);' +
    '--card:var(--dsw-alias-bg-layer-1,#fff);--line:var(--dsw-alias-border-l1,#e6eaf2);' +
    '--text:var(--dsw-alias-label-primary,#1f2430);--muted:var(--dsw-alias-label-secondary,#6b7280);' +
    '--brand:var(--dsw-alias-brand-primary,#4c6ef5)}';
  (document.head || document.documentElement).appendChild(themeStyle);
})();
`
}

/**
 * GET /workbench/html（在线）：取在线 HTML 正文，注入 Workbench 桥 + KB 适配器 + 主题映射。
 * @param {import('node:http').ServerResponse} res
 * @param {URLSearchParams} params
 * @param {object} config 运行时配置
 */
export async function handleKhubWorkbenchHtml(res, params, config) {
  const catalog = await getCatalog(config)
  const id = params.get('workbench') || ''
  const workbench = findWorkbench(catalog, id)
  const content = await api.content(config, workbench.nodeId)
  const html = content !== null && typeof content.content === 'string' ? content.content : ''
  if (html === '') throw new KhubError('在线工作台 HTML 内容为空', 'empty-html', 404)
  const bridge = '<script>' + BRIDGE_SOURCE + '</script>' +
    '<script>' + kbAdapterSource(workbench) + '</script>'
  const injected = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (m) => m + bridge)
    : bridge + html
  sendHtml(res, injected)
}

/**
 * GET /workbench/data（在线）：CSV matrix → 插件 rows，version → hash，支持轻量轮询。
 * @param {import('node:http').ServerResponse} res
 * @param {URLSearchParams} params
 * @param {object} config 运行时配置
 */
export async function handleKhubWorkbenchDataGet(res, params, config) {
  const catalog = await getCatalog(config)
  const id = params.get('workbench') || ''
  const tableName = params.get('table') || ''
  const probeHash = params.get('hash') || ''
  const workbench = findWorkbench(catalog, id)
  const table = findTable(workbench, tableName)
  const data = await api.csv(config, table.nodeId)
  const matrix = data !== null && Array.isArray(data.matrix) ? data.matrix : []
  const hash = versionHash(data === null ? 0 : data.version)
  const size = typeof data.text === 'string' ? Buffer.byteLength(data.text, 'utf8') : 0
  if (probeHash !== '' && probeHash === hash) {
    sendJson(res, { ok: true, changed: false, workbench: id, table: table.file, hash, mtimeMs: null, size })
    return
  }
  const converted = matrixToRows(matrix)
  sendJson(res, {
    ok: true,
    workbench: id,
    table: table.file,
    columns: converted.columns.length > 0 ? converted.columns : table.keys,
    fields: table.fields,
    rows: converted.rows,
    hash,
    mtimeMs: null,
    size,
    lineEnding: '\n',
    changed: probeHash !== '',
  })
}

/**
 * POST /workbench/data（在线）：走 PUT /csv/matrix 整表覆盖 + baseVersion 乐观锁。
 * 409 时返回与本地版完全相同的 {ok:false,code:'conflict',error,current}，前端冲突 UI 不改。
 * @param {import('node:http').ServerResponse} res
 * @param {object} body 请求体
 * @param {object} config 运行时配置
 */
export async function handleKhubWorkbenchDataPost(res, body, config) {
  const payload = body !== null && typeof body === 'object' ? body : {}
  const catalog = await getCatalog(config)
  const id = String(payload.workbench || '')
  const tableName = String(payload.table || '')
  const workbench = findWorkbench(catalog, id)
  const table = findTable(workbench, tableName)
  const matrix = rowsToMatrix(payload.columns, payload.rows)
  const baseVersion = baseVersionOf(payload.baseHash)
  let result
  try {
    result = await api.saveCsvMatrix(config, table.nodeId, matrix, baseVersion)
  } catch (error) {
    const status = error !== null && typeof error === 'object' ? Number(error.status || 0) : 0
    const code = error !== null && typeof error === 'object' ? String(error.code || '') : ''
    if (status === 409 || code === '409') {
      const fresh = await api.csv(config, table.nodeId)
      const converted = matrixToRows(fresh === null ? [] : fresh.matrix)
      const current = {
        ok: true, workbench: id, table: table.file,
        columns: converted.columns, fields: table.fields, rows: converted.rows,
        hash: versionHash(fresh === null ? 0 : fresh.version),
        changed: true,
      }
      sendJson(res, {
        ok: false,
        code: 'conflict',
        error: String((error && error.message) || '数据表已被其他成员更新，已重新加载'),
        current,
      }, 409)
      return
    }
    throw error
  }
  const nextVersion = result !== null && typeof result === 'object' && result.version !== undefined
    ? Number(result.version) : (baseVersion === null ? 1 : baseVersion + 1)
  invalidateCatalog()
  sendJson(res, {
    ok: true,
    hash: versionHash(nextVersion),
    columns: Array.isArray(payload.columns) ? payload.columns : [],
    rows: Array.isArray(payload.rows) ? payload.rows : [],
  })
}

/**
 * GET /khub/html?id= —— 资料库面板里的 HTML 预览。
 *
 * 返回注入了 BRIDGE_SOURCE + window.KB 适配器的页面，与工作台同一套：
 * 页面里挂载的 CSV 子节点可以直接读写，行为与在线资料库的 HtmlPreview 一致。
 *
 * @param {import('node:http').ServerResponse} res
 * @param {URLSearchParams} params
 * @param {object} config 运行时配置
 */
export async function handleKhubHtml(res, params, config) {
  const nodeId = String(params.get('id') || '').trim()
  if (nodeId === '') throw new KhubError('缺少 id', 'invalid-id', 400)
  const detail = await api.node(config, nodeId)
  const node = detail !== null && typeof detail === 'object' && detail.node !== null && typeof detail.node === 'object'
    ? detail.node : {}
  const content = detail !== null && typeof detail === 'object' ? detail : {}
  const html = typeof content.content === 'string' ? content.content : ''
  if (html === '') throw new KhubError('该 HTML 内容为空', 'empty-html', 404)
  let children = []
  try {
    const list = await api.children(config, nodeId)
    children = Array.isArray(list) ? list : []
  } catch { /* 没有子节点或权限不足：按无挂载表处理 */ }
  const csvNodes = children.filter((n) => String(n.nodeType || '').toUpperCase() === 'CSV')
  const workbench = {
    nodeId: Number(nodeId),
    spaceId: Number(node.spaceId || 0),
    spaceName: String(node.name || ''),
    name: String(node.name || ''),
    tables: csvNodes.map((n) => ({
      file: 'node-' + String(n.id) + '.csv',
      name: String(n.name || ('数据表 ' + String(n.id))),
      nodeId: Number(n.id),
    })),
  }
  const injected = '<script>' + BRIDGE_SOURCE + '</script><script>' + kbAdapterSource(workbench) + '</script>'
  const out = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (m) => m + injected)
    : injected + html
  sendHtml(res, out)
}

/**
 * GET /khub/raw?id=&name=&download=1 —— 代理原始字节。
 *
 * iframe / img 不能带 Authorization 头，所以由插件服务端带 PAT 取回再转发；
 * 不落盘、不缓存，只做一次性透传。
 *
 * @param {import('node:http').ServerResponse} res
 * @param {URLSearchParams} params
 * @param {object} config 运行时配置
 */
export async function handleKhubRaw(res, params, config) {
  const nodeId = String(params.get('id') || '').trim()
  if (nodeId === '') throw new KhubError('缺少 id', 'invalid-id', 400)
  const download = params.get('download') === '1'
  const bin = await khubBinary(config, '/api/nodes/' + encodeURIComponent(nodeId) + (download ? '/download' : '/raw'))
  const headers = {
    'Content-Type': bin.contentType,
    'Content-Length': bin.buffer.length,
    'Cache-Control': 'no-store',
  }
  if (download) {
    const name = String(params.get('name') || 'download').replace(/[\r\n"]/g, '_')
    headers['Content-Disposition'] = 'attachment; filename="' + name + '"; filename*=UTF-8\'\'' + encodeURIComponent(name)
  }
  res.writeHead(200, headers)
  res.end(bin.buffer)
}

/**
 * 收藏 / 分享 / 版本 / 最近：方法 + 路径 → 在线调用。
 * 表驱动比长串 if 更不容易漏分支，也方便对照在线 API 文档核对。
 */
const KHUB_ROUTES = {
  'GET /khub/fav-groups': (c) => api.favGroups(c),
  'GET /khub/node': (c, q) => api.node(c, q.get('id') || ''),
  'GET /khub/favorites': (c, q) => api.favorites(c, q.get('groupId') || ''),
  'POST /khub/favorite': (c, q, b) => api.favorite(c, Number(b.nodeId || 0), b.groupId),
  'PUT /khub/favorite': (c, q, b) => api.moveFavorite(c, Number(b.nodeId || 0), b.groupId),
  'DELETE /khub/favorite': (c, q) => api.unfavorite(c, q.get('nodeId') || ''),
  'POST /khub/fav-group': (c, q, b) => api.createFavGroup(c, b),
  'DELETE /khub/fav-group': (c, q) => api.deleteFavGroup(c, q.get('id') || ''),
  'GET /khub/shares': (c, q) => api.nodeShares(c, q.get('nodeId') || ''),
  'POST /khub/share': (c, q, b) => api.createShare(c, Number(b.nodeId || 0), {
    permission: String(b.permission || 'VIEW'),
    expireHours: Number(b.expireHours) > 0 ? Number(b.expireHours) : null,
    password: typeof b.password === 'string' && b.password !== '' ? b.password : null,
  }),
  'PUT /khub/share': (c, q, b) => api.updateShare(c, Number(b.id || 0), String(b.permission || 'VIEW')),
  'DELETE /khub/share': (c, q) => api.deleteShare(c, q.get('id') || ''),
  'GET /khub/shares-out': (c) => api.sharesOut(c),
  'GET /khub/shares-in': (c) => api.sharesIn(c),
  'GET /khub/versions': (c, q) => api.versions(c, q.get('nodeId') || ''),
  'GET /khub/version': (c, q) => api.versionDetail(c, q.get('nodeId') || '', q.get('no') || ''),
  'POST /khub/version/restore': (c, q, b) => api.restoreVersion(c, Number(b.nodeId || 0), Number(b.no || 0)),
  'GET /khub/recent': (c, q) => api.recent(c, q.get('limit') || 20),
  'POST /khub/visit': (c, q, b) => api.visit(c, Number(b.nodeId || 0)),
}

/**
 * `/khub/*` 数据类端点统一分发（配置类 /khub/settings 由 index.js 直接处理）。
 * @param {string} route 去掉插件前缀后的路径，如 /khub/spaces
 * @param {string} method HTTP 方法
 * @param {URLSearchParams} query 查询参数
 * @param {object} body 已解析的 JSON 请求体
 * @param {object} config 运行时配置
 * @returns {Promise<{status: number, body: object}>}
 */
export async function handleKhubApi(route, method, query, body, config) {
  const idOf = (key) => String(query.get(key) || (body !== null && body[key] !== undefined ? body[key] : '')).trim()
  const fail = (error) => {
    const status = error !== null && typeof error === 'object' && Number(error.status) > 0 ? Number(error.status) : 502
    return {
      status,
      body: {
        ok: false,
        error: String((error && error.message) || error),
        code: error !== null && typeof error === 'object' ? String(error.code || 'khub-error') : 'khub-error',
      },
    }
  }
  try {
    if (route === '/khub/probe' && method === 'POST') {
      return { status: 200, body: await probe(config) }
    }
    const handler = KHUB_ROUTES[method + ' ' + route]
    if (handler !== undefined) {
      const data = await handler(config, query, body !== null && typeof body === 'object' ? body : {})
      const key = route.indexOf('/khub/shares') === 0 ? 'shares'
        : route.indexOf('/khub/favorites') === 0 ? 'items'
          : route.indexOf('/khub/versions') === 0 ? 'versions'
            : route.indexOf('/khub/recent') === 0 ? 'items'
              : route.indexOf('/khub/fav-groups') === 0 ? 'groups'
                : 'data'
      if (Array.isArray(data)) return { status: 200, body: { ok: true, [key]: data } }
      if (data !== null && typeof data === 'object') return { status: 200, body: Object.assign({ ok: true }, data) }
      return { status: 200, body: { ok: true, data: data === undefined ? null : data } }
    }
    if (!configReady(config)) {
      return { status: 400, body: { ok: false, error: '在线资料库未配置或未启用', code: 'not-configured' } }
    }
    if (route === '/khub/spaces' && method === 'GET') {
      const spaces = await api.spaces(config)
      return { status: 200, body: { ok: true, spaces: Array.isArray(spaces) ? spaces : [] } }
    }
    if (route === '/khub/tree' && method === 'GET') {
      const spaceId = idOf('spaceId')
      if (spaceId === '') return { status: 400, body: { ok: false, error: '缺少 spaceId' } }
      const tree = await api.tree(config, spaceId)
      return { status: 200, body: { ok: true, tree: Array.isArray(tree) ? tree : [] } }
    }
    if (route === '/khub/children' && method === 'GET') {
      const nodeId = idOf('id')
      if (nodeId === '') return { status: 400, body: { ok: false, error: '缺少 id' } }
      const children = await api.children(config, nodeId)
      return { status: 200, body: { ok: true, children: Array.isArray(children) ? children : [] } }
    }
    /* Markdown 附件/引用解析：容器后代扁平清单，带 relPath。 */
    if (route === '/khub/attachments' && method === 'GET') {
      const nodeId = idOf('id')
      if (nodeId === '') return { status: 400, body: { ok: false, error: '缺少 id' } }
      const items = await api.attachments(config, nodeId)
      return { status: 200, body: { ok: true, items: Array.isArray(items) ? items : [] } }
    }
    if (route === '/khub/content' && method === 'GET') {
      const nodeId = idOf('id')
      if (nodeId === '') return { status: 400, body: { ok: false, error: '缺少 id' } }
      const content = await api.content(config, nodeId)
      return { status: 200, body: { ok: true, content } }
    }
    if (route === '/khub/csv' && method === 'GET') {
      const nodeId = idOf('id')
      if (nodeId === '') return { status: 400, body: { ok: false, error: '缺少 id' } }
      const csv = await api.csv(config, nodeId)
      return { status: 200, body: { ok: true, csv } }
    }
    if (route === '/khub/search' && method === 'GET') {
      const spaceId = idOf('spaceId')
      const keyword = String(query.get('keyword') || '')
      if (spaceId === '') return { status: 400, body: { ok: false, error: '缺少 spaceId' } }
      const items = await api.search(config, spaceId, keyword)
      return { status: 200, body: { ok: true, items: Array.isArray(items) ? items : [] } }
    }
    if (route === '/khub/node' && method === 'POST') {
      const payload = body !== null && typeof body === 'object' ? body : {}
      if (typeof payload.name !== 'string' || payload.name.trim() === '') {
        return { status: 400, body: { ok: false, error: '名称不能为空' } }
      }
      const created = await api.createNode(config, {
        spaceId: Number(payload.spaceId),
        parentId: Number(payload.parentId || 0),
        name: payload.name.trim(),
        nodeType: String(payload.nodeType || 'MD').toUpperCase(),
        content: typeof payload.content === 'string' ? payload.content : '',
      })
      invalidateCatalog()
      return { status: 200, body: { ok: true, node: created } }
    }
    if (route === '/khub/node' && method === 'PUT') {
      const payload = body !== null && typeof body === 'object' ? body : {}
      const nodeId = Number(payload.id || 0)
      if (nodeId <= 0) return { status: 400, body: { ok: false, error: '缺少合法的 id' } }
      const action = String(payload.action || 'rename')
      let result
      if (action === 'content') {
        result = await api.saveContent(config, nodeId,
          typeof payload.content === 'string' ? payload.content : '',
          payload.baseVersion === undefined ? null : Number(payload.baseVersion))
      } else {
        const patch = {}
        if (typeof payload.name === 'string') patch.name = payload.name.trim()
        if (payload.parentId !== undefined) patch.parentId = Number(payload.parentId)
        if (payload.sortOrder !== undefined) patch.sortOrder = Number(payload.sortOrder)
        result = await api.updateNode(config, nodeId, patch)
      }
      invalidateCatalog()
      return { status: 200, body: { ok: true, node: result } }
    }
    if (route === '/khub/csv' && method === 'PUT') {
      const payload = body !== null && typeof body === 'object' ? body : {}
      const nodeId = Number(payload.id || 0)
      if (nodeId <= 0) return { status: 400, body: { ok: false, error: '缺少合法的 id' } }
      const matrix = Array.isArray(payload.matrix) ? payload.matrix : []
      if (matrix.length === 0) return { status: 400, body: { ok: false, error: '表格为空' } }
      try {
        const saved = await api.saveCsvMatrix(config, nodeId, matrix.map((row) => (Array.isArray(row) ? row.map(String) : [])),
          payload.baseVersion === undefined ? null : Number(payload.baseVersion))
        invalidateCatalog()
        return { status: 200, body: { ok: true, version: Number(saved && saved.version ? saved.version : 0) } }
      } catch (error) {
        const status = error !== null && typeof error === 'object' ? Number(error.status || 0) : 0
        if (status === 409) {
          const fresh = await api.csv(config, nodeId)
          return {
            status: 409,
            body: {
              ok: false, code: 'conflict',
              error: String((error && error.message) || '数据表已被其他成员更新'),
              csv: fresh,
            },
          }
        }
        throw error
      }
    }
    if (route === '/khub/node' && method === 'DELETE') {
      const nodeId = Number(idOf('id'))
      if (nodeId <= 0) return { status: 400, body: { ok: false, error: '缺少合法的 id' } }
      const result = await api.deleteNode(config, nodeId)
      invalidateCatalog()
      return { status: 200, body: { ok: true, node: result } }
    }
    return { status: 404, body: { ok: false, error: '未知的在线资料库端点：' + String(route) } }
  } catch (error) {
    return fail(error)
  }
}

export default {
  getCatalog, invalidateCatalog, versionHash, kbAdapterSource,
  handleKhubWorkbenchList, handleKhubWorkbenchHtml, handleKhubWorkbenchDataGet,
  handleKhubWorkbenchDataPost, handleKhubHtml, handleKhubRaw, handleKhubApi,
}
