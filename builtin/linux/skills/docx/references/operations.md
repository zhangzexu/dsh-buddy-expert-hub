# DOCX 操作参考

仅在对应任务需要时读取本文件。优先采用能保留原文档结构且便于验证的方法。

## 依赖探测

```bash
python3 -c "import docx; print(docx.__version__)"
command -v soffice || command -v libreoffice
command -v pdftoppm || command -v pdftocairo
```

不要假设依赖已经存在。缺少依赖时，先说明缺失项；只有在当前环境和用户授权允许时安装。

## 读取正文与表格

```python
from docx import Document

doc = Document("input.docx")

for paragraph in doc.paragraphs:
    if paragraph.text.strip():
        print(paragraph.style.name, paragraph.text)

for table_index, table in enumerate(doc.tables, start=1):
    print(f"TABLE {table_index}")
    for row in table.rows:
        print([cell.text for cell in row.cells])
```

`Document.paragraphs` 不包含文本框、页眉页脚、脚注、批注等所有文本。审阅任务需要结合 OOXML 包中的相关部件检查，不能把普通正文提取结果当作完整文档内容。

## 新建文档

```python
from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.shared import Cm, Pt

doc = Document()
section = doc.sections[0]
section.top_margin = Cm(2.54)
section.bottom_margin = Cm(2.54)
section.left_margin = Cm(2.8)
section.right_margin = Cm(2.8)

normal = doc.styles["Normal"]
normal.font.name = "Arial"
normal.font.size = Pt(10.5)

title = doc.add_heading("文档标题", level=0)
title.alignment = WD_ALIGN_PARAGRAPH.CENTER
doc.add_paragraph("正文内容。")
doc.save("output.docx")
```

中文字体需要同时设置东亚字体。可对样式的 `w:rFonts` 设置 `w:eastAsia`，以减少 Word 与 LibreOffice 之间的字体差异。

## 局部替换文本

简单地给 `paragraph.text` 赋值会丢失段内样式。优先在现有 run 中替换；跨 run 的匹配需要先定位文本范围，再仅重建受影响的 run。

```python
from docx import Document

doc = Document("input.docx")
for paragraph in doc.paragraphs:
    for run in paragraph.runs:
        if "旧文本" in run.text:
            run.text = run.text.replace("旧文本", "新文本")
doc.save("output.docx")
```

替换完成后检查页眉页脚、表格单元格、文本框和超链接中的同名文本是否也在用户要求范围内。

## 表格

- 按字段长度分配列宽，不默认等宽。
- 不使用固定行高截断内容。
- 表头居中或按字段语义对齐，叙述性正文通常左对齐。
- 多页表格设置重复表头。
- 合并单元格前确认读取顺序和可访问性影响。

设置重复表头：

```python
from docx.oxml import OxmlElement

def repeat_table_header(row):
    tr_pr = row._tr.get_or_add_trPr()
    tbl_header = OxmlElement("w:tblHeader")
    tbl_header.set("{http://schemas.openxmlformats.org/wordprocessingml/2006/main}val", "true")
    tr_pr.append(tbl_header)
```

## 图片

```python
from docx import Document
from docx.shared import Cm

doc = Document("input.docx")
doc.add_picture("image.png", width=Cm(14.5))
doc.save("output.docx")
```

保持纵横比，不把图片宽度设置为超过页面可用宽度。重要图片应有题注；对外发布文档还应提供替代文本。

## 页眉、页脚与页码

页眉页脚属于每个节。文档含多个节时，要逐节确认“链接到前一节”的状态。页码通常是 Word 域，不要用静态数字代替；创建或修改字段后需在 Word/LibreOffice 中更新并重新渲染。

## 合并文档

直接追加段落无法完整保留节、样式、编号、关系和图片。优先使用专门的 DOCX 合并库或 LibreOffice/Word 自动化，并在合并后检查：

- 样式同名冲突；
- 编号重新开始或串号；
- 图片与超链接关系；
- 分节符、纸张方向和页眉页脚；
- 目录、脚注、批注和修订。

## 批注、修订和 OOXML

`python-docx` 对批注、修订、字段和内容控件的支持有限。只有在清楚对应 OOXML 部件及关系时才直接修改压缩包内容。至少同步检查：

- `word/document.xml`；
- `word/_rels/document.xml.rels`；
- `[Content_Types].xml`；
- 相应的 comments、footnotes、endnotes、header、footer 或 numbering 部件。

修改 OOXML 时使用临时目录重新打包，保留未修改部件，避免产生嵌套目录或丢失根级 `[Content_Types].xml`。

## 转换与渲染

使用技能内脚本：

```bash
python3 scripts/render_docx.py input.docx --output-dir render
python3 scripts/render_docx.py input.docx --output-dir render --emit-pdf
```

默认只生成用于检查的 PNG。`--emit-pdf` 仅在用户要求 PDF 或排查渲染问题时使用。最终 DOCX 在转换后仍需执行结构检查。
