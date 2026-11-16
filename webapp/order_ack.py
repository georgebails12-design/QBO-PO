"""
order_ack.py
============
Cardinal Glass "Order Acknowledgement Summary" PDF -> QuickBooks purchase order.

Reads the acknowledgement, finds the purchase order by its PO number, checks
every glass size Cardinal acknowledged against the PO's lines, and puts
Cardinal's cost on the matching lines and the requested (ship) date on the PO.

    venv/bin/python order_ack.py Order_Acknowledgement_Summary.pdf            # preview
    venv/bin/python order_ack.py Order_Acknowledgement_Summary.pdf --apply    # update the PO

How lines are matched
---------------------
Each acknowledgement line has a size like "40 3/8X86 5/16". The PO's glass
lines are named '40 3/8" x 86 5/16" (Job# ... Unit# ...)' (see
glass_pdf_parser.item_name), so the size is read from the item name (or the
line description) and compared in inches. Equal sizes match. When the same
size is on the PO more than once, the line with the same quantity and the
closest line position wins.

What is checked
---------------
  - every acknowledged size is on the PO (else: "not on the PO" -- call Cardinal)
  - width and height in the same order (a swapped size is matched but flagged)
  - quantity acknowledged = quantity ordered
  - PO glass lines that this acknowledgement doesn't cover (listed, not changed)
  - the acknowledgement's own arithmetic: qty x unit price = extended amount,
    and the lines add up to the printed total

What changes on the PO
----------------------
  - matched lines: Rate = Cardinal's unit price (per piece), Amount = qty x rate.
    Quantities are never changed.
  - the date (--date-field): "due" (default) puts the Requested Date in the PO's
    Due date, "txn" puts it in the PO date, "none" leaves the dates alone.
  - if the PO form has a custom field named like "Expected date", the
    Requested Date goes there too (as MM/DD/YYYY).
  - a memo line: "Cardinal OA 11/12/26 SO 16967339: 30 lines $10,351.35,
    requested 11/24/26". It is added once; re-running changes nothing.
  - with --attach (and on the web page by default) the acknowledgement PDF is
    attached to the PO, once.
Closed purchase orders are refused.
"""

import argparse
import datetime as dt
import math
import os
import re
import sys
from decimal import Decimal, ROUND_HALF_UP

import pdfplumber

import qbo_client

CENT = Decimal("0.01")
SIZE_TOLERANCE = 1 / 64  # inches; sizes closer than this are the same size
# How Cardinal bills (worked out from their acknowledgements): each side is rounded
# up to the next even inch, and a piece is never charged at less than 3 sq ft.
BILL_ROUND_INCHES = 2
MIN_BILLED_SQFT = Decimal("3")
DATE_FIELDS = ("due", "txn", "none")

# 31392 1.000 16967339 1.000 5.7 T Q366/13.0 BEF/ 5.7 T QI89 91310 4 102.6668 570.91 439.9272 17.1400 1,759.71
ROW_RE = re.compile(
    r"^(?P<po>\S+)\s+(?P<po_line>\d+\.\d+)\s+(?P<so>\d+)\s+(?P<so_line>\d+\.\d+)\s+"
    r"(?P<desc>.+?)\s+(?P<part>\S+)\s+(?P<qty>\d+)\s+(?P<sqft>[\d,]*\.\d+)\s+(?P<weight>[\d,]*\.\d+)\s+"
    r"(?P<unit>[\d,]*\.\d+)\s+(?P<sqft_price>[\d,]*\.\d+)\s+(?P<ext>-?[\d,]*\.\d{2})$"
)
NUM = r"\d+(?:\s*[- ]\s*\d+/\d+)?|\d+/\d+|\d+\.\d+"
ACK_SIZE_RE = re.compile(rf"^\s*(?P<w>{NUM})\s*[xX]\s*(?P<h>{NUM})\s*$")
PO_SIZE_RE = re.compile(rf"(?P<w>{NUM})\s*\"?\s*[xX]\s*(?P<h>{NUM})\s*\"?")
TOTAL_RE = re.compile(r"^Totals\s+(?P<qty>\d+)\s+(?P<sqft>[\d,]*\.\d+)\s+(?P<weight>[\d,]*\.\d+)\s+(?P<ext>[\d,]*\.\d{2})$")


class AckError(Exception):
    """A problem with the acknowledgement or the PO, with a message safe to show."""


def dec(value):
    return Decimal(str(value).replace(",", ""))


def cents(value):
    return dec(value).quantize(CENT, rounding=ROUND_HALF_UP)


def to_inches(text):
    """'40 3/8' -> 40.375, '10' -> 10.0, '13/16' -> 0.8125, '40-3/8' -> 40.375."""
    text = re.sub(r"\s*-\s*", " ", text.strip().rstrip('"'))
    total = 0.0
    for part in text.split():
        if "/" in part:
            n, d = part.split("/")
            total += int(n) / int(d)
        else:
            total += float(part)
    return total


def show_size(w, h):
    def one(x):
        whole, frac = int(x), x - int(x)
        n = round(frac * 64)
        if n == 0:
            return f"{whole}"
        if n == 64:
            return f"{whole + 1}"
        d = 64
        while n % 2 == 0:
            n, d = n // 2, d // 2
        return f"{whole} {n}/{d}" if whole else f"{n}/{d}"
    return f'{one(w)}" x {one(h)}"'


def _date(text):
    m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{2,4})", text or "")
    if not m:
        return None
    mo, d, y = (int(g) for g in m.groups())
    if y < 100:
        y += 2000
    try:
        return dt.date(y, mo, d)
    except ValueError:
        return None


def billing_check(row):
    """Checks Cardinal's billed SQ FT against the size they printed, and the unit
    price against SQ FT x price per sq ft. Returns flags (empty = all consistent)."""
    flags = []

    def up(x):
        return BILL_ROUND_INCHES * math.ceil(x / BILL_ROUND_INCHES - 1e-9)
    per_piece = Decimal(up(row["w"]) * up(row["h"])) / 144
    expected = per_piece * row["qty"]
    if abs(expected - row["sqft"]) > Decimal("0.001") * row["qty"]:
        flags.append(f"Cardinal billed {row['sqft']} sq ft, but {row['size_text']} x {row['qty']} is "
                     f"{expected:.4f} -- the size or the charge is off")
    billed_piece = max(row["sqft"] / row["qty"], MIN_BILLED_SQFT) if row["qty"] else Decimal(0)
    if abs(billed_piece * row["sqft_price"] - row["unit_price"]) > Decimal("0.01"):
        flags.append(f"unit price {row['unit_price']} isn't SQ FT x ${row['sqft_price']}/sq ft")
    return flags


# ---------------------------------------------------------------------------
# PDF -> acknowledgement
# ---------------------------------------------------------------------------
def parse_text(text):
    """Text of the whole acknowledgement -> {"date", "requested_date", "plant",
    "sales_orders", "po_numbers", "lines", "total", "flags"}."""
    if "Acknowledgement" not in text and "Acknowledgment" not in text:
        raise AckError("This doesn't look like a Cardinal Order Acknowledgement -- no 'Order Acknowledgement' title.")
    lines = [ln.strip() for ln in text.splitlines()]
    ack = {"date": None, "requested_date": None, "plant": None, "lines": [], "total": None, "flags": []}
    for ln in lines:
        if ack["date"] is None and re.search(r"\bDate\s+\d", ln) and "Requested" not in ln:
            ack["date"] = _date(ln.split("Date", 1)[1])
        if ack["requested_date"] is None and "Requested Date" in ln:
            ack["requested_date"] = _date(ln.split("Requested Date", 1)[1])
        m = re.match(r"^Plant\s+(\S+)", ln)
        if m and not ack["plant"]:
            ack["plant"] = m.group(1)
    totals = []
    for i, ln in enumerate(lines):
        m = TOTAL_RE.match(ln)
        if m:
            totals.append(cents(m.group("ext")))
            continue
        m = ROW_RE.match(ln)
        if not m:
            continue
        size = lines[i + 1] if i + 1 < len(lines) else ""
        sm = ACK_SIZE_RE.match(size)
        row = {
            "po": m.group("po"), "po_line": int(float(m.group("po_line"))),
            "so": m.group("so"), "so_line": int(float(m.group("so_line"))),
            "desc": m.group("desc"), "part": m.group("part"), "qty": int(m.group("qty")),
            "sqft": dec(m.group("sqft")), "unit_price": dec(m.group("unit")),
            "sqft_price": dec(m.group("sqft_price")), "ext": cents(m.group("ext")),
            "size_text": size if sm else "", "w": None, "h": None, "flags": [],
        }
        if sm:
            row["w"], row["h"] = to_inches(sm.group("w")), to_inches(sm.group("h"))
        else:
            row["flags"].append("couldn't read the size under this line")
        if sm:
            row["flags"].extend(billing_check(row))
        if (row["unit_price"] * row["qty"]).quantize(CENT, rounding=ROUND_HALF_UP) != row["ext"]:
            row["flags"].append(f"Cardinal's math: {row['qty']} x {row['unit_price']} isn't {row['ext']:,}")
        ack["lines"].append(row)
    if not ack["lines"]:
        raise AckError("No order lines could be read from this acknowledgement. "
                       "If it's a scan, ask Cardinal for the emailed PDF.")
    ack["total"] = totals[-1] if totals else None
    line_sum = sum(r["ext"] for r in ack["lines"])
    if ack["total"] is None:
        ack["flags"].append("No Totals line found -- check the last page came through.")
    elif line_sum != ack["total"]:
        ack["flags"].append(f"The lines add up to ${line_sum:,} but the acknowledgement's total is "
                            f"${ack['total']:,} -- a line may not have been read.")
    ack["sales_orders"] = sorted({r["so"] for r in ack["lines"]})
    ack["po_numbers"] = list(dict.fromkeys(r["po"] for r in ack["lines"]))
    if not ack["requested_date"]:
        ack["flags"].append("No Requested Date found on the acknowledgement.")
    return ack


def parse_pdf(path):
    with pdfplumber.open(path) as pdf:
        text = "\n".join(page.extract_text() or "" for page in pdf.pages)
    if not text.strip():
        raise AckError("This PDF has no text (a scan?). Use the PDF Cardinal emails, not a scanned copy.")
    return parse_text(text)


# ---------------------------------------------------------------------------
# QuickBooks PO
# ---------------------------------------------------------------------------
def find_po(doc_number):
    rows = qbo_client._query(f"SELECT * FROM PurchaseOrder WHERE DocNumber = '{doc_number}'")
    if not rows:
        raise AckError(f"No purchase order {doc_number} in QuickBooks.")
    if len(rows) > 1:
        raise AckError(f"More than one purchase order is numbered {doc_number}; fix the duplicate first.")
    return rows[0]


def po_size(line):
    """(w, h) from a PO line's item name, else its description; None if it has no size."""
    detail = line.get("ItemBasedExpenseLineDetail") or {}
    for text in ((detail.get("ItemRef") or {}).get("name"), line.get("Description")):
        m = PO_SIZE_RE.search(text or "")
        if m:
            return to_inches(m.group("w")), to_inches(m.group("h"))
    return None


def _same(a, b):
    return abs(a - b) < SIZE_TOLERANCE


def match_lines(ack_lines, po_lines):
    """Pairs each acknowledgement line with a PO line. Returns
    ([(ack_line, po_index or None, swapped)], [unused PO indexes that have a size])."""
    sized = []
    for idx, ln in enumerate(po_lines):
        if ln.get("DetailType") == "ItemBasedExpenseLineDetail":
            size = po_size(ln)
            if size:
                sized.append((idx, size, dec(ln["ItemBasedExpenseLineDetail"].get("Qty") or 0)))
    used = set()
    out = []
    for a in ack_lines:
        best = None
        if a["w"] is not None:
            for swapped in (False, True):
                w, h = (a["h"], a["w"]) if swapped else (a["w"], a["h"])
                cands = [(idx, qty) for idx, (pw, ph), qty in sized
                         if idx not in used and _same(pw, w) and _same(ph, h)]
                if cands:
                    # same quantity first, then the line closest to Cardinal's "PO Line" number
                    cands.sort(key=lambda c: (c[1] != a["qty"], abs((c[0] + 1) - a["po_line"])))
                    best = (cands[0][0], swapped)
                    break
        if best:
            used.add(best[0])
            out.append((a, best[0], best[1]))
        else:
            out.append((a, None, False))
    leftover = [idx for idx, _size, _qty in sized if idx not in used]
    return out, leftover


def _line_label(line):
    detail = line.get("ItemBasedExpenseLineDetail") or {}
    return (detail.get("ItemRef") or {}).get("name") or (line.get("Description") or "")[:80]


def _nearest(a, lines, leftover, within=1.0):
    """The unmatched PO line whose size is within an inch of this acknowledgement line, if any."""
    if a["w"] is None:
        return None
    best = None
    for idx in leftover:
        pw, ph = po_size(lines[idx])
        for w, h in ((pw, ph), (ph, pw)):
            off = max(abs(w - a["w"]), abs(h - a["h"]))
            if off <= within and (best is None or off < best[0]):
                best = (off, idx)
    return f"line {best[1] + 1}, {_line_label(lines[best[1]])}" if best else None


def plan_po(ack, po_number, date_field="due"):
    """What would change on one PO. Reads QuickBooks, changes nothing."""
    if date_field not in DATE_FIELDS:
        raise AckError(f"date field must be one of {', '.join(DATE_FIELDS)}")
    po = find_po(po_number)
    ack_lines = [a for a in ack["lines"] if a["po"] == po_number]
    lines = [dict(ln) for ln in po.get("Line", [])]
    pairs, leftover = match_lines(ack_lines, lines)
    problems = []
    if po.get("POStatus") == "Closed":
        problems.append(f"PO {po_number} is closed in QuickBooks (already billed?) -- not changing it.")

    rows = []
    for a, idx, swapped in pairs:
        row = {"po_line": a["po_line"], "size": a["size_text"], "qty": a["qty"], "unit_price": a["unit_price"],
               "ext": a["ext"], "desc": a["desc"], "flags": list(a["flags"]), "po_item": None,
               "po_qty": None, "old_rate": None, "new_rate": None, "old_amount": None, "new_amount": None,
               "status": "ok"}
        if idx is None:
            row["status"] = "missing"
            row["flags"].append("this size is not on the PO -- check with Cardinal before it ships")
            near = _nearest(a, lines, leftover)
            if near:
                row["flags"].append(f"closest unmatched PO line: {near}")
            rows.append(row)
            continue
        ln = dict(lines[idx])
        detail = dict(ln["ItemBasedExpenseLineDetail"])
        qty = dec(detail.get("Qty") or 0)
        row.update(po_item=_line_label(ln), po_qty=float(qty), old_rate=dec(detail.get("UnitPrice") or 0),
                   old_amount=cents(ln.get("Amount") or 0), new_rate=a["unit_price"])
        if swapped:
            row["flags"].append("width and height are the other way round from the PO")
            row["status"] = "check"
        if qty != a["qty"]:
            row["flags"].append(f"PO has qty {qty.normalize()}, Cardinal acknowledged {a['qty']}")
            row["status"] = "check"
        new_amount = (qty * a["unit_price"]).quantize(CENT, rounding=ROUND_HALF_UP)
        row["new_amount"] = new_amount
        detail["UnitPrice"] = float(a["unit_price"])
        ln["ItemBasedExpenseLineDetail"] = detail
        ln["Amount"] = float(new_amount)
        lines[idx] = ln
        row["unchanged"] = row["old_rate"] == a["unit_price"] and row["old_amount"] == new_amount
        rows.append(row)

    not_acked = [{"po_line": idx + 1, "item": _line_label(lines[idx]),
                  "qty": float(dec(lines[idx]["ItemBasedExpenseLineDetail"].get("Qty") or 0)),
                  "amount": cents(lines[idx].get("Amount") or 0)} for idx in leftover]

    req = ack["requested_date"]
    so = ", ".join(sorted({a["so"] for a in ack_lines}))
    ack_total = sum(a["ext"] for a in ack_lines)
    note = (f"Cardinal OA {ack['date'].strftime('%m/%d/%y') if ack['date'] else '?'} SO {so}: "
            f"{len(ack_lines)} lines ${ack_total:,}" + (f", requested {req.strftime('%m/%d/%y')}" if req else ""))
    memo = (po.get("PrivateNote") or "").strip()
    memo_changes = note not in memo
    new_memo = ((memo + "\n" + note).strip() if memo_changes else memo)[:4000]

    payload = {"Id": po["Id"], "SyncToken": po["SyncToken"], "sparse": True,
               "VendorRef": po["VendorRef"], "Line": [ln for ln in lines], "PrivateNote": new_memo}
    old_date = new_date = None
    if req and date_field == "due":
        old_date, new_date = po.get("DueDate"), req.isoformat()
        payload["DueDate"] = new_date
    elif req and date_field == "txn":
        old_date, new_date = po.get("TxnDate"), req.isoformat()
        payload["TxnDate"] = new_date

    # If the PO form has an "Expected ..." custom field, the requested date goes there too.
    expected_field = None
    if req and date_field != "none":
        fields = [dict(cf) for cf in po.get("CustomField") or []]
        for cf in fields:
            if "expected" in (cf.get("Name") or "").lower():
                expected_field = cf.get("Name")
                if cf.get("StringValue") != req.strftime("%m/%d/%Y"):
                    cf["StringValue"] = req.strftime("%m/%d/%Y")
                    cf.setdefault("Type", "StringType")
                    payload["CustomField"] = fields
                break

    old_total = cents(po.get("TotalAmt") or 0)
    new_total = sum(cents(ln.get("Amount") or 0) for ln in lines
                    if ln.get("DetailType") in ("ItemBasedExpenseLineDetail", "AccountBasedExpenseLineDetail"))
    unchanged = (all(r.get("unchanged", True) for r in rows if r["status"] != "missing")
                 and not memo_changes and old_date == new_date and "CustomField" not in payload)
    return {
        "po_number": po_number, "po_id": po["Id"], "vendor": (po.get("VendorRef") or {}).get("name"),
        "status": po.get("POStatus"), "sales_orders": so, "ack_total": ack_total,
        "date_field": date_field, "old_date": old_date, "new_date": new_date, "expected_field": expected_field,
        "old_total": old_total, "new_total": new_total, "lines": rows, "not_acknowledged": not_acked,
        "problems": problems, "note": note, "unchanged": unchanged, "payload": payload,
    }


def plan(ack, date_field="due"):
    return {"ack": ack, "pos": [plan_po(ack, n, date_field) for n in ack["po_numbers"]]}


def attachment_name(ack):
    d = ack["date"].strftime("%Y-%m-%d") if ack["date"] else "undated"
    return f"Cardinal OA {'-'.join(ack['sales_orders'])} {d}.pdf"


def apply(p, pdf_bytes=None):
    """Save the planned changes; with pdf_bytes also attach the acknowledgement
    (once) to each PO. Returns one result per PO."""
    results = []
    for po in p["pos"]:
        res = {"po_number": po["po_number"]}
        if po["problems"]:
            res.update(result="skipped", error=" ".join(po["problems"]))
            results.append(res)
            continue
        try:
            if po["unchanged"]:
                res["result"] = "unchanged"
            else:
                saved = qbo_client._post("purchaseorder", po["payload"]).get("PurchaseOrder", {})
                got = cents(saved.get("TotalAmt") or 0)
                res.update(result="updated" if got == po["new_total"] else "check", total=got)
            if pdf_bytes:
                name = attachment_name(p["ack"])
                existing = qbo_client.get_attachments_for_entity("PurchaseOrder", po["po_id"])
                if any(a.get("file_name") == name for a in existing):
                    res["attached"] = "already attached"
                else:
                    qbo_client.upload_attachment("PurchaseOrder", po["po_id"], name, pdf_bytes, "application/pdf")
                    res["attached"] = name
        except qbo_client.QBOError as e:
            res.update(result=res.get("result") if res.get("result") in ("updated", "check", "unchanged") else "failed",
                       error=str(e))
        results.append(res)
    return results


def as_json(p):
    """The plan with Decimals/dates turned into plain values, for the web page."""
    def f(x):
        return None if x is None else float(x)
    ack = p["ack"]
    return {
        "ack": {"date": ack["date"].isoformat() if ack["date"] else None,
                "requested_date": ack["requested_date"].isoformat() if ack["requested_date"] else None,
                "plant": ack["plant"], "sales_orders": ack["sales_orders"], "po_numbers": ack["po_numbers"],
                "total": f(ack["total"]), "flags": ack["flags"], "line_count": len(ack["lines"])},
        "pos": [{
            **{k: po[k] for k in ("po_number", "po_id", "vendor", "status", "sales_orders", "date_field",
                                  "old_date", "new_date", "expected_field", "problems", "note", "unchanged")},
            "ack_total": f(po["ack_total"]), "old_total": f(po["old_total"]), "new_total": f(po["new_total"]),
            "lines": [{**{k: r[k] for k in ("po_line", "size", "qty", "desc", "flags", "po_item", "po_qty", "status")},
                       "unit_price": f(r["unit_price"]), "ext": f(r["ext"]), "old_rate": f(r["old_rate"]),
                       "new_rate": f(r["new_rate"]), "old_amount": f(r["old_amount"]),
                       "new_amount": f(r["new_amount"]), "unchanged": r.get("unchanged", False)}
                      for r in po["lines"]],
            "not_acknowledged": [{**n, "amount": f(n["amount"])} for n in po["not_acknowledged"]],
        } for po in p["pos"]],
    }


def expected_totals(p):
    """{po number: new total} -- the web page sends this back so Apply only saves what was previewed."""
    return {po["po_number"]: round(float(po["new_total"]), 2) for po in p["pos"]}


# ---------------------------------------------------------------------------
# Command line
# ---------------------------------------------------------------------------
def print_plan(p):
    ack = p["ack"]
    print(f"Cardinal acknowledgement {ack['date']}  SO {', '.join(ack['sales_orders'])}  "
          f"requested {ack['requested_date']}  {len(ack['lines'])} lines  total ${ack['total'] or 0:,}")
    for fl in ack["flags"]:
        print(f"  ! {fl}")
    for po in p["pos"]:
        print(f"\nPO {po['po_number']} ({po['vendor']}, {po['status']})  "
              f"${po['old_total']:,} -> ${po['new_total']:,}   "
              f"{ {'due': 'Due date', 'txn': 'PO date', 'none': 'date'}[po['date_field']] }: "
              f"{po['old_date'] or '-'} -> {po['new_date'] or '(unchanged)'}")
        for pr in po["problems"]:
            print(f"  !! {pr}")
        print(f"  {'Ln':>3}  {'Size':<22}{'Qty':>4}  {'Rate now':>10}{'New rate':>11}{'Amount':>11}  PO item")
        for r in po["lines"]:
            if r["status"] == "missing":
                print(f"  {r['po_line']:>3}  {r['size']:<22}{r['qty']:>4}  {'':>10}{r['unit_price']:>11}"
                      f"{r['ext']:>11,}  ** NOT ON PO **")
            else:
                print(f"  {r['po_line']:>3}  {r['size']:<22}{r['qty']:>4}  {r['old_rate']:>10.4f}"
                      f"{r['new_rate']:>11}{r['new_amount']:>11,}  {r['po_item']}")
            for fl in r["flags"]:
                print(f"         ! {fl}")
        if po["not_acknowledged"]:
            print("  PO lines not on this acknowledgement (left as they are):")
            for n in po["not_acknowledged"]:
                print(f"    line {n['po_line']}: {n['item']}  qty {n['qty']:g}  ${n['amount']:,}")
        print(f"  memo: {po['note']}")


def main():
    ap = argparse.ArgumentParser(description="Check a Cardinal order acknowledgement against its QuickBooks PO "
                                             "and put Cardinal's cost and requested date on the PO.")
    ap.add_argument("pdf", help="the Order Acknowledgement Summary PDF")
    ap.add_argument("--date-field", choices=DATE_FIELDS, default="due",
                    help="where the Requested Date goes: PO due date (default), PO date, or nowhere")
    ap.add_argument("--attach", action="store_true", help="also attach the PDF to the PO")
    ap.add_argument("--apply", action="store_true", help="save the changes (default: preview only)")
    args = ap.parse_args()
    try:
        ack = parse_pdf(args.pdf)
        p = plan(ack, args.date_field)
    except (AckError, qbo_client.QBOError) as e:
        sys.exit(f"Error: {e}")
    print_plan(p)
    if not args.apply:
        print("\nPreview only. Add --apply to update the PO.")
        return
    with open(args.pdf, "rb") as f:
        pdf_bytes = f.read() if args.attach else None
    for r in apply(p, pdf_bytes):
        extra = r.get("error") or (f"saved total ${r['total']:,}" if "total" in r else "")
        print(f"  PO {r['po_number']}: {r['result']} {extra} {('attached: ' + r['attached']) if r.get('attached') else ''}")


if __name__ == "__main__":
    main()
