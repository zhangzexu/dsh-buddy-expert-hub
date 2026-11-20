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
  KhubError, api, configReady, probe, collectCatalog, fieldsFromHeaders, khubBinary, uploadBinary,
} from './knowledge-hub.js'
import { readOffice, writeOffice } from './ooxml.js'

/**
 * 「当前页分享（静态快照）」采集器，注入到 HTML 预览 iframe 里。
 *
 * iframe 是 sandbox（没有 allow-same-origin），父窗口读不到 contentDocument，
 * 所以由页面自己把渲染后的 DOM 序列化出来，通过 postMessage 回给父窗口。
 * 协议与在线资料库 HtmlPreview.vue 一致：khub:snapshot:request → khub:snapshot:result。
 * 序列化时移除脚本 / 子框架、固化表单当前值、去掉事件属性、禁用交互元素；
 * 后端还会再用 CSP（script-src 'none'）兜一层，访客只能看。
 */
export const SNAPSHOT_HELPER_SOURCE = String.raw`
(function () {
  window.addEventListener('message', function (e) {
    var d = e && e.data ? e.data : {};
    if (d.type !== 'khub:snapshot:request') return;
    var replyTo = e.source || window.parent;
    function send(html, err) {
      try { replyTo.postMessage({ type: 'khub:snapshot:result', id: d.id, html: html, error: err || '' }, '*'); }
      catch (e2) { /* 父窗口已卸载 */ }
    }
    try {
      var clone = document.documentElement.cloneNode(true);
      var dead = clone.querySelectorAll('script,noscript,iframe,object,embed,applet,frame,frameset,base,template,link[rel="import"],meta[http-equiv="refresh"]');
      Array.prototype.forEach.call(dead, function (n) { if (n.parentNode) n.parentNode.removeChild(n); });
      var live = document.querySelectorAll('input,textarea,select');
      var frozen = clone.querySelectorAll('input,textarea,select');
      for (var i = 0; i < live.length && i < frozen.length; i++) {
        var src = live[i], dst = frozen[i], tag = String(src.tagName || '').toUpperCase();
        if (tag === 'TEXTAREA') { dst.textContent = src.value; }
        else if (tag === 'SELECT') {
          Array.prototype.forEach.call(dst.querySelectorAll('option'), function (o) {
            if (o.value === src.value) o.setAttribute('selected', ''); else o.removeAttribute('selected');
          });
        } else if (src.type === 'checkbox' || src.type === 'radio') {
          if (src.checked) dst.setAttribute('checked', ''); else dst.removeAttribute('checked');
        } else { dst.setAttribute('value', src.value); }
      }
      var events = ['onclick', 'onchange', 'oninput', 'onsubmit', 'onload', 'onmouseover', 'onkeydown', 'onblur', 'onfocus'];
      Array.prototype.forEach.call(clone.querySelectorAll('*'), function (n) {
        events.forEach(function (a) { n.removeAttribute(a); });
      });
      Array.prototype.forEach.call(clone.querySelectorAll('button,input,textarea,select,[contenteditable]'), function (n) {
        n.setAttribute('disabled', '');
        if (n.hasAttribute('contenteditable')) n.setAttribute('contenteditable', 'false');
      });
      Array.prototype.forEach.call(clone.querySelectorAll('a'), function (n) {
        n.removeAttribute('href'); n.setAttribute('tabindex', '-1');
      });
      send('<!DOCTYPE html>' + String.fromCharCode(10) + clone.outerHTML, '');
    } catch (err) { send('', String(err && err.message ? err.message : err)); }
  });
}());
`;

/** 快照采集器与桥一起注入：<script>...</script>。 */
function snapshotScript() {
  return '<script data-khub-snapshot="1">' + SNAPSHOT_HELPER_SOURCE + '</' + 'script>';
}

/** catalog 缓存：树 + CSV 表头都不常变，20 秒内复用，避免每次轮询打 N 个请求。 */
const CATALOG_TTL_MS = 20000
let catalogCache = { at: 0, key: '', data: null, pending: null, pendingKey: '' }

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
  /* 冷启动时 iframe 的 ready 与 read 会几乎同时到，没有这一步会各拉一遍整棵树 + 全部表头，
     两边都变慢、又都撞上桥的超时。同一份配置只跑一次，后来者等同一个 Promise。 */
  if (catalogCache.pending !== null && catalogCache.pendingKey === key) return catalogCache.pending
  const pending = collectCatalog(config).then((data) => {
    catalogCache = { at: Date.now(), key: key, data: data, pending: null, pendingKey: '' }
    return data
  }).catch((error) => {
    catalogCache.pending = null
    catalogCache.pendingKey = ''
    throw error
  })
  catalogCache.pending = pending
  catalogCache.pendingKey = key
  return pending
}

/** 写操作后清空缓存，保证下一次 list / html 读到新节点。 */
export function invalidateCatalog() {
  catalogCache = { at: 0, key: '', data: null, pending: null, pendingKey: '' }
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
  try {
    /* 同 sendHtml：客户端先断开时写响应会抛，未捕获会把插件服务打挂 */
    if (typeof res.on === 'function') res.on('error', () => {})
    res.writeHead(Number(status || 200), {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store',
    })
    res.end(buf)
  } catch { /* 已被断开：静默放弃 */ }
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
  /* tables 里带着 preview（首屏内联用），list 不需要它，剔掉免得响应白白变大 */
  const workbenches = catalog.workbenches.map((w) => Object.assign({}, w, {
    tables: (Array.isArray(w.tables) ? w.tables : []).map((t) => ({
      file: t.file, name: t.name, nodeId: t.nodeId, fields: t.fields, keys: t.keys,
    })),
  }))
  sendJson(res, {
    ok: true,
    source: 'online',
    workbenches: workbenches,
    /* 目录树：个人工作台左侧要把工作台按文件夹分组，也要能新建目录 / 拖进目录。
       只回 FOLDER 节点（含 parentId），前端自己拼层级；spaceId 用来区分空间。 */
    folders: (Array.isArray(catalog.flatNodes) ? catalog.flatNodes : [])
      .filter((n) => String(n.nodeType || '').toUpperCase() === 'FOLDER')
      .map((n) => ({
        id: Number(n.id),
        spaceId: Number(n.spaceId || 0),
        parentId: Number(n.parentId || 0),
        name: String(n.name || ''),
        depth: Number(n.depth || 0),
      })),
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
export function kbAdapterSource(workbench, seed) {
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
    /* 服务端内联的首屏数据：页面拿到就能直接渲染，完全不等桥 */
    seed: seed !== null && seed !== undefined && typeof seed === 'object' ? seed : {},
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
  /* 服务端内联的首屏数据先灌进缓存：页面第一次 getCsv 就命中，
     完全不依赖「子→父」请求通道（通道在个别宿主里会整条不通）。 */
  (function seedCache() {
    var seed = CTX.seed || {};
    for (var file in seed) {
      if (!Object.prototype.hasOwnProperty.call(seed, file)) continue;
      var snapshot = seed[file];
      if (snapshot === null || typeof snapshot !== 'object') continue;
      var t = null;
      for (var i = 0; i < CTX.tables.length; i++) {
        if (CTX.tables[i].file === file) t = CTX.tables[i];
      }
      if (t === null) continue;
      cache[file] = {
        matrix: toMatrix(snapshot),
        version: versionOf(snapshot),
        name: t.name,
        nodeId: t.id,
        seeded: true
      };
    }
  }());

  /**
   * 给桥调用套一个适配器侧超时：桥自己 20 秒才超时，页面等不了那么久。
   * 超时后 reject 明确原因，页面就能显示「加载失败」而不是一直转圈。
   */
  function withTimeout(promise, ms, message) {
    if (typeof setTimeout !== 'function') return promise;
    return new Promise(function (resolve, reject) {
      var done = false;
      var timer = setTimeout(function () {
        if (done === true) return;
        done = true;
        reject(new Error(message));
      }, ms);
      promise.then(function (value) {
        if (done === true) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
      }, function (error) {
        if (done === true) return;
        done = true;
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  function cachedPayload(t, hit) {
    return {
      nodeId: t.id, name: hit.name, version: hit.version,
      headers: hit.matrix[0] || [], matrix: hit.matrix,
      rowCount: Math.max(0, hit.matrix.length - 1), colCount: (hit.matrix[0] || []).length,
      text: hit.matrix.map(function (r) { return r.join(','); }).join('\n')
    };
  }
  function readCsv(id) {
    var t = tableOf(id);
    if (t === null) return Promise.reject(new Error('本工作台没有挂载 CSV 数据表'));
    /* 父窗口的推送先到了就直接用：万一「子→父」这条请求通道不通（Electron 沙箱里出现过），
       页面仍然能把首屏渲染出来，不至于一直转圈。后台再补一次请求刷新缓存，失败也不影响。 */
    var hit = cache[t.file];
    if (hit !== undefined && hit.matrix !== undefined) {
      /* 命中缓存（服务端内联的种子 / 父窗口 push）就直接给，零请求、零等待 */
      return Promise.resolve(cachedPayload(t, hit));
    }
    return withTimeout(W().read({ table: t.file }), 8000, '数据请求超时（8 秒内父窗口没有回信，消息通道可能不通）').then(function (s) {
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
  /**
   * 在线版 index 的语义：null / 空 / 负数 / 越界 = 追加到末尾。
   * 不能直接用 Number(index) —— Number(null) 是 0，会把新行插到表头前面。
   * @param {any} index 插入位置
   * @param {number} fallback 追加时的位置
   * @returns {number} matrix 下标
   */
  function idxOf(index, fallback) {
    if (index === null || index === undefined || index === '' || index === false) return fallback;
    var n = Number(index);
    if (!Number.isFinite(n) || n < 0) return fallback;
    return Math.round(n);
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
    return withTimeout(W().write({
      table: t.file, baseHash: 'v' + String(version), columns: headers, rows: rows
    }), 8000, '保存超时（8 秒内父窗口没有回信，消息通道可能不通）').then(function (res) {
      var next = versionOf(res) || (Number(version) + 1);
      cache[t.file] = { matrix: matrix, version: next, name: t.name, nodeId: t.id };
      /* 必须回完整视图：在线资料库的 CSV 写接口返回 view()（含 matrix / headers / version），
         工作台 HTML 里是 KB.appendRow(...).then(res => state.matrix = res.matrix) 再 renderTable()。
         以前这里只回 { version, size }，res.matrix 是 undefined，renderTable 读 .length 就抛
         「Cannot read properties of undefined (reading 'length')」。 */
      return {
        nodeId: t.id, name: t.name, version: next,
        headers: matrix[0] || [], matrix: matrix,
        rowCount: Math.max(0, matrix.length - 1), colCount: (matrix[0] || []).length,
        text: matrix.map(function (r) { return r.join(','); }).join('\n'),
        size: JSON.stringify(matrix).length
      };
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
  /* getCsv 入口：直接读数据表，不再在页面右下角画诊断浮层。 */
  function readCsvWatched(id) {
    return readCsv(id);
  }

  function emit(name, data) {
    (listeners[name] || []).forEach(function (fn) { try { fn(data); } catch (e) {} });
    (listeners['*'] || []).forEach(function (fn) { try { fn({ event: name, data: data }); } catch (e) {} });
  }
  window.KB = {
    /* 适配器构建号：面板上会显示，用来确认「页面里跑的是哪一版注入脚本」。
       改注入逻辑时 +1，用户看一眼就知道新代码有没有生效。 */
    build: 6,
    embedded: true,
    standalone: false,
    getContext: function () { return Promise.resolve(CTX); },
    listChildren: function () { return Promise.resolve(CTX.tables.map(function (t) { return { id: t.id, name: t.name, nodeType: 'CSV' }; })); },
    getContent: function () { return Promise.resolve({ content: document.documentElement.outerHTML, version: 1 }); },
    saveContent: function () { return Promise.reject(new Error('在线 HTML 请在资料库中编辑')); },
    getCsv: readCsvWatched,
    /* 与在线 bridge 契约保持一致：一次给出 matrix（原始矩阵，含表头行）与
       rows（按表头映射的 {表头: 值} 对象数组），页面取哪个都能跑。 */
    readTable: function (id) {
      return readCsvWatched(id).then(function (data) {
        var headers = data.headers || [];
        var matrix = data.matrix || [];
        return {
          nodeId: data.nodeId, name: data.name, version: data.version,
          headers: headers, matrix: matrix,
          rows: matrix.slice(1).map(function (row) {
            var obj = {};
            headers.forEach(function (h, i) { obj[h] = row[i] === undefined || row[i] === null ? '' : String(row[i]); });
            return obj;
          }),
          rowCount: Math.max(0, matrix.length - 1), colCount: headers.length,
          text: data.text || ''
        };
      });
    },
    updateCell: function (id, row, col, value, version) {
      return mutate(id, function (m) {
        if (!m[0]) m[0] = [];
        for (var r = 0; r <= Number(row); r++) if (!m[r]) m[r] = m[0].map(function () { return ''; });
        m[Number(row)][Number(col)] = String(value);
        return m;
      }, version);
    },
    /* 下列签名与在线资料库 bridge/kb-bridge.js 一致：
       appendRow(nodeId, values, index?, baseVersion)、addColumn(nodeId, name, index?, baseVersion)。
       第 3 个参数是插入位置（matrix 下标，null / 负数 = 末尾或最后一列），
       第 4 个才是 baseVersion —— 以前少收一个参数，baseVersion 拿到的是 null。 */
    appendRow: function (id, values, index, version) {
      return mutate(id, function (m) {
        if (m.length === 0) m.push(['列1', '列2', '列3']);
        var width = (m[0] || []).length;
        var row = (values || []).map(String);
        while (row.length < width) row.push('');
        var at = idxOf(index, m.length);
        if (at > m.length) at = m.length;
        m.splice(at, 0, row);
        return m;
      }, version);
    },
    deleteRow: function (id, index, version) {
      return mutate(id, function (m) {
        var at = idxOf(index, m.length);
        if (at >= 0 && at < m.length) m.splice(at, 1);
        return m;
      }, version);
    },
    addColumn: function (id, name, index, version) {
      return mutate(id, function (m) {
        if (m.length === 0) m.push([]);
        var width = (m[0] || []).length;
        var at = idxOf(index, width);
        if (at > width) at = width;
        m.forEach(function (r, i) {
          while (r.length < at) r.push('');
          r.splice(at, 0, i === 0 ? String(name || '新列') : '');
        });
        return m;
      }, version);
    },
    deleteColumn: function (id, index, version) {
      return mutate(id, function (m) {
        var at = idxOf(index, -1);
        if (at < 0) return m;
        m.forEach(function (r) { if (at < r.length) r.splice(at, 1); });
        return m;
      }, version);
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
  /* 父窗口的 push（首屏 / 外部改动）先落到缓存，readCsv 命中就直接返回。 */
  try {
    if (window.Workbench && typeof window.Workbench.onData === 'function') {
      window.Workbench.onData(function (payload) {
        if (!payload || !payload.table) return;
        var file = String(payload.table);
        var t = null;
        for (var i = 0; i < CTX.tables.length; i++) {
          if (CTX.tables[i].file === file) t = CTX.tables[i];
        }
        if (t === null) return;
        cache[file] = { matrix: toMatrix(payload), version: versionOf(payload), name: t.name, nodeId: t.id };
      });
    }
  } catch (e) { /* 老版本桥没有 onData，忽略 */ }

  /* 主题别名：把页面常用的 --bg / --card / --line / --text / --muted / --brand 映射到宿主 token。
     只在**页面自己没有定义**该变量时才补 —— 工作台页面允许自带一整套配色，
     无条件覆盖会把奶油底 / 墨绿侧栏这类自定义主题染成宿主灰白。 */
  function applyAliases() {
    try {
      var root = document.documentElement;
      var hasStyleApi = typeof window !== 'undefined' && typeof window.getComputedStyle === 'function';
      var cs = hasStyleApi ? window.getComputedStyle(root) : null;
      var pairs = [
        ['--bg', '--dsw-alias-bg-base', '#f5f7fb'],
        ['--card', '--dsw-alias-bg-layer-1', '#fff'],
        ['--line', '--dsw-alias-border-l1', '#e6eaf2'],
        ['--text', '--dsw-alias-label-primary', '#1f2430'],
        ['--muted', '--dsw-alias-label-secondary', '#6b7280'],
        ['--brand', '--dsw-alias-brand-primary', '#4c6ef5']
      ];
      var css = '';
      for (var i = 0; i < pairs.length; i++) {
        var own = cs === null ? '' : String(cs.getPropertyValue(pairs[i][0]) || '').trim();
        if (own !== '') continue;
        css += pairs[i][0] + ':var(' + pairs[i][1] + ',' + pairs[i][2] + ');';
      }
      if (css === '') return;
      var style = document.createElement('style');
      style.textContent = ':root{' + css + '}';
      (document.head || root).appendChild(style);
    } catch (e) { /* 极简沙箱没有样式 API：跳过，页面自带配色照常生效 */ }
  }
  if (typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyAliases);
  } else {
    applyAliases();
  }
})();
`
}

/**
 * GET /workbench/html（在线）：取在线 HTML 正文，注入 Workbench 桥 + KB 适配器 + 主题映射。
 * @param {import('node:http').ServerResponse} res
 * @param {URLSearchParams} params
 * @param {object} config 运行时配置
 */
/** 首屏内联的行数上限：够渲染第一屏就行，别把大表整个塞进 HTML。 */
const SEED_ROWS = 200

/**
 * 用 catalog 里已经拿到的表内容拼出「种子数据」，**不再发任何请求**。
 *
 * 为什么这么做：iframe 是 opaque origin，页面渲染首屏只能靠一次请求走 postMessage，
 * 一旦这条通道在某个宿主里不通，页面就永远停在「加载中」。把数据随 HTML 一起送进去最稳。
 * 而额外发请求会让 /workbench/html 变慢，宿主代理对插件请求有 ~2s 超时，超时还会连带
 * 把插件服务拖崩 —— 所以这里直接复用 collectCatalog 时顺手抓下来的前 N 行。
 * @param {object} workbench 工作台条目
 * @returns {Record<string, object>} file → { columns, rows, hash, truncated }
 */
export function buildSeed(workbench) {
  const seed = {}
  const tables = Array.isArray(workbench.tables) ? workbench.tables : []
  for (const table of tables) {
    const matrix = Array.isArray(table.preview) ? table.preview : []
    if (matrix.length === 0) continue
    const converted = matrixToRows(matrix)
    const total = Math.max(0, converted.rows.length)
    seed[table.file] = {
      columns: converted.columns,
      rows: converted.rows.slice(0, SEED_ROWS),
      hash: versionHash(table.version),
      truncated: total > SEED_ROWS,
    }
  }
  return seed
}

export async function handleKhubWorkbenchHtml(res, params, config) {
  const catalog = await getCatalog(config)
  const id = params.get('workbench') || ''
  const workbench = findWorkbench(catalog, id)
  const content = await api.content(config, workbench.nodeId)
  const html = content !== null && typeof content.content === 'string' ? content.content : ''
  if (html === '') throw new KhubError('在线工作台 HTML 内容为空', 'empty-html', 404)
  const seed = buildSeed(workbench)
  const bridge = '<script>' + BRIDGE_SOURCE + '</script>' +
    '<script>' + kbAdapterSource(workbench, seed) + '</script>' + snapshotScript()
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
  const id = params.get('workbench') || ''
  const tableName = params.get('table') || ''
  const probeHash = params.get('hash') || ''

  /* 快速路径：catalog 生成的表名本身就是 `node-<id>.csv`，直接读这个节点就行，
     不必先采一遍「整棵树 + 全部 CSV 表头」。轮询每 2 秒一次，走老路径等于每秒都在
     重建 catalog，iframe 必然撞上桥的 5 秒超时（用户看到的就是「一直加载中」）。
     表名不是这个形状时再退回 catalog 校验。 */
  const fast = /^node-(\d+)\.csv$/i.exec(tableName)
  const fastId = fast === null ? 0 : Number(fast[1])
  /* 只有 catalog 生成的 `khub-<id>` + `node-<id>.csv` 组合才走快速路径，
     别的形状一律回老路径校验，避免任意字符串直接把 nodeId 打进来。 */
  const fastWorkbench = /^khub-(\d+)$/i.test(id)
  let nodeId = fastWorkbench === true && Number.isFinite(fastId) && fastId > 0 ? fastId : 0
  let file = tableName
  let keys = []
  let fields = []
  if (nodeId === 0) {
    const catalog = await getCatalog(config)
    const workbench = findWorkbench(catalog, id)
    const table = findTable(workbench, tableName)
    nodeId = table.nodeId
    file = table.file
    keys = Array.isArray(table.keys) ? table.keys : []
    fields = Array.isArray(table.fields) ? table.fields : []
  }

  const data = await api.csv(config, nodeId)
  const matrix = data !== null && Array.isArray(data.matrix) ? data.matrix : []
  const headers = data !== null && Array.isArray(data.headers) ? data.headers : []
  const hash = versionHash(data === null ? 0 : data.version)
  const size = typeof data.text === 'string' ? Buffer.byteLength(data.text, 'utf8') : 0
  if (probeHash !== '' && probeHash === hash) {
    sendJson(res, { ok: true, changed: false, workbench: id, table: file, hash, mtimeMs: null, size })
    return
  }
  const converted = matrixToRows(matrix)
  const derived = fields.length > 0 ? fields : fieldsFromHeaders(headers)
  sendJson(res, {
    ok: true,
    workbench: id,
    table: file,
    columns: converted.columns.length > 0 ? converted.columns : (keys.length > 0 ? keys : derived.map((f) => f.key)),
    fields: derived,
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
  /* 首屏数据必须随 HTML 一起内联：资料库面板的父窗口**没有**桥监听器，
     页面里的 KB.getCsv 只能走 Workbench.read → postMessage，而这条路从来没通过，
     于是一直停在「加载中」。seed 让 getCsv 命中缓存、零请求直接返回。
     并发读是为了不把 /khub/html 拖慢（宿主代理对插件请求有 ~2s 超时）。 */
  const tables = (await Promise.all(csvNodes.map(async (n) => {
    const base = {
      file: 'node-' + String(n.id) + '.csv',
      name: String(n.name || ('数据表 ' + String(n.id))),
      nodeId: Number(n.id),
    }
    try {
      const data = await api.csv(config, n.id)
      const headers = data !== null && Array.isArray(data.headers) ? data.headers : []
      const matrix = data !== null && Array.isArray(data.matrix) ? data.matrix : []
      const fields = fieldsFromHeaders(headers)
      return Object.assign(base, {
        fields,
        keys: fields.map((f) => f.key),
        version: Number(data !== null && data.version !== undefined ? data.version : 0),
        preview: matrix.slice(0, SEED_ROWS + 1),
      })
    } catch { /* 单表读失败不拖垮整页：页面还能用父窗口桥再取一次 */ return base }
  }))).filter((it) => it !== null)
  const workbench = {
    nodeId: Number(nodeId),
    spaceId: Number(node.spaceId || 0),
    spaceName: String(node.name || ''),
    name: String(node.name || ''),
    tables,
  }
  const seed = buildSeed(workbench)
  const injected = '<script>' + BRIDGE_SOURCE + '</script><script>' + kbAdapterSource(workbench, seed) + '</script>' + snapshotScript()
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

/* ------------------------------------------------------------------ Office 版式级预览（OnlyOffice） */

/**
 * 把 JSON 安全地内联进 `<script>`。
 *
 * '<' 一律替换成字面量 `\u003c`：HTML 解析器看到的是纯文本，数据里即便带
 * `</script>` 也不会提前闭合脚本块。顺带把 U+2028 / U+2029 也转义，避免旧引擎
 * 把字符串字面量断行。用 split/join 而非正则，省去源码里的转义层数。
 *
 * @param {any} value 任意可 JSON 序列化的值
 * @returns {string} 可直接作为 JS 表达式的文本
 */
function inlineJson(value) {
  const lt = '\\u003c'
  const ls = '\\u2028'
  const ps = '\\u2029'
  return JSON.stringify(value)
    .split('<').join(lt)
    .split(String.fromCharCode(0x2028)).join(ls)
    .split(String.fromCharCode(0x2029)).join(ps)
}

/**
 * frame 页面的内联样式：全屏、无边距、加载中 / 错误卡片。
 *
 * frame 是独立文档、拿不到宿主注入的 CSS 变量，所以所有主题色一律写成
 * `var(--dsw-alias-<语义>, <回退值>)`：宿主有变量时自动跟随深浅色，
 * 没有时退回原本的裸色值。#fff 与 rgba() 按约定保留。
 * 不引入 --wb-* / prefers-color-scheme / data-theme。
 */
const OFFICE_FRAME_CSS = `html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}
body{background:var(--dsw-alias-bg-base,#f6f7f8);font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--dsw-alias-label-primary,#1f2328)}
#office-editor{position:absolute;inset:0;width:100%;height:100%}
.dshe-mask{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:var(--dsw-alias-bg-base,#f6f7f8)}
.dshe-loading{font-size:13px;color:var(--dsw-alias-label-secondary,#57606a)}
.dshe-card{width:min(420px,92vw);padding:20px;border:1px solid var(--dsw-alias-border-l1,#e5e7eb);border-radius:12px;background:#fff;box-shadow:0 4px 16px rgba(0,0,0,.06);text-align:center}
.dshe-card-title{margin:0 0 10px;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#1f2328)}
.dshe-card-desc{margin:0 0 16px;font-size:12.5px;color:var(--dsw-alias-label-secondary,#57606a);word-break:break-word;white-space:pre-wrap}
.dshe-card-actions{display:flex;gap:8px;justify-content:center;flex-wrap:wrap}
.dshe-card-btn{height:32px;padding:0 16px;border:1px solid var(--dsw-alias-brand-primary,#0969da);border-radius:6px;background:var(--dsw-alias-brand-primary,#0969da);color:#fff;font-size:12.5px;cursor:pointer}
.dshe-card-btn-ghost{background:transparent;color:var(--dsw-alias-brand-primary,#0969da)}
.dshe-card-btn:hover{opacity:.9}`

/**
 * apiScript 白名单：必须是 http(s) URL，且与 docServerUrl 同源。
 * 任何一条不满足都返回 false，调用方只渲染错误卡片、绝不加载外部脚本。
 *
 * @param {string} apiScript 在线返回的编辑器脚本地址
 * @param {string} docServerUrl 在线返回的 Document Server 地址
 * @returns {boolean}
 */
function officeScriptOriginOk(apiScript, docServerUrl) {
  let scriptUrl = null
  let serverUrl = null
  try { scriptUrl = new URL(apiScript) } catch { return false }
  try { serverUrl = new URL(docServerUrl) } catch { return false }
  if (scriptUrl.protocol !== 'http:' && scriptUrl.protocol !== 'https:') return false
  if (serverUrl.protocol !== 'http:' && serverUrl.protocol !== 'https:') return false
  return scriptUrl.origin === serverUrl.origin
}

/**
 * 从在线 config 组装 DocEditor 配置。
 *
 * - view：强制只读三件套 editorConfig.mode='view'、document.permissions.edit=false、
 *   editorConfig.customization.toolbar=false，杜绝误入编辑；
 * - edit：不覆盖在线返回的 permissions 与 customization（autosave / forcesave /
 *   toolbar / goback 等由在线决定），只把 editorConfig.mode 显式设为 'edit'。
 *   能走到 edit 分支的前提是服务端已校验 `canWrite === true`。
 *
 * 其余字段（callbackUrl / user / lang / 尺寸等）原样保留，避免破坏在线的保存回调。
 *
 * @param {object} raw api.officeConfig 的 R.data
 * @param {string} mode 'view' | 'edit'
 * @returns {object} DocEditor 配置（不含 events，events 在页面脚本里挂函数）
 */
function buildOfficeEditorConfig(raw, mode) {
  const doc = raw.document !== null && typeof raw.document === 'object' ? raw.document : {}
  const perms = doc.permissions !== null && typeof doc.permissions === 'object' ? doc.permissions : {}
  const editor = raw.editorConfig !== null && typeof raw.editorConfig === 'object' ? raw.editorConfig : {}
  const customization = editor.customization !== null && typeof editor.customization === 'object' ? editor.customization : {}
  const isEdit = mode === 'edit'
  const documentConfig = isEdit
    ? Object.assign({}, doc)
    : Object.assign({}, doc, { permissions: Object.assign({}, perms, { edit: false }) })
  const editorConfig = isEdit
    ? Object.assign({}, editor, { mode: 'edit' })
    : Object.assign({}, editor, {
      mode: 'view',
      customization: Object.assign({}, customization, { toolbar: false }),
    })
  return {
    document: documentConfig,
    documentType: raw.documentType,
    editorConfig: editorConfig,
    token: raw.token,
    type: raw.type,
    width: raw.width,
    height: raw.height,
  }
}

/**
 * 生成插件自身同源的「版式级预览 / 编辑」薄 HTML（纯函数，便于单测）。
 *
 * 安全边界：
 *  - 所有内联数据走 inlineJson（'<' 转义），杜绝 `</script>` 注入；
 *  - apiScript 必须 http(s) 且与 docServerUrl 同源，否则只渲染错误卡片、不加载外部脚本；
 *  - PAT / token 只出现在这张服务端生成的 HTML 里，不进面板 state / 日志；
 *  - 所有 parent.postMessage 的 targetOrigin 收敛为 window.location.origin（不再用 '*'）；
 *  - view 强制只读三件套；edit 用在线返回的 permissions / customization，
 *    且只有服务端校验 canWrite===true 之后才会走到这里生成可写编辑器；
 *  - 页面不引用任何外部框架 / CDN，唯一的外部脚本就是白名单里的 apiScript。
 *
 * @param {object|null} officeCfg api.officeConfig(config, id, mode) 的返回值
 * @param {number} nodeId 节点 id（用于 postMessage 回传）
 * @param {string} [errorMessage] 服务端已判定的错误，非空时直接渲染错误卡片
 * @param {string} [mode] 'view' | 'edit'，其余一律按 'view'
 * @returns {string} 完整的 HTML 文档
 */
export function buildOfficeFrameHtml(officeCfg, nodeId, errorMessage, mode) {
  const frameMode = mode === 'edit' ? 'edit' : 'view'
  const raw = officeCfg !== null && typeof officeCfg === 'object' ? officeCfg : {}
  const safeId = Number.isInteger(Number(nodeId)) && Number(nodeId) > 0 ? Number(nodeId) : 0
  const explicitError = typeof errorMessage === 'string' ? errorMessage : ''
  const apiScript = typeof raw.apiScript === 'string' ? raw.apiScript.trim() : ''
  const docServerUrl = typeof raw.docServerUrl === 'string' ? raw.docServerUrl.trim() : ''
  let error = explicitError
  let payload = null
  if (error === '') {
    if (officeCfg === null || typeof officeCfg !== 'object') {
      error = '在线资料库未返回版式配置'
    } else if (frameMode === 'edit' && raw.canWrite !== true) {
      /* 双保险：即便上层漏了权限门槛，纯函数也绝不内联可写 config / token。 */
      error = '没有编辑权限：在线资料库未授予该节点的写权限'
    } else if (!officeScriptOriginOk(apiScript, docServerUrl)) {
      error = '编辑器脚本地址非法或与 Document Server 不同源，已阻止加载'
    } else {
      payload = {
        apiScript: apiScript,
        cfg: buildOfficeEditorConfig(raw, frameMode),
        meta: {
          mode: frameMode,
          canWrite: raw.canWrite === true,
          nodeVersion: raw.nodeVersion === undefined ? null : raw.nodeVersion,
        },
      }
    }
  }
  const inlineJs = `(function () {
  'use strict';
  var NODE_ID = ${safeId};
  var FRAME_MODE = ${inlineJson(frameMode)};
  var PAYLOAD = ${inlineJson(payload)};
  var ERROR_TEXT = ${inlineJson(error)};
  /* targetOrigin 收敛到页面自身 origin：frame 由插件同源提供，不再向 '*' 广播。 */
  var ORIGIN = window.location.origin;
  var maskEl = document.getElementById('dshe-mask');
  var docDirty = false;
  var everDirty = false;
  function post(type, extra) {
    var msg = { type: type, id: NODE_ID };
    if (extra && typeof extra === 'object') {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) msg[k] = extra[k];
      }
    }
    try { parent.postMessage(msg, ORIGIN); } catch (e) { /* 父窗口已卸载 */ }
  }
  window.dsheOfficeFallback = function (target) {
    post('dshe:office:fallback', { target: target === 'preview' ? 'preview' : 'light' });
  };
  function cardButton(label, target, ghost) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dshe-card-btn' + (ghost === true ? ' dshe-card-btn-ghost' : '');
    btn.textContent = label;
    btn.onclick = function () { window.dsheOfficeFallback(target); };
    return btn;
  }
  function renderError(message) {
    var text = String(message || '版式编辑加载失败');
    if (maskEl) {
      maskEl.innerHTML = '';
      var box = document.createElement('div');
      box.className = 'dshe-card';
      var title = document.createElement('div');
      title.className = 'dshe-card-title';
      title.textContent = FRAME_MODE === 'edit' ? '版式编辑不可用' : '版式预览不可用';
      var desc = document.createElement('div');
      desc.className = 'dshe-card-desc';
      desc.textContent = text;
      var actions = document.createElement('div');
      actions.className = 'dshe-card-actions';
      if (FRAME_MODE === 'edit') actions.appendChild(cardButton('切回预览', 'preview', true));
      actions.appendChild(cardButton('切回轻量视图', 'light', false));
      box.appendChild(title); box.appendChild(desc); box.appendChild(actions);
      maskEl.appendChild(box);
    }
    post('dshe:office:error', { message: text, mode: FRAME_MODE });
  }
  function hideMask() {
    if (maskEl && maskEl.parentNode) maskEl.parentNode.removeChild(maskEl);
  }
  if (ERROR_TEXT !== '') { renderError(ERROR_TEXT); return; }
  if (!PAYLOAD || typeof PAYLOAD.apiScript !== 'string' || PAYLOAD.apiScript === '') {
    renderError('编辑器配置缺失'); return;
  }
  var cfg = PAYLOAD.cfg;
  var meta = PAYLOAD.meta;
  cfg.events = {
    onRequestClose: function () {
      post('dshe:office:close', { dirty: docDirty === true, mode: FRAME_MODE });
    },
    onError: function (e) {
      var detail = e && (e.message || e.error) ? String(e.message || e.error) : '';
      renderError(detail === '' ? '编辑器内部错误' : detail);
    }
  };
  if (FRAME_MODE === 'edit') {
    /* OnlyOffice 在「有未保存改动 → 全部改动已保存」时回调 data=false。
       只有真实经历 dirty→clean 才发 saved：加载完成、纯打开文档都不伪造「已保存」。
       注意这是编辑器侧状态信号，在线资料库的版本写入由 callbackUrl 异步完成。 */
    cfg.events.onDocumentStateChange = function (e) {
      var changed = e !== null && typeof e === 'object' && e.data === true;
      if (changed === true) { docDirty = true; everDirty = true; return; }
      if (docDirty === true && everDirty === true) {
        docDirty = false;
        post('dshe:office:saved', { nodeVersion: meta.nodeVersion, mode: 'edit' });
      } else {
        docDirty = false;
      }
    };
  }
  var tag = document.createElement('script');
  tag.src = PAYLOAD.apiScript;
  tag.onload = function () {
    if (!window.DocsAPI || typeof window.DocsAPI.DocEditor !== 'function') {
      renderError('编辑器脚本已加载，但未找到 DocsAPI.DocEditor'); return;
    }
    try {
      new window.DocsAPI.DocEditor('office-editor', cfg);
      hideMask();
      post('dshe:office:ready', {
        mode: FRAME_MODE,
        canWrite: meta.canWrite === true,
        nodeVersion: meta.nodeVersion
      });
    } catch (err) {
      renderError('编辑器初始化失败：' + String(err && err.message ? err.message : err));
    }
  };
  tag.onerror = function () { renderError('编辑器脚本加载失败，请检查 Document Server 是否可访问'); };
  document.head.appendChild(tag);
}());`
  const title = frameMode === 'edit' ? '版式编辑' : '版式预览'
  const loading = frameMode === 'edit' ? '正在加载版式编辑…' : '正在加载版式预览…'
  return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    '<title>' + title + '</title>\n<style>' + OFFICE_FRAME_CSS + '</style>\n</head>\n<body>\n' +
    '<div id="office-editor"></div>\n' +
    '<div id="dshe-mask" class="dshe-mask"><div class="dshe-loading">' + loading + '</div></div>\n' +
    '<script>' + inlineJs + '</' + 'script>\n</body>\n</html>'
}

/**
 * GET /khub/office/frame?id=<nodeId>&mode=view|edit —— 服务端带 PAT 取 OnlyOffice
 * config，返回一张插件自身同源的薄 HTML，浏览器在里面 new DocsAPI.DocEditor。
 *
 * 权限门槛：mode=edit 时先向在线取 edit config 并校验 `canWrite === true`；
 * 为 false / 缺失 / 401 / 403 一律**不**生成可写编辑器（也不内联可写 config，
 * 即不下发 token / 签名直链 / edit 权限），只渲染带「切回预览」与「切回轻量视图」
 * 按钮的错误卡片，并把原因通过 dshe:office:error 发给父面板。
 * 保存由在线资料库的 callbackUrl 异步完成，插件侧不阻塞、不伪造版本号。
 *
 * @param {import('node:http').ServerResponse} res
 * @param {URLSearchParams} params
 * @param {object} config 运行时配置
 * @param {string} [requestedMode] index.js 显式透传的 mode；缺省时回落到 params
 * @returns {Promise<void>}
 */
export async function handleKhubOfficeFrame(res, params, config, requestedMode) {
  const rawId = String(params.get('id') || '').trim()
  const nodeId = Number(rawId)
  const mode = requestedMode === 'edit' || requestedMode === 'view'
    ? requestedMode
    : (String(params.get('mode') || 'view') === 'edit' ? 'edit' : 'view')
  if (!Number.isInteger(nodeId) || nodeId <= 0) {
    sendHtml(res, buildOfficeFrameHtml(null, 0, '缺少合法的文档 id', mode))
    return
  }
  let officeCfg = null
  let errorMessage = ''
  let effectiveCanWrite = false
  try {
    const raw = await api.officeConfig(config, nodeId, mode)
    if (mode === 'edit' && (raw === null || typeof raw !== 'object' || raw.canWrite !== true)) {
      errorMessage = '没有编辑权限：在线资料库未授予该节点的写权限'
    } else {
      officeCfg = raw
      if (mode === 'edit') {
        effectiveCanWrite = true
      } else {
        /* 在线 view config 的 canWrite 恒为 false（它表示「当前 mode 是否可写」，
           不是用户权限）。为了让面板在只读预览态也能显示「编辑」入口，这里只取一次
           edit config 的 canWrite 做服务端权限判定；那份可写 config（含 token、
           签名直链、edit 权限）绝不内联进 view frame，也不下发给面板 JS。 */
        try {
          const probe = await api.officeConfig(config, nodeId, 'edit')
          effectiveCanWrite = probe !== null && typeof probe === 'object' && probe.canWrite === true
        } catch { effectiveCanWrite = false }
      }
    }
  } catch (error) {
    const status = error !== null && typeof error === 'object' ? Number(error.status || 0) : 0
    const prefix = status === 401 || status === 403 ? '（HTTP ' + String(status) + '）' : ''
    errorMessage = '读取在线版式配置失败' + prefix + '：' + String((error && error.message) || error)
  }
  /* 把「用户是否可写」以布尔量交给 frame 的 ready 消息；不改可写 editorConfig 本身。 */
  const framedCfg = officeCfg === null ? null : Object.assign({}, officeCfg, { canWrite: effectiveCanWrite })
  sendHtml(res, buildOfficeFrameHtml(framedCfg, nodeId, errorMessage, mode))
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
    /* 在线资料库新增的「当前页分享（静态快照）」：mode=SNAPSHOT + 冻结后的 HTML。
       LIVE 时这两个字段留 undefined，JSON.stringify 会忽略，后端走原有逻辑。 */
    mode: typeof b.mode === 'string' && b.mode !== '' ? String(b.mode).toUpperCase() : undefined,
    snapshotHtml: typeof b.snapshotHtml === 'string' && b.snapshotHtml !== '' ? b.snapshotHtml : undefined,
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
  /* Office 专用：401 / 403 原样映射（HTTP status 与 code 都进响应体），
     让前端能明确判定「无权限」而不是笼统的 502；其余沿用同一格式。 */
  const officeFail = (error) => {
    const out = fail(error)
    return { status: out.status, body: Object.assign({ status: out.status }, out.body) }
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
    /* ---- Office 版式级预览（OnlyOffice / WPS）能力探测 ----
       只下发非敏感字段；在线不可用 / 未配置时由 officeFail 或上面的
       configReady 分支给出可判定错误，前端一律静默回退到内置轻量视图。 */
    if (route === '/khub/office/status' && method === 'GET') {
      try {
        const status = await api.officeStatus(config)
        const src = status !== null && typeof status === 'object' ? status : {}
        return {
          status: 200,
          body: {
            ok: true,
            provider: typeof src.provider === 'string' ? src.provider : '',
            enabled: src.enabled === true,
            docServerUrl: typeof src.docServerUrl === 'string' ? src.docServerUrl : '',
            backendUrl: typeof src.backendUrl === 'string' ? src.backendUrl : '',
            jwtConfigured: src.jwtConfigured === true,
            wpsConfigured: src.wpsConfigured === true,
          },
        }
      } catch (error) {
        return officeFail(error)
      }
    }
    /* 代取 OnlyOffice config：只透传构建 frame 需要的字段，绝不下发 PAT / 密钥。
       面板正常流程不调它（改用服务端渲染的 /khub/office/frame），token 不进面板 state。
       mode=edit 必须由在线确认 canWrite===true 才能下发可写 config / token，
       否则返回 403 forbidden（且响应体里不含 token）。view 保持原样。 */
    if (route === '/khub/office/config' && method === 'GET') {
      try {
        const nodeId = Number(idOf('id'))
        if (!Number.isInteger(nodeId) || nodeId <= 0) {
          return { status: 400, body: { ok: false, error: '缺少合法的 id', code: 'invalid-id', status: 400 } }
        }
        const mode = String(query.get('mode') || 'view') === 'edit' ? 'edit' : 'view'
        const raw = await api.officeConfig(config, nodeId, mode)
        const src = raw !== null && typeof raw === 'object' ? raw : {}
        if (mode === 'edit' && src.canWrite !== true) {
          return { status: 403, body: { ok: false, code: 'forbidden', error: '没有编辑权限', status: 403 } }
        }
        return {
          status: 200,
          body: {
            ok: true,
            documentType: src.documentType,
            document: src.document,
            editorConfig: src.editorConfig,
            type: src.type,
            width: src.width,
            height: src.height,
            token: src.token,
            provider: src.provider,
            docServerUrl: src.docServerUrl,
            apiScript: src.apiScript,
            nodeVersion: src.nodeVersion,
            canWrite: src.canWrite,
          },
        }
      } catch (error) {
        return officeFail(error)
      }
    }
    /* 新建空间：工作台「目录位置」确认环节用（用户不想放进现有空间）。
       与在线 POST /api/spaces 同构，只透传 name / type / description / icon。 */
    if (route === '/khub/space' && method === 'POST') {
      const payload = body !== null && typeof body === 'object' ? body : {}
      const created = await api.createSpace(config, payload)
      invalidateCatalog()
      return { status: 200, body: { ok: true, space: created } }
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
    /* Office 内置编辑：读成段落 / 单元格矩阵，改完回写成新版本。 */
    if (route === '/khub/office') {
      const nodeId = idOf('id')
      if (nodeId === '') return { status: 400, body: { ok: false, error: '缺少 id' } }
      const raw = await api.node(config, nodeId)
      const detail = raw !== null && typeof raw === 'object' && raw.node !== null && typeof raw.node === 'object' ? raw.node : raw
      const name = String((detail && detail.name) || '')
      const nodeType = String((detail && detail.nodeType) || '').toUpperCase()
      if (method === 'GET') {
        const raw = await khubBinary(config, '/api/nodes/' + encodeURIComponent(nodeId) + '/raw')
        const model = readOffice(raw.buffer, name)
        return {
          status: 200,
          body: {
            ok: true,
            node: { id: Number(nodeId), name, nodeType, version: detail && detail.version !== undefined ? Number(detail.version) : null },
            model,
          },
        }
      }
      if (method === 'POST') {
        const payload = body !== null && typeof body === 'object' ? body : {}
        if (payload.model === null || typeof payload.model !== 'object') {
          return { status: 400, body: { ok: false, error: '缺少 model' } }
        }
        const raw = await khubBinary(config, '/api/nodes/' + encodeURIComponent(nodeId) + '/raw')
        const out = writeOffice(raw.buffer, name, payload.model)
        const saved = await uploadBinary(config, nodeId, out, name, detail && detail.mime ? String(detail.mime) : '')
        invalidateCatalog()
        return { status: 200, body: { ok: true, version: saved.version, size: saved.size } }
      }
      return { status: 405, body: { ok: false, error: '仅支持 GET / POST' } }
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
  getCatalog, invalidateCatalog, versionHash, kbAdapterSource, SNAPSHOT_HELPER_SOURCE,
  handleKhubWorkbenchList, handleKhubWorkbenchHtml, handleKhubWorkbenchDataGet,
  handleKhubWorkbenchDataPost, handleKhubHtml, handleKhubRaw, handleKhubApi,
  buildOfficeFrameHtml, handleKhubOfficeFrame,
}
