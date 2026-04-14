---
name: docx
description: "Comprehensive Word document creation, editing, and analysis with support for tracked changes, comments, formatting preservation, and text extraction. Use when you need to: (1) create new Word documents programmatically, (2) edit existing .docx files, (3) add tracked changes or comments to documents, (4) extract text or analyze document contents, (5) convert documents to other formats, or (6) work with document XML structure."
---

# DOCX Creation, Editing, and Analysis

## Workflow Decision Tree

| Task | Approach |
|------|----------|
| Read/analyze content | Text extraction or Raw XML access |
| Create new document | docx-js workflow |
| Edit your own document (simple) | Basic OOXML editing |
| Edit someone else's document | Redlining workflow (recommended) |

## Reading and Analyzing Content

### Text Extraction
```bash
pandoc --track-changes=all path-to-file.docx -o output.md
```

### Raw XML Access
For comments, complex formatting, etc.:
```bash
python ~/.pi/agent/skills/docx/ooxml/scripts/unpack.py <office_file> <output_directory>
```

## Creating New Documents

Use **docx-js** for new Word documents.

1. **MANDATORY**: Read `~/.pi/agent/skills/docx/docx-js.md` completely
2. Create JavaScript/TypeScript file using Document, Paragraph, TextRun components
3. Export as .docx using `Packer.toBuffer()`

## Editing Existing Documents

Use the **Document library** (Python OOXML manipulation).

1. **MANDATORY**: Read `~/.pi/agent/skills/docx/ooxml.md` completely
2. Unpack: `python ~/.pi/agent/skills/docx/ooxml/scripts/unpack.py <file> <dir>`
3. Create and run Python script using Document library
4. Pack: `python ~/.pi/agent/skills/docx/ooxml/scripts/pack.py <dir> <output.docx>`

## Redlining Workflow (Tracked Changes)

1. Get markdown: `pandoc --track-changes=all file.docx -o current.md`
2. Read `~/.pi/agent/skills/docx/ooxml.md` and unpack document
3. Implement changes in batches using `get_node` and `doc.save()`
4. Pack: `python ~/.pi/agent/skills/docx/ooxml/scripts/pack.py unpacked reviewed.docx`
5. Verify: `pandoc --track-changes=all reviewed.docx -o verification.md`

## Converting to Images

```bash
soffice --headless --convert-to pdf document.docx
pdftoppm -jpeg -r 150 document.pdf page
```

## Dependencies

- pandoc, docx (npm), LibreOffice, poppler-utils, defusedxml (pip)
