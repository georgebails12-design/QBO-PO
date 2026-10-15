"""
commission_bills.py
===================
Create the payroll commission Bills in QuickBooks from the commissions
workbook (e.g. "Payroll_Com_Oct_26th_2026.xlsx").

One Bill per commission row:

  Vendor       sales rep (col B), mapped to a QBO vendor via commission_vendors.json
  Bill date    payment received date (col I)
  Due date     the payroll date (--due-date, or read from the sheet name "Oct 26")
  Bill no.     "17506 Final" (invoice # + Final/Deposit)
  Category     6800 Sales Commissions, Class Operations, Customer = col F
  Amount       commission (col O)
  Description  "17506 Final <customer> P#$ 14784 6%"  (% is the row's real rate, col N)

Uses the same QuickBooks connection (qbo_config.json / qbo_tokens.json) as
the PO app, so run it from the app folder on the server:

    venv/bin/python commission_bills.py Payroll_Com_Oct_26th_2026.xlsx           # preview only
    venv/bin/python commission_bills.py Payroll_Com_Oct_26th_2026.xlsx --post    # create the bills

Re-running is safe: a bill with the same number for the same vendor is skipped.
"""

import argparse
import csv
import datetime as dt
import json
import os
import re
import sys
from decimal import Decimal, ROUND_HALF_UP

import openpyxl

import qbo_client

VENDOR_MAP_FILE = os.path.join(qbo_client.APP_DIR, "commission_vendors.json")
DEFAULT_ACCOUNT = "6800 Sales Commissions"
DEFAULT_CLASS = "Operations"

# Column positions (0-based) in the commissions sheet. Several headers repeat
# ("Date", "Type"), so columns are taken by position and the header is checked.
COL = {
    "rep": 1,          # B
    "kind": 2,         # C  "Invoice"
    "inv_date": 3,     # D
    "inv_no": 4,       # E
    "customer": 5,     # F  Customer:Project
    "stage": 6,        # G  Final / Deposit
    "pay_date": 8,     # I
    "panda_amt": 9,    # J  "Panda #"
    "rate": 13,        # N  %
    "commission": 14,  # O
    "second": 15,      # P  2nd Comm
    "comm_memo": 17,   # R
}
EXPECTED_HEADERS = {"inv_no": "Number", "customer": "Custmer/Project", "rate": "%",
                    "commission": "Comission", "second": "2nd Comm"}

MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"], 1)}


def money(value):
    return Decimal(str(round(float(value), 6))).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def fmt_rate(rate):
    return f"{round(float(rate) * 100, 4):g}%"


def as_date(value):
    if isinstance(value, dt.datetime):
        return value.date()
    if isinstance(value, dt.date):
        return value
    if isinstance(value, str) and value.strip():
        for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y"):
            try:
                return dt.datetime.strptime(value.strip(), fmt).date()
            except ValueError:
                pass
    return None


def due_date_from_sheet(sheet_name, rows):
    """'Oct 26' -> 2026-10-26, year taken from the latest payment date in the sheet."""
    m = re.match(r"\s*([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})", sheet_name or "")
    if not m or m.group(1).lower() not in MONTHS:
        return None
    year = max((r["pay_date"] for r in rows if r["pay_date"]), default=dt.date.today()).year
    return dt.date(year, MONTHS[m.group(1).lower()], int(m.group(2)))


# ---------------------------------------------------------------------------
# Spreadsheet
# ---------------------------------------------------------------------------
def read_rows(path, sheet=None):
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb[sheet] if sheet else wb.worksheets[0]
    all_rows = list(ws.iter_rows(values_only=True))
    if not all_rows:
        raise SystemExit(f"{path}: sheet '{ws.title}' is empty")

    header = all_rows[0]
    for key, name in EXPECTED_HEADERS.items():
        got = header[COL[key]] if len(header) > COL[key] else None
        if str(got or "").strip() != name:
            raise SystemExit(
                f"Unexpected layout: column {chr(65 + COL[key])} header is {got!r}, expected {name!r}. "
                "Has a column been added or moved?")

    rows = []
    for excel_row, r in enumerate(all_rows[1:], start=2):
        r = list(r) + [None] * (20 - len(r))
        rep = str(r[COL["rep"]] or "").strip()
        commission = r[COL["commission"]]
        if not rep or commission in (None, "") or str(r[COL["kind"]] or "").strip() != "Invoice":
            continue
        inv_no = str(r[COL["inv_no"]] or "").strip()
        stage = str(r[COL["stage"]] or "").strip()
        doc_number = str(r[COL["comm_memo"]] or "").strip() or f"{inv_no} {stage}".strip()
        customer = str(r[COL["customer"]] or "").strip()
        panda_amt = r[COL["panda_amt"]]
        rate = r[COL["rate"]]
        panda_txt = f"{float(panda_amt):g}" if isinstance(panda_amt, (int, float)) else str(panda_amt or "")
        rate_txt = fmt_rate(rate) if isinstance(rate, (int, float)) else str(rate or "")
        rows.append({
            "excel_row": excel_row,
            "rep": rep,
            "customer": customer,
            "doc_number": doc_number,
            "pay_date": as_date(r[COL["pay_date"]]),
            "amount": money(commission),
            "second": money(r[COL["second"]]) if isinstance(r[COL["second"]], (int, float)) else None,
            "description": f"{doc_number} {customer} P#$ {panda_txt} {rate_txt}".strip(),
        })
    return ws.title, rows


# ---------------------------------------------------------------------------
# QuickBooks lookups
# ---------------------------------------------------------------------------
def norm(s):
    return re.sub(r"\s+", " ", str(s or "")).strip().lower()


def load_vendor_map():
    if not os.path.exists(VENDOR_MAP_FILE):
        return {}
    with open(VENDOR_MAP_FILE, "r", encoding="utf-8") as f:
        data = json.load(f)
    return {norm(k): v for k, v in data.items() if not k.startswith("_")}


class Lookups:
    def __init__(self):
        self.vendors = qbo_client._query("SELECT Id, DisplayName FROM Vendor WHERE Active = true")
        self.customers = qbo_client._query(
            "SELECT Id, DisplayName, FullyQualifiedName FROM Customer WHERE Active = true")
        self.accounts = qbo_client._query(
            "SELECT Id, Name, AcctNum, FullyQualifiedName FROM Account WHERE Active = true")
        self.classes = qbo_client._query("SELECT Id, Name, FullyQualifiedName FROM Class WHERE Active = true")
        self.vendor_by_name = {norm(v["DisplayName"]): v for v in self.vendors}
        self.customer_by_fqn = {norm(c.get("FullyQualifiedName") or c["DisplayName"]): c for c in self.customers}
        self.vendor_map = load_vendor_map()

    def account(self, label):
        want = norm(label)
        for a in self.accounts:
            names = {norm(a["Name"]), norm(a.get("FullyQualifiedName")),
                     norm(f"{a.get('AcctNum', '')} {a['Name']}")}
            if want in names or (a.get("AcctNum") and want == norm(a["AcctNum"])):
                return a
        raise SystemExit(f"Account '{label}' not found in QuickBooks (use --account).")

    def klass(self, label):
        want = norm(label)
        for c in self.classes:
            if want in (norm(c["Name"]), norm(c.get("FullyQualifiedName"))):
                return c
        raise SystemExit(f"Class '{label}' not found in QuickBooks (use --class).")

    def customer(self, fqn):
        c = self.customer_by_fqn.get(norm(fqn))
        if c:
            return c
        # Tolerate spacing differences around the ':' separators
        squashed = re.sub(r"\s*:\s*", ":", norm(fqn))
        for key, c in self.customer_by_fqn.items():
            if re.sub(r"\s*:\s*", ":", key) == squashed:
                return c
        return None

    def vendor_by_display(self, name):
        return self.vendor_by_name.get(norm(name))

    def payees(self, rep):
        """[(vendor, share, how)] for a rep, or raise LookupError with the reason."""
        mapped = self.vendor_map.get(norm(rep))
        if mapped:
            splits = [{"vendor": mapped, "share": 1}] if isinstance(mapped, str) else mapped
            out = []
            for s in splits:
                v = self.vendor_by_display(s["vendor"])
                if not v:
                    raise LookupError(f"vendor '{s['vendor']}' (mapped for {rep}) not found in QuickBooks")
                out.append((v, Decimal(str(s.get("share", 1))), "map"))
            if sum(s for _, s, _ in out) != 1:
                raise LookupError(f"shares for {rep} in commission_vendors.json don't add up to 1")
            return out
        # Not mapped: accept a single vendor whose name contains the rep's name as a word
        word = re.compile(rf"\b{re.escape(rep)}\b", re.I)
        hits = [v for v in self.vendors if word.search(v["DisplayName"])]
        if len(hits) == 1:
            return [(hits[0], Decimal(1), "auto")]
        if hits:
            names = ", ".join(v["DisplayName"] for v in hits[:5])
            raise LookupError(f"'{rep}' matches several vendors ({names}) -- add it to commission_vendors.json")
        raise LookupError(f"no vendor for '{rep}' -- add it to commission_vendors.json")


def existing_bills(doc_numbers):
    """{(doc_number, vendor_id)} for bills already in QBO with these numbers."""
    found = set()
    numbers = sorted(set(doc_numbers))
    for i in range(0, len(numbers), 50):
        chunk = numbers[i:i + 50]
        in_list = ", ".join("'" + n.replace("\\", "\\\\").replace("'", "\\'") + "'" for n in chunk)
        for b in qbo_client._query(f"SELECT Id, DocNumber, VendorRef FROM Bill WHERE DocNumber IN ({in_list})"):
            found.add((b.get("DocNumber"), b["VendorRef"]["value"]))
    return found


# ---------------------------------------------------------------------------
# Build / post
# ---------------------------------------------------------------------------
def split_amount(total, shares):
    parts = [money(total * s) for s in shares]
    parts[-1] += total - sum(parts)  # rounding remainder on the last payee
    return parts


def plan_bills(rows, lk, due_date, account, klass):
    bills, problems = [], []
    for r in rows:
        try:
            payees = lk.payees(r["rep"])
        except LookupError as e:
            problems.append((r, str(e)))
            continue
        customer = lk.customer(r["customer"])
        if not customer:
            problems.append((r, f"customer/project '{r['customer']}' not found in QuickBooks"))
            continue
        if not r["pay_date"]:
            problems.append((r, "no payment date (column I)"))
            continue
        if len(r["doc_number"]) > 21:
            problems.append((r, f"bill number '{r['doc_number']}' is longer than QuickBooks' 21 characters"))
            continue
        for (vendor, _share, how), amount in zip(payees, split_amount(r["amount"], [s for _, s, _ in payees])):
            bills.append({
                "row": r, "vendor": vendor, "how": how, "amount": amount, "customer": customer,
                "payload": {
                    "VendorRef": {"value": vendor["Id"]},
                    "TxnDate": r["pay_date"].isoformat(),
                    "DueDate": due_date.isoformat(),
                    "DocNumber": r["doc_number"],
                    "Line": [{
                        "DetailType": "AccountBasedExpenseLineDetail",
                        "Amount": float(amount),
                        "Description": r["description"],
                        "AccountBasedExpenseLineDetail": {
                            "AccountRef": {"value": account["Id"]},
                            "CustomerRef": {"value": customer["Id"]},
                            "ClassRef": {"value": klass["Id"]},
                        },
                    }],
                },
            })
    return bills, problems


def write_export(path, bills, due_date, account_label, class_label):
    """Same columns as the QuickBooks spreadsheet import sheet, for review or manual import."""
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["Post?", "Invoice/Bill Date", "Due Date", "Invoice / Bill Number", "Transaction Type",
                    "Customer", "Vendor", "Currency Code", "Product/Services", "Description", "Qty",
                    "Discount %", "Unit Price", "Category", "Location", "Class", "Tax"])
        for b in bills:
            r = b["row"]
            w.writerow(["Yes", f"{r['pay_date']:%m/%d/%Y}", f"{due_date:%m/%d/%Y}", r["doc_number"], "Bill",
                        b["customer"].get("FullyQualifiedName") or r["customer"], b["vendor"]["DisplayName"],
                        "", "", r["description"], "1.00", "", f"{b['amount']:.2f}", account_label, "",
                        class_label, ""])


def main():
    ap = argparse.ArgumentParser(description="Create commission Bills in QuickBooks from the payroll commission sheet.")
    ap.add_argument("workbook", help="commissions .xlsx")
    ap.add_argument("--post", action="store_true", help="actually create the bills (default: preview only)")
    ap.add_argument("--due-date", help="payroll/due date, MM/DD/YYYY (default: from the sheet name, e.g. 'Oct 26')")
    ap.add_argument("--sheet", help="sheet name (default: first sheet)")
    ap.add_argument("--account", default=DEFAULT_ACCOUNT, help=f"expense account (default: {DEFAULT_ACCOUNT})")
    ap.add_argument("--class", dest="klass", default=DEFAULT_CLASS, help=f"class (default: {DEFAULT_CLASS})")
    ap.add_argument("--export", help="also write the bills to this CSV (QuickBooks import-sheet layout)")
    args = ap.parse_args()

    sheet_name, rows = read_rows(args.workbook, args.sheet)
    due_date = as_date(args.due_date) if args.due_date else due_date_from_sheet(sheet_name, rows)
    if not due_date:
        raise SystemExit(f"Couldn't read a due date from sheet name '{sheet_name}' -- pass --due-date MM/DD/YYYY")
    print(f"Sheet '{sheet_name}': {len(rows)} commission rows, due {due_date:%m/%d/%Y}")

    lk = Lookups()
    account, klass = lk.account(args.account), lk.klass(args.klass)
    bills, problems = plan_bills(rows, lk, due_date, account, klass)
    already = existing_bills(b["row"]["doc_number"] for b in bills)

    print()
    print(f"{'Row':>4}  {'Bill #':<15} {'Date':<10} {'Vendor':<26} {'Amount':>10}  Customer")
    for b in bills:
        r = b["row"]
        flag = "  (vendor auto-matched)" if b["how"] == "auto" else ""
        if (r["doc_number"], b["vendor"]["Id"]) in already:
            flag += "  ALREADY IN QBO - skipped"
        print(f"{r['excel_row']:>4}  {r['doc_number']:<15} {r['pay_date']:%m/%d/%y}  "
              f"{b['vendor']['DisplayName'][:26]:<26} {b['amount']:>10,.2f}  {r['customer']}{flag}")
    total = sum((b["amount"] for b in bills), Decimal(0))
    print(f"{'':>4}  {'':<15} {'':<10} {'TOTAL':<26} {total:>10,.2f}")

    second = [r for r in rows if r["second"]]
    if second:
        print(f"\nNote: {len(second)} rows have a '2nd Comm' amount (total "
              f"{sum(r['second'] for r in second):,.2f}); those are NOT billed by this script.")

    if problems:
        print(f"\n{len(problems)} row(s) can't be billed until fixed:")
        for r, why in problems:
            print(f"  row {r['excel_row']} ({r['rep']}, {r['doc_number']}, {r['amount']:,.2f}): {why}")

    if args.export:
        write_export(args.export, bills, due_date, args.account, args.klass)
        print(f"\nWrote {args.export}")

    to_post = [b for b in bills if (b["row"]["doc_number"], b["vendor"]["Id"]) not in already]
    if not args.post:
        print(f"\nPreview only -- re-run with --post to create {len(to_post)} bill(s).")
        return 1 if problems else 0

    created, failed = 0, 0
    for b in to_post:
        r = b["row"]
        try:
            data = qbo_client._post("bill", b["payload"])
            print(f"Created bill {r['doc_number']} for {b['vendor']['DisplayName']} (Id {data['Bill']['Id']})")
            created += 1
        except qbo_client.QBOError as e:
            print(f"FAILED row {r['excel_row']} {r['doc_number']}: {e}")
            failed += 1
    print(f"\nDone: {created} created, {len(bills) - len(to_post)} already existed, "
          f"{failed} failed, {len(problems)} not billable.")
    return 1 if (failed or problems) else 0


if __name__ == "__main__":
    sys.exit(main())
