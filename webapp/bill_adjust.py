"""
bill_adjust.py
==============
Re-price a vendor's open bills so they add up to the dollars actually paid.

Typical use: ELVIAL invoices in euros are entered at the euro amounts, then
paid by one USD wire. The wire amount is spread over the bills in proportion
to each bill's amount (one exchange rate for the whole payment), so after the
update the bills total exactly the amount paid and the Pay Bills screen
clears them to zero.

    venv/bin/python bill_adjust.py ELVIAL 00125 06306 04502 04501 --total 73341.31            # preview
    venv/bin/python bill_adjust.py ELVIAL 00125 06306 04502 04501 --total 73341.31 --apply    # update

Bill numbers can be the full QuickBooks number ("INV-K-06306") or just its
ending ("06306"). Only unpaid bills are touched.

How each bill changes (--mode):
  scale  (default) every line is multiplied by the same rate, so job costs and
         item costs carry the real USD cost. Rounding cents go on the biggest line.
  line   the lines are left alone and one line is added for the difference,
         to --account (e.g. an exchange gain/loss account).

The bill's memo gets a note with the original amount, the rate and the date.
Re-running with the same total does nothing (the bills already add up).
"""

import argparse
import datetime as dt
import re
import sys
from decimal import Decimal, ROUND_HALF_UP

import qbo_client

CENT = Decimal("0.01")
EXPENSE_LINE_TYPES = ("AccountBasedExpenseLineDetail", "ItemBasedExpenseLineDetail")


class AdjustError(Exception):
    """A problem with the request or the bills, with a message safe to show."""


def dec(value):
    return Decimal(str(value))


def cents(value):
    return dec(value).quantize(CENT, rounding=ROUND_HALF_UP)


def _quote(s):
    return "'" + str(s).replace("\\", "\\\\").replace("'", "\\'") + "'"


# ---------------------------------------------------------------------------
# Lookups
# ---------------------------------------------------------------------------
def find_vendor(name):
    """The one vendor whose display name matches `name` (exact, else contains)."""
    name = (name or "").strip()
    if not name:
        raise AdjustError("Enter the vendor.")
    rows = qbo_client._query(f"SELECT Id, DisplayName, CurrencyRef FROM Vendor WHERE DisplayName = {_quote(name)}")
    if not rows:
        rows = qbo_client._query(f"SELECT Id, DisplayName, CurrencyRef FROM Vendor WHERE DisplayName LIKE "
                                 f"{_quote('%' + name + '%')}")
    if not rows:
        raise AdjustError(f"No vendor named like '{name}' in QuickBooks.")
    if len(rows) > 1:
        names = ", ".join(r["DisplayName"] for r in rows[:8])
        raise AdjustError(f"'{name}' matches more than one vendor ({names}). Type the full name.")
    return rows[0]


def find_account(label):
    label = (label or "").strip()
    if not label:
        raise AdjustError("Line mode needs an account for the adjustment line (--account).")
    for field in ("FullyQualifiedName", "Name", "AcctNum"):
        rows = qbo_client._query(f"SELECT Id, Name, FullyQualifiedName, AcctNum FROM Account "
                                 f"WHERE {field} = {_quote(label)}")
        if rows:
            return rows[0]
    m = re.match(r"^\s*(\d+)\s+(.+)$", label)  # "6800 Sales Commissions"
    if m:
        rows = qbo_client._query(f"SELECT Id, Name, FullyQualifiedName, AcctNum FROM Account "
                                 f"WHERE AcctNum = {_quote(m.group(1))}")
        if rows:
            return rows[0]
        rows = qbo_client._query(f"SELECT Id, Name, FullyQualifiedName, AcctNum FROM Account "
                                 f"WHERE Name = {_quote(m.group(2))}")
        if rows:
            return rows[0]
    raise AdjustError(f"No account '{label}' in QuickBooks.")


def parse_numbers(text_or_list):
    """'00125, 06306 04502' or a list -> ['00125', '06306', '04502'] (order kept, no repeats)."""
    if isinstance(text_or_list, str):
        parts = re.split(r"[\s,;]+", text_or_list)
    else:
        parts = [p for item in text_or_list for p in re.split(r"[\s,;]+", str(item))]
    out = []
    for p in parts:
        p = p.strip()
        if p and p not in out:
            out.append(p)
    return out


def _number_matches(doc_number, wanted):
    doc, want = (doc_number or "").strip().upper(), wanted.strip().upper()
    if not doc:
        return False
    if doc == want:
        return True
    # "06306" matches "INV-K-06306" but not "INV-K-106306"
    return doc.endswith(want) and not doc[len(doc) - len(want) - 1].isalnum()


def find_bills(vendor_id, numbers):
    """{wanted number: full Bill} for this vendor. Raises if any number is missing or ambiguous."""
    bills = qbo_client._query(f"SELECT * FROM Bill WHERE VendorRef = {_quote(vendor_id)} "
                              f"ORDERBY TxnDate DESC")
    found, problems = {}, []
    for want in numbers:
        hits = [b for b in bills if _number_matches(b.get("DocNumber"), want)]
        open_hits = [b for b in hits if dec(b.get("Balance", 0)) != 0]
        if len(open_hits) == 1 or (len(hits) == 1 and not open_hits):
            found[want] = (open_hits or hits)[0]
        elif not hits:
            problems.append(f"no bill numbered '{want}' for this vendor")
        else:
            nums = ", ".join(f"{b.get('DocNumber')} ({b.get('TxnDate')})" for b in (open_hits or hits))
            problems.append(f"'{want}' matches more than one bill: {nums}; type the full number")
    if problems:
        raise AdjustError("; ".join(problems).capitalize() + ".")
    ids = [b["Id"] for b in found.values()]
    if len(set(ids)) != len(ids):
        raise AdjustError("Two of the numbers point to the same bill.")
    return found


# ---------------------------------------------------------------------------
# Plan
# ---------------------------------------------------------------------------
def allocate(amounts, total):
    """Split `total` over `amounts` proportionally, in cents, summing exactly to `total`.
    Leftover cents go to the largest amounts first."""
    base = sum(amounts)
    if base <= 0:
        raise AdjustError("The bills add up to zero, so there is nothing to spread the payment over.")
    raw = [a * total / base for a in amounts]
    out = [r.quantize(CENT, rounding=ROUND_HALF_UP) for r in raw]
    diff = total - sum(out)
    order = sorted(range(len(amounts)), key=lambda i: amounts[i], reverse=True)
    step = CENT if diff > 0 else -CENT
    i = 0
    while diff != 0:
        out[order[i % len(order)]] += step
        diff -= step
        i += 1
    return out


def _expense_lines(bill):
    return [ln for ln in bill.get("Line", []) if ln.get("DetailType") in EXPENSE_LINE_TYPES]


def _scaled_lines(bill, new_total):
    """The bill's lines with every amount scaled so they sum to new_total."""
    lines = [dict(ln) for ln in bill.get("Line", [])]
    exp = [ln for ln in lines if ln.get("DetailType") in EXPENSE_LINE_TYPES]
    old_amounts = [dec(ln.get("Amount", 0)) for ln in exp]
    if sum(old_amounts) <= 0:
        raise AdjustError(f"Bill {bill.get('DocNumber')} has no positive line amounts to scale.")
    new_amounts = allocate(old_amounts, new_total)
    changes = []
    for ln, old, new in zip(exp, old_amounts, new_amounts):
        ln["Amount"] = float(new)
        kind = ln["DetailType"]
        if kind == "ItemBasedExpenseLineDetail":
            detail = dict(ln[kind])
            qty = dec(detail.get("Qty") or 0)
            if qty:
                detail["UnitPrice"] = float((new / qty).quantize(Decimal("0.0000001"), rounding=ROUND_HALF_UP))
            ln[kind] = detail
        changes.append({"description": (ln.get("Description") or "")[:80], "old": old, "new": new})
    return lines, changes


def _line_with_adjustment(bill, new_total, account, description):
    lines = [dict(ln) for ln in bill.get("Line", [])]
    old_total = sum(dec(ln.get("Amount", 0)) for ln in _expense_lines(bill))
    diff = new_total - old_total
    template = next((ln for ln in _expense_lines(bill) if ln["DetailType"] == "AccountBasedExpenseLineDetail"), None)
    detail = {"AccountRef": {"value": account["Id"], "name": account.get("FullyQualifiedName") or account["Name"]}}
    if template:  # keep the class / customer of the bill's first category line
        for key in ("ClassRef", "CustomerRef", "BillableStatus", "TaxCodeRef"):
            if template["AccountBasedExpenseLineDetail"].get(key):
                detail[key] = template["AccountBasedExpenseLineDetail"][key]
    lines.append({"DetailType": "AccountBasedExpenseLineDetail", "Amount": float(diff),
                  "Description": description, "AccountBasedExpenseLineDetail": detail})
    return lines, [{"description": description, "old": Decimal("0.00"), "new": diff}]


def plan(vendor_name, numbers, total, pay_date=None, mode="scale", account=None):
    """Work out the new amount for every bill. Reads QuickBooks, changes nothing."""
    numbers = parse_numbers(numbers)
    if not numbers:
        raise AdjustError("Enter the bill numbers.")
    try:
        total = cents(total)
    except Exception:
        raise AdjustError(f"'{total}' is not an amount.")
    if total <= 0:
        raise AdjustError("The amount paid must be more than zero.")
    if mode not in ("scale", "line"):
        raise AdjustError("Mode must be 'scale' or 'line'.")
    pay_date = pay_date or dt.date.today().isoformat()

    vendor = find_vendor(vendor_name)
    acct = find_account(account) if mode == "line" else None
    bills = find_bills(vendor["Id"], numbers)

    home = None
    problems = []
    for want, b in bills.items():
        cur = (b.get("CurrencyRef") or {}).get("value")
        home = home or cur
        if b.get("ExchangeRate") not in (None, 1, 1.0) or (cur and home and cur != home):
            problems.append(f"{b['DocNumber']} is a {cur} bill with exchange rate {b.get('ExchangeRate')}; "
                            f"pay it in QuickBooks with the day's exchange rate instead of changing its amount")
        if dec(b.get("Balance", 0)) == 0:
            problems.append(f"{b['DocNumber']} is already paid")
        elif cents(b.get("Balance", 0)) != cents(b.get("TotalAmt", 0)):
            problems.append(f"{b['DocNumber']} is part paid ({cents(b['Balance'])} of {cents(b['TotalAmt'])} open)")
        if any(ln.get("DetailType") not in EXPENSE_LINE_TYPES for ln in b.get("Line", [])):
            problems.append(f"{b['DocNumber']} has a line type this tool doesn't handle")
    if problems:
        raise AdjustError("Can't adjust: " + "; ".join(problems) + ".")

    order = list(bills)
    old = [cents(bills[w]["TotalAmt"]) for w in order]
    old_total = sum(old)
    new = allocate(old, total)
    rate = total / old_total
    rate_txt = f"{rate:.6f}"

    rows = []
    for want, before, after in zip(order, old, new):
        b = bills[want]
        note = (f"Adjusted {pay_date} to USD paid: {before:,.2f} x {rate_txt} = {after:,.2f} "
                f"(payment {total:,.2f} over {len(order)} bills)")
        if mode == "scale":
            lines, changes = _scaled_lines(b, after)
        else:
            lines, changes = _line_with_adjustment(b, after, acct, f"Exchange difference, USD paid {pay_date}")
        memo = (b.get("PrivateNote") or "").strip()
        memo = (memo + "\n" + note).strip() if memo else note
        rows.append({
            "number": want, "id": b["Id"], "doc": b.get("DocNumber"), "date": b.get("TxnDate"),
            "due": b.get("DueDate"), "old": before, "new": after, "diff": after - before,
            "changes": changes, "unchanged": before == after,
            "payload": {"Id": b["Id"], "SyncToken": b["SyncToken"], "sparse": True,
                        "Line": lines, "PrivateNote": memo[:4000]},
        })
    return {"vendor": {"id": vendor["Id"], "name": vendor["DisplayName"]}, "pay_date": pay_date,
            "mode": mode, "account": (acct or {}).get("FullyQualifiedName"),
            "old_total": old_total, "new_total": total, "rate": rate, "bills": rows}


def apply(p):
    """Save the planned amounts. Returns one result per bill."""
    results = []
    for r in p["bills"]:
        if r["unchanged"]:
            results.append({"doc": r["doc"], "result": "unchanged"})
            continue
        try:
            saved = qbo_client._post("bill", r["payload"]).get("Bill", {})
            got = cents(saved.get("TotalAmt", 0))
            results.append({"doc": r["doc"], "result": "updated" if got == r["new"] else "check",
                            "total": got, "id": saved.get("Id")})
        except qbo_client.QBOError as e:
            results.append({"doc": r["doc"], "result": "failed", "error": str(e)})
    return results


def as_json(p):
    """The plan with Decimals turned into floats, for the web page."""
    def f(x):
        return float(x)
    return {
        "vendor": p["vendor"], "pay_date": p["pay_date"], "mode": p["mode"], "account": p["account"],
        "old_total": f(p["old_total"]), "new_total": f(p["new_total"]), "rate": f"{p['rate']:.6f}",
        "bills": [{"number": r["number"], "doc": r["doc"], "date": r["date"], "due": r["due"],
                   "old": f(r["old"]), "new": f(r["new"]), "diff": f(r["diff"]), "unchanged": r["unchanged"],
                   "lines": [{"description": c["description"], "old": f(c["old"]), "new": f(c["new"])}
                             for c in r["changes"]]}
                  for r in p["bills"]],
    }


# ---------------------------------------------------------------------------
# Command line
# ---------------------------------------------------------------------------
def print_plan(p):
    print(f"Vendor: {p['vendor']['name']}   payment {p['new_total']:,.2f} on {p['pay_date']}   "
          f"rate {p['rate']:.6f}   mode: {p['mode']}" + (f" -> {p['account']}" if p["account"] else ""))
    print(f"{'Bill':<16}{'Date':<12}{'Now':>14}{'New':>14}{'Change':>12}")
    for r in p["bills"]:
        print(f"{r['doc']:<16}{r['date']:<12}{r['old']:>14,.2f}{r['new']:>14,.2f}{r['diff']:>12,.2f}")
        if len(r["changes"]) > 1 or p["mode"] == "line":
            for c in r["changes"]:
                print(f"    {c['description'][:40]:<40}{c['old']:>12,.2f} -> {c['new']:,.2f}")
    print(f"{'Total':<28}{p['old_total']:>14,.2f}{p['new_total']:>14,.2f}{p['new_total'] - p['old_total']:>12,.2f}")


def main():
    ap = argparse.ArgumentParser(description="Re-price open bills so they add up to the dollars paid.")
    ap.add_argument("vendor", help="vendor name as in QuickBooks, e.g. ELVIAL")
    ap.add_argument("numbers", nargs="+", help="bill numbers, full or just the ending (00125 06306 ...)")
    ap.add_argument("--total", required=True, help="dollars paid for these bills, e.g. 73341.31")
    ap.add_argument("--date", help="payment date for the memo note, YYYY-MM-DD (default today)")
    ap.add_argument("--mode", choices=("scale", "line"), default="scale",
                    help="scale every line (default) or add one adjustment line")
    ap.add_argument("--account", help="account for the adjustment line in line mode")
    ap.add_argument("--apply", action="store_true", help="save the changes (default: preview only)")
    args = ap.parse_args()
    try:
        p = plan(args.vendor, args.numbers, args.total.replace(",", "").replace("$", ""),
                 args.date, args.mode, args.account)
    except (AdjustError, qbo_client.QBOError) as e:
        sys.exit(f"Error: {e}")
    print_plan(p)
    if not args.apply:
        print("\nPreview only. Add --apply to update these bills.")
        return
    for r in apply(p):
        extra = r.get("error") or (f"saved total {r['total']:,.2f}" if "total" in r else "")
        print(f"  {r['doc']}: {r['result']} {extra}")


if __name__ == "__main__":
    main()
