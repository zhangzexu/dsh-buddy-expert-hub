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
  var seq = 0;
  var pending = {};
  var dataHandlers = [];
  var conflictHandlers = [];
  var themeHandlers = [];
  var themeState = { scheme: 'light', tokens: {} };
  function call(kind, payload) {
    return new Promise(function (resolve, reject) {
      var id = 'wb-' + (++seq) + '-' + String(Date.now());
      var timer = setTimeout(function () {
        delete pending[id];
        reject(new Error('工作台请求超时（5 秒）'));
      }, 5000);
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
    /* 只接受父窗口回信，避免同页其它窗口伪造 push / response 毒化页面数据。
       顶层直接打开 HTML 调试时 window.parent === window，此时跳过这层校验。 */
    if (window.parent !== window && event.source !== window.parent) return;
    if (d.kind === 'response' && pending[d.requestId]) {
      var p = pending[d.requestId];
      clearTimeout(p.timer);
      delete pending[d.requestId];
      if (d.ok === true) p.ok(d.payload);
      else p.fail(new Error(String((d.payload && d.payload.error) || '工作台请求失败')));
      return;
    }
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
      root.style.colorScheme = scheme;
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
