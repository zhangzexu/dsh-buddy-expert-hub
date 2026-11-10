---
name: workbuddy-office-routing
display_name_zh: Office 文件路由
display_name_en: Office Routing
description: 本地 Office/WPS 文件（doc/docx/dot/wps/wpt、xls/xlsx/xlt/csv/tsv、ppt/pptx/pps/pot）的读取、编辑、创建与格式转换，一律先加载本技能，再交给 `wps-office-suite` 技能处理。当用户上传、提及、读取、编辑或要求创建本地 Office 文件时优先加载。PDF 阅读理解与任意 PDF 编辑不在支持范围内。
author: Tencent Docs (adapted for dsh)
version: "0.2.0"
---

# Local Office/WPS Routing

本技能是**前置路由**：处理本地 Office/WPS 文件前先加载它，然后统一交给 `wps-office-suite`。
不要自己拼装文档、不要引用其它已不存在的技能、不要依赖宿主注入的编辑器上下文或 `file_id`。

## 唯一目标技能

`wps-office-suite`（WPS Office 全家桶 v5.4.0）：四引擎（WPS → MS Office → LibreOffice → 纯 Python）自动检测，
自带 `scripts/wps.py` 统一入口与 47 个脚本，覆盖 Word / Excel / PPT 的创建、编辑、排版、分析和格式转换。

加载它之后先看它的 `SKILL.md`，并运行 `python scripts/wps --list` 查看当前可用命令，再按命令表选调用方式。

## 路由表

| 任务 | 交给 `wps-office-suite` 的能力 |
|---|---|
| 新建 / 编辑 Word（`.doc` `.docx` `.dot` `.wps` `.wpt`） | `word`；公文排版 `gongwen`；长文档 `long-document`；模板 `template` |
| 新建 / 编辑 / 分析 Excel（`.xls` `.xlsx` `.xlt` `.csv` `.tsv`） | `excel`；`excel-analyze`；图表推荐 `chart-recommend`；公式解释 `formula-explain` |
| 新建 / 编辑 / 生成 PPT（`.ppt` `.pptx` `.pps` `.pot`） | `ppt`；`ppt-generate`；`docx-to-ppt` |
| 格式转换（docx/xlsx/pptx ↔ pdf/txt/html/csv/png） | `convert` |
| 跨文档检索 / 批量整理 / 水印 / 打码 | `doc-search`、`doc-manager`、`watermark`、`redact` |

## 前置条件

- 需要 **Python 3.8+**；纯 Python 模式需 `python-docx` / `openpyxl` / `python-pptx`（见该技能的 `requirements.txt`）。
- 首次使用先跑 `python scripts/wps_test.py` 做环境自检，`python scripts/wps_excel.py engine-info` 看当前引擎。
- 机器上没有 WPS / MS Office / LibreOffice 时会自动落到纯 Python 引擎；此时**添加幻灯片、主题、VBA/宏不可用**，如实告知用户，不要假装完成。
- 单文件建议 < 50MB；中文路径、文件被其它程序占用是常见失败原因（该技能自带 20+ 避坑与 15 个错误 ID 速查，按其中的排查步骤处理）。

## 输出格式分类

结构化文本内容（讲稿、发言要点、文案、摘要、报告、会议纪要）默认按「文档」处理，产出 DOCX；只有用户明确指定 markdown / 纯文本时才改。表格类请求按 Excel、演示类按 PPT。

## 不在范围内

- **PDF 阅读理解**（提取文字/表格/图片、逐页核对）：当前没有对应技能。可先尝试 `wps-office-suite` 的 `convert` 把 PDF 转成可解析格式，转换失败就如实说明不支持；不要自行拼接其它 PDF 工具链或 `pip install` 第三方库。
- **生成 / 编辑任意 PDF**：`convert` 只能导出 PDF，不做任意 PDF 编辑；不支持时明确告知。
- 在线文档、腾讯文档、资料库、企业微信：不属于本地文件路由。
- WPS 专有 `.et` `.ett` `.dps` `.dpt`：请用户先另存为 `.xlsx` / `.pptx`。
- 宏文件（`.docm` `.xlsm` `.pptm` 等）可按对应类型打开，但**不执行宏**。

## 展示结果

产出文件后把**绝对路径**写进回复，提示用户自行打开。本运行环境不提供 `present_files` 预览面板，
不要调用该工具、不要调用 `get_pool_status` / `open_file`，也不要声称「已在预览面板打开」。
