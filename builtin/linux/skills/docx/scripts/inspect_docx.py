#!/usr/bin/env python3
"""Inspect the package structure of a DOCX file using the Python standard library."""

from __future__ import annotations

import argparse
import json
import sys
import zipfile
from collections import Counter
from pathlib import Path
from xml.etree import ElementTree as ET


W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PKG_REL = "{http://schemas.openxmlformats.org/package/2006/relationships}"
REQUIRED_PARTS = ("[Content_Types].xml", "_rels/.rels", "word/document.xml")


def parse_xml(archive: zipfile.ZipFile, name: str) -> ET.Element:
    return ET.fromstring(archive.read(name))


def inspect(path: Path) -> tuple[dict[str, object], list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    report: dict[str, object] = {"file": str(path.resolve())}

    if not path.is_file():
        return report, [f"File not found: {path}"], warnings
    if path.suffix.lower() != ".docx":
        warnings.append("The filename does not use the .docx extension.")
    if not zipfile.is_zipfile(path):
        return report, ["The file is not a readable ZIP/OOXML package."], warnings

    try:
        with zipfile.ZipFile(path) as archive:
            names = archive.namelist()
            name_set = set(names)
            report["package_parts"] = len(names)
            missing = [name for name in REQUIRED_PARTS if name not in name_set]
            if missing:
                errors.append("Missing required parts: " + ", ".join(missing))

            malformed: list[str] = []
            for name in names:
                if name.endswith(".xml") or name.endswith(".rels"):
                    try:
                        parse_xml(archive, name)
                    except (ET.ParseError, KeyError) as exc:
                        malformed.append(f"{name}: {exc}")
            if malformed:
                errors.append("Malformed XML parts: " + "; ".join(malformed))

            if "word/document.xml" in name_set:
                root = parse_xml(archive, "word/document.xml")
                report.update(
                    {
                        "paragraphs": len(root.findall(f".//{W}p")),
                        "tables": len(root.findall(f".//{W}tbl")),
                        "table_rows": len(root.findall(f".//{W}tr")),
                        "table_cells": len(root.findall(f".//{W}tc")),
                        "sections": len(root.findall(f".//{W}sectPr")),
                        "explicit_page_breaks": len(
                            root.findall(f".//{W}br[@{W}type='page']")
                        ),
                        "insertions": len(root.findall(f".//{W}ins")),
                        "deletions": len(root.findall(f".//{W}del")),
                        "comment_anchors": len(root.findall(f".//{W}commentRangeStart")),
                        "hyperlinks": len(root.findall(f".//{W}hyperlink")),
                    }
                )

            categories = Counter()
            for name in names:
                if name.startswith("word/media/") and not name.endswith("/"):
                    categories["media"] += 1
                elif name.startswith("word/header") and name.endswith(".xml"):
                    categories["headers"] += 1
                elif name.startswith("word/footer") and name.endswith(".xml"):
                    categories["footers"] += 1
                elif name == "word/comments.xml":
                    categories["comment_parts"] += 1
                elif name == "word/footnotes.xml":
                    categories["footnote_parts"] += 1
                elif name == "word/endnotes.xml":
                    categories["endnote_parts"] += 1
            report.update(categories)

            external_targets: list[str] = []
            for name in names:
                if not name.endswith(".rels"):
                    continue
                try:
                    rels = parse_xml(archive, name)
                except ET.ParseError:
                    continue
                for rel in rels.findall(f".//{PKG_REL}Relationship"):
                    if rel.get("TargetMode") == "External":
                        target = rel.get("Target") or ""
                        external_targets.append(target)
            report["external_relationships"] = external_targets
            if external_targets:
                warnings.append(
                    f"Found {len(external_targets)} external relationship(s); review before sharing."
                )
    except (OSError, zipfile.BadZipFile) as exc:
        errors.append(str(exc))

    report["size_bytes"] = path.stat().st_size if path.exists() else 0
    return report, errors, warnings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("docx", type=Path, help="DOCX file to inspect")
    parser.add_argument("--json", action="store_true", help="Print JSON only")
    args = parser.parse_args()

    report, errors, warnings = inspect(args.docx)
    payload = {"ok": not errors, "report": report, "warnings": warnings, "errors": errors}
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    else:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        print("PASS" if not errors else "FAIL", file=sys.stderr)
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
