---
name: pdf
description: Use for extracting, merging, splitting, OCR, and filling PDFs.
---

# PDF Processing

- [Quick Start](#quick-start)
- [Common Operations](#common-operations)
  - [Merge PDFs](#merge-pdfs)
  - [Split PDF](#split-pdf)
  - [Rotate Pages](#rotate-pages)
  - [Extract Text](#extract-text)
  - [Extract Tables](#extract-tables)
  - [Create PDFs](#create-pdfs)
  - [OCR Scanned PDFs](#ocr-scanned-pdfs)
- [Gotchas](#gotchas)
- [Reusable Scripts](#reusable-scripts)
- [Library Reference](#library-reference)
- [Command-Line Tools](#command-line-tools)

---

## Quick Start

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("document.pdf")
print(f"Pages: {len(reader.pages)}")

# Extract text
text = "".join(page.extract_text() for page in reader.pages)
```

---

## Common Operations

### Merge PDFs

```python
from pypdf import PdfReader, PdfWriter

writer = PdfWriter()
for pdf_file in ["doc1.pdf", "doc2.pdf"]:
    for page in PdfReader(pdf_file).pages:
        writer.add_page(page)
with open("merged.pdf", "wb") as f:
    writer.write(f)
```

### Split PDF

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("input.pdf")
for i, page in enumerate(reader.pages):
    writer = PdfWriter()
    writer.add_page(page)
    with open(f"page_{i+1}.pdf", "wb") as f:
        writer.write(f)
```

### Rotate Pages

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("input.pdf")
writer = PdfWriter()
for page in reader.pages:
    writer.add_page(page.rotate(90))   # clockwise
with open("rotated.pdf", "wb") as f:
    writer.write(f)
```

### Extract Text

```python
import pdfplumber

with pdfplumber.open("document.pdf") as pdf:
    text = "\n".join(page.extract_text() or "" for page in pdf.pages)
```

### Extract Tables

```python
import pdfplumber

with pdfplumber.open("document.pdf") as pdf:
    for page in pdf.pages:
        tables = page.extract_tables()
        for table in tables:
            for row in table:
                print(row)
```

### Create PDFs

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

images = convert_from_path("scanned.pdf")
text = "\n".join(pytesseract.image_to_string(img) for img in images)
```

---

## Gotchas

| Issue | Explanation | Workaround |
|-------|-------------|------------|
| **Scanned PDFs contain no text** | `extract_text()` returns empty or garbage for image-based pages. | Run OCR first (see [OCR Scanned PDFs](#ocr-scanned-pdfs)). |
| **Tables without visible borders** | `pdfplumber.extract_tables()` relies on ruling lines; borderless tables may be missed or parsed as a single column. | Set `table_settings={"vertical_strategy": "text", "horizontal_strategy": "text"}` or switch to layout-based extraction. |
| **reportlab origin is bottom-left** | Coordinates `(0, 0)` are at the bottom-left corner of the page, unlike most image APIs where `(0, 0)` is top-left. | Use `page_height - y` to convert from top-left conventions, or use `c.translate()` and draw in your own coordinate space. |
| **Rotation mutates in place** | `page.rotate()` modifies the page object and returns it; do not reuse the original writer without care. | Re-read the source PDF if you need both original and rotated copies. |

---

## Reusable Scripts

The following standalone CLI wrappers live in `scripts/` so you do not rebuild logic each time. Copy or adapt them directly. Each script is self-contained and prints usage when called with no arguments.

**Available scripts:**
- `scripts/pdf_merge.py` – merge multiple PDFs
- `scripts/pdf_split.py` – split into one file per page
- `scripts/pdf_text.py` – extract plain text
- `scripts/pdf_rotate.py` – rotate all pages

### `scripts/pdf_merge.py`

```python
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
```

### `scripts/pdf_split.py`

```python
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
```

### `scripts/pdf_text.py`

```python
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
```

### `scripts/pdf_rotate.py`

```python
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
```

---

## Library Reference

| Library | Best For | Avoid When | Key Dependency |
|---------|----------|------------|----------------|
| **pypdf** | Merging, splitting, rotating, light metadata editing | Complex layout extraction, fine-grained text positioning | Pure Python |
| **pdfplumber** | Text and table extraction with bounding-box info | Creating new PDFs, heavy document assembly | `pdfminer.six` |
| **PyMuPDF (fitz)** | Fast rendering, precise text extraction, annotations, redaction | Requiring a pure-Python dependency chain (needs compiled binary) | Compiled C lib |
| **reportlab** | Generating new PDFs programmatically | Editing existing PDFs | Pure Python |

### Decision Flow

1. **Need to merge / split / rotate / stamp?** -> `pypdf`
2. **Need to extract text or tables from existing PDFs?** -> `pdfplumber`
3. **Need speed, image rendering, or annotation editing?** -> `PyMuPDF`
4. **Need to create a brand-new PDF from scratch?** -> `reportlab`

---

## Command-Line Tools

```bash
# Extract text preserving layout
pdftotext -layout input.pdf output.txt

# Merge with qpdf
qpdf --empty --pages file1.pdf file2.pdf -- merged.pdf
```

---

## Quick Reference

| Task | Tool | Key Function |
|------|------|--------------|
| Merge/Split/Rotate | pypdf | `writer.add_page()` |
| Extract text | pdfplumber | `page.extract_text()` |
| Extract tables | pdfplumber | `page.extract_tables()` |
| Create PDFs | reportlab | `Canvas` |
| OCR | pytesseract + pdf2image | `image_to_string()` |
