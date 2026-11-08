---
name: workbuddy-pdf
description: Read, summarize, search, and understand PDFs with the local workbuddy-pdf CLI. Use for PDF questions, text/table/image extraction, and checking scans, charts, or formulas against page images. Reading only — creating or editing PDF files is not supported.
description_zh: 阅读理解 PDF，提取文字、表格和图片，结合原页图像核对结论；仅支持读取，不支持生成或编辑 PDF。
description_en: Read and understand PDFs with the local workbuddy-pdf CLI, with page-image checks when needed. Reading only — creating or editing PDFs is not supported.
version: "0.2.0"
---

# PDF 阅读理解

用 `workbuddy-pdf` 提取与问题相关的内容。提取结果可能遗漏文字或打乱顺序；重要结论应能定位到原 PDF。

## 范围：只读，不做生成/编辑

本 Skill 只覆盖读取，不使用 CLI 的格式转换、合并、拆分、加解密等其他功能。**生成、导出或编辑 PDF 文件当前不支持**——不要用浏览器打印（Chrome headless 等）、`pip install` / reportlab / pypdf / pandoc 等第三方库，也不要翻找其他 PDF 工具自行拼一条生成链路。遇到这类请求：直接说明当前不支持生成/编辑 PDF，并给出可行替代（整理成 DOCX / Markdown / 表格，或由用户自行导出）。

## 定位工具

先用 `--help` 确认当前 CLI 支持的参数。macOS、Linux 或 Git Bash 通过 `sh "<skill_dir>/scripts/run.sh" --help` 调用；Windows PowerShell 通过 `powershell -NoProfile -ExecutionPolicy Bypass -File "<skill_dir>/scripts/run.ps1" --help` 调用。`<skill_dir>` 是本文件所在目录。脚本依次查找 `WORKBUDDY_PDF`、skill 的 `bin/<平台>/` 和 PATH，并原样转发参数。下文的 `workbuddy-pdf` 均指通过对应脚本调用。

CLI 由应用按需下载并放在 PATH 上，不要自行搜索、下载或拼接它的路径。

### 退出码 69 与 127

- **69：组件尚未就绪。** 后台下载还没完成（通常十几秒），stderr 会提示尚未就绪。隔几秒重试同一条命令即可，不必改参数；**不要**尝试 `pip install`、`brew install` 或下载任何同名工具替代——那会引入来源不可控的二进制。持续多次失败时，向用户说明组件下载未完成、建议检查网络，再决定是否改用其他读取方式。
- **127：找不到 CLI。** 说明本机确实没有该能力，此时才考虑说明限制或换用可用的读取方式。

CLI 自身的退出码是 `0/2/3/4/5/6`（成功 / 用法 / 输入输出 / PDF 无法读取 / 转换失败 / 其他异常），**不含 69**——69 只来自宿主铺的占位程序。看到这些码时按含义修正参数或输入，再决定是否重试。

## 选择读取方式

| 目标 | 参数 |
|---|---|
| 总结、问答、查找事实 | `-f md`：先走较快的文字提取路径 |
| 只要纯文字 | `-f txt` |
| 需要版面归组后的正文和表格 | `-f md-plain` |
| 查段落、表格及图片的结构 | `-f structure` |
| 提取表格单元格 | `-f table --table-format json`；CSV 不保留合并跨度 |
| 查看扫描页、图表、公式或核对版面 | `-f png --dpi 150` |

`md-plain` 和 `structure` 使用完整版面识别；普通问答先用 `md`，只有需要归组或结构时再使用它们。`table` 和 `png` 的输出路径是目录。CLI 没有页范围参数，会处理整份 PDF。

扫描页会被自动检测，但**当前发布包不自带 OCR**。需要本机安装 PaddleOCR 或 Tesseract；没有引擎时，`md`、`txt`、`md-plain`、`structure` 和 `table` 遇到扫描页会报错，不应把失败当作空白页。已安装却找不到时，可用 `PDF2DOCX_PADDLEOCR` 或 `PDF2DOCX_TESSERACT` 指定可执行文件路径；PaddleOCR 的结构识别还可用 `PDF2DOCX_PADDLE_PYTHON` 指定 Python。Tesseract 的非默认语言需对应语言包，`PDF2DOCX_OCR_LANG` 可指定语言。扫描表格的行列和合并跨度是近似识别，须核对原页。

## 读取与定位

每份 PDF 使用独立的工作目录，明确指定输出路径；`-` 不是标准输出。示例：

```bash
workdir=$(mktemp -d "${TMPDIR:-/tmp}/pdf-read.XXXXXX")
sh "<skill_dir>/scripts/run.sh" "/abs/input.pdf" "$workdir/content.md" -f md -q 2>"$workdir/extract.log"
```

检查退出码、实际文件和日志；失败时不要沿用旧产物。加密 PDF 用用户提供的密码加 `-p <password>`，回答里不要复述密码。长文档先看篇幅和章节，再搜索关键词并读取命中处及上下文，避免把整份内容放进上下文。页眉页脚可能重复；引用数字时核对表头、单位和邻近文字。

需要 PDF 中的图片时，在 `md` 或 `md-plain` 命令中加 `--image-dir "$workdir/images"`。该目录存放可提取的图片；扫描页上被识别出的非文字区域可能被裁切输出，但不保证覆盖所有图表，也不等于整页截图。检查日志、Markdown 链接和实际文件；`--no-clobber` 不保护图片附属文件，因此每份文档用新目录。查看完整页面时用 `-f png`。

## 核对与引用

- 逐页留意正文过少、乱码、占位符及缺失的表格、公式或脚注。整篇有文字也不能排除混合扫描页；没有识别到表格不代表原文没有。
- 对影响答案的图表趋势、公式、合并表头、数值和单位，查看原页。不同提取结果一致也不能证明内容完整；无法核实时说明范围。
- `structure` 中 `source.page` 从 **0** 开始，Markdown 页注释和 `page-0001.png` 从 **1** 开始。回答引用 PDF 文件页序；印刷页码不同时注明，多文档分别标明来源。

交付用户需要的结论、摘录或数据及来源，只说明影响结论的读取限制。
