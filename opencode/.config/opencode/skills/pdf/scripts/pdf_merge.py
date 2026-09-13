#!/usr/bin/env python3
"""Merge multiple PDFs into one. Usage: pdf_merge.py out.pdf a.pdf b.pdf ..."""
import sys
from pypdf import PdfReader, PdfWriter

if len(sys.argv) < 3:
    sys.exit("Usage: pdf_merge.py <output.pdf> <input1.pdf> [input2.pdf] ...")

writer = PdfWriter()
for path in sys.argv[2:]:
    for page in PdfReader(path).pages:
        writer.add_page(page)
with open(sys.argv[1], "wb") as f:
    writer.write(f)
print(f"Merged {len(sys.argv) - 2} files into {sys.argv[1]}")
