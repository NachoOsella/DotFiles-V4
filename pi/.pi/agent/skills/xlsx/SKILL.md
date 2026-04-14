---
name: xlsx
description: "Comprehensive Excel spreadsheet creation, editing, and analysis with support for formulas, formatting, data analysis, and visualization. Use when you need to: (1) create new Excel files with formulas and formatting, (2) read or analyze spreadsheet data, (3) modify existing .xlsx files, (4) perform data analysis or create visualizations, or (5) work with complex Excel features like conditional formatting."
---

# XLSX Creation, Editing, and Analysis

## Reading and Analyzing Data

Use **pandas** for data analysis:
```python
import pandas as pd
df = pd.read_excel('file.xlsx')
```

## Creating/Editing Excel Files

### CRITICAL: Use Formulas, Not Hardcoded Values

```python
# Good: Let Excel calculate
sheet['B10'] = '=SUM(B2:B9)'

# Bad: Hardcoding calculated values
sheet['B10'] = 45  # Don't do this
```

### Basic Workflow

```python
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment

wb = Workbook()
sheet = wb.active
sheet['A1'] = 'Hello'
sheet['B2'] = '=SUM(A1:A10)'
wb.save('output.xlsx')
```

### Recalculating Formulas (MANDATORY)

Excel files created by openpyxl contain formulas as strings but not calculated values. Always recalculate after saving:

```bash
python ~/.pi/agent/skills/xlsx/recalc.py <excel_file> [timeout_seconds]
```

## Library Selection

| Use Case | Library |
|----------|---------|
| Data analysis, bulk operations | pandas |
| Complex formatting, formulas | openpyxl |

## Complete Workflow

1. Choose tool (pandas vs openpyxl)
2. Create/load workbook
3. Add data, formulas, formatting
4. Save file
5. **Recalculate**: `python ~/.pi/agent/skills/xlsx/recalc.py output.xlsx`
