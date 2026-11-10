---
name: docx
display_name: Word 文档处理
display_name_en: Word Document Processing
description: Create, read, edit, format, review, merge, and validate Microsoft Word .docx documents. Use when the user mentions Word, DOCX, office documents, reports, proposals, contracts, templates, tracked changes, comments, or document layout.
description_zh: 创建、读取、编辑、排版、审阅、合并和校验 Word DOCX 文档，并通过渲染检查保证交付质量。
description_en: Create, read, edit, format, review, merge, and validate Word DOCX documents with structural and visual quality checks.
category: writing
version: 1.0.0
author: double
user-invocable: true
disable-model-invocation: false
---

# DOCX 文档处理

处理 `.docx`、Microsoft Word 文档及面向 Word 的交付物。保持用户指定的内容、格式、语言、文件名和输出范围；除非用户明确要求，不要用 PDF、Markdown 或纯文本替代 DOCX。

## 任务路由

先判断任务类型，再执行对应流程：

- 读取或审阅：提取正文、标题、表格、页眉页脚、批注和修订信息，保持原有章节与标签语义。
- 新建：先确定受众、用途、篇幅和视觉风格；缺失但不影响正确性的细节可采用专业、克制的默认值。
- 编辑：默认保留原文件并输出新文件，只做用户要求的局部修改；不得无故重写全文或破坏既有样式。
- 模板套用：以模板的页面、样式、编号、页眉页脚和表格规则为准，只替换需要变化的内容。
- 合并或转换：保持源文件顺序、标题层级、分页和可追溯性，并说明不能无损保留的特性。
- 审阅功能：批注、修订、目录、域、脚注、内容控件等高级能力优先使用可验证的 Word/LibreOffice 或 OOXML 方法，不能可靠实现时必须明确说明限制。

常见操作和实现示例见 @references/operations.md。最终检查项见 @references/quality-checklist.md。

## 默认工作流

1. 检查输入文件是否存在、是否为有效 DOCX，以及是否需要保留原件。
2. 读取文本、表格、图片、节、样式、页眉页脚、批注和修订等与任务相关的结构。
3. 选择最小且可验证的实现方式：
   - 常规创建与编辑使用 `python-docx`；
   - 格式转换和渲染优先使用 LibreOffice；
   - `python-docx` 不支持的高级特性才直接修改 OOXML，并在修改前备份原文件。
4. 将中间文件放在独立临时目录，将最终文件写入用户指定位置；未指定时使用清晰、无覆盖风险的文件名。
5. 对最终 DOCX 执行结构检查：

   ```bash
   python3 scripts/inspect_docx.py output.docx
   ```

6. 对创建、排版或布局敏感的修改执行渲染检查：

   ```bash
   python3 scripts/render_docx.py output.docx --output-dir render
   ```

7. 逐页检查渲染图。发现裁切、重叠、乱码、孤行、异常分页、表格溢出或页眉页脚错位时，修复后重新渲染。
8. 仅交付用户要求的最终文件，并简要说明完成的操作。除非用户要求，不交付临时 PDF、页面图片或调试文件。

## 创建与排版要求

- 使用真实的 Word 标题样式、列表编号和表格结构，不用手工空格、连续换行或字符模拟版式。
- 先定义页面、页边距、字体、字号、段落间距、标题层级、颜色和表格规则，再写入内容。
- 中文正文优先使用常见中文字体，并设置兼容的拉丁字体；避免依赖目标环境可能缺失的冷门字体。
- 表格列宽按内容分配，允许正文换行，不设置可能截断文字的固定行高；跨页表格应重复表头。
- 图片保持纵横比并限制在页面可用宽度内；需要时添加题注和替代文本。
- 目录、交叉引用和页码等字段应在交付前更新；若无可靠字段更新工具，说明首次用 Word 打开后可能需要“更新域”。
- 内容正确性优先于装饰。正式文档使用克制、统一、可打印的视觉体系。

## 编辑与安全边界

- 不覆盖原文件，除非用户明确要求覆盖。
- 修改前记录目标文件和输出文件；批量操作前先列出匹配范围。
- 对合同、证书、财务或其他敏感文档，不自行改变事实、数字、签名、印章或法律措辞。
- 不将密码、令牌、个人敏感信息写入脚本、模板、日志或技能文件。
- 删除批注、接受修订、清理元数据、解除保护或移除水印会改变审阅或合规状态，只有在用户明确要求时执行。
- 遇到损坏、加密、受保护或包含宏的文件，先报告状态；本技能只处理 `.docx`，不得把 `.docm` 静默改成 `.docx`。

## 交付门槛

必须同时满足：

- 文件可作为 ZIP/OOXML 包正常打开，核心 XML 可解析；
- 正文、表格、图片、页眉页脚和分页符合用户要求；
- 创建或布局修改任务已完成逐页渲染检查；
- 未引入多余批注、修订、外部链接、临时文本或占位符；
- 最终回复明确给出 DOCX 路径，并只陈述实际完成和验证过的结果。

若 LibreOffice 或页面渲染工具不可用，可完成结构检查后交付，但必须明确说明“未完成视觉渲染校验”，不得声称版式已通过检查。
