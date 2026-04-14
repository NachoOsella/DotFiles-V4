#!/usr/bin/env python3
"""
Tool to pack a directory into a .docx, .pptx, or .xlsx file with XML formatting undone.
"""

import argparse
import shutil
import subprocess
import sys
import tempfile
import defusedxml.minidom
import zipfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="Pack a directory into an Office file")
    parser.add_argument("input_directory", help="Unpacked Office document directory")
    parser.add_argument("output_file", help="Output Office file (.docx/.pptx/.xlsx)")
    parser.add_argument("--force", action="store_true", help="Skip validation")
    args = parser.parse_args()

    try:
        success = pack_document(
            args.input_directory, args.output_file, validate=not args.force
        )
        if args.force:
            print("Warning: Skipped validation", file=sys.stderr)
        elif not success:
            print("Contents would produce a corrupt file.", file=sys.stderr)
            sys.exit(1)

    except ValueError as e:
        sys.exit(f"Error: {e}")


def pack_document(input_dir, output_file, validate=False):
    input_dir = Path(input_dir)
    output_file = Path(output_file)

    if not input_dir.is_dir():
        raise ValueError(f"{input_dir} is not a directory")

    with tempfile.TemporaryDirectory() as temp_dir:
        temp_content_dir = Path(temp_dir) / "content"
        shutil.copytree(input_dir, temp_content_dir)

        for pattern in ["*.xml", "*.rels"]:
            for xml_file in temp_content_dir.rglob(pattern):
                condense_xml(xml_file)

        output_file.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(output_file, "w", zipfile.ZIP_DEFLATED) as zf:
            for f in temp_content_dir.rglob("*"):
                if f.is_file():
                    zf.write(f, f.relative_to(temp_content_dir))
    return True

def condense_xml(xml_file):
    with open(xml_file, "r", encoding="utf-8") as f:
        dom = defusedxml.minidom.parse(f)
    for element in dom.getElementsByTagName("*"):
        if element.tagName.endswith(":t"): continue
        for child in list(element.childNodes):
            if (child.nodeType == child.TEXT_NODE and child.nodeValue and child.nodeValue.strip() == "") or child.nodeType == child.COMMENT_NODE:
                element.removeChild(child)
    with open(xml_file, "wb") as f:
        f.write(dom.toxml(encoding="UTF-8"))

if __name__ == "__main__":
    main()
