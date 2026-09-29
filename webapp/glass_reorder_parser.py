"""
glass_reorder_parser.py
=======================
Parses a Panda Windows & Doors "Glass Reorder Purchase Request" PDF (the
GLASS_REORDER_FORM.pdf the office fills out when glass has to be
reordered) into the same shape glass_pdf_parser.parse_glass_pdf() returns,
so the Import Glass PDF dialog can create QuickBooks Items from either kind
of document.

How a reorder form differs from a production doc / shop drawing:
  - Every page repeats the whole header block (ship/order dates, sales rep,
    project, reason for reorder), and ends with "GLASS REORDER ISSUE PAGE
    N OF M". That repeated block is cut out before matching units, otherwise
    it bleeds into the last unit's BREAKDOWN on each page.
  - There's no "-" between VENDOR and TYPE on the UNIT# line.
  - Dimensions use the "×" multiplication sign instead of the letter X.
  - The header adds ORDER DATE, TARGET SHIP DATE, SALES REP, PM, UNIT TYPE
    and REASON FOR REORDER, returned alongside job / project_name / jdm.

Spec parsing, lite-code mapping, dimension flags and the Item Name /
Description format all come from glass_pdf_parser -- extend LITE1_MAP /
LITE2_MAP there when a new glass type shows up (e.g. the untempered
"CARDINAL 366 LOW-E" seen on reorder forms is flagged, not guessed).

Like the production doc, a reorder form has no pricing on it -- price is
entered by hand in the review grid before the Items are created.
"""

import datetime
import re

import glass_pdf_parser as gpp

DIM_TOKEN = gpp.DIM_TOKEN

UNIT_RE = re.compile(
    r"UNIT#\s*([\d.,\s-]+?)\s*VENDOR:\s*(.*?)\s*(?:-\s*)?TYPE:\s*(.*?)\s*"
    r"QTY:\s*(\d+)\s*-\s*OVERALL DIM\.:\s*(.+?)\s*-\s*OA:\s*(" + DIM_TOKEN + r")"
    r"(?:\s*BREAKDOWN:\s*(.*?))?(?=UNIT#|$)",
    re.IGNORECASE | re.DOTALL,
)

# Footer of one page through the repeated header of the next, up to that
# page's first UNIT# (or the end of the document on the last page).
PAGE_BREAK_RE = re.compile(r"GLASS REORDER ISSUE PAGE \d+ OF \d+.*?(?=UNIT#|$)", re.IGNORECASE)

REORDER_ITEM_SUFFIX = " Reorder"


def is_reorder_form(raw_text):
    return bool(re.search(r"REASON FOR REORDER", raw_text, re.IGNORECASE)) and \
        bool(re.search(r"GLASS\s+REORDER", raw_text, re.IGNORECASE))


def _field(flat, label, next_labels):
    """Value after `label`, up to whichever of next_labels comes first."""
    stop = "|".join(re.escape(n) for n in next_labels)
    m = re.search(re.escape(label) + r"\s*(.*?)\s*(?=" + stop + r"|$)", flat, re.IGNORECASE)
    return m.group(1).strip() if m and m.group(1).strip() else None


def _parse_date(value):
    """'Wed 9/9/26' -> date(2026, 9, 9); None if it can't be read."""
    m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{2,4})", value or "")
    if not m:
        return None
    month, day, year = (int(g) for g in m.groups())
    if year < 100:
        year += 2000
    try:
        return datetime.date(year, month, day)
    except ValueError:
        return None


def parse_reorder_header(flat):
    """Header fields from the first page's header block (every page repeats it)."""
    first_page = re.split(r"UNIT#", flat, maxsplit=1)[0]

    job, project_name, jdm = gpp.parse_header(first_page)
    header = {
        "job": job, "project_name": project_name, "jdm": jdm,
        "target_ship_date": _field(first_page, "TARGET SHIP DATE:", ["REORDER", "ORDER DATE:"]),
        "order_date": _field(first_page, "ORDER DATE:", ["PURCHASE", "SALES REP:"]),
        "sales_rep": _field(first_page, "SALES REP:", ["PM:"]),
        "pm": _field(first_page, "PM:", ["REQUEST", "PROJECT NAME:"]),
        "unit_type": _field(first_page, "UNIT TYPE:", ["INFORMATION", "REASON FOR REORDER:"]),
        "reason": _field(first_page, "REASON FOR REORDER: DATE SUBMITTED",
                         ["SUBMITTAL SIGNATURE", "APPROVAL SIGNATURE"])
                  or _field(first_page, "REASON FOR REORDER:", ["DATE SUBMITTED", "SUBMITTAL SIGNATURE"]),
    }

    flags = []
    if not job:
        flags.append("PROJECT# not found on the form - Item Names will have no Job#, verify.")
    ship = _parse_date(header["target_ship_date"])
    ordered = _parse_date(header["order_date"])
    if ship and ordered and ordered > ship:
        flags.append(f"ORDER DATE ({header['order_date']}) is after TARGET SHIP DATE "
                     f"({header['target_ship_date']}) - one of them is probably a typo.")
    header["form_flags"] = flags
    return header


def parse_reorder_units(flat):
    body = PAGE_BREAK_RE.sub(" ", flat)
    units = []
    for m in UNIT_RE.finditer(body):
        units.append({
            "unit": m.group(1).strip(),
            "vendor": m.group(2).strip(),
            # No row-number column on this form, so no gpp.clean_glass_type()
            # -- it would strip the "366" off "CARDINAL 366".
            "type": m.group(3).strip(),
            "qty": int(m.group(4)),
            "dim": m.group(5).strip(),
            "oa": m.group(6).strip(),
            "spec": re.sub(r"\s+", " ", (m.group(7) or "").strip()),
        })
    return units


def parse_reorder_text(raw_text):
    """Same return shape as glass_pdf_parser.parse_glass_pdf(), plus
    form="reorder", the reorder-only header fields, and form_flags.

    Raises ValueError if no UNIT# blocks are found."""
    # "×" -> "X" so dimension splitting / flags / Item Names match the production doc.
    flat = gpp.flatten(raw_text.replace("×", "X"))

    header = parse_reorder_header(flat)
    raw_units = parse_reorder_units(flat)
    if not raw_units:
        raise ValueError("No UNIT# blocks were found on this glass reorder form.")

    units = []
    for u in raw_units:
        _parsed, spec_flags = gpp.parse_spec(u["spec"])
        units.append({
            **u,
            "name": gpp.item_name(header["job"], u["unit"] + REORDER_ITEM_SUFFIX, u["dim"]),
            "description": gpp.description(u["spec"], u["oa"]),
            "flags": gpp.dim_flags(u["dim"]) + spec_flags,
        })

    return {"form": "reorder", **header, "units": units}


def parse_reorder_pdf(path):
    return parse_reorder_text(gpp.extract_text(path))


if __name__ == "__main__":
    import json
    import sys

    for pdf_path in sys.argv[1:]:
        print(json.dumps(parse_reorder_pdf(pdf_path), indent=2))
