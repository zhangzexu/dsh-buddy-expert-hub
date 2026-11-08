# 小程序接入云数据

只替换数据层，页面和应用保持不变。新建项目选云端保存时，页面从一开始就调用数据层，不经过本地存储版本。

开通、建表、权限、登录规则、SDK 安装与初始化均以 `cloud-service` 为准。

## 可复制资产

读取资产原文后复制进工程，工程内不引用 Skill 安装路径。

| 资产 | 复制到 | 作用 |
|---|---|---|
| `skills/cloud-service/assets/miniprogram-diagnostics.js` | `utils/workbuddy-cloud-diagnostics.js` | 失败请求诊断，接入方式见 `cloud-service` 的诊断文档 |
| `skills/cloud-service/assets/miniprogram-data-access.js` | `utils/workbuddy-data-access.js` | 一张表的增删改查封装 |
| `skills/cloud-service/assets/miniprogram-login-panel/login-panel.{wxml,wxss,js,json}` | `components/login-panel/` | 邮箱验证码登录组件 |

## 数据访问

`createTableAccess(cloud, { table, columns, fromRow, toRow, orderBy })` 返回 `list`、`create`、`update`、`remove`，都返回 `{ data, error }`，不会 reject：

- `cloud` 是 `createMiniProgramWorkBuddyCloud` 返回的客户端，入口为 `cloud.database.from(table)`。
- `toRow` 只返回本次要提交的字段，没有可写字段时返回 `INVALID_PAYLOAD`，不发请求。
- 不注入归属字段，归属由表定义和权限策略决定。
- `update`、`remove` 命中 0 行返回 `NOT_FOUND_OR_FORBIDDEN`。
- id 无效返回 `INVALID_ID`，底层异常返回 `CLIENT_EXCEPTION`。

接入步骤：

1. 在 `utils/cloud.js` 导出 `{ cloud }`。
2. 复制数据访问资产，用 `createTableAccess` 生成数据访问对象，替换页面中原有的本地读写调用。
3. 页面读写改为异步，错误展示 `error.message`，与数据无关的 UI 保持不变。
4. 保存后修复已报告的原生校验问题。

## 登录组件

组件依赖 `utils/cloud.js` 导出的 `{ cloud }`，登录成功触发 `signedin` 事件，只处理登录，不处理页面数据。

页面接入：

- 页面 `json` 的 `usingComponents` 加入 `"login-panel": "../../components/login-panel/login-panel"`。
- `app.js` 提供会话缓存，登录或退出后重置：

```js
const { cloud } = require('./utils/cloud');

App({
    ensureSession() {
        if (!this.sessionPromise) {
            this.sessionPromise = cloud.auth.getSession();
        }
        return this.sessionPromise;
    },
    resetSession() {
        this.sessionPromise = null;
    },
});
```

- 页面 `authState` 取 `checking` / `signed-out` / `signed-in`。`onShow` 调用 `restore()`：先置 `checking`，再 `await getApp().ensureSession()`；`error` 或无 `session` 时 `resetSession()`、置 `signed-out` 并清空本页数据；否则置 `signed-in` 后加载数据。WXML 里三种状态分别显示加载态、`<login-panel bind:signedin="onSignedIn" />`、业务内容。
- `onSignedIn` 先 `getApp().resetSession()` 再 `restore()`。
- 退出：`await cloud.auth.signOut()`，随后 `getApp().resetSession()` 再 `restore()`。
- tabBar 的各页面各自在 `onShow` 重新检查。

## 交付核对

- 已完成项只包含实际做到的。
- H5 预览无法做真实微信登录，也不能证明真机读写；真机或体验版验证之前，不得声称读写可用。
- 本地已有数据不会自动上云；需要迁移时与用户另行确认。
