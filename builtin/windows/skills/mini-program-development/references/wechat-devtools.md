# 微信开发者工具与真机调试

微信开发者工具（IDE）用于本地加载、编译、模拟器、真机预览和调试。IDE 与云服务可以共存：打开 IDE 或在 IDE 中调试，复用工程已有的应用绑定、配置和数据，不重新创建、不重新激活云服务。

## IDE 信号

出现以下任一表述，视为需要 IDE：微信开发者工具、编译、模拟器、真机预览、真机调试、自动化测试、性能分析。

- 否定或引用语境不算信号，例如「不用开发者工具，直接发布」仍是发布请求。
- 已有小程序工程上的页面新增、功能修改、缺陷修复是普通开发，不属于 IDE 信号。
- 本机已安装 IDE 不构成 IDE 信号，不自动打开，不自动进入 IDE 流程。

## 本机检测

新建项目开始时检测一次。用 `Bash` 只判断下表文件是否存在，不启动任何进程：

| 系统 | 判定为已安装的文件 |
|---|---|
| macOS | `/Applications/wechatwebdevtools.app/Contents/MacOS/cli` 或 `~/Applications/wechatwebdevtools.app/Contents/MacOS/cli` |
| Windows | `%ProgramFiles(x86)%\Tencent\微信web开发者工具\cli.bat`、`%ProgramFiles%\Tencent\微信web开发者工具\cli.bat` 或 `%LOCALAPPDATA%\Programs\Tencent\微信web开发者工具\cli.bat` |

其他系统不支持 IDE，按未检测到处理。只检查上表的默认位置。

## 分支

| IDE 信号 | 本机检测 | 行为 |
|---|---|---|
| 无 | 未检测到 | 快速本地开发，WorkBuddy 基础预览，不提 IDE。 |
| 无 | 已检测到 | 先完成快速本地开发与源码、配置校验。完成后用 `AskUserQuestion` 询问：使用本地 IDE 做模拟器预览、真机预览或调试；或不使用 IDE，仅在 WorkBuddy 内生成应用。选择使用 IDE 进入 IDE 工作流；选择不使用则走 WorkBuddy 应用链路，后续仍可从预览底部的入口手动用 IDE 打开。 |
| 有 | 已检测到 | 进入 IDE 工作流。 |
| 有 | 未检测到 | 询问是否安装微信开发者工具。同意则进入 IDE 工作流；拒绝则继续本地源码开发与静态校验，并明确说明无法完成编译、调试、模拟器和真机运行时验证。 |

云服务需求与 IDE 需求同时出现时，云服务按 `cloud-service` 处理，IDE 工作流照常进入，两者互不替代。

## IDE 工作流

IDE 工作流由 `wechatide-skill` 提供，以参考资料的方式使用：获取、阅读、照做。

- 不通过 Skill 工具加载，不注册为 skill。
- 不写入 `$WORKBUDDY_CONFIG_DIR/skills/`（默认 `~/.workbuddy/skills/`）及宿主扫描的任何位置。
- 它自带的脚本可以执行。
- 它的路由表中的 `cloudbase-operator` 场景不进入；后端能力按 `cloud-service`。

### 本地已有资料

检查 `$WORKBUDDY_CONFIG_DIR/references/wechatide-skill/`（默认 `~/.workbuddy/references/wechatide-skill/`）。

- 存在：跳过获取，直接阅读。不比较版本，不为刷新而重新下载。
- 不存在：按下一节获取。
- 读到的内容与用户 IDE 的实际行为矛盾时，删除该目录并重新获取一次。

### 获取

版本清单只从下面这个地址取，原样使用，不改主机和路径：

```
https://devtools.wxqcloud.qq.com.cn/WechatWebDev/skills/wechatide-skill/version.json
```

清单请求失败（网络错误、非 200、JSON 无法解析、缺少 `downloadUrl`），停止并告知用户。不循环重试，不换来源，不猜测下载地址。

`downloadUrl` 是唯一的动态值，下载前三项都要通过：

1. 以 `https://` 开头。
2. 前缀为 `https://devtools.wxqcloud.qq.com.cn/WechatWebDev/skills/`。
3. 文件名符合 `wechatide-skill-<semver>.zip`。

任一项不通过：停止并告知用户，不重试，不换来源，不拼接地址。

解压前检查压缩包条目，任一项命中就停止：

- 符号链接：用 `zipinfo <zip>` 查看，权限列以 `l` 开头的条目。检查符号链接不用 `unzip -l`。
- 路径穿越：`zipinfo -1 <zip>` 列出的条目名含 `../` 或以 `/` 开头。

检查通过后只解压到 `$WORKBUDDY_CONFIG_DIR/references/wechatide-skill/`。解压后确认其中存在 `SKILL.md`；缺失或解压失败时删除自己创建的目录并告知用户。

### 使用

把 `$WORKBUDDY_CONFIG_DIR/references/wechatide-skill/SKILL.md` 当作文件读取并照做。只先读根文件，它的子场景（`installer`、`initializer`、`compiler`、`debugger`、`automator`、`previewer`、`project-manager`、`project-config`）由根文件的路由表给出相对路径，一次只读它路由到的那一个，不预读，不跨场景混用原子工具。

按它的文档执行，包括它要求运行的脚本，路径同样相对该参考目录解析。它的安装诊断、IDE 安装指引、就绪检查和场景路由都按这个方式使用。

## 工程要求

- IDE 能打开的工程需要真实的 `appid`；`touristappid` 或空值会被 IDE 拒绝。
- IDE 的服务端口需要在「设置 → 安全设置」中开启，命令行才能打开工程。
