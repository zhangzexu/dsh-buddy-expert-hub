# dsh-buddy-expert-hub

DeepSeek Harness（dsh）插件：把 WorkBuddy 的「专家 · 技能 · 连接器」体验搬进 dsh。

左侧边栏多一行入口，点开后是一个四标签页面板：

| 标签页 | 数据来源 | 数量（当前快照） |
| --- | --- | --- |
| 专家 | ntd-resource 仓库 `experts/<dir>/.codebuddy-plugin/plugin.json`（`expertType=agent`）+ `~/.dsh/experts/` 本地已导入专家 | 39 + 本地 |
| 专家团 | 同上（`expertType=team`，含团队成员名单） | 15 + 本地 |
| 技能 | 数据根下的 `skills/<collection>/.../SKILL.md` | 随上游仓库变化，见下方说明 |
| 连接器 | 本机 `~/.workbuddy/connectors-marketplace`（MCP / CLI） | 316 |

支持搜索、分页加载、详情查看、快捷提示复制、MCP 配置复制，以及把专家 / 专家团**导入**成 DSH 原生专家格式。

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
3. 搜索框 250ms 防抖，每个标签页保留自己的关键词；
4. 点击卡片或列表行，右侧滑出详情抽屉（窄屏自动全屏），`Esc`、右上 ✕ 或点击遮罩关闭；
5. 专家 / 专家团详情底部有「导入」按钮，导入后按钮变为「已导入 ✓」并禁用；
6. 已导入的专家会在列表**置顶**，卡片上带「本地」标识；
7. 技能列表每页 60 条，滚动到底部或点「加载更多」继续加载；
8. 右上「刷新」按钮触发一次资源仓库同步。

---

## 数据源与数据根

### 数据根优先级

| 顺序 | 目录 | 说明 |
| --- | --- | --- |
| 1 | `$DSH_HOME/dsh-buddy-expert-hub/repo` | 刷新（或首次没有其它数据源）时克隆的完整仓库，**只有它带 `skills/`** |
| 2 | `$DSH_HOME/ntd-resource` | NTD 已同步的副本，**只读复用**，通常只有 `experts/` |
| 3 | 都没有 | 懒加载时自动克隆到 `dsh-buddy-expert-hub/repo` |

- 有 `~/.dsh/ntd-resource` 时**不会**为了建索引而联网：专家立刻可用。
- 那份副本没有 `skills/`，所以「技能」标签页会提示 **「技能数据尚未同步」** 并给一个「立即同步」按钮。
- 点「立即同步」/ 右上「刷新」时，无论当前数据根是谁，都会对 `~/.dsh/dsh-buddy-expert-hub/repo` 执行克隆或 `git fetch --depth 1` + `reset`，成功后**把数据根切到它**。

### 数据源位置

| 内容 | 位置 |
| --- | --- |
| 专家 / 专家团 / 技能 | `https://gitcode.com/weibaohui/ntd-resource` |
| 本地已导入专家 | `$DSH_HOME/experts/<id>/`（DSH 原生格式，权威来源） |
| 连接器 | 本机 `~/.workbuddy/connectors-marketplace/{connectors,icons}` |
| 连接器兜底快照 | 插件内置 `data/connectors.json`（构建产物，316 条） |

连接器在运行时优先读本机市场目录；读不到时自动回落到 `data/connectors.json`，`/status` 的 `connectorSource` 字段会显示当前来源（`marketplace` / `snapshot` / `none`）。

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

## 接口表

所有接口挂在 webServer 的 `/dsh-buddy-expert-hub` 前缀下，统一返回 `{ ok: true, ... }` 或 `{ ok: false, error }`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/status` | `{ ok, repoReady, indexReady, lastSync, counts:{experts,teams,skills,connectors}, localCounts:{experts,teams}, sourceUrl, dataRoot, hasSkills, connectorSource, skipped, busy, progress, lastError, lastErrorRaw, warnings, importedCount, baseDir, localExpertsDir }`；`counts.experts/teams` 为合并去重后的数量，与列表一致；`lastError` 是给人看的中文，`lastErrorRaw` 是原始错误堆栈 |
| POST | `/refresh` | 触发同步；默认立即返回 `{ started, busy }`，加 `?wait=1` 则等待完成后再返回状态。`progress` 每秒回写「已用时 Ns」 |
| GET | `/experts` | `q` / `category` / `limit`(默认 200) / `offset` → `{ ok, total, localCount, items }` |
| GET | `/teams` | 同上，只返回 `expertType=team` |
| GET | `/categories` | 专家分类聚合 `[{ id, count, label }]` |
| GET | `/skills` | `q` / `collection` / `limit`(默认 60) / `offset` → `{ ok, total, items, collections }`；`collections` 的计数按**当前过滤结果**重算（搜索时组头显示的是命中数，不是集合全量）；数据源无 `skills/` 时返回 `{ ok:false, code:'skills-missing', error:'技能数据尚未同步，请点击刷新' }` |
| GET | `/connectors` | `q` / `limit` / `offset` → `{ ok, total, items }` |
| GET | `/detail` | `type`(`expert`\|`team`\|`skill`\|`connector`) + `id` → 单项完整信息 + `readme`（agent markdown / SKILL.md 正文前 2000 字）；专家优先查本地已导入目录 |
| GET | `/asset` | `path`（相对数据根的 POSIX 路径）→ 图片二进制，按扩展名 + 魔数返回真实 MIME |
| GET | `/icon` | `id`（连接器 id）→ 图标二进制，本机 icons 优先，回落插件内置 `data/icons/`，都没有返回 404 |
| GET | `/local-avatar` | `id`（本地专家 id，`[A-Za-z0-9._-]+`）→ `~/.dsh/experts/<id>/avatar.*` |
| POST | `/import` | body `{ type: 'expert'\|'team', id }` → 写 `$DSH_HOME/experts/<id>/` + `dsh-buddy-expert-hub/imported/<id>/bundle/`，返回 `{ ok, id, type, path, already, files, bundle }` |
| GET | `/imported` | `{ ok, ids, items:[{id,type,displayName,description,avatar}], dir }`，扫描 `$DSH_HOME/experts/`（只认含 `expert.yml` 的目录）并与 `state.json` 记录合并去重 |

> **`repoReady` 与 `indexReady` 是两个独立信号**：
> 前者表示「数据目录可用」（`dataRoot` 已定位到某个含 `experts/` 的目录），
> 后者表示「索引已构建完成、可以对外提供列表数据」。
> 二者可以并存为 `repoReady:true` + `indexReady:false`：例如 `dsh-buddy-expert-hub` 目录被同名文件占用、
> 索引写不下去时会回落到 `~/.dsh/ntd-resource` 继续读，但索引尚未落盘。
> 前端只依赖 `indexReady` 判断能否渲染列表，`repoReady` 仅用于诊断。


索引不可用且正在同步时，数据类接口返回 `{ ok: false, busy: true, indexReady: false, message }`，前端据此显示「首次同步中，请稍候…」并轮询 `/status`。

---

## 工作目录

```
$DSH_HOME/                       # 默认 ~/.dsh
├── ntd-resource/                # NTD 已同步副本（只读复用，可能无 skills/）
├── experts/<id>/                 # 本地专家（DSH 原生格式，导入落点 & 权威来源）
└── dsh-buddy-expert-hub/
    ├── repo/                     # 插件自己的浅克隆（带 skills/）
    ├── imported/<id>/bundle/     # 导入时额外保留的 WorkBuddy 原始目录
    ├── index.json                # 索引缓存（重启后直接读取）
    └── state.json                # { lastSync, dataRoot, importedIds }
```

本地专家会被**合并进「专家 / 专家团」列表并置顶**（`local: true`、`source: 'local'`），卡片带「本地」标识，详情页「导入」按钮为禁用态「已导入 ✓」。

合并是**字段级**的：同 id 时以本地包为骨架，但 `displayName / profession / description / tags / quickPrompts / categoryId / avatar / skills / members` 等任一侧缺失的字段会从仓库条目补齐 —— 导入后卡片的标签、快捷提示、职业不会丢失。`/status` 的 `counts.experts / counts.teams` 也按**合并去重后**的口径统计，与列表条数、Tab 徽标保持一致；另有 `localCounts` 单独给出本地条数。

索引缓存带版本号（`index.version`）和 `dataRoot`；版本不匹配、或原数据根已消失时自动重建。

---

## 目录结构（插件自身）

```
dsh-buddy-expert-hub/
├── package.json
├── cordis.patch.yml           # 插件装载补丁
├── lib/
│   ├── index.js               # host 半：文件系统 / git / HTTP 路由
│   └── client.js              # client 半：侧边栏图标 + 主面板
├── data/connectors.json       # 连接器离线快照（构建产物）
├── scripts/build-connectors.mjs
└── README.md
```

零 npm 依赖、零构建步骤：host 半是纯 ESM，client 半是一个由 `window.__ModuleLoader__` 加载的普通脚本，使用 `React.createElement` 而不用 JSX。

---

## 重新生成连接器快照

```bash
node scripts/build-connectors.mjs
# 或
npm run build:connectors
```

脚本只读本机 `~/.workbuddy/connectors-marketplace`，输出 `data/connectors.json`。若目标机器没有该目录，脚本会跳过生成并保留既有快照。

---

## 自检

```bash
node --check lib/index.js
node --check lib/client.js
node scripts/build-connectors.mjs
```

---

## 安全说明

- `/asset` 只允许访问数据根内的文件：先做词法层 `path.resolve` 包含性检查，再对已存在的路径做 `realpath` 二次校验，阻断目录穿越与符号链接逃逸；
- `/icon`、`/local-avatar`、`/import` 对 id 做 `^[A-Za-z0-9][A-Za-z0-9._-]*$` 白名单校验；
- `/import` 的目标目录固定在 `$DSH_HOME/experts/` 下，源目录固定在本插件 clone 的 `repo/experts/` 下；
- `~/.dsh/ntd-resource` 只读：插件不会往里 clone / pull / 写文件；
- 所有路由处理都包在 try/catch 中，插件初始化也包在 try/catch 中 —— 任何异常都只会让接口返回错误，不会阻断 dsh web 启动。

---

## License

MIT
