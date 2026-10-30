"""
commission_support.py
=====================
Checks the scanned commission support (the paper backup for each paid
invoice) against the commission workbook, and attaches each invoice's pages
to its commission bills in QuickBooks.

    venv/bin/python commission_support.py <workbook.xlsx> <scan.pdf>            # check + split
    venv/bin/python commission_support.py <workbook.xlsx> <scan.pdf> --attach   # also attach to the bills

Check:
  * every page is read (its text layer, or OCR for copier scans) and matched
    to the invoice numbers on the sheet;
  * a sheet row with no page    -> MISSING SUPPORT;
  * an invoice-like number on a page that is not on the sheet
                                -> possibly a commission missing from the sheet;
  * a page with no invoice number is treated as a continuation of the page
    before it, and flagged so someone glances at it.
Each invoice's pages are saved as "Commission support <invoice>.pdf" in the
output folder (default: next to the scan).

Attach (run after commission_bills.py --post): every bill for that invoice
with this payroll's due date gets the invoice's PDF. A bill that already has
a file with the same name is skipped, so re-running is safe.

OCR needs the tesseract binary and pytesseract on the server (see glass_ocr.py).
"""

import argparse
import os
import re
import sys

import pdfplumber
import pypdfium2 as pdfium

import commission_bills as cb
import qbo_client

MIN_TEXT_CHARS = 25        # less text than this on a page = scanned image, OCR it
NEAR_RANGE = 1000          # numbers within this of the sheet's invoice #s count as invoice-like
OCR_DPI = 300


def page_texts(path):
    """[(page_no, text, how)] for every page of the PDF."""
    out = []
    with pdfplumber.open(path) as pdf:
        for i, page in enumerate(pdf.pages, start=1):
            text = page.extract_text() or ""
            if len(text.strip()) >= MIN_TEXT_CHARS:
                out.append((i, text, "text"))
                continue
            if not page.images:          # nothing scanned on it: a blank page
                out.append((i, text, "text"))
                continue
            out.append((i, _ocr(page), "ocr"))
    return out


def _ocr(page):
    """Read a scanned page: Tesseract first, RapidOCR if Tesseract is missing or
    finds no 5-digit number (invoice # / Q#) on the page."""
    from glass_ocr import remove_colored_ink
    img = remove_colored_ink(page.to_image(resolution=OCR_DPI).original.convert("RGB"))
    text, missing = "", []
    try:
        import pytesseract
        text = pytesseract.image_to_string(img)
    except ImportError:
        missing.append("pytesseract")
    except Exception as e:  # TesseractNotFoundError and friends
        missing.append(f"tesseract ({type(e).__name__})")
    if not NUMBER.search(text):
        try:
            import numpy as np
            from glass_ocr import _rapid_engine
            engine = _rapid_engine()
            if engine is not None:
                res, _ = engine(np.array(img))
                rapid = "\n".join(r[1] for r in (res or []))
                if NUMBER.search(rapid) or not text:
                    text = rapid
            elif missing:
                missing.append("rapidocr")
        except ImportError:
            missing.append("rapidocr")
    if not text and missing:
        raise cb.CommissionError("This scan needs OCR but none is available (" + ", ".join(missing) + "). "
                         "Install tesseract-ocr + pytesseract or rapidocr_onnxruntime.")
    return text


# A 5-digit number that is not part of a dollar amount ($18,409.42 / 17563.50),
# a fraction (166 31/32) or a longer number.
NUMBER = re.compile(r"(?<![\d$.,/])(\d{5})(?!\d|[.,]\d|\s*/\s*\d)")


def q_base(q):
    """'92119/3764' and '90500.1' are the same job as '92119' and '90500'."""
    return re.split(r"[/.\s-]", str(q or "").strip())[0]


def match_pages(pages, invoices, q_numbers=None):
    """Assign pages to invoice numbers.

    q_numbers maps a job's Q# to its invoice number(s); a page with no invoice
    number but a sheet Q# (crating sheet, Panda Number Report) goes to that job.
    Returns (groups {invoice: [page_no]}, notes [str], extra {number: [page_no]})."""
    inv_set = set(invoices)
    qmap = {q_base(k): v for k, v in (q_numbers or {}).items() if q_base(k)}
    nums = [int(n) for n in invoices if n.isdigit()]
    lo, hi = (min(nums) - NEAR_RANGE, max(nums) + NEAR_RANGE) if nums else (0, -1)
    groups = {n: [] for n in invoices}
    extra, notes = {}, []
    last = None
    for page_no, text, how in pages:
        tokens = set(NUMBER.findall(text))
        found = sorted(t for t in tokens if t in inv_set)
        near = sorted(t for t in tokens if t not in inv_set and lo <= int(t) <= hi and t not in qmap)
        by_q = []
        if not found:
            # The first Q# on the page is the header's; later ones are usually references.
            q = next((t for t in re.findall(r"\d{5,}", text) if t in qmap), None)
            if q:
                cands = qmap[q]
                by_q = [c for c in cands if last and c in last] or cands[:1]
        for t in near:
            extra.setdefault(t, []).append(page_no)
        if found:
            for n in found:
                groups[n].append(page_no)
            last = found
        elif by_q:
            for n in by_q:
                groups[n].append(page_no)
            notes.append(f"page {page_no}: no invoice #, matched by Q# to {', '.join(by_q)}")
            last = by_q
        elif near:                    # a page for an invoice that isn't on the sheet
            last = None
        elif not text.strip():
            notes.append(f"page {page_no}: no readable text ({how}) -- check it by eye")
        elif last:
            for n in last:
                groups[n].append(page_no)
            notes.append(f"page {page_no}: no invoice # found, kept with {', '.join(last)} (page before)")
        else:
            notes.append(f"page {page_no}: no invoice # found and nothing before it -- not attached")
    return groups, notes, extra


def q_numbers_for(rows):
    """{Q#: [invoice numbers]} from the sheet rows."""
    out = {}
    for r in rows:
        inv = r["doc_number"].split()[0]
        if r.get("q_number"):
            out.setdefault(q_base(r["q_number"]), [])
            if inv not in out[q_base(r["q_number"])]:
                out[q_base(r["q_number"])].append(inv)
    return out


def split_pdf(path, groups, out_dir):
    """Write one PDF per invoice; returns {invoice: file path}."""
    os.makedirs(out_dir, exist_ok=True)
    src = pdfium.PdfDocument(path)
    files = {}
    for inv, page_nos in groups.items():
        if not page_nos:
            continue
        dst = pdfium.PdfDocument.new()
        dst.import_pages(src, [p - 1 for p in page_nos])
        fp = os.path.join(out_dir, support_filename(inv))
        dst.save(fp)
        files[inv] = fp
    return files


def support_filename(invoice):
    return f"Commission support {invoice}.pdf"


def attach_support(files, rows, due_date):
    """Attach each invoice's PDF to its bills that are due on due_date.

    Returns {"attached": [(bill id, bill #, vendor, file)], "skipped": n,
             "no_file": [bill #], "not_posted": [bill #], "found": n}."""
    docs = sorted({r["doc_number"] for r in rows})
    inv_of_doc = {r["doc_number"]: r["doc_number"].split()[0] for r in rows}
    bills = []
    for i in range(0, len(docs), 50):
        in_list = ", ".join("'" + d.replace("'", "\\'") + "'" for d in docs[i:i + 50])
        bills += qbo_client._query(
            f"SELECT Id, DocNumber, VendorRef, DueDate FROM Bill WHERE DocNumber IN ({in_list}) "
            f"AND DueDate = '{due_date.isoformat()}'")
    out = {"attached": [], "skipped": 0, "no_file": set(), "found": len(bills)}
    for b in sorted(bills, key=lambda b: b["DocNumber"]):
        fp = files.get(inv_of_doc.get(b["DocNumber"]))
        if not fp:
            out["no_file"].add(b["DocNumber"])
            continue
        name = os.path.basename(fp)
        if any(a["file_name"] == name for a in qbo_client.get_attachments_for_entity("Bill", b["Id"])):
            out["skipped"] += 1
            continue
        with open(fp, "rb") as f:
            qbo_client.upload_attachment("Bill", b["Id"], name, f.read(), "application/pdf")
        out["attached"].append((b["Id"], b["DocNumber"], b["VendorRef"].get("name", b["VendorRef"]["value"]), name))
    found_docs = {b["DocNumber"] for b in bills}
    out["no_file"] = sorted(out["no_file"])
    out["not_posted"] = [d for d in docs if d not in found_docs]
    return out


def attach(files, rows, due_date):
    res = attach_support(files, rows, due_date)
    for bill_id, doc, vendor, name in res["attached"]:
        print(f"  attached {name} -> bill {bill_id} ({doc} / {vendor})")
    print(f"\nAttached {len(res['attached'])}, already attached {res['skipped']}, "
          f"{res['found']} bill(s) due {due_date:%m/%d/%Y} found.")
    if res["no_file"]:
        print("No support file for: " + ", ".join(res["no_file"]))
    if res["not_posted"]:
        print("Not in QuickBooks yet (post first): " + ", ".join(res["not_posted"]))


def main():
    ap = argparse.ArgumentParser(description="Check scanned commission support against the workbook and attach it to the bills.")
    ap.add_argument("workbook")
    ap.add_argument("scan", help="scanned support PDF")
    ap.add_argument("--sheet")
    ap.add_argument("--due-date", help="payroll/due date, MM/DD/YYYY (default: from the sheet name)")
    ap.add_argument("--out", help="folder for the per-invoice PDFs (default: next to the scan)")
    ap.add_argument("--attach", action="store_true", help="attach the per-invoice PDFs to the posted bills")
    args = ap.parse_args()

    sheet_name, rows = cb.read_rows(args.workbook, args.sheet)
    due_date = cb.as_date(args.due_date) if args.due_date else cb.due_date_from_sheet(sheet_name, rows)
    invoices = sorted({r["doc_number"].split()[0] for r in rows})

    pages = page_texts(args.scan)
    groups, notes, extra = match_pages(pages, invoices, q_numbers_for(rows))
    print(f"{os.path.basename(args.scan)}: {len(pages)} page(s); sheet '{sheet_name}' has {len(invoices)} invoice(s)\n")

    missing = [n for n in invoices if not groups[n]]
    if missing:
        print("MISSING SUPPORT (on the sheet, no page found):")
        for n in missing:
            r = next(r for r in rows if r["doc_number"].split()[0] == n)
            print(f"  {r['doc_number']:<15} {r['rep']:<8} {r['amount']:>10,.2f}  {r['customer']}")
    if extra:
        print("\nIN THE SCAN BUT NOT ON THE SHEET (possible missing commission rows):")
        for n, p in sorted(extra.items()):
            print(f"  {n}  page(s) {', '.join(map(str, p))}")
    if notes:
        print("\nPages to look at:")
        for n in notes:
            print("  " + n)
    if not (missing or extra or notes):
        print("Every invoice on the sheet has support, and nothing extra was found.")

    out_dir = args.out or os.path.join(os.path.dirname(os.path.abspath(args.scan)), "commission_support")
    files = split_pdf(args.scan, groups, out_dir)
    print(f"\nWrote {len(files)} per-invoice PDF(s) to {out_dir}")

    if args.attach:
        if not due_date:
            raise SystemExit("Couldn't tell the payroll date -- pass --due-date MM/DD/YYYY")
        attach(files, rows, due_date)
    return 1 if (missing or extra) else 0


if __name__ == "__main__":
    sys.exit(main())
