#!/usr/bin/env python3
"""Split a PDF into one file per page. Usage: pdf_split.py input.pdf [prefix]"""
import sys
from pathlib import Path
from pypdf import PdfReader, PdfWriter

if len(sys.argv) < 2:
    sys.exit("Usage: pdf_split.py <input.pdf> [output_prefix]")

prefix = sys.argv[2] if len(sys.argv) > 2 else "page"
reader = PdfReader(sys.argv[1])
for i, page in enumerate(reader.pages, start=1):
    writer = PdfWriter()
    writer.add_page(page)
    out = f"{prefix}_{i:03d}.pdf"
    with open(out, "wb") as f:
        writer.write(f)
    print(out)
