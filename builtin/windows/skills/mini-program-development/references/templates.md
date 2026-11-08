# 小程序模板使用约定

## 当前基础模板

- 模板 ID：`workbuddy-native-basic`
- 模板版本：`1.0.0`
- 展开工具：`workbuddy_miniprogram_scaffold`

该版本只提供一个原生微信小程序基础模板：无 npm、无云服务、无 Taro。模板包含严格 JSON、完整首页，以及 loading / empty / error 三态示例。

模板内容来自真实资产目录 `assets/templates/native-basic/1.0.0/`（含 `manifest.json` 与工程文件），`workbuddy_miniprogram_scaffold` 必须按 manifest 校验后再展开。

新建项目必须由展开工具写入基础文件。工具成功后，以展开结果为稳定基线，仅增量修改用户需求涉及的页面、样式、交互和能力；不得跳过工具并从空目录重造 `project.config.json`、`app.json`、首页等基础文件。

已有工程不得调用展开工具。保留其目录结构、技术栈与已有文件，只做需求范围内的增量修改。

## 三层模板方向

后续模板能力按三层演进，当前只实现第一层：

1. **基础稳定层**：版本化原生工程、严格配置、首页骨架和通用状态表达。本期的 `workbuddy-native-basic@1.0.0` 属于此层。
2. **业务能力层**：按明确产品需求叠加登录、数据、文件等可复用能力；本期不提供业务模板。
3. **场景差异层**：Agent 根据用户当前需求增量生成页面内容、视觉样式和业务交互，不固化为通用模板。

## 稳定写法

后续开发应复用基础模板中的稳定写法：

- `app.json` 保持严格 JSON，并保留 `"lazyCodeLoading": "requiredComponents"`；
- 使用原生 WXML、WXSS 和页面 JS，不引入浏览器 API、React 或 Taro；
- 页面资源、组件、`include` / `import` 和 WXSS `@import` 使用大小写一致的本地相对引用；
- loading、empty、error 与正常内容由简单 data 状态切换，复杂计算留在页面 JS；
- 扩展业务时修改必要文件，不覆盖与需求无关的模板内容，不另造第二套基础入口。
