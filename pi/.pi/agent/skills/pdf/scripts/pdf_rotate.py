#!/usr/bin/env python3
"""Rotate all pages of a PDF. Usage: pdf_rotate.py input.pdf 90 out.pdf"""
import sys
from pypdf import PdfReader, PdfWriter

if len(sys.argv) != 4:
    sys.exit("Usage: pdf_rotate.py <input.pdf> <degrees> <output.pdf>")

degrees = int(sys.argv[2])
reader = PdfReader(sys.argv[1])
writer = PdfWriter()
for page in reader.pages:
    writer.add_page(page.rotate(degrees))
with open(sys.argv[3], "wb") as f:
    writer.write(f)
print(f"Rotated {len(reader.pages)} pages by {degrees} degrees -> {sys.argv[3]}")
