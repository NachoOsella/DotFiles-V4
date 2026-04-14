---
name: pdf
description: "Comprehensive PDF manipulation toolkit for extracting text and tables, creating new PDFs, merging/splitting documents, and handling forms. Use when you need to: (1) extract text or tables from PDFs, (2) create new PDF documents, (3) merge or split PDF files, (4) rotate or modify pages, (5) OCR scanned documents, or (6) fill PDF forms."
---

# PDF Processing

## Quick Start

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("document.pdf")
print(f"Pages: {len(reader.pages)}")

# Extract text
text = "".join(page.extract_text() for page in reader.pages)
```

## Common Operations

### Merge PDFs
```python
writer = PdfWriter()
for pdf_file in ["doc1.pdf", "doc2.pdf"]:
    for page in PdfReader(pdf_file).pages:
        writer.add_page(page)
with open("merged.pdf", "wb") as f:
    writer.write(f)
```

### Split PDF
```python
reader = PdfReader("input.pdf")
for i, page in enumerate(reader.pages):
    writer = PdfWriter()
    writer.add_page(page)
    with open(f"page_{i+1}.pdf", "wb") as f:
        writer.write(f)
```

### Rotate Pages
```python
page = reader.pages[0]
page.rotate(90)  # 90 degrees clockwise
```

### Extract Tables (pdfplumber)
```python
import pdfplumber
with pdfplumber.open("document.pdf") as pdf:
    for page in pdf.pages:
        tables = page.extract_tables()
```

### Create PDFs (reportlab)
```python
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas

c = canvas.Canvas("hello.pdf", pagesize=letter)
c.drawString(100, 700, "Hello World!")
c.save()
```

### OCR Scanned PDFs
```python
from pdf2image import convert_from_path
import pytesseract

images = convert_from_path('scanned.pdf')
text = "\n".join(pytesseract.image_to_string(img) for img in images)
```

## Command-Line Tools

```bash
# Extract text preserving layout
pdftotext -layout input.pdf output.txt

# Merge with qpdf
qpdf --empty --pages file1.pdf file2.pdf -- merged.pdf
```

## Quick Reference

| Task | Tool | Key Function |
|------|------|--------------|
| Merge/Split/Rotate | pypdf | `writer.add_page()` |
| Extract text | pdfplumber | `page.extract_text()` |
| Extract tables | pdfplumber | `page.extract_tables()` |
| Create PDFs | reportlab | Canvas |
| OCR | pytesseract + pdf2image | `image_to_string()` |
