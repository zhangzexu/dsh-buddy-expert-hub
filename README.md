# dsh-buddy-expert-hub

DeepSeek Harness（dsh）插件：把 WorkBuddy 的「专家 · 技能 · 连接器」体验搬进 dsh。

左侧边栏多一行入口，点开后是一个四标签页面板：

| 标签页 | 数据来源 | 数量 |
| --- | --- | --- |
| 专家 | `dsh-buddy-expert-hub-resource` 仓库 `experts/<dir>/.codebuddy-plugin/plugin.json`（`expertType=agent`）+ `~/.dsh/experts/` 本地已导入专家 | 随仓库变化 + 本地 |
| 专家团 | 同上（`expertType=team`，含团队成员名单） | 随仓库变化 + 本地 |
| 技能 | 数据根下的 `skills/<collection>/.../SKILL.md` | 随上游仓库变化，见下方说明 |
| 连接器 | 资源仓库 `connectors/connectors.json`（单文件清单）+ `$DSH_HOME/dsh-buddy-expert-hub/connectors/` 本地已安装定义 | 随仓库变化 + 本地 |

支持搜索、分页加载、详情查看、快捷提示复制、MCP 配置复制，把专家 / 专家团**导入**成 DSH 原生专家格式，以及通过各标签页工具栏的 `+` 按钮**从文件夹**添加技能 / 导入专家 / 导入专家团（带格式校验、批量模式与幂等不覆盖）。

输入框工具栏的**专家按钮**只列**已安装**的专家 / 专家团 / 技能 / 连接器；设置里还有一个「启用内置技能」开关，可把插件包内的内置技能一次性装进本地技能库（按系统取 `builtin/windows` 或 `builtin/linux`，装完在插件界面不可见，关闭开关即移除）。

适用运行时：**dsh 0.1.5-rc.1**（`main` 为 keyed 插槽、`sidebar.panellist` 为 list 插槽，注册时只传 `label` 不传 `locale`）。

---

## 安装

### 从本地目录安装（开发态）

```bash
dsh plugin --profile web add D:\path\to\dsh-buddy-expert-hub
```

### 从 npm 安装

```bash
dsh plugin --profile web add dsh-buddy-expert-hub
```

安装后重启 / 刷新 dsh web，左侧边栏会出现「专家·技能·连接器」图标。

### 卸载

```bash
dsh plugin --profile web remove dsh-buddy-expert-hub
```

卸载不会删除 `~/.dsh/ntd-resource`、`~/.dsh/dsh-buddy-expert-hub/` 与 `~/.dsh/experts/`，需要彻底清理时手动删除即可。

---

## 使用

1. 点击左侧栏「专家·技能·连接器」图标进入面板；
2. 顶部四个标签页切换 专家 / 专家团 / 技能 / 连接器，徽标是各自的总数；
3. 四个标签页的工具栏**位置与样式完全一致**：左侧是「全部 / 已安装 / 云端」视图按钮组，右侧各一个 `+` 按钮：
   - 专家 →「导入专家」；专家团 →「导入专家团」；技能 →「添加技能」；连接器 →「新增连接器」；
   - `+` 按钮不带 `title` 悬浮提示，只保留 `aria-label` 供无障碍与自动化定位；
   - **顶部原来的「导入条目」按钮已删除**，专家 / 专家团 / 技能改为从文件夹导入（见下节）。
4. 四处工具栏的「已安装」统一为视图按钮（专家 / 专家团 / 技能 / 连接器），四处按钮组的**顺序、class、间距、右侧 `+` 按钮位置完全一致**（均由 `ResourceToolbar` 渲染，实测四个 tab 的视图按钮 class 序列与 `+` 按钮 class 逐字相同）：
   - `全部` = 当前列表全量；`已安装` = 本机已导入 / 已安装的条目；
   - **`云端` 的语义按资源类型区分**：专家 / 专家团的 `云端` 指资源仓库来源（排除本地导入条目）；技能的 `云端` 指 **SkillHub 云端商店**（技能特有入口），不是仓库技能；连接器沿用原有 `origin=cloud` 语义。
   - 技能的两个子分组「仓库技能 / SkillHub 商店」与工具栏视图**双向同步**：点「仓库技能」→ 视图切到「全部」，点「SkillHub 商店」→ 视图切到「云端」；点「全部」/「云端」视图也会同步高亮对应子分组。因此不会出现两个视图渲染同一个列表的重复面板。
   - 连接器的「已安装」视图额外保留「全部 / 本地自定义 / 云端下载」来源细分，专家 / 专家团 / 技能不套用；
   - 空态按视图给出下一步动作，已安装为空时引导点对应 `+` 按钮。
5. 搜索框 250ms 防抖，每个标签页保留自己的关键词；
6. 点击卡片或列表行，右侧滑出详情抽屉（窄屏自动全屏），`Esc`、右上 ✕ 或点击遮罩关闭；
7. 专家 / 专家团详情底部有「导入」按钮，导入后按钮变为「已导入 ✓」并禁用；详情右上「导出」可生成单条目包（后端 `POST /import/item` 仍保留）。
8. 已导入的专家会在列表**置顶**，卡片上带「本地」标识；
9. 技能列表每页 60 条，滚动到底部或点「加载更多」继续加载；技能的两个子分组是「仓库技能 / SkillHub 商店」，不再有「已安装」子分组；
10. 右上「刷新」按钮触发一次资源仓库同步（数据源是本机目录时改为重新读取该目录，不联网）。

### 在对话里引用技能（`/` 指令）

技能引用发送后，用户消息里**只显示 `/技能名`**，不会把整篇 `SKILL.md` 提示词塞进发送内容：

- 触发字符**只有 `/`**：在输入框输入 `/`，从「技能」分组里选已安装且开启的技能。**插件不再注册 `@` 触发源** —— `@` 完全回归宿主原生的「文件或对话」候选，插件不会往里面塞专家 / 专家团 / 技能 / 连接器任何条目；这四类一律从输入框工具栏的**专家按钮**（自绘紧凑选择器）里选。这里说的是**输入触发符**的口径，不代表下面三个引用入口被删掉。
- 指令名取自 `/skills/installed` 返回的 `dir`，也就是宿主原生技能目录名（由 `SKILL.md` frontmatter 的 `name` 净化而来），**不是**资源仓库里的相对路径 `skills/<集合>/<名字>`。
- 宿主启动时会扫描 `$DSH_HOME/skills/<dir>/SKILL.md` 并在需要时**按需加载**，插件再把整篇正文内联进用户消息是重复且有害的（发送时看到整篇提示词、白白消耗 token）。因此 `codec.serialize` 对技能只返回 `/技能名`，不再内联 `SKILL.md` 正文、指令段或资源目录指针；正文交给宿主原生 skill 机制。
- **技能引用有三个入口，三者发送后统一为 `/技能名`、都不会内联正文**：① 输入框 `/` 菜单（主路径，技能候选只在这里出现）；② 列表页技能卡片的「引用」气泡；③ 工具栏自绘紧凑选择器（`conversation.input.overlay` 的「技能」分类，它不是 `@` 触发源，故仍保留）。三者都会先命中已安装记录、统一插入结构化引用 `skill:<dir>`，由同一份 `codec` 展开成 `/技能名`；旧草稿里残留的 `skill:skills/<集合>/<名字>` 会取末段净化成合法指令名后降级输出，不会报错。
- 三个入口的技能引用都要求**已安装且开启**：未安装提示先点卡片上的 `+` 安装，已关闭提示到「已安装」里开启；关闭的技能宿主扫描不到，自然也不会出现在 `/` 菜单里。工具栏自绘选择器的「技能」分类仍按 `/pick` 列出仓库技能，但选中未安装 / 已关闭技能时只给上述中文提示，**不再产出降级指令名**。
- **连接器不变**：仍是会话常驻（`/attach` → dock chip）+ 发送时内联 MCP 配置；专家 / 专家团仍走 `/attach` 单选语义。三条链路互不影响。
- 宿主契约：`/` 同时是宿主内置 slash-menu 的触发符。插件注册前会探测 `inputTriggers`（`registerSource` 是否可用、是否已有同名源或占用 `/` 的源）；注册被拒时先尝试自定义前缀 `/skill`，两者都被拒则明确告警「宿主不允许 / 触发源，需要宿主侧配合；技能引用暂不可用」，**绝不静默把技能退回 `@` 菜单**。注册结果可在控制台用 `__expertHubDiag().skillTrigger` 查看；`__expertHubDiag().atTrigger` 会如实写着 `@` 源已注销。

### 输入框专家按钮：只列已安装

点击输入框工具栏的专家按钮后，二级列表**只列本机已安装的条目**（请求带 `installed=1`，过滤在服务端做）：

- 专家 / 专家团：只保留本地已导入的条目（`local: true` / `source: 'local'`）；
- 技能：只保留 `$DSH_HOME/skills/` 里真实存在的技能（含已关闭的，选中时给「已关闭」中文提示），**内置技能开关装进来的那批不列**；
- 连接器：只保留本地已定义 / 已安装的连接器（`origin: 'local'` 或 `installed: true`）；
- 某一类一条都没有时，给出可读中文 + 一个「打开面板安装」按钮，直接跳到侧栏面板去装；
- 技能条目由后端额外下发 `dir`（宿主原生技能名）与 `enabled`，前端不再二次解析 `/skills/installed`；老响应缺这两个字段时回落到本地快照。

> 面板自身的列表页（四个 Tab）**不受影响**，仍然是「全部 / 已安装 / 云端」三视图；`installed=1` 只作用于输入框选择器与显式传参的调用方。

### 内置技能（设置里一个开关）

设置弹窗里有「**启用内置技能**」开关（`role="switch"` + 原生 `checkbox`，浅色主题）：

- 开启 = 把插件包内**两个来源**的技能**全部安装**到 `$DSH_HOME/skills/`；关闭 = 把它们**全部移除**：
  - `builtin/<platform>/skills/*` —— 随包发布的独立技能（Windows 当前 **24** 个、Linux 当前 **27** 个，数量取决于随包目录内容）；
  - `builtin/<platform>/builtin-plugins/<插件>/skills/*` —— 内置插件里**自包含**的技能（Windows 当前 **11** 个、Linux 当前 **5** 个；纳入前要先过滤，见下一条）。
- 平台目录：`win32 → builtin/windows`，其它平台（darwin / linux 等）→ `builtin/linux`；目录不存在或为空时按「0 个技能」处理，开关仍可点、不报错；
- **插件技能为什么要筛**：内置插件里的技能大多依赖**所属插件的运行时**（`mcp__*` 工具、`ToolSearch` 发现的工具、`editor_sdk` 本地服务、插件根的 `core/ agents/ hooks/ shared/ dist/ bin/ prebuilds/`，或不在自己目录里的 `scripts/...`）。这些技能单独复制到 `$DSH_HOME/skills` 会变成「列表里看得见、一调用就报工具不存在」，比不装更糟。所以只纳入**完全自包含**的技能，判定原则是**宁可少装，不装坏技能**。
  读 `SKILL.md`，命中任一即排除，共 9 条规则、判定顺序固定（返回第一条命中的原因）：

  | # | 判据 | 中文原因 |
  | --- | --- | --- |
  | 1 | 目录里没有 `SKILL.md` | `缺少 SKILL.md` |
  | 2 | 文本含 `mcp`（不区分大小写） | `依赖 MCP 能力` |
  | 3 | 文本含 `ToolSearch` | `依赖 ToolSearch 发现的工具` |
  | 4 | 文本含 `editor_sdk`（不区分大小写） | `依赖 editor_sdk 本地服务` |
  | 5 | `allowed-tools:` 后跟实际值 | `声明了 allowed-tools 限制` |
  | 6 | `../Xxx`（`../` 后接 ASCII 字母） | `引用了插件上级目录` |
  | 7 | `core/` `agents/` `hooks/` `shared/` `dist/` `bin/` `prebuilds/` | `引用插件内目录` |
  | 8 | `Plugin` / `插件` 字样 | `依赖插件运行时` |
  | 9 | 提到的每个 `scripts/<相对路径>` 不在本技能目录内 | `引用的脚本不在技能目录内` |

  > 这套规则只作用于**插件来源**；`builtin/<platform>/skills` 是宿主发布的独立技能包，原样安装、不做文本筛查 —— 实测顶层技能里也有不少命中上述关键字（例如正文里出现 `bin/`、`不要 ToolSearch`、`mcp__miora__*` 这类说明或工具名），按规则筛会大量误杀。

  > 规则 1 里 `allowed-tools:` 后面为空**不算**命中（内置插件里多个技能故意留空占位）；规则 5 只查文件存在性，不做语义解析。
  > 当前实测（Windows）：**11 个纳入**（`ardot` 的 `ardot-design-to-code` / `ardot-poster` / `ardot-slides` / `ardot-ui-design` / `design-router` / `livestream-poster`，`workbuddy-docx` 的 `design-token` / `doc-typeset` / `generate-fillable-contract-html` / `html-review`，`workbuddy-pptx` 的 `workbuddy-pptx`），**15 个排除**（`ardot-design-core`、`calendar-management`、`library-office-edit`、`tencent-docs`、`tencent-saas-docs`、`tencent-private-docs`、`weixinpay-feedback` / `-pay` / `-register`、`brief-compose`、`format-extract`、`html-to-doc`、`tdoc-orchestrator`、`workbuddy-sheet-generation`、`workbuddy-sheetagent`），合计可装 **35**（24 + 11）。Linux 目录当前为顶层 27 + 插件 5 = **32** 可装、插件来源排除 11。这些数字随包目录内容变化，以 `GET /builtin/skills` 的 `counts` 为准。排除明细连原因一起在 `excluded` 里可见。计算是**运行期按规则算**的，不是写死名单：插件目录里增删技能或改 `SKILL.md`，名单跟着变。
- **为什么不做「整包安装插件」**：CodeBuddy 插件包（`builtin-plugins/<插件>/`）里没有 dsh 的 bundle 入口，宿主也不认这种目录结构；宿主的插件注册表是 `~/.workbuddy/plugins` 下的私有格式，直接往里写会与宿主自己的插件清扫/版本管理冲突（重装、清理、升级都可能把它删掉或改坏）。所以内置插件只作为**技能来源**被读取，不改写成宿主插件。
- 装进去的每个目录内会写一个 `.builtin-skill.json` 标记（`{from, platform, sourceDir, origin, plugin, installedAt}`），**只有带这个标记的目录才会被移除**；
- **不覆盖同名技能**：目标目录已存在但没有标记（用户自己装的）→ 跳过，并在 `skipped` 里写明「同名技能已存在，未覆盖」，用户文件逐字节不动；
- **重名处理**：`builtin/<platform>/skills` 先占目录名，插件来源撞名时追加 `-2`、`-3`；
- **幂等**：重复开启 = 覆盖升级，计入 `updated`；重复关闭 = 没有可移除的就删 0 个；
- **这些技能在插件界面完全不可见**：`/skills/installed` 与 `/pick?installed=1` 都会把它们排除（宿主启动时仍会原生扫描 `$DSH_HOME/skills` 正常加载它们）；
- **启动不自动安装**：只由用户显式开关触发。若已开启但目录被手动删掉，再关一次或再开一次即可恢复；
- 复制限制（单文件 ≤ 2MB / 单技能 ≤ 40MB / 单技能 ≤ 400 文件，跳过符号链接），超限的技能整体失败并记入 `skipped`，不影响其它技能（插件来源超限的会在筛选阶段就排除，原因 `体积超过复制上限`）。

#### 宿主已装插件就跳过（只作用于插件来源）

宿主的插件注册表是**私有状态**，路径口径只有一个：`$WORKBUDDY_CONFIG_DIR/plugins/installed_plugins.json`
（未设置 `WORKBUDDY_CONFIG_DIR` 时按宿主默认目录 `os.homedir()/.workbuddy` 拼）。本插件**只读**它，
绝不写入、绝不修改；接口与前端**只回显归一化后的插件名**，绝不回显注册表绝对路径或本机目录
（注册表里的 `installPath` 等字段一律不对外）。

判定方式：进入 `builtin-plugins/<插件>/` 时，先取注册表 `plugins` 对象每个 key 在 `@` 前的部分
做**名字归一化**，再判断 `installedHostPluginNames().has(归一化后的插件目录名)`。命中 → 该插件
**整包跳过**：本来会纳入的技能改用原因 `宿主已安装该插件，技能由宿主提供`，在 `excluded` 里带
`hostInstalled: true`；本来就被九条规则排除的技能保留各自更具体的原原因、带 `hostInstalled: false`。
`counts.hostSkipped` = `excluded` 里 `hostInstalled === true` 的条数，也就是「因此少装的可纳入技能数」。

**跳过范围严格限定为插件来源（`origin: 'plugin'`）**：顶层 `builtin/<platform>/skills/*` 的
24 / 27 个照常安装、绝不过滤；注册表里 `skill-*` 前缀的**顶层独立技能插件**（例如
`skill-cloud-service`）也只是被归一化回显，不会触发任何跳过。判定按插件**逐个**做 —— 只装了
`workbuddy-docx` 就只跳过它那 4 个自包含技能，不是「有插件装就全跳」。

名字归一化规则：小写 → 循环去掉 `workbuddy-` / `tencent-` / `builtin-` / `mcp-` / `skill-`
前缀 → 去掉 `-plugin` 后缀 → 去掉首尾多余的 `-` → **只接受 `[a-z0-9._-]` 字符**。
最后一步是安全边界：注册表 key 若被写成含盘符、斜杠、中文或空格的畸形字符串
（宿主异常 / 手工改坏），归一化结果直接丢弃，既不能参与插件匹配，也不会被
`hostPlugins.names` 回显出去 —— 呼应「绝不回显注册表路径」的承诺；接口输出端
还会再过滤一层做纵深防御。用来对齐两个平台对同一插件的不同命名：

| 原始名 | 归一化结果 | 说明 |
| --- | --- | --- |
| `workbuddy-docx` / `tencent-docx` | `docx` | Windows ↔ Linux 别名 |
| `workbuddy-pptx` / `tencent-pptx` | `pptx` | Windows ↔ Linux 别名 |
| `workbuddy-sheetagent` / `sheetagent` | `sheetagent` | Windows ↔ Linux 别名 |
| `tencent-docs-plugin` | `docs` | 循环去 `tencent-` 后再去 `-plugin` |
| `tencent-private-docs-plugin` | `private-docs` | 同上 |
| `ardot` / `weixinpay` | `ardot` / `weixinpay` | 无前后缀，原样保留 |
| `mcp-miora` | `miora` | 去掉 `mcp-` |
| `skill-cloud-service` | `cloud-service` | 顶层独立技能插件，不触发跳过 |

**读不到注册表就退化为原行为**：文件不存在 / 非法 JSON / 结构不对（`{}`、`plugins: null`、
数组、顶层 `null` 等）一律当成「一个都没装」，返回空集合，不抛异常、不打日志刷屏。注册表
**不做缓存**（宿主随时可能装 / 卸插件），每次请求重新读盘；一次 `listBuiltinSkills()` 调用内只读一次。

实测数字（随包目录内容与宿主注册表变化，以 `GET /builtin/skills` 的 `counts` 为准）：本机
注册表下 Windows **35 → 24**（11 个插件来源技能因宿主已装跳过，顶层 24 个照常）；Linux 目录
在**没有宿主注册表**时仍是 **32**（27 顶层 + 5 插件）——补齐 `mcps/` 不改变技能数；同一份
注册表挂到 Linux 平台副本上则是 **32 → 27**（5 个插件来源技能被跳过）。

#### 附：补齐 `builtin/<os>/mcps/` 后，之前不能用的插件技能能用了吗？

结论：**不能**。这与本插件的安装方式有关，与资源是否补齐无关。

- `builtin/<os>/mcps/<name>/.mcp.json` 是 **CodeBuddy 宿主插件的 MCP 清单**，用
  `${CODEBUDDY_PLUGIN_ROOT}/dist/cli.cjs` 指向宿主插件包自带的 CLI；MCP server 由**宿主**按
  插件注册表启动并注册工具（`builtin-plugins/weixinpay/.mcp.json` 同理，指向
  `${CODEBUDDY_PLUGIN_ROOT}/dist/mcp-server.mjs`）。
- 本插件的「内置技能」只做一件事：**把 `SKILL.md` 整树复制到 `$DSH_HOME/skills/<dir>`**，
  不解析 `.mcp.json`、不启动进程、**不向宿主注册任何 MCP server**。依赖 `mcp__*` 工具的技能
  复制过去后仍会因为「工具不存在」而调不起来 —— 这正是九条规则第 2 条「依赖 MCP 能力」
  把它们排除的原因。
- 所以补齐 `mcps/` 只让随包文件更完整，不会让依赖 MCP 的技能脱离宿主插件独立可用。

两个平台的随包内容并不相同，但**判定规则完全一致**（九条自包含规则 + 宿主已装跳过）：

| 项 | `builtin/windows` | `builtin/linux` |
| --- | --- | --- |
| 顶层 `skills/` | 24 | 27 |
| `builtin-plugins/` 目录 | 11 个：`ardot`、`builtin-calendar`、`builtin-teams-todo`、`subscription-gate`、`tencent-docs-plugin`、`tencent-private-docs-plugin`、`wecom-a2a-auth`、`weixinpay`、`workbuddy-docx`、`workbuddy-pptx`、`workbuddy-sheetagent` | 5 个：`sheetagent`、`tencent-docs-plugin`、`tencent-docx`、`tencent-pptx`、`weixinpay` |
| 插件来源技能（纳入 / 排除） | 11 / 15 | 5 / 11 |
| 可装总数（无宿主注册表） | 35 | 32 |
| `mcps/` 内容 | `agently-cli`（CLI 二进制）、`miora-mcp`（`.mcp.json` + 资源） | `agently-cli`（CLI 二进制）、`ardot-mcp-app`（`.codebuddy-plugin/plugin.json` + bootstrap）、`miora-mcp`（`.mcp.json` + 资源） |
| 插件命名 | `workbuddy-docx` / `workbuddy-pptx` / `workbuddy-sheetagent` | `tencent-docx` / `tencent-pptx` / `sheetagent` |

> 两边同名的只有 `tencent-docs-plugin` / `weixinpay`；其余靠上表的别名归一化对齐。
> Linux 的插件命名、技能集合与 `mcps` 都和 Windows 不同，但「宿主已装就跳过」的判定与
> 九条自包含规则在两边逐字一致。

---

## 数据源与数据根

### 数据根优先级

| 顺序 | 目录 | 说明 |
| --- | --- | --- |
| 1 | 设置里配置的**本机资源目录** | 目录存在且含 `experts/` / `skills/` / `connectors/` 至少其一时优先使用；不执行任何 git 操作 |
| 2 | 同步后缓存的数据根 | 通常是 `$DSH_HOME/dsh-buddy-expert-hub/repo`，索引缓存恢复时也会写入 |
| 3 | `$DSH_HOME/ntd-resource` | NTD 已同步的副本，**只读复用**，通常只有 `experts/` |
| 4 | 都没有 | 懒加载时自动克隆到 `dsh-buddy-expert-hub/repo` |

- 有 `~/.dsh/ntd-resource` 时**不会**为了建索引而联网：专家立刻可用。
- 那份副本没有 `skills/`，所以「技能」标签页会提示 **「技能数据尚未同步」** 并给一个「立即同步」按钮。
- git 数据源下，点「立即同步」/ 右上「刷新」时会对 `~/.dsh/dsh-buddy-expert-hub/repo` 执行克隆或 `git fetch --depth 1` + `reset`，成功后**把数据根切到它**；**本机目录模式下整条 git 路径都跳过**，改为重读目录并重建索引。
- `ntd-resource` 只是历史遗留的**本机目录名**，与当前远程仓库名无关；全新安装没有它也能正常工作，详见下一节。

### 数据源位置

| 内容 | 位置 |
| --- | --- |
| 专家 / 专家团 / 技能 | 默认 `https://gitee.com/zhangzexu/dsh-buddy-expert-hub-resource.git`，也可在「设置」里改成任意本机资源目录 |
| 本地已导入专家 | `$DSH_HOME/experts/<id>/`（DSH 原生格式，权威来源） |
| 连接器（云端） | 数据根（资源仓库副本）`connectors/connectors.json` + `connectors/icons/<id>.<ext>` |
| 连接器（本地已安装） | `$DSH_HOME/dsh-buddy-expert-hub/connectors/<dir>/connector.json` |

**插件不再内置任何连接器数据**：`data/` 目录已删除，`package.json` 的 `files` 也不再包含它。连接器只从上面两处读 —— 一处是资源仓库（云端），一处是本机已安装定义（本地）。

`/status` 的 `connectorSource` 有三个取值：`repo`（数据根里存在 `connectors/connectors.json`）/ `none`（还没同步或仓库里没有这份清单）/ `library`（本地资料库模式，连接器来自导出包快照）。常规模式读不到仓库清单时 `counts.connectors` 只会统计本地已安装条目，面板会提示「连接器需先同步资源仓库」。

**本地资料库模式的连接器口径**：`GET /export` 会把当前「云端 + 本地」合并后的连接器快照写进导出包的 `connectors` 数组；`POST /library/import` 把它存进索引（`libraryConnectors`），此后 `/connectors`、`/status.counts.connectors`、`/detail?type=connector`、`/export` 全部只读这份快照，不再扫旧数据根，也不会把后来新增的本机定义掺进来 —— 避免「专家 / 技能来自新包、连接器来自旧仓库」的新旧混算。恒等式 `connectable + unsupported === connectors` 在该模式下同样成立。

### 资源仓库与同步

插件默认的远程资源仓库：

```text
https://gitee.com/zhangzexu/dsh-buddy-expert-hub-resource.git
```

| 项 | 说明 |
| --- | --- |
| 默认值 | `lib/index.js` 的 `SOURCE_URL`；`/dsh-buddy-expert-hub/status` 返回 `sourceUrl` / `sourceKind` / `defaultUrl` / `usingDefault` |
| 自定义 git 仓库 | 面板「设置」里可填 `https://` 或 `git@` 形式的仓库地址，写入 `state.json` 的 `settings.sourceUrl`，**下次同步生效**；留空回到默认地址。内网镜像或 fork 仓库用这个 |
| 自定义本机目录 | 面板「设置」里可直接填本机目录（见下节），`sourceKind` 为 `local`；保存时校验目录。`dataRoot` 立刻重算；新数据源为本机目录时，旧索引立即作废并在下次请求自动重建（不联网、不需要点刷新）；切回 git 仓库时索引保持到下次同步，界面会提示「数据源已切换，点刷新以应用新数据源」（**重启后仍提示**，见下节） |
| 克隆目标 | `$DSH_HOME/dsh-buddy-expert-hub/repo`（只有完整仓库带 `skills/`）；本机目录模式不会创建或改动它 |
| 同步方式 | git 数据源：首次 `git clone --depth 1`，之后 `git fetch --depth 1` + `git reset --hard FETCH_HEAD`；点「立即同步」或右上「刷新」触发。本机目录：只重读目录并重建索引，**不联网、不执行任何 git 命令** |
| 校验 | git 地址只接受 `https://` 与 `git@` 两种形式（不得含空白或 `..`）；本机目录必须是绝对地址，相对路径会被拒并提示填绝对路径；未知协议一律拒绝 |

`sourceKind` 只有两个取值：`git`（远程 git 仓库）/ `local`（本机资源目录）。`/settings` 与 `/status` 都会返回它。

### 设置 / 数据源地址：使用本机目录

「资源仓库地址」输入框除了 git 地址，也可以直接填**本机目录**，效果与 git 路径一致：插件把这个目录当数据根读，专家 / 专家团 / 技能 / 连接器 / 图标 / `/status` / 「刷新」全部照常工作。

支持的写法：

| 写法 | 示例 |
| --- | --- |
| Linux / macOS 绝对路径 | `/home/me/dsh-buddy-expert-hub-resource` |
| Windows 盘符（正斜杠或反斜杠） | `D:\data\resource`、`D:/data/resource` |
| Windows UNC | `\\server\share\resource` |
| 用户主目录 | `~`、`~/dsh-buddy-expert-hub-resource` |
| file URL | `file:///home/me/dsh-buddy-expert-hub-resource`、`file://D:/data/resource` |

- 路径**可以含空格**，也可以含 `..`（例如 `/tmp/a/../b`），最终会归一成绝对路径再使用。
- **不支持相对路径**（`./foo`、`../foo`、`foo`）：保存时返回 400，错误为「本机目录请填绝对路径（如 /home/me/dsh-buddy-expert-hub-resource 或 D:\\data\\resource）；相对路径不支持」。
- 目录结构要求：与资源仓库相同，`experts/`、`skills/`、`connectors/` 三者中至少有一个是目录（只放 `connectors/connectors.json` + `connectors/icons/` 也能用）；专家包放 `experts/<id>/`，技能放 `skills/<collection>/<name>/SKILL.md`，连接器清单放 `connectors/connectors.json`、图标放 `connectors/icons/<id>.<ext>`。
- 保存时会检查目录：不存在返回「本机目录不存在：…」，存在但三个子目录一个都没有返回「本机目录里没有 experts/、skills/ 或 connectors/ 中的任何一个：…」；**不会静默回落成 git 仓库**。
- 本机模式下不 clone、不 fetch、不 `remote set-url`、不 reset，也不会在 `$DSH_HOME/dsh-buddy-expert-hub/repo` 下创建 `.git`。目录后来被删或变空时，同步会明确报「本机资源目录不可用：…请检查路径或在设置里改回仓库地址」，不会偷偷去克隆默认远程仓库。
- 本机目录里的文件改动，点右上「**刷新**」即重新读取并重建索引，无需重启、无需联网。
- **切换到另一个本机目录时**：保存会立刻重算 `dataRoot`，并因为数据根变了而作废旧索引（清内存索引、删 `index.json`）；下一次数据请求按既有懒加载自动重建（只读本地文件、不联网、不执行 git），**不需要点「刷新」**。重建期间数据接口返回 `busy` 占位，不会出现「连接器来自新目录、专家与技能还来自旧目录」的混合响应；重启后因为是新索引落盘，仍然是新目录。
- **切回 git 仓库时**（填 `https://` / `git@` 地址或点「**恢复默认**」）：数据根同样立刻重算，但**索引保持到下次同步**，绝不为了重建而去克隆；`/status` 会返回 `indexDataRoot`（旧索引对应的目录）与 `indexStale: true`，界面在副标题下方提示「数据源已切换，点「刷新」以应用新数据源」。点右上「刷新」后提示消失。
- **切回 git 后重启的行为**（曾有一版「重启后配置永不生效」的缺陷，已修）：「待刷新」状态会持久化到 `state.json` 的 `indexSwitchPending` 字段。冷启动时若配置为 git、但 `index.json.dataRoot` 仍指向之前的本机目录，这份缓存会被判作废并删除，`dataRoot` 绝不会回落到本机目录；同时 `indexStale: true` 与 `indexDataRoot` 仍然返回，前端**重启后照样提示点「刷新」**。抑制标志还会挡住 `requireIndex()` 的自动懒同步，**冷启动不会偷偷触发一次 30MB 克隆**。点「刷新」后：按 git 根重建索引、`indexStale` 变 `false`、`dataRoot` 指向 git 根、`indexSwitchPending` 清为 `false`。
- git 地址 A 换成 git 地址 B 时数据根通常不变（仍是 `ntd-resource` 或插件 clone），此时**什么都不做**：不清索引、`indexStale` 为 `false`、不会因轮询触发一次意外的克隆；新地址按既有语义在下次同步时生效。
- **刷新失败不再报成功**：`git fetch` / `reset` 失败（离线、坏远端、Git 不可用）时 `/refresh?wait=1` 返回 `ok:false` 与中文错误，`lastSync` 不更新、`index.json` 被删除、`indexReady` 为 `false`、旧计数不再展示，避免「失败后下一个请求把旧索引装回内存」的旧索引复活。失败后自动同步被抑制（不会每轮轮询重试一次克隆），**只有用户主动点「刷新」才重试**；成功后一切恢复正常。

> `$DSH_HOME/ntd-resource` 是历史上 NTD 同步留下的**本机只读副本目录**，名字沿用旧称呼，与上面的远程地址无关。插件不会往里 clone / pull / 写文件；全新安装没有这个目录也能正常同步。git 仓库需包含 `experts/`、`skills/` 等目录，卸载插件也不会删除这些数据目录。

### 连接器：连接与自动写入宿主 MCP 配置

连接器分三步：**发现 → 安装 → 连接**。安装只保存定义，连接才写宿主配置。

#### 来源与优先级

两层「发现位置」（条目字段 `origin`，表示这一条当前在哪里被扫到）：

| 来源 | 位置 | origin |
| --- | --- | --- |
| 云端 | 资源仓库（数据根）`connectors/connectors.json`，随同步更新 | `cloud` |
| 本地 | `$DSH_HOME/dsh-buddy-expert-hub/connectors/<dir>/connector.json` | `local` |

同 id 时优先级 **local > cloud**（本地定义覆盖同名云端条目）。工具栏统一为「全部 / 已安装 / 云端」三视图（专家 / 专家团 / 技能 / 连接器四处样式一致），连接器的 `GET /connectors?origin=` 只接受这三个值，其它值（包括历史遗留的 `market`）一律按 `all` 处理；专家 / 专家团 / 技能的「已安装 / 云端」是纯前端过滤，不改后端索引。

两种「定义来源」（定义字段 `source`，表示这条定义是谁写下来的，**装到本地后依然保留**）：

| source | 含义 | 产生方式 |
| --- | --- | --- |
| `manual` | 本地自定义 | 在「+ 新增连接器」弹窗里手填；历史定义缺 `source` 字段时也按此处理 |
| `cloud` | 云端下载 | 在「云端 / 全部」视图点统一的 `+` 图标，从资源仓库安装 |

两层语义必须分清：`origin` 回答「现在在哪」，`source` 回答「从哪来」。所以「从云端下载后装到本地」的条目是 `origin=local` + `source=cloud`，卡片上显示「云端下载」而不是「本地自定义」。读取时**以定义文件里的 `source` 为准**（缺字段才用目录兜底：本地目录 `manual`、云端目录 `cloud`）。历史值 `market` 与更早误写的 `local` 一律归一为 `cloud`（它们都表示「不是用户手填的」），其它非法值（数字、空串、未知字符串）收敛为所在目录的兜底值。

云端清单是**单文件** `connectors/connectors.json`（一个 JSON 数组，全部连接器收在一起，条目字段与手动新增一致）：

- 传输类型**以 `config.mcpServers[<key>]` 的块结构为准，再退回顶层 `transport` / 块里的 `type`**：块里有 `command` → `stdio`，块里有 `url` 且没有 `command` → `streamable-http`。之所以结构优先：上游真实数据里有 12 条把 HTTP 服务标成了 `stdio`（块里只有 `{url, timeout}`，没有启动命令），只按顶层声明会把它们整条丢掉；`http` 与 `streamable-http` 同义，一并归一；`url` / `command` / `args` / `env` / `headers` 一律以 `config.mcpServers[<key>]` 为准（顶层 `url` 只是冗余副本）；
- URL 允许 **`${VAR}` 占位模板**（连 scheme 位置也可以是占位符，例如 `"${SCHEMA}://${HOST}:${PORT}/api/v1/mcp/stream"`）：连接时会由用户填的参数求值，落盘阶段不做真实性校验，只要求「替换占位符后是 http(s) 地址」以拦住 `javascript:` / `file:` 这类危险 scheme；
- `authMode` / `requiredParams` / `optionalParams` / `paramFields` / `setupSchema` / `needsSetup` / `iconExt` / `author` 原样保留；云端清单走**宽松解析**：只有「缺 id / 不是对象 / 读不出来」才跳过（记进 `/status` 的 `connectorSkipped`），字段不全的条目用 id 兜底名称后照收；整份文件缺失或不是数组时返回空列表；
- **仓库里每一条都进列表，连不了的显式标出来**：`transport` 归一到四种值 —— `streamableHttp` / `streamable-http` / `http` 是同一个东西（MCP 的 Streamable HTTP 传输），一律 `streamable-http`；块里只有 `url`、没有 `command` 却声明成 `stdio` 的按结构纠正为 `streamable-http` 并打 `transportFixed`；`sse` / `cli` 保留原值。宿主 `mcp-client` 只能装载 `streamable-http` 与 `stdio`，因此 `cli`（没有 MCP 配置）、`sse`、以及地址里含 `${VAR}` 占位符的条目会带 `connectable: false` + 中文 `unsupportedReason`，卡片上置灰标「不可连接」、不给安装 / 连接入口（后端 `/connectors/install` 与 `/connectors/connect` 同样 400 拦住）。真实仓库 316 条实测：`streamable-http` 246（含纠正 12 + `http` 归一 4）/ `stdio` 16 / `cli` 45 / `sse` 9，`connectable` 255 条、`unsupported` 61 条（45 `cli` + 9 `sse` + 7 占位符地址），`connectorSkipped` 为 0 —— 列表显示 316 条、其中 255 条可连接是**正确结果**，不是解析失败；
- 目录形态 `connectors/<id>/connector.json` 作为**回退**仍支持（结构见下方「手动新增」示例），只在单文件缺失或损坏时才扫描。
- **地址含 `${VAR}` 占位符的条目在面板内没有任何连接入口**：`/connectors/connect`、`/connectors/provision`、`/connectors/provision/preview` 都会 400 拒绝（占位符不会被 `mcp-client` 配置求值，写进去就是一个跑不起来的地址）。要使用这类连接器，需手动编辑宿主 `cordis.patch.yml` 里对应的 `mcp-client` 条目，把 `${VAR}` 换成真实地址。

#### 安装（保存定义）

- 未安装的云端卡片显示统一的 **`+` 图标**（与 SkillHub 商店的 `+` 同款 `dshe-add-btn`，无文字、无 `title`），点一下把定义复制到本地 `connectors/<dir>/`；不写 profile、不保存凭据
- 同 id 已经安装过时，卡片不会再出现 `+` 图标（安装接口返回 `already: true`）；想让云端版本覆盖本地版本，需先卸载再安装
- 已安装卡片显示 **× 卸载**（移除本地定义并断开连接登记；profile 里的条目不会自动删除）。卸载成功后后端按具体 id 清掉所有会话中该连接器注入的上下文，响应回报 `detachedSessions`（清理的会话数）与中文 `detachNote`；前端广播 `dsh-buddy-expert-hub:attachments-changed` 让 dock 立即对账，其它已挂载连接器不受影响
- 已安装卡片名称右侧有 **来源徽标**：`本地自定义`（靛蓝）/ `云端下载`（蓝）
- 「已安装」视图下多一行 **来源筛选**：`全部 / 本地自定义 / 云端下载`，每项带实时条数（纯前端过滤，切来源不重新拉数据）
  - 按钮上的条数是**当前搜索结果内**的条数（“筛完还剩多少”的直觉口径，受关键词影响）；后端 `counts.sources` 是全量口径、不受关键词影响，前端不消费该字段
  - 来源筛选与关键词同时生效且结果为空时，提示会说明「『本地自定义』里没有匹配「xxx」的」，避免把“被来源挡住”误读成“关键词不存在”
- 顶部 **「+ 新增连接器」** 手动填写 MCP 配置：名称、描述、传输方式（Streamable HTTP / stdio）、URL 或 命令+参数+环境变量、请求头、必填参数名（留空则从 `${VAR}` 自动推断）
- id 由名称派生（kebab-case），同 id 冲突自动加序号
- 磁盘目录名由 id 决定，但**一个 id 只对应一个目录**：id 含路径分隔符等非法字符时净化成 `名字-哈希`；
  若该目录已被**别的 id** 占用（例如某条自报 id 恰好等于别人的净化名，或 Windows / macOS 上仅大小写不同的 `Alpha` 与 `alpha`），
  会自动改用 `名字-2`、`名字-3`… 另一个空位，**不会覆盖也不会互相误删**；所有候选用尽才返回可读错误「目录名冲突：该位置已被其他连接器占用，请换一个名称后重试」
- 详情抽屉「更多」区块展示：来源中文名、安装状态、安装时间（`YYYY-MM-DD HH:mm`，本地时区）、本地定义文件绝对路径（仅已安装条目返回）
  - 安装时间 = 这条连接器**第一次装上来的时间**：定义文件里存 `installedAt`，读取时沿用文件里的值（不会每次刷新都变成“刚刚”）；
    同 id 覆盖写盘时保留最初的值；卸载后重装因为文件已删而重新计时；时间戳**越界**（≥ 8.64e15）时该行不渲染，**非数字**（如 `"abc"` / `null`）按未记录处理、取当前时间正常渲染

已安装视图为空时提示「还没有安装任何连接器 —— 点右上「新增连接器」手动填一个，或在「云端 / 全部」里点 + 图标安装」；来源筛选后为空时提示「没有来自该来源的连接器」。

云端条目为 0 **且** 本地条目也为 0 时（`connectorSource === 'none'` 且列表为空），连接器页整体走空态：「还没有连接器数据：点右上「刷新」从资源仓库同步，或点「新增连接器」手动添加」。此时副标题也不显示「0 个连接器」，而是提示「连接器需先同步资源仓库」。

#### 状态机

| 状态 | 卡片按钮 | 点击行为 |
| --- | --- | --- |
| 未安装 | 统一的 `+` 图标 | 保存定义到本地 |
| 已安装 · 免认证 | 对话气泡 | 直接挂到会话 |
| 已安装 · 需认证/参数 | `+` | 打开连接弹窗 → 写 profile + 加密凭据 |
| 已连接 | 对话气泡 | 挂到会话 |

接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/connectors?origin=all\|installed\|cloud` | 两源合并列表，返回 `counts`。`origin=installed` 只看本地已安装；`cloud` 只看**云端层级里尚未安装**的；`all`（及任何非法值）返回全部 |
| POST | `/connectors/install` | `{ id }`，从资源仓库安装定义到本地；`connectable === false` 的条目（`cli` / `sse` / 占位符地址）返回 400 并说明原因 |
| POST | `/connectors/create` | 手动新增定义（字段同上） |
| POST | `/connectors/uninstall` | `{ id }`，删本地定义并断开连接登记；`id` 需通过 `safeId()` 白名单，否则 400 |

`counts` 两套口径并存（键名不冲突）：

| 键 | 口径 |
| --- | --- |
| `all` / `installed` / `cloud` | 按 `installed` / `origin` 统计（历史口径，语义未变；`cloud` 是「当前能在云端扫到的条数」） |
| `connectable` / `unsupported` | 按条目的 `connectable` 统计（`connectable + unsupported === all`）：列表是全量的，`cli` / `sse` / 占位符地址这些连不了的条目也在里面，只标「不可连接」 |
| `sources.{manual,cloud}` | **只统计已安装条目**，按定义来源 `source` 聚合 |

> `sources` 之所以是嵌套对象而不是三个扁平键：扁平的 `counts.cloud` 已经被「云端可见条数」占用，再放一个「来源=云端的已安装条数」会互相覆盖。

已安装条目额外返回 `file`（定义文件绝对路径，位于 `$DSH_HOME/dsh-buddy-expert-hub/connectors/<id>/connector.json`）；未安装条目一律不带该字段，也不会泄漏 `searchText` / `params` / `credentials`。
- 定义落盘前会用**严格模式**自检（保证「能写进磁盘的一定读得回来」，不留读不回的幽灵目录）；若目标 `connector.json` 已损坏（无法解析，例如手改 JSON 改坏或写盘中断），会先把它另存为 `connector.json.corrupt-<时间戳>` 再写入，**留档失败则拒绝写入**并提示，绝不静默覆盖你手写的内容。

连接器按是否需要初始化分两类，判定依据是仓库条目里的 `authMode` 与 `requiredParams`（由资源仓库维护脚本从 WorkBuddy 市场元数据的 `auth_mode` / `token-schema.json` 生成后就固化在 `connectors.json` 里，运行时不再读市场目录）：

| 类型 | 判定 | 卡片交互 |
| --- | --- | --- |
| 免连接 | `authMode` 为空 / `server-side` / `mcp`，且无必填参数 | **不显示 `+`**，直接是对话气泡，点击即挂到会话 |
| 需连接 | `token` / `oauth` / `oneid-token`，或存在必填参数 | 首次点 `+` 打开连接弹窗，填写后确认 |

点「确认写入并连接」后，插件会：

1. **校验必填参数**：以条目的 `requiredParams` 为准（它由 `paramFields[].required` 反推，保证表单与后端校验同源），`required: false` 的字段允许留空；
2. **本地加密保存**：写入 `$DSH_HOME/dsh-buddy-expert-hub/credentials.enc`（AES-256-GCM，文件权限 0600），**不碰系统环境变量**，Windows / Linux / macOS 行为一致；值不回显、不进日志、不进 prompt；
3. **为三个 profile**（`desktop` / `web` / `hubtest`）的 `cordis.patch.yml` 追加一条 `- insert:` 片段：
   `name: "@deepseek-ai/dsh-mcp-client"`，`transport` 由 `streamableHttp` 转 `streamable-http`，
   `headers` / `env` 里的 `${VAR}` 转成一行**自包含**的 `!!js` 解密表达式（`process.getBuiltinModule("fs"|"crypto"|"os")`），片段里没有任何明文；
4. **安全写入**：写前逐个备份为 `cordis.patch.yml.bak-<时间戳>`；同 `id` 条目已存在则跳过（幂等）；任一文件失败整体回滚。

写入后**需要重启 dsh web**：新增插件实例要等宿主重载配置才生效，插件无法重启自己所在的宿主进程。

> **安全边界**：加密主密钥由「机器名 + 用户名 + 随机 salt」派生，同机同用户的进程理论上可解密。它能防的是配置文件被分享/提交/备份泄露，**不等于** OS 级密钥库（Windows DPAPI / macOS Keychain / Linux libsecret）。要更强只能引入原生密钥库依赖，本插件坚持零依赖。

OAuth 类连接器需先在 WorkBuddy 完成登录（插件只读布尔登录态，不读取、不解密凭据）；未登录时只给引导，不会假装连接成功。

相关接口：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/connectors/provision/preview?id=<id>` | 只读预览：返回片段、目标 profile 文件、需设置的环境变量名，不含任何凭据 |
| POST | `/connectors/provision` | `{ id, params, confirm: true }`；`confirm` 不是 `true` 一律拒绝（修改用户系统配置必须显式确认） |

### 关于技能数量

技能数量**不写死**，它以数据根 `skills/` 里实际存在的 `SKILL.md` 为准，会随上游仓库增删而变：

- 扫描规则：`skills/<collection>/.../SKILL.md`，递归收集，跳过以 `.` 开头的目录（这类通常是上游嵌套的工具配置，不是独立技能）；
- 想知道当前值：看面板 Tab 上的徽标，或 `/dsh-buddy-expert-hub/status` 的 `counts.skills`；
- 如果这个数明显偏小（甚至是 0），先确认数据根是不是**完整检出**：
  `git -C <数据根> config core.sparseCheckout` 若为 `true`，说明工作区被设成了稀疏检出，
  只会落一部分目录，此时插件读到的技能数取决于落盘范围，而不是仓库真实内容。
  执行 `git -C <数据根> sparse-checkout disable` 后再点「刷新」即可恢复完整索引。

### 关于专家数量

`experts/` 下有 **54** 个目录，全部含可解析的 `plugin.json`：39 个 `agent` + 15 个 `team`。
若某个目录缺少 `plugin.json`，该目录会被跳过并记录进 `/status` 的 `skipped` 字段，不会导致整体失败。

---

## 导入格式

`POST /import` 会写**两份**产物：

1. **DSH 原生专家包** → `$DSH_HOME/experts/<id>/`（这是 dsh 运行时真正会读取的位置）；
2. **WorkBuddy 原始目录包** → `$DSH_HOME/dsh-buddy-expert-hub/imported/<id>/bundle/`（保留完整目录含 `skills/`，便于溯源与后续扩展；dsh 不读这里）。

```
~/.dsh/experts/<id>/
├── expert.yml            # id / display_name / description / order
├── role.md               # agent markdown 全文（含 frontmatter）
├── avatar.<ext>          # 按源文件真实后缀（png / jpg / webp / svg），无头像则跳过
├── .expert-source.json   # 溯源信息
├── team.json             # 仅团队：id / name / leadAgent / members
├── members/<memberId>.md # 仅团队：各成员角色说明（不含团长，团长正文在 role.md）
└── members/avatars/*     # 仅团队：成员头像（team.json 里指向这里，不会悬空）
                          # 团队自身 avatar.<ext> 缺失时回落用团长的头像

~/.dsh/dsh-buddy-expert-hub/imported/<id>/bundle/   # WorkBuddy 原始目录（含 .codebuddy-plugin 与 skills/）
```

`expert.yml` 示例：

```yaml
id: "senior-developer"
display_name: "吴八哥"
description: "10年以上全栈经验，精通多种语言和框架，是团队的技术中坚"
order: 300
```

- `id` = `plugin.name`；
- **`display_name` 顺序（中文优先、人名优先）**：
  `displayName.zh → profession.zh → displayName.en → profession.en → TitleCase(id)`。
  `displayName` 优先于 `profession` —— 前者是人名（「吴八哥」），后者是岗位（「高级开发工程师」）；
  中文优先保证界面里不会突然冒出英文人名。四个字段都缺失时（如 `software-company`、`equity-research`）回落到把 kebab id 转成 Title Case（`Software Company` / `Equity Research`）。
- `description` = `displayDescription.zh → description_zh → description → displayDescription.en`；
- 所有值都用双引号包裹并转义 `\`、`"`、控制字符，描述里的全角冒号/引号不会破坏 YAML；
- **源数据没有 `avatar` 字段的专家不生成 `avatar.*` 文件**（54 个里有 5 个如此，如 `software-company`、`equity-research`），由消费方（dsh / 前端首字母色块）兜底，不伪造资产；
- `order` 固定 300（本地专家按 `order` 升序排在远端专家之前）；
- 团队额外：`role.md` 主体是团长 agent 全文，尾部追加 `## 团队成员`（`姓名 · 职业`，团长标「（团长）」）；同时写 `team.json` 与 `members/<memberId>.md`。
- `.expert-source.json`：`{ sourcePath, pluginDir, agentFile, fingerprint, importedAt, expertType, leadAgent, memberAgents, memberCount, skills }`，其中 `agentFile` 只存文件名。
- `fingerprint` 是 **DSH 消费方的必填字段**（`dsh-ntd-experts` 的 `contract.js` 里 `REQUIRED_MANIFEST_STRING_FIELDS` 就要求 `sourcePath / pluginDir / agentFile / fingerprint` 四个非空字符串）。缺失会被判为 `MANIFEST_BROKEN`，界面上显示「清单缺失，请卸载重装」，等于导入失败。
  取值是 `sha256(源码 plugin.json + '\n' + 源 agent markdown)` 的 64 位十六进制，**只对源数据求值、不含时间戳**，因此同源必得同值，重复导入不会产生假阳性。
  不写 `manager` 字段：那样消费方会把包标成「由第三方管理」；留空则归入 `LEGACY`（可被收编覆盖），用户能正常看到并直接使用。

**幂等**：`$DSH_HOME/experts/<id>/` 已存在时直接返回 `{ok:true, already:true}`，不覆盖用户手工改过的内容。

---

## 文件夹导入（添加技能 / 导入专家 / 导入专家团）

三个 `+` 按钮打开同一个「文件夹导入」弹窗，只是 `type` 不同：**添加技能**（`skill`）、**导入专家**（`expert`）、**导入专家团**（`team`）。
弹窗用 `<input type="file" webkitdirectory>` 选目录；非 Chromium 环境可用 `showDirectoryPicker()` 兜底，两者都不支持时给中文提示，不会静默失败。

### 必需文件（不同的功能校验不同的格式）

| 类型 | 目录根下必需文件 | 可选 / 兼容输入 |
| --- | --- | --- |
| 技能 `skill` | `SKILL.md`（frontmatter 建议写 `name`；解析不出时用目录名兜底，并在结果里标注） | `README.md` 与其它资源文件 |
| 专家 `expert` | `expert.yml`（至少含 `id` / `display_name`）+ `role.md` | 或 `.codebuddy-plugin/plugin.json`（可解析、含 `name` / `displayName`），此时按兼容格式转换 |
| 专家团 `team` | `expert.yml` + `role.md` + `team.json`（含 `teamInfo` 或 `members` 数组） | 或 `plugin.json` 里带团队信息（`expertType=team` / `members` / `teamInfo`），导入时生成 `team.json` |

校验失败会逐条列出缺哪些文件；后端是权威校验方，前端只做同规则的轻量预检并把结果展示在弹窗里。

### 两种导入模式

1. **单条目模式**：先把所选目录整体当作一个条目校验，通过即导入这一个条目；
2. **批量模式**：整体校验不通过时，把**一级子目录各当作一个条目**分别校验（只看第一层，不递归），成功的导入、失败的逐条列出中文原因；全部失败时 `ok:false` 并给出可读汇总（如「3 个子目录均校验失败」）。

### 限制与落盘

- 已知文本扩展名（`.md/.json/.yml/.yaml/.svg/.py/...`）按 `utf8` 读取，其余（含 `.png/.jpg/.webp` 与未知类型）按 `base64` 读取；
- 单文件 ≤ 2MB、最多 200 个文件、解码后总计 ≤ 20MB，前后端双重限制；
- 拒绝 `..`、绝对路径、Windows 盘符、反斜杠路径与符号链接，`path.relative` 二次校验；
- 技能落 `$DSH_HOME/skills/<净化后的名字>/`（复用 `skillDirNameOf()`），这正是宿主启动时扫描的**原生技能目录**：装好并开启后，对话里用 `/<净化后的名字>` 即可让宿主按需加载它的 `SKILL.md`，插件不会再内联正文；专家 / 专家团落 `$DSH_HOME/experts/<id>/`（DSH 原生 `expert.yml` / `role.md` / `avatar.*` / `team.json`）；
- **绝不覆盖已存在目录**：同名返回 `already:true`，用户手工改过的内容保持不变。

接口与响应见下方 `POST /import/folder`。

---

## 接口表

所有接口挂在 webServer 的 `/dsh-buddy-expert-hub` 前缀下，统一返回 `{ ok: true, ... }` 或 `{ ok: false, error }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/status` | `{ ok, repoReady, indexReady, lastSync, counts:{experts,teams,skills,connectors,connectable,unsupported}, localCounts:{experts,teams}, sourceUrl, sourceKind, dataRoot, indexDataRoot, indexStale, library, hasSkills, connectorSource, connectorSkipped, skipped, busy, progress, lastError, lastErrorRaw, warnings, importedCount, baseDir, localExpertsDir }`（本轮**没有新增 `/status` 字段**；新增的 `indexSwitchPending` 只写进 `state.json`，不对外暴露）；`counts.experts/teams` 为合并去重后的数量，与列表一致；`counts.connectors` 是**现算**的两源合并总条数（常规模式不进索引；本地资料库模式改用导出包快照），`counts.connectable` / `counts.unsupported` 是其中宿主能装载 / 装载不了的条数（`connectable + unsupported === connectors`）；`connectorSource` 为 `repo` / `none` / `library`；`connectorSkipped` 是**真正解析不了**（缺 id / 结构异常）的条数，正常数据下为 0 —— 它和「不可连接」不是一回事；`lastError` 是给人看的中文，`lastErrorRaw` 是原始错误堆栈；`sourceKind` 为 `git` / `local`，`local` 时 `dataRoot` 是设置里配置的本机目录；`busy` 是**真实的同步中状态**（不是恒 `true`）；`indexDataRoot` 是当前索引对应的数据根，`indexStale` 在「切到 git 数据源、数据根变化」时为 `true` —— 包含冷启动作废旧缓存、当前无索引的情况（此时 `indexDataRoot` 取 `state.json` 里记录的旧根），前端据此提示点「刷新」 |
| GET | `/settings` | `{ ok, sourceUrl, sourceKind, defaultUrl, usingDefault, skillhubUrl, builtinSkills, builtinPlatform, builtinSkillCount, builtinSkillPluginCount, builtinSkillExcluded, builtinSkillHostSkipped }`；`sourceKind` 同上。`builtinSkills` 是内置技能开关状态（旧 `state.json` 无该字段时缺省 `false`），`builtinPlatform` 为 `windows` / `linux`，`builtinSkillCount` 是插件包内当前平台**可用技能总数**（设置弹窗用它渲染「N 个技能」），`builtinSkillPluginCount` 是其中来自内置插件的自包含技能数，`builtinSkillExcluded` 是内置插件里未纳入的数量（含依赖插件运行时与被宿主跳过的），`builtinSkillHostSkipped`（number）是其中**因宿主已装对应插件而跳过**的条数，与 `/builtin/skills` 的 `counts.hostSkipped` 一致（缺该字段或不是 number 时前端整句省略描述，不渲染 `undefined`） |
| POST | `/settings` | body `{ sourceUrl, skillhubUrl? }` → `{ ok, sourceUrl, sourceKind, skillhubUrl }`。`sourceUrl` 可填 `https://` / `git@` 仓库地址或本机目录绝对地址；本机目录会校验存在性与 `experts/` / `skills/` / `connectors/` 结构，不合格返回 400 并给出中文原因；相对路径返回 400 且错误含「绝对路径」。数据根变化时按新数据源分流：**新源为本机目录** → 旧索引立即作废（`state.index` 清空 + 删 `index.json`），下次请求懒加载自动重建、不联网、不自动触发 git；**新源为 git** → 保留旧索引、不触发同步，`/status` 报 `indexStale: true` 由前端提示点「刷新」，并把 `indexSwitchPending: true` 写进 `state.json`（重启后仍提示、仍不自动克隆）；**git 地址互换且数据根不变** → 什么都不做 |
| POST | `/settings/reset` | 清除自定义地址、回到 `SOURCE_URL`，返回 `{ ok, sourceUrl, sourceKind: 'git', defaultUrl, usingDefault: true }`；数据根变化时按「新源为 git」处理，保留索引并置 `indexStale` |
| POST | `/refresh` | 触发同步；默认立即返回 `{ started, busy }`，加 `?wait=1` 则等待完成后再返回状态。`progress` 每秒回写「已用时 Ns」 |
| GET | `/experts` | `q` / `category` / `limit`(默认 200) / `offset` → `{ ok, total, localCount, items }` |
| GET | `/teams` | 同上，只返回 `expertType=team` |
| GET | `/categories` | 专家分类聚合 `[{ id, count, label }]` |
| GET | `/skills` | `q` / `collection` / `limit`(默认 60) / `offset` → `{ ok, total, items, collections }`；`collections` 的计数按**当前过滤结果**重算（搜索时组头显示的是命中数，不是集合全量）；数据源无 `skills/` 时返回 `{ ok:false, code:'skills-missing', error:'技能数据尚未同步，请点击刷新' }` |
| GET | `/skills/installed` | 列出 `$DSH_HOME/skills/`（含 `skills-disabled/`）里的已安装技能：`{ ok, items:[{ dir, name, description, source, enabled, slug, installedAt, path }] }`。`dir` 是宿主原生技能名，`/` 菜单只取 `enabled === true` 的项并把它当 `/` 指令名；关闭态目录宿主扫描不到。**内置技能开关装进来的目录（含 `.builtin-skill.json` 标记）不在此列表里出现** |
| GET | `/pick` | 输入框选择器候选源，返回 `{ ok, keyword, installedOnly, groups:[{ kind, title, total, items }] }`（agent / team / skill / connector 四组）。`installed=1`（等价写法 `scope=installed`）只返回**已安装**条目：专家 / 团队看 `local === true` 或 `source === 'local'`；技能看本地技能库（`dir` / frontmatter `name` / `slug` / 仓库 `id` 末段任一命中，且排除内置技能开关装的那批），并额外下发 `dir` 与 `enabled`；连接器看 `origin === 'local'` 或 `installed === true`。过滤后 `group.total` 是**过滤后**的数量。不带参数时行为与此前完全一致（全量） |
| GET | `/builtin/skills` | 内置技能总开关概览（**只给设置弹窗显示数量与排除说明用**，不是给用户浏览技能列表）：`{ ok, platform, enabled, root, pluginsRoot, available:[{ dir, name, description, installed, origin, plugin }], excluded:[{ plugin, dir, reason, hostInstalled }], excludedTruncated, hostPlugins:{ count, names }, counts:{ available, installed, plugin, excluded, hostSkipped } }`。`available` 是真正可安装的那批（`origin`：`'skills'` = `builtin/<platform>/skills`，`'plugin'` = 内置插件里的自包含技能，`plugin` 为所属插件目录名，顶层来源为空串）；`excluded` 是内置插件里**未纳入**的技能及中文原因，每条带 `hostInstalled`（`true` = 因宿主已装对应插件跳过，原因 `宿主已安装该插件，技能由宿主提供`；`false` = 九条规则 / 体积超限等原有原因），**最多 30 条**，超出置 `excludedTruncated: true`，`counts.excluded` 始终是真总数；`counts.plugin` 是 `origin === 'plugin'` 的条数，`counts.hostSkipped` 是 `excluded` 里 `hostInstalled === true` 的条数。`hostPlugins` 只回显**归一化且通过字符白名单 `[a-z0-9._-]` 校验**后的宿主插件名（`count === names.length`，字母序去重），**绝不回显注册表绝对路径或本机目录**；含盘符 / 斜杠 / 中文 / 空格的畸形 key 在归一化阶段就被丢弃，输出端还有一层同样的过滤兜底；注册表读不到时为 `{count:0, names:[]}` |
| POST | `/builtin/skills/toggle` | body `{ enabled: boolean }`（非布尔返回 400，GET 返回 405）。开启 → 全量安装 `available` 里的技能（`excluded` 永不安装）并置 `state.settings.builtinSkills = true`，响应带 `{ total, installed, updated, skipped:[{dir,reason}] }`（`total` = 可用总数：无宿主注册表时 Windows 35 / Linux 32；本机注册表下 Windows 24，随 `counts.available` 变化）；关闭 → 只移除带标记的目录并置 `false`，响应带 `{ removed:[dir] }`。两种响应都带最新 `counts` |
| GET | `/connectors` | `q` / `limit` / `offset` → `{ ok, total, items }` |
| GET | `/detail` | `type`(`expert`\|`team`\|`skill`\|`connector`) + `id` → 单项完整信息 + `readme`（agent markdown / SKILL.md 正文前 2000 字）；专家优先查本地已导入目录 |
| GET | `/asset` | `path`（相对数据根的 POSIX 路径）→ 图片二进制，按扩展名 + 魔数返回真实 MIME |
| GET | `/icon` | `id`（连接器 id）→ 图标二进制，先查资源仓库 `<数据根>/connectors/icons/<id>.<ext>`，再查本地已安装定义目录，都没有返回 404（前端回落首字母色块） |
| GET | `/local-avatar` | `id`（本地专家 id，`[A-Za-z0-9._-]+`）→ `~/.dsh/experts/<id>/avatar.*` |
| POST | `/import` | body `{ type: 'expert'\|'team', id }` → 写 `$DSH_HOME/experts/<id>/` + `dsh-buddy-expert-hub/imported/<id>/bundle/`，返回 `{ ok, id, type, path, already, files, bundle }` |
| GET | `/imported` | `{ ok, ids, items:[{id,type,displayName,description,avatar}], dir }`，扫描 `$DSH_HOME/experts/`（只认含 `expert.yml` 的目录）并与 `state.json` 记录合并去重 |
| POST | `/import/item` | 单条目包（`.json.gz` / 明文 JSON，格式 `{format,type,id,name,dir,files:[{path,data,encoding}]}`）→ 只新增这一个条目。**接口保留**：条目详情的「导出」包仍可由它导入，但面板顶部「导入条目」按钮已删除 |
| GET | `/export/item` | `type`(`expert`\|`team`\|`skill`) + `id` → 下载单个条目的 `.json.gz` 包。专家 / 专家团的 `id` 先过 `safeId()` 单段目录名白名单，再用「词法前缀 + `realpathSync`」双重校验目录，目录穿越与符号链接逃逸一律 400/404；技能 `id` 是 `skills/<集合>/<名字>` 形式的相对路径，保留 `index.skills.find` + `safeRepoPath` 的既有链路。错误文案只回显 id，不回显绝对路径 |
| POST | `/import/folder` | **本轮新增**：浏览器选择文件夹导入。请求体 `{ type:'skill'\|'expert'\|'team', rootName:string, files:[{path,data,encoding}] }`，`encoding` 为 `utf8` 或 `base64`。响应 `{ ok:true, mode:'single'\|'batch', imported:[{id,name,type,dir,already?,notes?}], skipped:[{dir,reason}] }`；全部失败时 `{ ok:false, error, imported:[], skipped, mode }`。先按「所选目录本身就是一个条目」校验，不通过再按一级子目录批量导入；三种类型格式要求不同，见「文件夹导入」章节。安全与幂等：拒绝 `..` / 绝对路径 / 盘符 / 反斜杠 / 符号链接，单文件 ≤ 2MB、文件数 ≤ 200、总计 ≤ 20MB，已存在目录返回 `already:true` 不覆盖 |
| POST | `/library/import` | 上传整包字节（gzip JSON），原子落盘后切换数据源 |

> **`repoReady` 与 `indexReady` 是两个独立信号**：
> 前者表示「数据目录可用」（`dataRoot` 已定位到某个含 `experts/` / `skills/` / `connectors/` 之一的目录；git 克隆与 `ntd-resource` 仍要求 `experts/` 非空），
> 后者表示「索引已构建完成、可以对外提供列表数据」。
> 二者可以并存为 `repoReady:true` + `indexReady:false`：例如 `dsh-buddy-expert-hub` 目录被同名文件占用、
> 索引写不下去时会回落到 `~/.dsh/ntd-resource` 继续读，但索引尚未落盘。
> 前端只依赖 `indexReady` 判断能否渲染列表，`repoReady` 仅用于诊断。


索引不可用时，数据类接口返回 `{ ok: false, busy, indexReady: false, error, message }`：`busy` 取**真实同步状态**（同步已失败即为 `false`），`error` 与 `message` 内容相同、同时提供，前端两条取值链都不会拿到空白文案。首次同步、同步失败、以及「切到 git 待刷新」三种情况给出不同提示，其中待刷新时提示「数据源已切换，点「刷新」以应用新数据源」。自动同步在「待刷新」或「上次同步失败」期间被抑制，只有用户主动点「刷新」才会重试。

---

## 工作目录

```
$DSH_HOME/                       # 默认 ~/.dsh
├── ntd-resource/                # NTD 已同步副本（只读复用，可能无 skills/）
├── experts/<id>/                 # 本地专家（DSH 原生格式，导入落点 & 权威来源）
├── skills/<dir>/                 # 本地技能库（宿主原生扫描；内置开关装进来的带 .builtin-skill.json）
├── skills-disabled/<dir>/        # 被「关闭」的技能（移出 skills/，宿主扫描不到）
└── dsh-buddy-expert-hub/
    ├── repo/                     # 插件自己的浅克隆（带 skills/）
    ├── imported/<id>/bundle/     # 导入时额外保留的 WorkBuddy 原始目录
    ├── index.json                # 索引缓存（重启后直接读取）
    └── state.json                # { lastSync, dataRoot, importedIds, settings:{ sourceUrl, skillhubUrl, builtinSkills } }
```

本地专家会被**合并进「专家 / 专家团」列表并置顶**（`local: true`、`source: 'local'`），卡片带「本地」标识，详情页「导入」按钮为禁用态「已导入 ✓」。

合并是**字段级**的：同 id 时以本地包为骨架，但 `displayName / profession / description / tags / quickPrompts / categoryId / avatar / skills / members` 等任一侧缺失的字段会从仓库条目补齐 —— 导入后卡片的标签、快捷提示、职业不会丢失。`/status` 的 `counts.experts / counts.teams` 也按**合并去重后**的口径统计，与列表条数、Tab 徽标保持一致；另有 `localCounts` 单独给出本地条数。

索引缓存带版本号（`index.version`）和 `dataRoot`；版本不匹配、原数据根已消失、配置了本机目录而缓存来自另一个数据根、或**配置为 git 而缓存仍绑在本机目录**时自动作废（后者还会删掉这份缓存并置持久化的待刷新标志）。切到另一个本机目录时保存接口会主动清掉这份缓存（零联网重建）；切回 git 仓库时同进程内保留到下次同步并由 `/status` 的 `indexStale` 标记，**重启后则判缓存作废，但提示不丢、也不会自动克隆**。

---

## 目录结构（插件自身）

```
dsh-buddy-expert-hub/
├── package.json
├── cordis.patch.yml           # 插件装载补丁
├── lib/
│   ├── index.js               # host 半：文件系统 / git / HTTP 路由
│   ├── client.js              # client 半：侧边栏图标 + 主面板
│   ├── connector-store.js     # 连接器定义层：本地 / 云端 两源合并
│   ├── connector-meta.js      # 认证模式 / 必填参数 / WorkBuddy 登录态
│   ├── connector-provision.js # 连接阶段：生成并写入宿主 mcp-client 片段
│   ├── connector-secret.js    # 凭据 AES-256-GCM 本地加密
│   └── frontmatter.js         # SKILL.md frontmatter 解析
├── builtin/                   # 内置技能（随包发布的只读资源，必须进 files）
│   ├── windows/skills/<dir>/  # 来源一：Windows 平台内置技能（每个含 SKILL.md）
│   ├── windows/builtin-plugins/<插件>/skills/<dir>/  # 来源二：内置插件里的技能（只装自包含的，见「内置技能」一节）
│   ├── <os>/mcps/<name>/       # CodeBuddy 宿主插件 MCP 清单（.mcp.json / .codebuddy-plugin），本插件只读 SKILL.md、不注册 MCP
│   └── linux/                  # 其它平台（darwin / linux）：结构同 windows，内容随包不同（当前 27 个独立技能 + 5 个插件技能）
├── scripts/build-connectors.mjs   # 资源仓库维护工具（见下节）
└── README.md
```

**没有 `data/` 目录**：插件不再内置连接器清单与图标，`package.json` 的 `files` 发布 `lib` / `builtin` / `cordis.patch.yml` / `README.md`；`scripts/check-package.mjs` 会断言 `builtin` 已进 `files`（漏了就会出现「开启内置技能后 0 个技能」）。

零 npm 依赖、零构建步骤：host 半是纯 ESM，client 半是一个由 `window.__ModuleLoader__` 加载的普通脚本，使用 `React.createElement` 而不用 JSX。

---

## 重新生成资源仓库的连接器清单

`scripts/build-connectors.mjs` 是**资源仓库维护工具**，不是插件运行时的一部分 —— 普通用户不需要执行它，插件只读它产出的 `connectors/connectors.json`。

```bash
node scripts/build-connectors.mjs [--out <file>] [--data-root <dir>]
# 或
npm run build:connectors
```

| 项 | 说明 |
| --- | --- |
| 输入 | 本机 WorkBuddy 连接器市场目录 `~/.workbuddy/connectors-marketplace/{connectors,icons}` 与 `.codebuddy-connector/connectors.json` 里的 `auth_mode` |
| 输出 | `<数据根>/connectors/connectors.json`（单文件清单）+ `<数据根>/connectors/icons/<id>.<ext>`（图标） |
| 数据根解析 | `--data-root` 显式给出 > `$DSH_HOME/ntd-resource` > `$DSH_HOME/dsh-buddy-expert-hub/repo`（后两者要求含非空 `experts/`） |
| 失败行为 | 数据根不可用 / 找不到市场目录时打印中文错误并**以非 0 退出**（避免维护者误以为已经产出了新清单） |
| `--out` | 指到别处时图标跟着清单走（`<out 所在目录>/icons`） |

> `lib/connector-meta.js` 里的 `readAuthModeMap()` 只被这个维护脚本使用（读市场元数据作为上游输入）；插件运行时不再读任何市场目录。

---

## 自检

```bash
npm run check            # 所有 lib/*.js 语法检查 + 发布清单自检
node --check lib/index.js
node --check lib/client.js
```

---

## 安全说明

- **本机同源门禁（防 DNS rebinding / CSRF）**：所有请求在路由分发之前先过 `localRequestGuard()`。`Host` 只接受 `localhost` / `127.0.0.1` / `::1`（可带端口，含 `[::1]:port`）；带 `Origin` 时其 host 必须是上述本地 host 且与 `Host` 一致；`Sec-Fetch-Site: cross-site` 一律 403，`cross-origin` 且不同源也 403。**允许没有 Origin 的同源请求**（插件自己的 fetch、curl、验收脚本都依赖这条），不强制非 GET 请求带自定义头；被拒时统一返回 403 `{ ok:false, error:'请求来源不被允许' }`，不泄漏内部信息。这样 `text/plain` 的 CORS-safelisted 跨站表单无法再触发 `/settings`、`/connectors/create`、`/import/folder`、`/library/import`。
- **单条目导出防目录穿越**：`GET /export/item` 的专家 / 专家团 `id` 走 `safeId()` 白名单 + `safeRepoDirReal()`（词法前缀 + `realpathSync`）双重校验，曾经 `id=../../../..` 能让 `path.join(root,'experts',id)` 逃到盘符根、把最多 400 个仓库外文件打进 gzip 下载包（可读 `~/.ssh/id_rsa` / `credentials.enc` / `state.json`）。技能 `id` 是相对路径形式，继续由 `index.skills.find` + `safeRepoPath` 兜住；404 文案只回显 id，不回显绝对路径。
- **连接器配置片段防 `!!js` 注入（宿主 RCE）**：写入宿主 `cordis.patch.yml` 的 `!!js` 表达式不再把用户文本塞进模板字面量。文本按 `${VAR}` 占位符切成片段，字面量一律变成 JS 字符串常量（含注入嫌疑字符时整体 `\uXXXX` 转义），变量片段才是 `buildSecretExpr()` 生成的「读取本地加密凭据」表达式，用 `+` 拼接。用户输入永远只是字符串内容，反引号、非白名单 `${...}`、反斜杠都不再有机会被宿主求值；占位符替换功能不打折，凭据值始终只存在于加密的 `credentials.enc` 里，不会明文进 YAML。
- `/asset` 只允许访问数据根内的文件：先做词法层 `path.resolve` 包含性检查，再对已存在的路径做 `realpath` 二次校验，阻断目录穿越与符号链接逃逸；
- `/icon`、`/local-avatar`、`/import` 对 id 做 `^[A-Za-z0-9][A-Za-z0-9._-]*$` 白名单校验；
- `/import` 的目标目录固定在 `$DSH_HOME/experts/` 下，源目录固定在本插件 clone 的 `repo/experts/` 下；
- 连接器定义的 **id 来自不可信输入**（云端定义文件 / 请求体），绝不直接拼磁盘路径：写盘用 `diskNameOfId()` 净化为单段目录名（并校验最终路径仍在 `connectors/` 之内），删除前用 `isSafeSegmentName()` 硬校验、不合格直接 400 拒绝。曾经 `POST /connectors/install {"id":"../../x"}` 能写到 `connectors/` 之外，`POST /connectors/uninstall {"id":"../../victim"}` 能递归删掉 `$DSH_HOME` 下的任意目录；卸载路由另有一层 `safeId()` 白名单（与 `/attach`、`/icon` 同一套规则）。
  界面上卸载这类条目时 toast 会给出指引：「该连接器 id 含非法字符（xxx），无法通过界面卸载；请手动删除 $DSH_HOME/dsh-buddy-expert-hub/connectors/ 下的对应目录」。
  代价：如果某个云端定义自报的 id 本身含非法字符（只有恶意/脏定义才会这样），它会以净化后的目录名落盘、并且无法通过卸载接口删除 —— 需要手动删 `$DSH_HOME/dsh-buddy-expert-hub/connectors/` 下对应目录；
- `~/.dsh/ntd-resource` 只读：插件不会往里 clone / pull / 写文件；
- 所有路由处理都包在 try/catch 中，插件初始化也包在 try/catch 中 —— 任何异常都只会让接口返回错误，不会阻断 dsh web 启动。
- **卸载或删除条目时自动清理注入的上下文**：dock 点「×」/ 输入框选择器取消选中走 `/detach`，disposer 先撤销宿主 `systemPrompt.section()` 返回的独立注册（函数 / 对象 / void / Promise 形态都兼容，注册期直接返回 rejected Promise 时立即吞掉，不产生未捕获异常）再撤销 inject fiber；面板卸载连接器按具体 id（不用 null 全拆）清掉所有会话里该连接器的挂载与 pending，响应回报 `detachedSessions` 与中文 `detachNote`。`/attachments` 在索引缓存可用时一次算好源集合、遍历全部会话的注册表自愈清掉源已消失的专家 / 连接器（专家与连接器分表处理，id 撞名互不干扰，连续两次结果一致）；索引不可用（`loadIndexCache()` 返回 null，如首次启动 / 同步中途）或 `state.busy` 为 true 时一律跳过自愈、零 dispose，原样保留挂载，避免误清。**已知边界**：手动删仓库专家目录但索引缓存未重建时不会立刻自愈（源判定按旧索引），需点「刷新」重建索引；切到 git 数据源且 `indexSwitchPending` 时旧索引保留，自愈不检查该标志；同步失败且用户不点「刷新」时索引长期不可用，自愈长期跳过（宁可不清也不误清）。

---

## License

MIT
