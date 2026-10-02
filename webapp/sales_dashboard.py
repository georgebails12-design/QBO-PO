"""
sales_dashboard.py
==================
Data for the Sales Dashboard page: monthly sales and cash collected per
RSM, pulled read-only from QuickBooks.

Sales = invoice lines that post to an Income account, by invoice date,
less credit memos the same way. Deposit invoices post to 2115 Customer
Deposits (and final invoices back the deposit out with a negative line to
the same account), and sales tax posts to a liability, so neither counts --
summing invoice totals would double-count every deposit.

Cash collected = customer payments (Payment.TotalAmt), by payment date.
Payments that only apply journal-entry or credit-memo credits to an invoice
are $0 and add nothing. Each payment is credited to the RSM of the
invoice(s) it was applied to, split in proportion to the amounts applied;
cash not applied to any invoice is shown as "Not applied to an invoice".

RSM is the "RSM" dropdown custom field on each invoice. The API returns the
dropdown option's id, not its label, so RSM_NAMES maps ids to names (same
list the n8n "QBO - Weekly Overdue AR by RSM" workflow uses).

Pulling every transaction takes a while, so the result is cached to
sales_dashboard_cache.json (gitignored) and rebuilt by a background job the
page starts, like the vendor/item reference data.
"""

import json
import os
import time
from collections import defaultdict

import qbo_client

APP_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_FILE = os.path.join(APP_DIR, "sales_dashboard_cache.json")

# How far back the dashboard goes (by transaction date).
START_DATE = "2025-01-01"

# enhancedAllCustomFields (minorversion 70+) is what makes QBO return the
# newer dropdown custom fields like RSM on invoices at all.
CUSTOM_FIELD_PARAMS = {"include": "enhancedAllCustomFields", "minorversion": "75"}

# RSM dropdown option id -> name. Ids missing here show as "Unmapped (<id>)".
RSM_NAMES = {
    "1": "Avi Shoshan",
    "2": "Efrain",
    "3": "Trever",
    "4": "Emanuel Teral(Alex)",
    "6": "Derrick",
    "7": "Troy",
    "10": "Private Label",
    "11": "Sean",
    "12": "Service",
    "13": "Stefan",
    "15": "Spencer",
    "16": "Tyler",
    "18": "Tyler",
    "23": "David Rodriquez",
    "24": "William",
}
NO_RSM = "No RSM on invoice"
UNAPPLIED = "Not applied to an invoice"


def _custom_field(txn, name):
    for cf in txn.get("CustomField") or []:
        if (cf.get("Name") or "").strip() == name:
            return (cf.get("StringValue") or "").strip()
    return ""


def rsm_name(txn):
    rsm_id = _custom_field(txn, "RSM")
    if not rsm_id:
        return NO_RSM
    return RSM_NAMES.get(rsm_id, f"Unmapped RSM #{rsm_id}")


def _fetch(entity, where):
    return qbo_client._query(f"SELECT * FROM {entity} WHERE {where}", params=CUSTOM_FIELD_PARAMS)


def _fetch_invoices_by_id(ids):
    """Invoices dated before START_DATE that later payments were applied to."""
    found = []
    ids = sorted(ids)
    for i in range(0, len(ids), 100):
        chunk = ", ".join(f"'{x}'" for x in ids[i:i + 100])
        found.extend(_fetch("Invoice", f"Id IN ({chunk})"))
    return found


def _income_account_ids():
    rows = qbo_client._query("SELECT Id, AccountType FROM Account WHERE AccountType = 'Income'")
    return {a["Id"] for a in rows}


def _revenue(txn, income_ids):
    """Sum of the lines on an invoice/credit memo that post to an Income account."""
    total = 0.0
    for line in txn.get("Line") or []:
        detail_type = line.get("DetailType")
        if detail_type == "SalesItemLineDetail":
            acct = (line["SalesItemLineDetail"].get("ItemAccountRef") or {}).get("value")
        elif detail_type == "DiscountLineDetail":
            acct = (line["DiscountLineDetail"].get("DiscountAccountRef") or {}).get("value")
            if acct in income_ids:
                total -= float(line.get("Amount") or 0)  # discounts come through as positive amounts
            continue
        else:
            continue
        if acct in income_ids:
            total += float(line.get("Amount") or 0)
    return total


def build():
    """Pull everything from QuickBooks and aggregate it into the page's data."""
    income_ids = _income_account_ids()
    invoices = _fetch("Invoice", f"TxnDate >= '{START_DATE}'")
    credit_memos = _fetch("CreditMemo", f"TxnDate >= '{START_DATE}'")
    payments = _fetch("Payment", f"TxnDate >= '{START_DATE}'")

    inv_by_id = {i["Id"]: i for i in invoices}
    linked_ids = {
        t["TxnId"]
        for p in payments for line in p.get("Line") or [] for t in line.get("LinkedTxn") or []
        if t.get("TxnType") == "Invoice" and t.get("TxnId") not in inv_by_id
    }
    for inv in _fetch_invoices_by_id(linked_ids) if linked_ids else []:
        inv_by_id[inv["Id"]] = inv

    # facts[(month, rsm)] = {"sales", "cash", "n"}
    facts = defaultdict(lambda: {"sales": 0.0, "cash": 0.0, "n": 0})
    invoice_rows = []
    for inv in invoices:
        month = inv["TxnDate"][:7]
        rsm = rsm_name(inv)
        sales = _revenue(inv, income_ids)
        f = facts[(month, rsm)]
        f["sales"] += sales
        f["n"] += 1
        invoice_rows.append({
            "id": inv["Id"], "doc": inv.get("DocNumber") or "", "date": inv["TxnDate"],
            "customer": (inv.get("CustomerRef") or {}).get("name", ""), "rsm": rsm,
            "sales": round(sales, 2), "total": round(float(inv.get("TotalAmt") or 0), 2),
            "balance": round(float(inv.get("Balance") or 0), 2),
        })
    for cm in credit_memos:
        facts[(cm["TxnDate"][:7], rsm_name(cm))]["sales"] -= _revenue(cm, income_ids)

    for pay in payments:
        cash = float(pay.get("TotalAmt") or 0)
        if not cash:
            continue
        month = pay["TxnDate"][:7]
        applied = defaultdict(float)
        for line in pay.get("Line") or []:
            for t in line.get("LinkedTxn") or []:
                if t.get("TxnType") == "Invoice":
                    inv = inv_by_id.get(t["TxnId"])
                    applied[rsm_name(inv) if inv else NO_RSM] += float(line.get("Amount") or 0)
        applied_total = sum(applied.values())
        to_invoices = min(cash - float(pay.get("UnappliedAmt") or 0), applied_total) if applied_total > 0 else 0.0
        for rsm, amount in applied.items():
            facts[(month, rsm)]["cash"] += to_invoices * amount / applied_total
        if cash - to_invoices > 0.005:
            facts[(month, UNAPPLIED)]["cash"] += cash - to_invoices

    months = sorted({m for m, _ in facts})
    rows = [
        {"m": m, "r": r, "sales": round(v["sales"], 2), "cash": round(v["cash"], 2), "n": v["n"]}
        for (m, r), v in sorted(facts.items())
        if round(v["sales"], 2) or round(v["cash"], 2) or v["n"]
    ]
    rsms = sorted({r["r"] for r in rows}, key=lambda r: (r in (NO_RSM, UNAPPLIED) or r.startswith("Unmapped"), r.lower()))
    return {
        "built_at": time.time(),
        "start_date": START_DATE,
        "months": months,
        "rsms": rsms,
        "facts": rows,
        "invoices": invoice_rows,
        "notes": (
            "Sales = invoice lines posting to income accounts, by invoice date, less credit memos "
            "(customer deposits and sales tax excluded). Cash collected = customer payments by "
            "payment date, credited to the RSM on the invoice(s) each payment was applied to. "
            "RSM comes from the invoice's RSM field in QuickBooks."
        ),
    }


def load_cache():
    if not os.path.exists(CACHE_FILE):
        return None
    with open(CACHE_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def refresh_cache():
    data = build()
    tmp = CACHE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f)
    os.replace(tmp, CACHE_FILE)
    return data
