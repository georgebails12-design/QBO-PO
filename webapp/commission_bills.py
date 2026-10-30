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
import requests

import qbo_client

VENDOR_MAP_FILE = os.path.join(qbo_client.APP_DIR, "commission_vendors.json")


class CommissionError(Exception):
    """A problem with the workbook or the QuickBooks setup, with a message safe to show."""
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
    "q_number": 12,    # M  Q Number
    "pay_date": 8,     # I
    "panda_amt": 9,    # J  "Panda #"
    "rate": 13,        # N  %
    "commission": 14,  # O
    "second": 15,      # P  2nd Comm
    "comm_memo": 17,   # R
}
EXPECTED_HEADERS = {"q_number": "Q Number", "inv_no": "Number", "customer": "Custmer/Project", "rate": "%",
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
def read_rows(path, sheet=None, start_row=2):
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb[sheet] if sheet else wb.worksheets[0]
    all_rows = list(ws.iter_rows(values_only=True))
    if not all_rows:
        raise CommissionError(f"{path}: sheet '{ws.title}' is empty")

    header = all_rows[0]
    for key, name in EXPECTED_HEADERS.items():
        got = header[COL[key]] if len(header) > COL[key] else None
        if str(got or "").strip() != name:
            raise CommissionError(
                f"Unexpected layout: column {chr(65 + COL[key])} header is {got!r}, expected {name!r}. "
                "Has a column been added or moved?")

    rows = []
    for excel_row, r in enumerate(all_rows[1:], start=2):
        if excel_row < start_row:
            continue
        r = list(r) + [None] * (21 - len(r))
        rate_cell, next_cell = r[COL["rate"]], r[COL["rate"] + 1]
        if (not (isinstance(rate_cell, (int, float)) and rate_cell < 1)
                and isinstance(next_cell, (int, float)) and 0 < next_cell < 1 and r[10] in (None, "")):
            r = r[:10] + r[11:]  # row typed one column to the right (blank in K): shift it back
        rep = str(r[COL["rep"]] or "").strip()
        commission = r[COL["commission"]]
        if (not rep or commission in (None, "") or str(r[COL["kind"]] or "").strip() != "Invoice"
                or (isinstance(commission, (int, float)) and abs(commission) < 0.005)):
            continue
        inv_no = str(r[COL["inv_no"]] or "").strip()
        stage = str(r[COL["stage"]] or "").strip()
        # Built from the invoice # and Final/Deposit rather than read from the Comm Memo column,
        # whose formula is sometimes pointed at the wrong cells (e.g. "46269 Socal Glass ...").
        doc_number = f"{inv_no} {stage}".strip() or str(r[COL["comm_memo"]] or "").strip()
        customer = str(r[COL["customer"]] or "").strip()
        panda_amt = r[COL["panda_amt"]]
        rate = r[COL["rate"]]
        panda_txt = f"{float(panda_amt):g}" if isinstance(panda_amt, (int, float)) else str(panda_amt or "")
        rate_txt = fmt_rate(rate) if isinstance(rate, (int, float)) else str(rate or "")
        second = r[COL["second"]]
        second_rate = ""
        if isinstance(second, (int, float)) and second and isinstance(panda_amt, (int, float)) and panda_amt:
            second_rate = fmt_rate(round(second / panda_amt, 5))
        rows.append({
            "excel_row": excel_row,
            "rep": rep,
            "customer": customer,
            "doc_number": doc_number,
            "pay_date": as_date(r[COL["pay_date"]]),
            "amount": money(commission),
            "second": money(second) if isinstance(second, (int, float)) and second else None,
            "second_description": f"{doc_number} {customer} P#$ {panda_txt} {second_rate}".strip(),
            "description": f"{doc_number} {customer} P#$ {panda_txt} {rate_txt}".strip(),
            "q_number": str(r[COL["q_number"]] or "").strip(),
            "panda": float(panda_amt) if isinstance(panda_amt, (int, float)) else None,
            "rate": float(rate) if isinstance(rate, (int, float)) else None,
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


SECOND_COMM_BY_INVOICE_KEY = "2nd Comm by invoice"  # {"17589": "MACAPINLAC CECILE"}


SECOND_COMM_KEY = "2nd Comm"  # commission_vendors.json key for who is paid the "2nd Comm" column


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
        raise CommissionError(f"Account '{label}' not found in QuickBooks (use --account).")

    def klass(self, label):
        want = norm(label)
        for c in self.classes:
            if want in (norm(c["Name"]), norm(c.get("FullyQualifiedName"))):
                return c
        raise CommissionError(f"Class '{label}' not found in QuickBooks (use --class).")

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
        """[(vendor, share, how)] for a rep, or raise LookupError with the reason.

        share is the fraction of the row's commission that vendor is paid; on a
        shared deal (e.g. "TE") each rep is normally paid the full commission."""
        mapped = self.vendor_map.get(norm(rep))
        if mapped:
            splits = [mapped] if isinstance(mapped, str) else mapped
            splits = [{"vendor": s} if isinstance(s, str) else s for s in splits]
            out = []
            for s in splits:
                v = self.vendor_by_display(s["vendor"])
                if not v:
                    raise LookupError(f"vendor '{s['vendor']}' (mapped for {rep}) not found in QuickBooks")
                out.append((v, Decimal(str(s.get("share", 1))), "map"))
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


# The bill's "Q Number/PO #" box is a QuickBooks custom field. Custom fields
# are only returned/accepted with a newer minor version and this include flag.
CF_MINOR_VERSION = "75"
CF_PARAMS = {"minorversion": CF_MINOR_VERSION, "include": "enhancedAllCustomFields"}
Q_FIELD_NAMES = ("q number/po #", "q number/po#", "q number", "q#/po #", "q#")


def _cf_request(method, path, params=None, payload=None):
    access_token, realm_id, environment = qbo_client.get_valid_access_token()
    url = f"{qbo_client._api_base(environment, realm_id)}/{path}"
    resp = requests.request(method, url, headers=qbo_client._headers(access_token),
                            params={**CF_PARAMS, **(params or {})},
                            data=json.dumps(payload) if payload is not None else None, timeout=30)
    if resp.status_code not in (200, 201):
        raise qbo_client.QBOError(f"QuickBooks {method} {path} failed ({resp.status_code}): {resp.text}")
    return resp.json()


def find_q_field():
    """The "Q Number/PO #" custom field as seen on recent bills: {"DefinitionId", "Name", "Type"} or None."""
    data = _cf_request("GET", "query", {"query": "SELECT * FROM Bill ORDERBY MetaData.LastUpdatedTime DESC "
                                                 "STARTPOSITION 1 MAXRESULTS 200"})
    seen = {}
    for bill in data.get("QueryResponse", {}).get("Bill", []):
        for cf in bill.get("CustomField") or []:
            if cf.get("DefinitionId"):
                seen.setdefault(norm(cf.get("Name")), cf)
    for name in Q_FIELD_NAMES:
        if name in seen:
            cf = seen[name]
            return {"DefinitionId": cf["DefinitionId"], "Name": cf.get("Name"), "Type": cf.get("Type", "StringType")}
    for name, cf in seen.items():  # e.g. "Q #/PO Number"
        if re.match(r"q\b|q#", name) and ("number" in name or "po" in name):
            return {"DefinitionId": cf["DefinitionId"], "Name": cf.get("Name"), "Type": cf.get("Type", "StringType")}
    return None


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
def plan_bills(rows, lk, due_date, account, klass, q_field=None):
    bills, problems = [], []
    second_name = lk.vendor_map.get(norm(SECOND_COMM_KEY))
    second_vendor = lk.vendor_by_display(second_name) if second_name else None
    if second_name and not second_vendor:
        raise CommissionError(f"'{SECOND_COMM_KEY}' vendor '{second_name}' not found in QuickBooks")
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
        lines = [(vendor, money(r["amount"] * share), how,
                  r["description"] if share == 1 or r["rate"] is None
                  else r["description"].rsplit(" ", 1)[0] + " " + fmt_rate(r["rate"] * float(share)))
                 for vendor, share, how in payees]
        inv = r["doc_number"].split()[0]
        override = (lk.vendor_map.get(norm(SECOND_COMM_BY_INVOICE_KEY)) or {}).get(inv)
        row_second_vendor = lk.vendor_by_display(override) if override else second_vendor
        if override and not row_second_vendor:
            problems.append((r, f"2nd Comm vendor '{override}' for {inv} not found in QuickBooks"))
            continue
        if r["second"]:
            if not row_second_vendor:
                problems.append((r, f"has 2nd Comm {r['second']:,.2f} but no '{SECOND_COMM_KEY}' vendor is set "
                                    "in commission_vendors.json"))
            else:
                lines.append((row_second_vendor, r["second"], "map", r["second_description"]))
        for vendor, amount, how, description in lines:
            bill = {
                "row": r, "vendor": vendor, "how": how, "amount": amount, "customer": customer,
                "description": description,
                "payload": {
                    "VendorRef": {"value": vendor["Id"]},
                    "TxnDate": r["pay_date"].isoformat(),
                    "DueDate": due_date.isoformat(),
                    "DocNumber": r["doc_number"],
                    "PrivateNote": description,  # the bill's Memo box, same text as the line description
                    "Line": [{
                        "DetailType": "AccountBasedExpenseLineDetail",
                        "Amount": float(amount),
                        "Description": description,
                        "AccountBasedExpenseLineDetail": {
                            "AccountRef": {"value": account["Id"]},
                            "CustomerRef": {"value": customer["Id"]},
                            "ClassRef": {"value": klass["Id"]},
                        },
                    }],
                },
            }
            if q_field and r["q_number"]:
                bill["payload"]["CustomField"] = [{"DefinitionId": q_field["DefinitionId"], "Name": q_field["Name"],
                                                   "Type": q_field["Type"], "StringValue": r["q_number"]}]
            bills.append(bill)
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
                        "", "", b["description"], "1.00", "", f"{b['amount']:.2f}", account_label, "",
                        class_label, ""])


def prepare(workbook, sheet=None, start_row=2, due_date=None, account=DEFAULT_ACCOUNT, klass=DEFAULT_CLASS,
            q_field_id=None):
    """Read the workbook and plan its bills against QuickBooks (nothing is created).

    Returns {sheet_name, rows, due_date, bills, problems, already, q_field}. `already`
    holds (bill number, vendor id) pairs that exist in QuickBooks and will be skipped."""
    sheet_name, rows = read_rows(workbook, sheet, start_row)
    due = as_date(due_date) if due_date else due_date_from_sheet(sheet_name, rows)
    if not due:
        raise CommissionError(f"Couldn't read a due date from sheet name '{sheet_name}' -- give the payroll date.")
    lk = Lookups()
    acct, kl = lk.account(account), lk.klass(klass)
    q_field = ({"DefinitionId": q_field_id, "Name": "Q Number/PO #", "Type": "StringType"}
               if q_field_id else find_q_field())
    bills, problems = plan_bills(rows, lk, due, acct, kl, q_field)
    already = existing_bills(b["row"]["doc_number"] for b in bills)
    return {"sheet_name": sheet_name, "rows": rows, "due_date": due, "bills": bills, "problems": problems,
            "already": already, "q_field": q_field}


def is_already(b, already):
    return (b["row"]["doc_number"], b["vendor"]["Id"]) in already


def post_bill(b):
    """Create one planned bill. Returns (QuickBooks bill id, warning or "")."""
    saved = _cf_request("POST", "bill", payload=b["payload"])["Bill"]
    warning = ""
    if b["payload"].get("CustomField") and not any(
            cf.get("StringValue") == b["row"]["q_number"] for cf in saved.get("CustomField") or []):
        warning = "QuickBooks didn't keep the Q Number"
    return saved["Id"], warning


def main():
    ap = argparse.ArgumentParser(description="Create commission Bills in QuickBooks from the payroll commission sheet.")
    ap.add_argument("workbook", help="commissions .xlsx")
    ap.add_argument("--post", action="store_true", help="actually create the bills (default: preview only)")
    ap.add_argument("--due-date", help="payroll/due date, MM/DD/YYYY (default: from the sheet name, e.g. 'Oct 26')")
    ap.add_argument("--sheet", help="sheet name (default: first sheet)")
    ap.add_argument("--start-row", type=int, default=2,
                    help="first sheet row of this payroll, when one sheet holds several (e.g. 43)")
    ap.add_argument("--account", default=DEFAULT_ACCOUNT, help=f"expense account (default: {DEFAULT_ACCOUNT})")
    ap.add_argument("--class", dest="klass", default=DEFAULT_CLASS, help=f"class (default: {DEFAULT_CLASS})")
    ap.add_argument("--q-field-id", help="DefinitionId of the bill's 'Q Number/PO #' custom field "
                                         "(default: found from existing bills)")
    ap.add_argument("--export", help="also write the bills to this CSV (QuickBooks import-sheet layout)")
    args = ap.parse_args()

    try:
        plan = prepare(args.workbook, args.sheet, args.start_row, args.due_date, args.account, args.klass,
                       args.q_field_id)
    except CommissionError as e:
        raise SystemExit(str(e))
    rows, due_date, bills, problems, already = (plan["rows"], plan["due_date"], plan["bills"],
                                                 plan["problems"], plan["already"])
    print(f"Sheet '{plan['sheet_name']}': {len(rows)} commission rows, due {due_date:%m/%d/%Y}")
    if plan["q_field"]:
        print(f"Q Number goes in the bill's '{plan['q_field']['Name']}' box")
    else:
        print("WARNING: couldn't find the 'Q Number/PO #' box on any recent bill in QuickBooks -- "
              "bills will be created without it (fill one in by hand on any bill, then re-run).")
    print()
    print(f"{'Row':>4}  {'Bill #':<15} {'Date':<10} {'Vendor':<26} {'Amount':>10}  Customer")
    for b in bills:
        r = b["row"]
        flag = "  (vendor auto-matched)" if b["how"] == "auto" else ""
        if is_already(b, already):
            flag += "  ALREADY IN QBO - skipped"
        print(f"{r['excel_row']:>4}  {r['doc_number']:<15} {r['pay_date']:%m/%d/%y}  "
              f"{b['vendor']['DisplayName'][:26]:<26} {b['amount']:>10,.2f}  {r['customer']}{flag}")
    total = sum((b["amount"] for b in bills), Decimal(0))
    print(f"{'':>4}  {'':<15} {'':<10} {'TOTAL':<26} {total:>10,.2f}")

    if problems:
        print(f"\n{len(problems)} row(s) can't be billed until fixed:")
        for r, why in problems:
            print(f"  row {r['excel_row']} ({r['rep']}, {r['doc_number']}, {r['amount']:,.2f}): {why}")

    if args.export:
        write_export(args.export, bills, due_date, args.account, args.klass)
        print(f"\nWrote {args.export}")

    to_post = [b for b in bills if not is_already(b, already)]
    if not args.post:
        print(f"\nPreview only -- re-run with --post to create {len(to_post)} bill(s).")
        return 1 if problems else 0

    created, failed = 0, 0
    for b in to_post:
        r = b["row"]
        try:
            bill_id, warning = post_bill(b)
            note = f"  (WARNING: {warning})" if warning else ""
            print(f"Created bill {r['doc_number']} for {b['vendor']['DisplayName']} (Id {bill_id}){note}")
            created += 1
        except qbo_client.QBOError as e:
            print(f"FAILED row {r['excel_row']} {r['doc_number']}: {e}")
            failed += 1
    print(f"\nDone: {created} created, {len(bills) - len(to_post)} already existed, "
          f"{failed} failed, {len(problems)} not billable.")
    return 1 if (failed or problems) else 0


if __name__ == "__main__":
    sys.exit(main())
