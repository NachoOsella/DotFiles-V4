#!/usr/bin/env python3
"""Extract plain text from a PDF. Usage: pdf_text.py input.pdf > out.txt"""
import sys
import pdfplumber

if len(sys.argv) < 2:
    sys.exit("Usage: pdf_text.py <input.pdf>")

with pdfplumber.open(sys.argv[1]) as pdf:
    for page in pdf.pages:
        text = page.extract_text()
        if text:
            print(text)
