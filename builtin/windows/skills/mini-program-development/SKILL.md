---
name: mini-program-development
description: 在 WorkBuddy 内创建、修改、预览和托管发布微信小程序。适用于静态小程序，或需要数据库、登录、文件、LLM 等云服务的小程序；发布、上线、小程序码和小程序代码问题也使用此 Skill；需要微信开发者工具编译、模拟器、真机预览或真机调试时同样使用。
description_en: Develop, preview, validate, and publish WeChat mini programs inside WorkBuddy. Use for static or cloud-enabled mini programs, publishing, release, QR-code, and mini-program code issues, and when WeChat DevTools compilation, simulator, real-device preview or debugging is needed.
license: Internal
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Skill, ToolSearch, DeferExecuteTool, AskUserQuestion, workbuddy_miniprogram_scaffold, workbuddy_cloud_service, workbuddy_sites_deploy, workbuddy_sites_unpublish
disable: false
---

# WorkBuddy 小程序开发

本 Skill 负责 WorkBuddy 内的小程序开发闭环：生成原生工程、预览、代码方法论、微信开发者工具的编译与真机调试、发布前预检和托管发布指引。

当用户明确说「小程序 / 微信小程序 / mini program / miniprogram」时，直接进入本 Skill，不再反问「网页还是小程序」。
仍可继续澄清产品需求（例如存储、数据同步、登录、云服务）。

- 静态小程序：不使用云服务，仍可在 WorkBuddy 内预览和发布。
- 云服务小程序：在原小程序工程和原应用上增加服务能力；仅在确实需要数据、登录、文件、LLM 或微信虚拟支付/xpay 时加载 `cloud-service`。
- IDE：微信开发者工具用于本地编译、模拟器、真机预览与调试，与云服务可以共存；分支与流程见 [微信开发者工具与真机调试](references/wechat-devtools.md)。

## 开发流程

1. 先检查是否已有小程序工程。已有工程必须增量修改，**不得**调用 `workbuddy_miniprogram_scaffold`，也不得迁移其技术栈。
2. 新建项目在 scaffold 之前确定数据存放方式：本地存储，或云端保存。需求没有说明时，只就这一项向用户确认一次，不顺带询问功能清单；需求已经明确的不再确认。
3. 对独立空目录调用 `workbuddy_miniprogram_scaffold`。工具成功后读取 [模板使用约定](references/templates.md) 和 [原生工程约束](references/native-project.md)，只增量生成用户需求相对基础模板的业务差异；不得从空目录手工重造基础文件。scaffold 之后先看 [页面骨架](references/skeletons.md) 的选择表，有匹配的骨架时读取并按需取用，没有匹配的直接实现；骨架是起点，可整体采用、部分采用或不采用。
4. 选本地存储走静态路径：先完成本地交互、原生预览和可发布工程；不调用云服务。选云端保存时，在 scaffold 之后、写页面之前完成第 5 步的云服务接入，页面从一开始就基于云数据层，不先写本地存储版再改写。
5. 确认需要数据、登录、文件或 LLM 时，加载 `cloud-service`，在当前工程上接入。已有静态工程增量接入云数据，或新建项目选择云端保存时，先读 [小程序接入云数据](references/cloud-upgrade.md)，复用其中的资产，只替换数据层，不重写页面；其中包含可直接取用的登录组件。
6. 在保存代码后修复已报告的原生校验问题。预览成功不等于原生编译或发布成功。
7. 新建项目开始时，按 [微信开发者工具与真机调试](references/wechat-devtools.md) 检测本机是否已安装微信开发者工具；需求出现编译、模拟器、真机预览、真机调试、微信开发者工具等表述时，按其中的分支处理。检测到已安装但需求没有这些表述时，不自动打开，不自动进入 IDE 流程，只在开发与校验完成后按其中的分支询问。
8. 小程序开发完成并通过基础校验后，默认加载 `sites` 创建或复用小程序应用，并交付一张 `.genie` 应用卡用于预览。
   - 这是应用注册与预览，不是开通 cloud-service，也不是微信发布。
   - 小程序源文件不要通过 `present_files` 生成多张独立产物卡，仅交付工具返回的 `genieFilePath`。
   - 后续若用户需要发布，可在该应用预览面板右上角点击「分享 / Share」进入试用、绑定、上传、提审和正式发布。

## 代码问题与发布恢复

先按 [校验与错误码方法论](references/validation-and-recovery.md) 避免和修复确定的代码问题。

- 可前置发现的问题：修复后重复相应校验；不要声称未执行的校验通过。
- Genie BaaS 返回微信错误后：只有其权威结果分类为代码或配置问题时，才按本 Skill 方法论修复；授权、账号、频率、审核和平台限制直接采用 Genie BaaS 的用户文案。
- 不得为通过校验而删除用户需要的插件、云能力或业务功能。
- WorkBuddy 本地 daemon 可以执行已有的确定性源码优化；必须记录优化动作并重新校验。需要理解业务语义的修改由 Agent 完成。

## 交付要求

完成后说明实际执行的预览和校验结果，以及未执行或无法覆盖的部分。

发布回答必须包含：

1. 点击小程序产物卡片打开预览；
2. 在预览右上角点击「分享 / Share」；
3. 可选试用小程序或绑定已有小程序；
4. 不要要求用户通过微信开发者工具手工上传。

发布、上线、小程序码相关问题，按 [预览与托管发布](references/delivery.md) 的界面知识回答。
