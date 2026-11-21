/**
 * dsh-buddy-expert-hub — iframe 侧 postMessage 桥。
 * iframe 使用 sandbox="allow-scripts"（不给 allow-same-origin），是 opaque origin，
 * 无法直接 fetch 插件 API；所有数据读写由父组件代理，父组件校验来源与消息类型。
 *
 * 外观：iframe 是独立文档，拿不到宿主的 CSS 变量。父组件会在页面 ready 后、
 * 以及宿主外观变化时下发 `kind:"theme"`（payload = { scheme, tokens }），
 * 本桥把它写到 documentElement 的内联样式与 data-dsh-theme 上，
 * 页面即可用 `var(--dsw-alias-bg-base, 回退)` 跟随宿主深浅色。
 * @module dsh-buddy-expert-hub/workbench-bridge
 */
export const BRIDGE_MAGIC = '__wb:1'

export const BRIDGE_SOURCE = String.raw`
(function () {
  var MAGIC = '__wb:1';
  /* 请求超时：在线资料库走远端，冷启动（首屏要采 catalog + 读表）偶尔会慢到 5 秒以上，
     原来卡在 5 秒会让页面直接显示「工作台请求超时」。给到 20 秒，慢也比失败好。 */
  var TIMEOUT_MS = 20000;
  var seq = 0;
  var pending = {};
  /* 最近一次收到父窗口回信的时间戳（诊断用：0 表示从未收到） */
  var lastResponseAt = 0;
  /* 最近一次收到父窗口**任意**消息的时间 + 父窗口自报的收发计数（诊断用） */
  var lastParentMsgAt = 0;
  var parentInfo = null;
  var dataHandlers = [];
  var conflictHandlers = [];
  var themeHandlers = [];
  var themeState = { scheme: 'light', tokens: {} };
  function call(kind, payload) {
    return new Promise(function (resolve, reject) {
      var id = 'wb-' + (++seq) + '-' + String(Date.now());
      var timer = setTimeout(function () {
        delete pending[id];
        reject(new Error('工作台请求超时（' + String(Math.round(TIMEOUT_MS / 1000)) + ' 秒）'));
      }, TIMEOUT_MS);
      pending[id] = { ok: resolve, fail: reject, timer: timer };
      try {
        window.parent.postMessage({ magic: MAGIC, kind: kind, requestId: id, payload: payload || {} }, '*');
      } catch (error) {
        clearTimeout(timer);
        delete pending[id];
        reject(error);
      }
    });
  }
  window.addEventListener('message', function (event) {
    var d = event && event.data;
    if (!d || d.magic !== MAGIC) return;
    lastParentMsgAt = Date.now();
    /* 父窗口每秒一条 ping，带上它自己「收到几条 / 回了几个」，用来判断是哪个方向断了 */
    if (d.kind === 'ping') { parentInfo = d.payload || null; return; }
    /* 来源校验分两档：
       - response：靠 requestId 兜底（只有发起方知道这个 id），因此 event.source 不一致也放行。
         Electron 的 sandbox / webview 组合下 source 经常不是 window.parent，
         严格比较会把真实回信全丢掉，页面就永远停在「加载中」。
       - push / conflict / theme：没有 requestId，仍要求来自父窗口，防止同页其它窗口伪造数据。 */
    if (d.kind === 'response' && pending[d.requestId]) {
      lastResponseAt = Date.now();
      var p = pending[d.requestId];
      clearTimeout(p.timer);
      delete pending[d.requestId];
      if (d.ok === true) p.ok(d.payload);
      else p.fail(new Error(String((d.payload && d.payload.error) || '工作台请求失败')));
      return;
    }
    if (window.parent !== window && event.source !== null && event.source !== window.parent) return;
    if (d.kind === 'push') {
      dataHandlers.forEach(function (fn) { try { fn(d.payload); } catch (e) {} });
      return;
    }
    if (d.kind === 'theme') {
      applyTheme(d.payload);
      return;
    }
    if (d.kind === 'conflict') {
      conflictHandlers.forEach(function (fn) { try { fn(d.payload); } catch (e) {} });
    }
  });
  /* 宿主 token 落到本页 :root：同名 --dsw-alias-* + data-dsh-theme 标记。
     页面只要写 var(--dsw-alias-bg-base, #fff) 就自动跟随深浅色。 */
  function applyTheme(payload) {
    var data = payload !== null && typeof payload === 'object' ? payload : {};
    var tokens = data.tokens !== null && typeof data.tokens === 'object' ? data.tokens : {};
    var root = document.documentElement;
    for (var name in tokens) {
      if (Object.prototype.hasOwnProperty.call(tokens, name)) {
        var value = String(tokens[name]);
        if (value !== '') {
          try { root.style.setProperty('--dsw-alias-' + name, value); } catch (e) {}
        }
      }
    }
    var scheme = data.scheme === 'dark' ? 'dark' : 'light';
    themeState = { scheme: scheme, tokens: tokens };
    try {
      root.setAttribute('data-dsh-theme', scheme);
      /* color-scheme 会把原生 select / date / 滚动条整体换成深色。
         页面若自己声明了 color-scheme（自带主题），尊重它，不要覆盖。 */
      var ownScheme = '';
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        ownScheme = String(window.getComputedStyle(root).colorScheme || '').trim();
      }
      if (ownScheme === '' || ownScheme === 'normal') root.style.colorScheme = scheme;
    } catch (e) {}
    themeHandlers.forEach(function (fn) { try { fn(themeState); } catch (e) {} });
  }
  window.Workbench = {
    ready: function () { return call('ready', {}); },
    read: function (payload) { return call('read', payload || {}); },
    write: function (payload) { return call('write', payload || {}); },
    onData: function (fn) { if (typeof fn === 'function') dataHandlers.push(fn); },
    onConflict: function (fn) { if (typeof fn === 'function') conflictHandlers.push(fn); },
    /* 当前宿主外观：{ scheme:'light'|'dark', tokens:{...} }，未收到前 scheme 为 light。 */
    theme: function () { return themeState; },
    /* 诊断：发出去多少请求、还有几个在等、最近一次回信是什么时候。页面卡住时用它定位。 */
    __stat: function () {
      var n = 0;
      for (var k in pending) {
        if (Object.prototype.hasOwnProperty.call(pending, k)) n += 1;
      }
      return {
        sent: seq, pending: n, lastResponseAt: lastResponseAt,
        lastParentMsgAt: lastParentMsgAt, parentInfo: parentInfo
      };
    },
    /* 外观变化回调：注册时若已有 token 会立刻回调一次，页面无需关心时序。 */
    onTheme: function (fn) {
      if (typeof fn !== 'function') return;
      themeHandlers.push(fn);
      if (themeState.tokens['bg-base'] !== undefined) {
        try { fn(themeState); } catch (e) {}
      }
    }
  };
  if (document && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { window.Workbench.ready().catch(function () {}); });
  } else {
    window.Workbench.ready().catch(function () {});
  }
})();
`;

export default { BRIDGE_MAGIC, BRIDGE_SOURCE }
