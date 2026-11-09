# 他人提交合并说明

> 面向维护者：把别人在 Git / Gitee 上提交的 commit 或 Pull Request 合进本仓库的标准流程。
> 贡献者请直接看文末「附：贡献者提交步骤」。
>
> 仓库：`https://gitee.com/zhangzexu/dsh-buddy-expert-hub.git`
> 本文只约定协作口径，不改任何代码行为。

---

## 1. 分支与提交约定

| 项 | 约定 |
| --- | --- |
| `master` | 稳定分支，远端默认分支（`origin/HEAD -> origin/master`），只接受从 `dev` 合入的版本 |
| `dev` | 日常开发分支，所有 PR 默认合入这里 |
| 功能分支 | `feat/xxx`、`fix/xxx`，从 `dev` 拉出，合并后删除 |
| 提交信息 | `feat: 中文描述` / `fix: 中文描述` / `docs: 中文描述`，一行说清「改了什么」 |
| 禁止 | `git push --force` 到 `dev` / `master`；跳过 hooks（`--no-verify`）；把个人 `state.json`、凭据、绝对路径提交进仓库 |

合并前先确认自己在哪：

```bash
git status
git branch --show-current
git fetch origin --prune
git log --oneline --decorate -8
```

**注意**：本仓库曾有本地已 commit 但未 push 的情况（例如 `4468a57`）。合并他人代码前，先把自己的本地提交推上去或确认不冲突，否则后面 `pull` / `merge` 会形成叉状历史，排查困难。

---

## 2. 先把别人的提交取下来

三种来源，任选一种：

### A. Gitee 上的 Pull Request（最常见）

在 PR 页面拿到贡献者的仓库地址与分支名，取到本地一个临时分支：

```bash
git fetch <贡献者仓库地址> <贡献者分支>:pr/<功能名>
# 例：git fetch https://gitee.com/someone/dsh-buddy-expert-hub.git feat/picker:pr/picker
git branch -a | grep pr/
```

也可以在 Gitee 网页上直接点「合并」，合并完本地执行 `git pull`。**但建议先按第 3 节在本地审一遍再合并**，网页合并无法中途停下去跑检查。

### B. 别人已经推到共享仓库的分支

```bash
git fetch origin --prune
git checkout -b pr/<功能名> origin/<对方分支>
```

### C. 只给了补丁文件

```bash
git apply --check /path/to/xxx.patch      # 先验证能不能干净落下
git am /path/to/*.patch                   # 保留原作者与提交信息
```

---

## 3. 合并前检查清单（必做）

### 3.1 看清楚改了什么

```bash
git log --oneline dev..pr/<功能名>
git diff --stat dev...pr/<功能名>           # 三点：从共同祖先到对方分支尖端的差异
git diff dev...pr/<功能名> -- lib/ README.md package.json
```

### 3.2 本仓库特有的重点项

- [ ] **`package.json` 的 `files` 白名单**：新增 `lib/*.js` 必须能被白名单覆盖，否则 `npm pack` 出来的包会缺文件、装完直接加载失败（`lib/frontmatter.js` 踩过这个坑）。跑 `npm run check` 会卡住这一条。
- [ ] **包体积**：`files` 只发布 `builtin/**/skills/**`。曾经误把 `mcps/`、插件运行时的 `dist/` 带进去，包从 10.4MB 涨到 91.7MB。任何提交里出现 `builtin/*/mcps/`、`node_modules/`、`dist/`、`prebuilds/` 都应拒绝。
- [ ] **不要提交个人状态**：`.workbuddy/`（项目数据，不是缓存，禁止删除）、`state.json`、`index.json`、`credentials.enc`、`*.log`、任何含 `C:\Users\...` 或 `~/.dsh` 的绝对路径。
- [ ] **前后端字段对齐**：`lib/client.js` 读的响应字段必须在 `lib/index.js` 里真的下发；新增/删除字段要同步 `README.md` 接口表与 `docs/user-guide.md`。
- [ ] **内置技能相关**：改动 `builtin/` 或内置技能筛选规则时，确认 `GET /builtin/skills` 的 `counts` 与文档里的数字一致；本机 Windows 当前 4 个可装、Linux 32 个。
- [ ] **文档**：行为变更要同步 `README.md`，纯使用说明放 `docs/user-guide.md`。

### 3.3 跑检查（按影响面，不要全量）

```bash
npm run check                 # 所有 lib/*.js 语法检查 + 发布清单自检，必跑
```

按改动范围选择验收脚本（这些脚本位于**工作区上级目录**的 `_harness/`，属于内部验收工具，没有就跳过）：

| 改动范围 | 建议跑 |
| --- | --- |
| 只改 `lib/client.js` | `node ../_harness/render.mjs` |
| 只改 `lib/index.js` 的路由 / 响应字段 | `node ../_harness/smoke37.mjs`、`smoke38.mjs` |
| 改内置技能 / `builtin/` | `node ../_harness/smoke40.mjs` |
| 改 `package.json` / `.gitignore` | `node scripts/check-package.mjs --verbose` |

用户明确要求过：**按改动影响跑，不要全量跑**。

---

## 4. 三种合并方式

### 4.1 整分支合并（推荐）

```bash
git checkout dev
git merge --no-ff pr/<功能名> -m "merge: 合并 <贡献者> 的 <功能>（PR #N）"
```

`--no-ff` 保留合并节点，日后回滚只要 `git revert -m 1 <合并提交>` 一次即可。

### 4.2 只挑其中几个提交

```bash
git checkout dev
git cherry-pick <sha1> <sha2>          # 按原顺序
git cherry-pick --abort                 # 出问题随时中止
```

适合对方分支里混了无关提交、或只想先合一部分的情况。挑完后在合并说明里写清楚「只取了哪几个 sha」。

### 4.3 压缩成一条提交

```bash
git checkout dev
git merge --squash pr/<功能名>
git commit -m "feat: <功能描述>（来自 <贡献者>）"
```

注意：`--squash` 不会生成合并节点，回滚时只能整条 revert；贡献者原始提交信息会丢，需要在 commit message 里注明来源。

---

## 5. 冲突怎么处理

最容易冲突的是 `README.md`、`lib/index.js`、`lib/client.js`（都长且多人改）。

```bash
git status                     # 先看冲突文件列表
git diff --name-only --diff-filter=U
```

处理原则：

1. **逐段比对，别一把梭** —— 不要用 `git checkout --ours .` / `--theirs .` 覆盖整个文件，这两个文件里通常双方各改了不同功能。
2. 冲突在 `README.md` 时，通常是两人各加了一节，保留双方内容、调整顺序即可。
3. 冲突在 `lib/index.js` / `lib/client.js` 时，确认接口字段是否两边都改了：一边加了字段、一边删了同一字段，要按当前设计口径决定取舍，再跑一次 `npm run check` 与对应验收脚本。
4. 解决后：

```bash
git add <已解决的文件>
git diff --check                # 查尾随空格 / 冲突标记残留
git grep -n '<<<<<<<\|=======\|>>>>>>>' -- . || true
git commit                      # merge 冲突解决后收尾
```

Windows 上看到 `LF will be replaced by CRLF` 是换行符提示、不是错误；团队统一 `core.autocrlf` 即可，不要为此重写整个文件。

---

## 6. 合并后验证与推送

```bash
npm run check
node scripts/check-package.mjs --verbose
# 按第 3.3 节跑对应验收脚本
git log --oneline --decorate -5
git diff --stat origin/dev..dev          # 确认真正要推出的内容
git push origin dev
```

> **Gitee 推送凭证**：非交互终端里 `credential.helper=manager` 没有缓存写凭证时会报
> `Cannot prompt because user interactivity has been disabled`，并可能长时间卡住等输入。
> 遇到这个错误，请**在自己的图形终端**执行 `git push origin dev`（会弹凭据窗口），或先把
> Gitee 令牌缓存到凭据管理器。不要给 `git push` 接 `| tail` 之类的管道，会把输出憋住、
> 看起来像卡死。

合入 `master`（发版时）：

```bash
git checkout master
git merge --no-ff dev -m "merge: 合并 dev 到 master"
git push origin master
```

---

## 7. 回滚

| 场景 | 做法 |
| --- | --- |
| 合并已推送、需要撤销 | `git revert -m 1 <合并提交的 sha>`，再 `git push`。保留历史，团队共用分支首选 |
| 合并**还没推送** | 确认无未提交改动后可 `git reset --hard origin/dev`。**这是破坏性操作**，先 `git stash` 或备份 |
| 只是某个文件合错了 | `git checkout origin/dev -- <文件>` 后重新提交 |

回滚后同样要跑 `npm run check` + 影响面验收，并同步修正文档。

---

## 8. 合并说明模板（可直接复制到 PR / 合并提交）

```markdown
## 合并说明

- 来源：<贡献者> / <分支或 PR #N>；取用提交：<sha 列表，或「全部」>
- 改动范围：lib/index.js、lib/client.js、README.md、docs/…
- 目的：一句话说清这次合并解决什么问题
- 行为变化：合并前 → 合并后（列出用户能感知到的差异）
- 兼容性：是否新增/删除接口字段、是否影响旧 state.json、是否影响已安装的技能目录
- 验证：npm run check ✅；render 427/0 ✅；smokeXX N/0 ✅；check-package ✅
- 风险与回滚：已知边界；回滚用 git revert -m 1 <sha>
- 文档：README.md / docs/user-guide.md 已同步
```

---

## 9. 常见坑速查

| 现象 | 原因 / 处理 |
| --- | --- |
| `npm pack` 后插件加载失败，报找不到某个 `lib/*.js` | 新文件没进 `package.json` 的 `files`；跑 `npm run check` 能提前拦住 |
| 包体积突然几十 MB | 误提交 `mcps/`、`dist/`、`node_modules/`；检查 `files` 与 `.gitignore` |
| 合并后内置技能变 0 个 | `builtin/<os>/skills` 没被带进来，或 `files` 的 glob 被改坏 |
| 网页合并后本地 `pull` 出一堆冲突 | 本地有未推送提交；先处理本地提交再合并 |
| `git push` 卡住 / 报交互被禁用 | 见第 6 节 Gitee 凭证 |
| 文档里的数量、接口字段对不上代码 | 合并时只改了代码没改 `README.md` / `docs/user-guide.md` |

---

## 附：贡献者提交步骤

```bash
# 1. fork 仓库，克隆自己的 fork
git clone https://gitee.com/<你的账号>/dsh-buddy-expert-hub.git
cd dsh-buddy-expert-hub

# 2. 从 dev 拉功能分支
git remote add upstream https://gitee.com/zhangzexu/dsh-buddy-expert-hub.git
git fetch upstream
git checkout -b feat/<功能名> upstream/dev

# 3. 改动后自检
npm run check

# 4. 提交（中文、一行说清）
git add <具体文件>
git commit -m "feat: <改动描述>"

# 5. 推送并在 Gitee 提 PR 到 dev
git push origin feat/<功能名>
```

PR 描述请按第 8 节模板填写，尤其是「行为变化」和「验证结果」。不要提交 `state.json`、
`index.json`、`.workbuddy/`、任何凭据或本机绝对路径。
