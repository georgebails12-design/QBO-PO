"""Register sheet -> JSON rows the way n8n's Extract from File (xlsx, header row) gives them:
one object per row, keyed by header, empty cells left out."""
import json, sys
import openpyxl
ws = openpyxl.load_workbook(sys.argv[1], data_only=True)["Register"]
rows = list(ws.iter_rows(values_only=True))
head = rows[0]
print(json.dumps([{h: v for h, v in zip(head, r) if v not in (None, "")} for r in rows[1:]], default=str))
