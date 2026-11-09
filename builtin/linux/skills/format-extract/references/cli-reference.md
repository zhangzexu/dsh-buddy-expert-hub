# format-extract 转换器与 API 参考

> 供 Expert 在需要自定义输入/输出、批量处理、独立质量评估时渐进加载。
> 日常"docx → HTML 格式提取"直接走 `run.py`，无需阅读本文档。

---

## 统一入口

所有命令固定使用技能自带的纯 Python 转换器 `scripts/docx2html.py`
（随技能分发，**不需要 Node.js、不依赖 npm、不联网**）：

```bash
python3 <skill-dir>/scripts/docx2html.py
```

> 解释器需已安装 `python-docx`。若不确定用哪个，先跑
> `bash <skill-dir>/scripts/setup.sh --print-python` 拿到可用路径。
> 路径以本技能目录为基准，实际调用时替换为你的绝对或相对路径。

---

## convert — docx 转 HTML

### 单文件模式

```bash
python3 <skill-dir>/scripts/docx2html.py convert --input <docx-path> --output <html-path> [--image-base-url <url>]
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `--input <path>` | 是（与 `--input-dir` 二选一） | 输入 .docx 文件路径 |
| `--output <path>` | 否 | 输出 HTML 路径，默认同名 .html |
| `--image-base-url <url>` | 否 | 图片 src 的相对基础路径，默认 `images` |

图片按出现顺序抽取为 `image1.png` / `image2.jpg` …，落盘在**输出 HTML 同级的
`images/` 目录**（目录名取自 `--image-base-url`）。转换成功后 HTML 内的 `src`
使用 `./images/imageN.ext` 形式的相对路径。

### 批量模式

```bash
python3 <skill-dir>/scripts/docx2html.py convert --input-dir <dir> --output-dir <dir> [--image-base-url <url>]
```

仅处理目录**顶层**的 .docx，不递归子目录。`--input` 与 `--input-dir` 互斥。

---

## assess — HTML 质量评估

```bash
python3 <skill-dir>/scripts/docx2html.py assess <html-file> [--output <report-path>]
```

独立评估 HTML 质量，退出码 1 表示未通过检查（非崩溃）。

### 5 项检查维度

| 维度 | 通过条件 |
|------|----------|
| 结构化校验 | 根元素为 `<article class="docx-content">`，标签正确闭合 |
| 样式信噪比 | 文本量 ÷（文本量 + 表现层标记）≥ 50%；**结构标签（table/tr/td/p/h*/ul/li/br）不计入分母**，避免表格型文档被误判 |
| 表格还原度 | 合并单元格无还原问题 |
| 样式白名单 | 仅保留 `color` / `background-color` / `text-align` / `text-decoration` / `font-weight` / `font-style` / `max-width` |
| 降噪检查 | 无 `mso-*` 属性、无 `MsoXxx` 类名、无空 `<span>` |

> assess 输入必须是 convert 产出的 HTML；不接受原始 .docx。

---

## 编程式 API（Python）

`scripts/docx2html.py` 可直接被 import 复用，无需走子进程。

### convert_docx

```python
def convert_docx(docx_path: Path, image_base_url: str, images_dir: Path | None) -> str
```

返回完整 HTML 字符串（含 `<!DOCTYPE html>` 与内联 `<style>`）。
`images_dir=None` 时只提取图片字节、不落盘。

```python
import sys
from pathlib import Path

sys.path.insert(0, "<skill-dir>/scripts")
from docx2html import convert_docx

out = Path("./out/reference_format.html")
out.parent.mkdir(parents=True, exist_ok=True)
images = out.parent / "images"
images.mkdir(exist_ok=True)

html = convert_docx(Path("./document.docx"), "./images", images)
out.write_text(html, encoding="utf-8")
```

### assess_html / generate_report

```python
def assess_html(html: str, label: str) -> dict
def generate_report(result: dict) -> str
```

```python
from docx2html import assess_html, generate_report

result = assess_html(html, label="reference_format.html")
print(generate_report(result))          # 人类可读报告
print(result["overall"])                # 'pass' / 'fail'
```

返回结构：

```python
{
  "file": str,
  "timestamp": str,          # ISO 8601
  "overall": "pass" | "fail",
  "checks": [ { "name": str, "passed": bool, "detail": str } ],
  "summary": { "total": int, "passed": int, "failed": int, "warnings": int },
}
```

---

## 退出码与错误

| 退出码 | 含义 |
|--------|------|
| 0 | 成功 |
| 1 | 失败（文件不存在 / 格式错误 / assess 未通过） |
| 2 | 参数错误（缺参数 / 互斥冲突 / 未知子命令） |

### 常见错误

| 错误关键词 | 处理 |
|------------|------|
| `--input 与 --input-dir 互斥` | 二者选其一 |
| `ENOENT: 输入文件不存在` | 检查路径拼写，转绝对路径后重试 1 次 |
| `ENOENT: 输入目录不存在` | 检查 `--input-dir` 指向 |
| `ENOENT: HTML 文件不存在` | assess 的目标路径错误 |
| `未知子命令` | 只支持 `convert` / `assess` |
| 损坏的 ZIP / 非 .docx | 不重试，检查输入文件 |
| `ModuleNotFoundError: No module named 'docx'` | 跑一次 `scripts/setup.sh`，或把 `FORMAT_EXTRACT_PY` 指向已有环境 |

---

## 反模式（避免踩坑）

- 对同一 .docx 反复 convert 而不 assess → 先跑一次 assess 看质量
- 把非 convert 产出的 HTML 交给 assess → assess 只认 `<article class="docx-content">` 结构
- `--image-base-url` 用绝对 URL → 必须相对路径（如 `./images`）
- 期望批量模式递归子目录 → 只处理顶层
- 换成第三方 docx2html 库 → 本技能已自包含，换库会改变样式白名单口径，assess 直接判负
