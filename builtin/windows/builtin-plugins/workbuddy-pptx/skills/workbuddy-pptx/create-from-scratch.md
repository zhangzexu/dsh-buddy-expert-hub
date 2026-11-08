
# 从零构建 PPT

## 前置信息

### 目录结构

```markdown
<workspace_dir>/
├── <project_dir>/                  # 目录名 = pptx 文件名去后缀
│   ├── assets/                     # 静态资源
│   ├── slides/                     # DSL 源文件（每页一个 .slide）
│   │   ├── 01.slide
│   │   └── ...
│   └── <name>.pptx                 # 生成的演示文稿
```

命名约定：项目目录名与 pptx 文件名去后缀一致；页面文件 `{两位序号}.slide`；资源文件禁用中文、空格、特殊字符。

### CLI 工具

- slidep CLI：`create` / `lint` / `upsert-dsl`，完整参数见 [slidep-cli.md](references/cli/slidep-cli.md)（仅用于生成阶段，改稿走 [edit-existing](edit-existing.md)）

---

## Step 1：需求对齐

确定主题、目标、受众、页数预期

**对话策略**：

- **只问缺失的**：能从上下文推断的直接采用，一轮问完，文字提问 ≤ 3 个
- **页数规则**：用户指定则以用户为准；给了逐页大纲则对齐其页数；只给主题时自行推测合理页数并说明理由
- **默认不打断**：非硬阻塞的空缺按合理默认推进，不反复向用户确认
- **意图未对齐 → 禁止进入后续任何步骤**，不许一边做一边猜

**产物**：以上 6 个维度全部有明确答案，作为 Step 2 及之后所有步骤的输入。

---

## Step 2：收集信息与素材

### 2.1 提取用户上传的材料(如果有)

### 2.2 联网搜索补充

当模型信息不足、数据过时或需要行业案例时，主动联网搜索。

**触发信号**：

- 主题涉及数字 / 市场 / 行业等时效性信息 → 需要最新数据
- 主题含陌生术语 → 先查清楚
- 用户要求"有说服力"但未提供素材 → 补充外部佐证

若用户已提供完整参考材料，本步可跳过或降级为只查陌生概念。

## Step 3：设计 PPT

### 3.1 风格路由（选 scenario）

从用户 query 中识别主题领域、目标受众、使用场合、调性倾向，与预设风格比对：

| 风格                                                     | 核心调性                       | 适用场景                                                                                                      |
| :------------------------------------------------------- | :----------------------------- | :------------------------------------------------------------------------------------------------------------ |
| [通用](references/scenarios/general.md)                   | 自由设计、按需推导             | 产品介绍、工作总结、技术分享、项目提案、述职报告等大多数场景                                                  |
| [学术风](references/scenarios/academic.md)                | 可信、证据驱动、蓝白克制       | 开题 / 中期 / 高校答辩、科研结题、文献综述、学术会议、临床/医学汇报（**不含教学课件**，授课讲义走通用） |
| [投资分析](references/scenarios/investment-analysis.md)   | 深度、严谨、证据留痕、假设透明 | 行业研究、公司深度、投研 deck、投委会汇报、券商研报、投资备忘录、IPO 路演、买方尽调、估值报告                 |
| [红金政务风](references/scenarios/redgold.md)             | 庄重、红金热烈、中文优先       | 党政机关汇报、国企央企汇报、党课/学习宣讲、表彰大会                                                           |
| [个人介绍](references/scenarios/personal-introduction.md) | 具体优于形容、张弛有度、有节奏 | 自我介绍（求职面试、职业交流、校园破冰、部门迎新）、介绍他人（人物分享、读书会、纪念专题）                    |

**判断标准**：用户场景是否**明确属于**上表某风格的特定领域。预设风格仅限垂直领域，产品介绍、工作总结、技术分享等通用场景走通用路线。

### 3.2 构建叙事与视觉（DESIGN.md）

1. **阅读 3.1 选定的 scenario 文件**，吸收该场景的配色 / 字体 / 布局候选 / 独有风格。
2. **一定要阅读 `references/design-principle.md`**，掌握通用的结构原则、写作原则、禁令、叙事骨架、字段表，构建 `DESIGN.md`——综合 Step 1 对齐的 6 个维度 + scenario 的具体视觉选项 + design-principle 的通用框架。

---

## Step 4：创建空白 PPTX 并打开预览

进入逐页生成前，必须先完成本步。

1. 运行 `slidep create "<project_dir>/<filename>.pptx"` 创建空白文件
   - 文件名默认中文（如 `"季度汇报.pptx"`），用户明确要求英文时才用英文
2. 成功后**立即调用 `present_files`** 让文件在预览面板中打开，确保后续逐页制作时用户能实时看到渲染效果
   - 不得推迟到交付阶段，不得仅在文字中说明而不实际调用
   - 预览面向用户，Agent 不读取、不截图、不导出页面，也不依据用户预览做视觉核对

---

## Step 5：逐页生成 PPT

按大纲顺序从第 1 页到第 N 页，每页闭环：**配图(如果有) → 写页面 → 校验 → 提交**。

### SlideDSL 与组件

每页是一个 `.slide` 文件，使用受限的 JSX DSL，直接编译成 OOXML（.pptx）。把它当 HTML + 内联 CSS 来写，禁止 React 生态概念（`import` / `export` / hooks / state），文件最后一个表达式必须是 `<Slide>`。

动笔前按需阅读本页用到的组件文档（`references/dsl/*.md`）：

| 组件                                    | 用途                |
| --------------------------------------- | ------------------- |
| [Slide](references/dsl/slide.md)         | 页面根容器          |
| [Box](references/dsl/box.md)             | 布局容器（Flexbox） |
| [Text](references/dsl/text.md)           | 文字内容            |
| [Image](references/dsl/image.md)         | 位图 / 照片         |
| [SVG](references/dsl/svg.md)             | 内联矢量图          |
| [Chart](references/dsl/chart.md)         | 图表                |
| [Table](references/dsl/table.md)         | 表格                |
| [FAIcon](references/dsl/faicon.md)       | Font Awesome 图标   |
| [CodeBlock](references/dsl/codeblock.md) | 代码块              |
| [Math](references/dsl/math.md)           | 数学公式            |
| [QRCode](references/dsl/qrcode.md)       | 二维码              |
| [Hyperlink](references/dsl/hyperlink.md) | 超链接              |
| [Animation](references/dsl/animation.md) | 入场/退出/强调动画  |
| [Diagram](references/dsl/diagram.md)     | 流程图/架构图路由   |

### 每页流程

1. **配图前置**：每页动笔前先生成**本页**所需图片，检查清晰、无水印、符合上下文后再写页面内容。禁止一次性生成全部页面图片。只核对素材文件本身，此处不检查 PPT 页面或渲染结果。
2. **写入页面源文件**：write_to_file 到 `slides/{NN}.slide`
3. **写完立即校验（硬约束）**：每页先写入 pptx，再做布局检查；禁止 upsert 前先 lint。向用户汇报时仍称「检查页面」，不暴露命令名。
   - 不得尝试截图、导出或读取 PPT 的渲染结果来核对页面效果，只按布局检查的诊断修复。

   1. 新页追加（省略 `--page-index`）：

      ```bash
      slidep upsert-dsl "<pptx路径>" --dsl-file "slides/{NN}.slide"
      ```
      成功后才继续检查；失败 `{ ok: false, error }`：按错误修 `.slide` 后重新追加（此时还没有可用下标）。
   2. Agent 自行判定当前页下标：首页为 `0`，后续新页按写入顺序递增；修复时复用当前页下标。用该下标检查页面：

      ```bash
      slidep lint "<pptx路径>" --dsl-file "slides/{NN}.slide" --page-index <page_index>
      ```
      若校验未通过，根据 `diagnostics` 字段修复 `.slide` 文件后重新插入并校验。
   3. 未通过则**替换同一页**再检查，直到 `ok: true` 才进入下一页：

      ```bash
      slidep upsert-dsl "<pptx路径>" --dsl-file "slides/{NN}.slide" --page-index <同一 page_index>
      slidep lint "<pptx路径>" --dsl-file "slides/{NN}.slide" --page-index <同一 page_index>
      ```
      下标由 Agent 在逐页循环中自行判定和维护；禁止按 `01.slide` 文件名、`slides/` 目录排序或 sidecar 猜测。对用户仍说「检查页面」，禁止提及 lint 实现。按 `diagnostics` 中的布局规则修 `.slide`。

## Step 6：结束

Step5完成所有页生成后直接结束PPT生成流程，不要再做任何其余的动作(禁止复检、禁止截图等)。


# 严格约束

- 在 TODO / 进度汇报中**必须使用用户术语**（内容大纲 / 风格设计 / 创建演示文稿 / 逐页制作 / 交付），**禁止暴露内部实现**（`JSX`、`DSL`、`slidep`、`lint`、`upsert-dsl`、`OOXML` 等）。沟通统一用「页 / 封面 / 目录 / 这一页」。
- 本技能slidep相关工具链已经内置实现截图和视觉检查，生成流程**禁止主动调用外部工具进行截图和视觉检查**（例如使用LibreOffice截图）。
- 本生成流程已经在逐页生成过程，每页均进行严格核查，禁止生成中或者生成完成后通过各种方式进行复检。
