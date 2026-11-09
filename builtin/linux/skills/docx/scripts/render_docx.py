#!/usr/bin/env python3
"""Render a DOCX to per-page PNG files through LibreOffice and a PDF renderer."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def find_command(*names: str) -> str | None:
    for name in names:
        command = shutil.which(name)
        if command:
            return command
    return None


def run(command: list[str], env: dict[str, str] | None = None) -> None:
    result = subprocess.run(command, env=env, text=True, capture_output=True)
    if result.returncode != 0:
        details = "\n".join(part for part in (result.stdout, result.stderr) if part.strip())
        raise RuntimeError(f"Command failed ({result.returncode}): {' '.join(command)}\n{details}")


def render_with_pymupdf(pdf: Path, output_dir: Path, dpi: int) -> list[Path]:
    try:
        import fitz  # type: ignore
    except ImportError as exc:
        raise RuntimeError(
            "No PDF rasterizer found. Install pdftoppm/pdftocairo or the PyMuPDF package."
        ) from exc

    scale = dpi / 72.0
    document = fitz.open(pdf)
    outputs: list[Path] = []
    try:
        for index, page in enumerate(document, start=1):
            output = output_dir / f"page-{index}.png"
            page.get_pixmap(matrix=fitz.Matrix(scale, scale), alpha=False).save(output)
            outputs.append(output)
    finally:
        document.close()
    return outputs


def render_pdf(pdf: Path, output_dir: Path, dpi: int) -> list[Path]:
    pdftoppm = find_command("pdftoppm")
    if pdftoppm:
        prefix = output_dir / "page"
        run([pdftoppm, "-png", "-r", str(dpi), str(pdf), str(prefix)])
        return sorted(output_dir.glob("page-*.png"), key=lambda item: int(item.stem.split("-")[-1]))

    pdftocairo = find_command("pdftocairo")
    if pdftocairo:
        prefix = output_dir / "page"
        run([pdftocairo, "-png", "-r", str(dpi), str(pdf), str(prefix)])
        return sorted(output_dir.glob("page-*.png"), key=lambda item: int(item.stem.split("-")[-1]))

    return render_with_pymupdf(pdf, output_dir, dpi)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("docx", type=Path, help="DOCX file to render")
    parser.add_argument("--output-dir", required=True, type=Path, help="Directory for page PNGs")
    parser.add_argument("--dpi", type=int, default=144, help="Raster resolution (default: 144)")
    parser.add_argument("--emit-pdf", action="store_true", help="Keep the intermediate PDF")
    args = parser.parse_args()

    source = args.docx.resolve()
    if not source.is_file():
        parser.error(f"file not found: {source}")
    if source.suffix.lower() != ".docx":
        parser.error("input must have a .docx extension")
    if args.dpi < 72 or args.dpi > 600:
        parser.error("--dpi must be between 72 and 600")

    office = find_command("soffice", "libreoffice")
    if not office:
        print("LibreOffice was not found (expected soffice or libreoffice in PATH).", file=sys.stderr)
        return 2

    output_dir = args.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    for stale in output_dir.glob("page-*.png"):
        stale.unlink()

    try:
        with tempfile.TemporaryDirectory(prefix="docx-render-") as temp_name:
            temp_dir = Path(temp_name)
            profile_dir = temp_dir / "lo-profile"
            profile_dir.mkdir()
            env = os.environ.copy()
            env["HOME"] = str(temp_dir)
            run(
                [
                    office,
                    "--headless",
                    "--convert-to",
                    "pdf",
                    "--outdir",
                    str(temp_dir),
                    f"-env:UserInstallation={profile_dir.resolve().as_uri()}",
                    str(source),
                ],
                env=env,
            )
            pdf = temp_dir / f"{source.stem}.pdf"
            if not pdf.is_file() or pdf.stat().st_size == 0:
                raise RuntimeError("LibreOffice did not produce a non-empty PDF.")

            pages = render_pdf(pdf, output_dir, args.dpi)
            if not pages:
                raise RuntimeError("No page PNG files were produced.")

            if args.emit_pdf:
                shutil.copy2(pdf, output_dir / pdf.name)
    except RuntimeError as exc:
        print(str(exc), file=sys.stderr)
        return 1

    for page in pages:
        print(page)
    if args.emit_pdf:
        print(output_dir / f"{source.stem}.pdf")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
