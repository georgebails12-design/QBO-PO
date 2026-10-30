"""
Build the commission-bills check workbook (no QuickBooks connection needed).

    python3 make_check.py <commission workbook.xlsx> <output.xlsx>

Lists every bill commission_bills.py would create, in the QuickBooks import
layout plus check columns, with totals by vendor and a reconciliation back to
the source sheet. Exits 2 if a rep in column B has no vendor mapping.
"""
import sys, os, json
WEBAPP = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..", "..", "webapp")
sys.path.insert(0, WEBAPP)
import commission_bills as cb
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.formatting.rule import FormulaRule
from openpyxl.utils import get_column_letter as L
import openpyxl

src, out = sys.argv[1], sys.argv[2]
sheet, rows = cb.read_rows(src)
due = cb.due_date_from_sheet(sheet, rows)
vm = json.load(open(os.path.join(WEBAPP, "commission_vendors.json")))
vm = {cb.norm(k): v for k, v in vm.items() if not k.startswith("_")}
raw = list(openpyxl.load_workbook(src, data_only=True).worksheets[0].iter_rows(values_only=True))

missing = sorted({r["rep"] for r in rows if cb.norm(r["rep"]) not in vm})
if missing:
    sys.exit(print("No vendor in commission_vendors.json for: " + ", ".join(missing)) or 2)
if any(r["second"] for r in rows) and cb.norm("2nd Comm") not in vm:
    sys.exit(print("Sheet has 2nd Comm amounts but no '2nd Comm' vendor in commission_vendors.json") or 2)

bills = []
for r in rows:
    x = raw[r["excel_row"] - 1]
    m = vm[cb.norm(r["rep"])]
    vendors = [m] if isinstance(m, str) else m
    for v in vendors:
        name, share = (v, 1.0) if isinstance(v, str) else (v["vendor"], float(v.get("share", 1)))
        desc = r["description"] if share == 1 else r["description"].rsplit(" ", 1)[0] + f" {cb.fmt_rate(x[13] * share)}"
        bills.append((r, name, cb.money(r["amount"] * cb.Decimal(str(share))), x[13] * share, desc,
                      "Commission" if len(vendors) == 1 else f"Shared deal ({r['rep']})"))
    if r["second"]:
        sv = (vm.get(cb.norm(cb.SECOND_COMM_BY_INVOICE_KEY)) or {}).get(r["doc_number"].split()[0]) or vm[cb.norm("2nd Comm")]
        bills.append((r, sv, r["second"], 0.005, r["second_description"], "2nd Comm override"))

wb = Workbook(); ws = wb.active; ws.title = "Bills to Post"
hdr = ["Post?", "Bill Date", "Due Date", "Bill Number", "Transaction Type", "Customer", "Vendor",
       "Description", "Qty", "Unit Price", "Category", "Class", "Q Number/PO #", "Memo",
       "Source Row", "Rep (col B)", "Bill Kind", "Panda #", "Rate", "Expected Amount", "Amount OK?", "Memo = Description?"]
ws.append(hdr)
green = PatternFill("solid", fgColor="1F9D45"); grey = PatternFill("solid", fgColor="D9D9D9")
for i, h in enumerate(hdr, 1):
    c = ws.cell(1, i); c.font = Font(bold=True, color="FFFFFF" if i <= 14 else "000000")
    c.fill = green if i <= 14 else grey; c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
for n, (r, v, amt, rate, desc, kind) in enumerate(bills, 2):
    x = raw[r["excel_row"] - 1]
    ws.append(["Yes", r["pay_date"], due, r["doc_number"], "Bill", r["customer"], v, desc, 1, float(amt),
               cb.DEFAULT_ACCOUNT, cb.DEFAULT_CLASS, r["q_number"], desc,
               r["excel_row"], r["rep"], kind, x[9], rate,
               f"=ROUND(R{n}*S{n},2)", f'=IF(ABS(J{n}-T{n})<=0.01,"OK","CHECK")', f'=IF(H{n}=N{n},"OK","CHECK")'])
last = ws.max_row
t = last + 2
ws.cell(t, 9, "Total").font = Font(bold=True)
ws.cell(t, 10, f"=SUM(J2:J{last})").font = Font(bold=True)

for row in ws.iter_rows(min_row=2, max_row=last):
    row[1].number_format = row[2].number_format = "m/d/yyyy"
    row[9].number_format = row[19].number_format = '#,##0.00'
    row[17].number_format = '#,##0'; row[18].number_format = '0.0##%'
ws.cell(t, 10).number_format = '#,##0.00'
widths = [7, 11, 11, 15, 11, 48, 20, 70, 5, 11, 22, 11, 14, 70, 8, 10, 22, 10, 8, 12, 10, 12]
for i, w in enumerate(widths, 1): ws.column_dimensions[L(i)].width = w
ws.freeze_panes = "E2"; ws.auto_filter.ref = f"A1:{L(len(hdr))}{last}"
red = PatternFill("solid", fgColor="F8CBAD")
ws.conditional_formatting.add(f"U2:V{last}", FormulaRule(formula=['U2="CHECK"'], fill=red))
ws.conditional_formatting.add(f"V2:V{last}", FormulaRule(formula=['V2="CHECK"'], fill=red))

# Summary
s = wb.create_sheet("Totals by Vendor")
s.append(["Vendor", "Bills", "Amount"])
for c in s[1]: c.font = Font(bold=True, color="FFFFFF"); c.fill = green
vendors = sorted({b[1] for b in bills})
for i, v in enumerate(vendors, 2):
    s.append([v, f"=COUNTIF('Bills to Post'!G:G,A{i})", f"=SUMIF('Bills to Post'!G:G,A{i},'Bills to Post'!J:J)"])
e = len(vendors) + 1
s.append(["Total", f"=SUM(B2:B{e})", f"=SUM(C2:C{e})"])
for c in s[e + 1]: c.font = Font(bold=True)

# Reconciliation to the source sheet (amounts as on the source sheet)
o = sum(float(r["amount"]) for r in rows); p = sum(float(r["second"] or 0) for r in rows)
def shares(m):
    return [1.0] if isinstance(m, str) else [1.0 if isinstance(v, str) else float(v.get("share", 1)) for v in m]
extra = sum(float(cb.money(r["amount"] * cb.Decimal(str(sh)))) for r in rows
            for sh in shares(vm[cb.norm(r["rep"])])[1:])
recon = [("Commission column (O) on source sheet", round(o, 2)),
         ("2nd Comm column (P) - sales assistant 0.5%", round(p, 2)),
         ("Shared deals - other reps on the same row", round(extra, 2))]
base = e + 3
s.cell(base, 1, "Reconciliation to " + sheet + " sheet").font = Font(bold=True)
for k, (label, val) in enumerate(recon, 1):
    s.cell(base + k, 1, label); s.cell(base + k, 3, val)
s.cell(base + 4, 1, "Expected total"); s.cell(base + 4, 3, f"=SUM(C{base+1}:C{base+3})")
s.cell(base + 5, 1, "Bills total"); s.cell(base + 5, 3, f"=C{e+1}")
s.cell(base + 6, 1, "Difference (should be 0.00)"); s.cell(base + 6, 3, f"=ROUND(C{base+4}-C{base+5},2)")
for r_ in range(base + 4, base + 7): s.cell(r_, 1).font = Font(bold=True)
for row in s.iter_rows(min_row=2): row[2].number_format = '#,##0.00'
s.column_dimensions["A"].width = 58; s.column_dimensions["B"].width = 8; s.column_dimensions["C"].width = 14
s.cell(base + 8, 1, "Note: 2nd Comm is rounded to cents per bill, so the difference can be off by a cent or two.")
# column is rounded to cents per bill, so the difference can be off by a cent or two."])
wb.save(out); print(len(bills), "bills")
