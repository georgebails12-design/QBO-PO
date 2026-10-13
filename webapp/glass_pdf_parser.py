"""
glass_pdf_parser.py
====================
Parses a Panda Windows & Doors green-copy glass sheet (or glass reorder
form) PDF into one entry per UNIT# block, each with a derived Item Name /
Description ready to become a QuickBooks Item, plus the THK/LITE/SPC
breakdown cardinal_glass_output.py needs for the Cardinal CSV.

This follows the "Glass Sheet -> Cardinal PO" browser tool's parser, which
was checked against jobs 4500839966, 223380, 91457, 91683, 90548, 88948 and
92605. Documents handled:
  - Green copy, Windsor / All Weather style (mixed case, order line #s,
    logo special notes)
  - Green copy, production style (all caps, capital "X" in sizes,
    "RESIDENTIAL" banner, blank trailing pages)
  - Glass reorder form ("VENDOR: CARDINAL TYPE:" with no dash, no Delivery
    Date row, "GLASS REORDER ISSUE" footer, reason for reorder)

How it reads the PDF:
  - Words are regrouped into lines by their position on the page (top to
    bottom, left to right) -- the raw text order on these forms is
    scrambled, so this matters.
  - Units are collected per page from the first line starting "UNIT#" up to
    the page footer ("GREEN COPY", "GLASS REORDER", "PAGE n OF"), then
    split on "UNIT# ... VENDOR:".

PO line format (one per unit):
  Item name:   {W}" x {H}" (Job# {Project#} Unit# {Unit})
  Description: {makeup} (Order Line #{...}) OA: {OA}
with "(see drawing)" dropped, fractions reduced (29 4/16" -> 29 1/4"),
`1/4"CLEAR` -> `1/4" CLEAR`, `+1/4"` -> `+ 1/4"`, and spaces removed from
unit numbers ("5. A1,C1" -> "5.A1,C1").

Lite codes for the Cardinal CSV: only glass types validated so far are
auto-mapped (LITE1_MAP / LITE2_MAP). Anything else is left blank and
flagged rather than guessed -- add new entries as new glass types show up.

This module has no prices -- a glass sheet has none. Price is entered by
hand when reviewing the parsed rows before creating QuickBooks Items.
"""

import datetime
import math
import re

import pdfplumber

# Confirmed mappings only -- see module docstring for how to extend these.
LITE1_MAP = {
    "CARDINAL 366 LOW-E TEMP": "T:Q366",
    "SATIN ETCH TEMPERED": "T:SATIN ETCH",
    "SATIN ETCH TEMP": "T:SATIN ETCH",
}
LITE2_MAP = {
    "CLEAR TEMP": "T:CLEAR",
    "SATIN ETCHED": "T:SATIN ETCH",
    "I89 TEMP": "T:I89",
}

MAX_GLASS_INCHES = 144  # Cardinal's longest tempered side (Bulletin IG23)
FRACTION_DENOMINATORS = {2, 4, 8, 16, 32, 64}

LINE_Y_TOLERANCE = 3     # points; words this close vertically share a line
CELL_GAP = 6             # points; a wider gap between words starts a new cell


# ---------------------------------------------------------------------------
# PDF -> lines
# ---------------------------------------------------------------------------
class Line:
    def __init__(self, page, y, words):
        self.page = page
        self.y = y
        self.words = words  # [(x0, x1, text)], sorted left to right

    @property
    def text(self):
        return " ".join(w[2] for w in self.words)

    def cells(self):
        """Words grouped into cells wherever the horizontal gap is wide --
        e.g. the project-name / JDM / project# row under the header."""
        out, cur, last_x1 = [], [], None
        for x0, x1, text in self.words:
            if cur and x0 - last_x1 > CELL_GAP:
                out.append(" ".join(cur))
                cur = []
            cur.append(text)
            last_x1 = x1
        if cur:
            out.append(" ".join(cur))
        return out


def group_lines(words):
    """words: [{"page", "x0", "x1", "bottom", "text"}] -> [Line], in reading
    order (page, top to bottom, left to right)."""
    words = sorted((w for w in words if w["text"].strip()),
                   key=lambda w: (w["page"], w["bottom"], w["x0"]))
    lines = []
    for w in words:
        last = lines[-1] if lines else None
        if last and last.page == w["page"] and abs(last.y - w["bottom"]) < LINE_Y_TOLERANCE:
            last.words.append((w["x0"], w["x1"], w["text"]))
        else:
            lines.append(Line(w["page"], w["bottom"], [(w["x0"], w["x1"], w["text"])]))
    for line in lines:
        line.words.sort(key=lambda t: t[0])
    return lines


def extract_lines(path):
    words = []
    with pdfplumber.open(path) as pdf:
        for page_no, page in enumerate(pdf.pages, start=1):
            for w in page.extract_words():
                words.append({"page": page_no, "x0": w["x0"], "x1": w["x1"],
                              "bottom": w["bottom"], "text": w["text"]})
    return group_lines(words)


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------
def norm(s):
    return re.sub(r"\s+", " ", s or "").strip()


def _key(s):
    return re.sub(r'\s*"\s*', '"', norm(s)).lower()


def fix_fraction(raw, flags=None, label=""):
    """'29 4/16' -> '29 1/4' (adding a flag when it had to reduce)."""
    t = norm(raw)
    m = re.match(r"^(\d+)(?:\s+(\d+)/(\d+))?$|^(\d+)/(\d+)$", t)
    if not m:
        return t
    whole = m.group(1) or "0"
    n = int(m.group(2) or m.group(4) or 0)
    d = int(m.group(3) or m.group(5) or 1)
    if m.group(4) and n >= d:
        # "571/16" -- the space between the inches and the fraction was lost
        # (scans). Accept it only if exactly one split makes sense.
        digits = m.group(4)
        splits = [(digits[:k], int(digits[k:])) for k in range(1, len(digits))
                  if not digits[k:].startswith("0") and int(digits[k:]) < d and int(digits[:k]) <= MAX_GLASS_INCHES]
        if len(splits) == 1 and d in FRACTION_DENOMINATORS:
            whole, n = splits[0]
            if flags is not None:
                flags.append(f'{label} read as "{t}" -- taken as {whole} {n}/{d}"; check against the paper')
        else:
            if flags is not None:
                flags.append(f'{label} "{t}" can\'t be a real size -- check against the paper and fix the item name')
            return t
    if not n:
        return whole
    k = math.gcd(n, d)
    out = (f"{whole} " if whole != "0" else "") + f"{n // k}/{d // k}"
    if k > 1 and flags is not None:
        flags.append(f'{label} written as {t}" on the sheet -- that\'s {out}"')
    return out


def _parse_date(s):
    m = re.search(r"(\d{1,2})/(\d{1,2})/(\d{2,4})", s or "")
    if not m:
        return None
    y = int(m.group(3))
    if y < 100:
        y += 2000
    try:
        return datetime.date(y, int(m.group(1)), int(m.group(2)))
    except ValueError:
        return None


def clean_glass_type(type_str):
    """Strip a stray trailing row-number that sometimes bleeds into this
    field from the PDF's row-number column sitting on the same line."""
    return re.sub(r"\s+\d+$", "", type_str).strip()


def clean_makeup(breakdown):
    """Glass makeup text for the description / Cardinal breakdown: order
    line and "(see drawing)" removed, spacing around inch marks and "+"
    normalized."""
    s = re.sub(r"\(Order Line #[^)]+\)", "", breakdown)
    s = re.sub(r"\(see drawing\)", "", s, flags=re.IGNORECASE)
    s = re.sub(r'"(?=[A-Za-z])', '" ', s)
    s = re.sub(r"\s*\+\s*", " + ", s)
    # Stray punctuation from marks next to the last word (mostly on scans).
    s = re.sub(r"[\s.,;:'`~»«“”]+$", "", s)
    return norm(s)


# ---------------------------------------------------------------------------
# Sheet parsing
# ---------------------------------------------------------------------------
UNIT_FOOTER_RE = re.compile(r"^(GREEN COPY|GLASS REORDER|PAGE \d+ OF)", re.IGNORECASE)


def parse_sheet(lines):
    """Parse grouped lines from a glass sheet / reorder form."""
    txt = [ln.text for ln in lines]
    all_text = "\n".join(txt)

    def find_date(label):
        """Value after "{label}:", stopping at the next "SOME LABEL:" on the
        same line (order and ship dates can share a row)."""
        m = re.search(label + r":\s*(.*?)(?=\s+[A-Z][A-Z ]*[A-Z]:|$)", all_text, re.MULTILINE)
        return norm(m.group(1)) if m else ""

    # Header: the row under "PROJECT NAME: ... JDM: ... PROJECT#:" holds the
    # name, JDM and project # as separate cells.
    project, job_name, jdm = "", "", ""
    hi = next((i for i, t in enumerate(txt) if "PROJECT NAME:" in t and "PROJECT#:" in t), -1)
    if hi >= 0 and hi + 1 < len(lines):
        row = lines[hi + 1]
        cells = row.cells()
        if cells:
            job_name = norm(cells[0])
            project = norm(cells[-1])
            if len(cells) >= 3:
                jdm = norm(cells[1])
        if not re.fullmatch(r"\d+", project):
            m = re.search(r"(\d{4,})\s*$", row.text)
            if m:
                project = m.group(1)
                job_name = norm(row.text[:m.start()])

    sheet = {
        "project": project, "job_name": job_name, "jdm": jdm,
        "unit_type": "", "logo": "", "special": "",
        "ship_date": find_date("TARGET SHIP DATE"),
        "order_date": find_date("ORDER DATE"),
        "reorder": False, "reason": "", "flags": [], "units": [],
    }

    ut = next((i for i, t in enumerate(txt) if t.startswith("UNIT TYPE:")), -1)
    if ut >= 0:
        for t in txt[ut + 1:ut + 4]:
            if re.match(r"^TS|^[A-Z]{1,4}\.?\d", t):
                sheet["unit_type"] = t
                break

    sn = next((i for i, t in enumerate(txt) if t.startswith("SPECIAL NOTES:")), -1)
    if sn >= 0:
        note = txt[sn + 1] if sn + 1 < len(txt) else ""
        if not note.startswith("TASK"):
            sheet["special"] = norm(note)
        m = re.search(r"Use\s+(.+?)\s+Logo", note, re.IGNORECASE)
        if m:
            sheet["logo"] = m.group(1)

    # Units: per page, from the first UNIT# line to the page footer.
    body, on, page = [], False, None
    for ln, t in zip(lines, txt):
        if ln.page != page:
            page, on = ln.page, False
        if t.startswith("UNIT#"):
            on = True
        if UNIT_FOOTER_RE.match(t):
            on = False
            continue
        if on:
            body.append(t)
    chunks = [c for c in re.split(r"(?=UNIT#[^\n]*?VENDOR:)", "\n".join(body)) if c.startswith("UNIT#")]

    for chunk in chunks:
        flat = norm(chunk)
        flags = []

        def grab(pattern, default=""):
            m = re.search(pattern, flat)
            return norm(m.group(1)) if m else default

        raw_unit = grab(r"UNIT#\s*(.+?)\s+VENDOR:")
        unit = re.sub(r"\s+", "", raw_unit).rstrip(".,")
        qty = int(grab(r"QTY:\s*(\d+)", "0"))
        oa = grab(r'OA:\s*([^-]+?")')
        if oa:
            oa = fix_fraction(oa.rstrip('"'), flags, "OA") + '"'

        w = h = ""
        d = re.search(r'OVERALL DIM\.?:\s*([\d\s/]+?)\s*("?)\s*[xX×]\s*([\d\s/]+?)\s*"', flat)
        if d:
            w = fix_fraction(d.group(1), flags, "Width")
            h = fix_fraction(d.group(3), flags, "Height")
            if not d.group(2):
                flags.append(f"Sheet is missing the inch mark after the width ({norm(d.group(1))})")
        elif re.search(r"OVERALL DIM\.?:\s*SHAPED", flat, re.IGNORECASE):
            flags.append("Shaped glass -- no overall size on the sheet; take it from the shop drawing details "
                         "and fix the item name before creating it")
        else:
            flags.append("Could not read the overall size on the sheet")

        breakdown = flat.split("BREAKDOWN:", 1)[1].strip() if "BREAKDOWN:" in flat else ""
        m = re.search(r"\(Order Line #([^)]+)\)", breakdown)
        order_line = m.group(1) if m else ""
        if raw_unit != unit:
            flags.append(f'Unit# written as "{raw_unit}" on the sheet')

        sheet["units"].append({
            "unit": unit, "raw_unit": raw_unit, "qty": qty,
            "w": w, "h": h, "dim": f'{w}" x {h}"' if d else "",
            "oa": oa, "order_line": order_line,
            "makeup": clean_makeup(breakdown),
            "vendor": grab(r"VENDOR:\s*(.+?)\s+-?\s*TYPE:"),
            "type": clean_glass_type(grab(r"TYPE:\s*(.+?)\s+QTY:")),
            "flags": flags,
        })

    # Reorder form + sheet-level checks
    if re.search(r"REASON FOR REORDER", all_text, re.IGNORECASE):
        sheet["reorder"] = True
        ri = next((i for i, t in enumerate(txt) if re.match(r"REASON FOR REORDER", t, re.IGNORECASE)), -1)
        reason = txt[ri + 1] if 0 <= ri < len(txt) - 1 else ""
        sheet["reason"] = "" if re.search(r"SIGNATURE|^UNIT#", reason) else norm(reason)

    od, sd = _parse_date(sheet["order_date"]), _parse_date(sheet["ship_date"])
    if od and sd and od > sd:
        sheet["flags"].append(
            f"Order date ({sheet['order_date']}) is after the target ship date "
            f"({sheet['ship_date']}) -- probably a typo on the sheet.")

    seen = {}
    for u in sheet["units"]:
        m = re.match(r"^0*(\d+)", u["unit"])
        base = m.group(1) if m else u["unit"]
        k = (base, u["w"], u["h"], u["qty"], _key(u["makeup"]))
        if k in seen:
            u["flags"].append(f"Same size, qty and makeup as Unit# {seen[k]} -- looks like the same unit entered twice")
        else:
            seen[k] = u["unit"]

    return sheet


# ---------------------------------------------------------------------------
# Makeup -> Cardinal THK / LITE / SPC breakdown
# ---------------------------------------------------------------------------
def resolve_lite(text, mapping):
    # "(SURFACE 2 &3)" says which face is etched; it isn't part of the glass
    # name Cardinal codes are keyed on.
    key = re.sub(r"\(\s*SURFACES?\b[^)]*\)", " ", text.upper())
    key = re.sub(r"\s+", " ", key).strip()
    if key in mapping:
        return mapping[key], None
    # Tolerate a trailing "#4"-style suffix (e.g. "SATIN ETCHED #4")
    base_key = re.sub(r"\s*#\d+$", "", key).strip()
    if base_key in mapping:
        return mapping[base_key], None
    return None, f"code not mapped for '{text.strip()}'"


PLY_RE = re.compile(r'^(?P<thk>\d+/\d+)"\s*(?P<lite>.+)$')
SPACER_RE = re.compile(r'^(?P<size>\d+/\d+)"\s*(?P<color>[A-Z]+)\s+(?:ALUMINUM\s+)?SPACER\b(?P<rest>.*)$', re.IGNORECASE)
SHADOW_RE = re.compile(r"SHADOW BARS\s*\(\s*(?:M[- ]?CODE)?[\s:-]*([^)]+?)\s*\)", re.IGNORECASE)
BUMP_RE = re.compile(r"BUMP ON\s*(?:\(([^)]+)\)|(\w+))", re.IGNORECASE)


def parse_spec(spec):
    """Split a 2-lite IG makeup ("{thk}\" {lite} + {spacer} + {thk}\" {lite}")
    into the Cardinal columns. Returns (parsed_dict_or_None, flags)."""
    parts = [p.strip() for p in (spec or "").split("+") if p.strip()]
    # Older sheets write shadow bars as their own "+ SHADOW BARS (...)" term
    # after the spacer -- fold those back into the spacer.
    merged = []
    for p in parts:
        if merged and re.match(r"SHADOW BARS", p, re.IGNORECASE):
            merged[-1] += " " + p
        else:
            merged.append(p)
    if len(merged) != 3:
        kind = "single-lite (monolithic)" if len(merged) == 1 else f"{len(merged)}-part"
        return None, [f"{kind} makeup -- not a 2-lite IG unit, so no Cardinal CSV line is built; verify manually"]

    p1, sp, p2 = (PLY_RE.match(merged[0]), SPACER_RE.match(merged[1]), PLY_RE.match(merged[2]))
    if not (p1 and sp and p2):
        return None, ["glass makeup did not match the expected pattern - THK/LITE/SPC columns left blank, verify manually"]

    flags = []
    lite1_text = p1.group("lite")
    lite2_text = p2.group("lite")

    shadow = SHADOW_RE.search(sp.group("rest")) or SHADOW_RE.search(lite2_text)
    bump = BUMP_RE.search(sp.group("rest")) or BUMP_RE.search(lite2_text)
    lite2_text = BUMP_RE.sub("", SHADOW_RE.sub("", lite2_text))
    lite2_text = re.sub(r"\bw/\s*$", "", lite2_text.strip(), flags=re.IGNORECASE)
    # A trailing "(99)"-style code after the lite isn't part of its name.
    m = re.search(r"\s*\(([^)]*)\)\s*$", lite2_text)
    if m:
        flags.append(f"LITE 2 has '({m.group(1)})' after it on the sheet -- not sent to Cardinal, verify")
        lite2_text = lite2_text[:m.start()]

    lite1_code, err1 = resolve_lite(lite1_text, LITE1_MAP)
    if err1:
        flags.append(f"LITE 1 {err1}")
    lite2_code, err2 = resolve_lite(lite2_text, LITE2_MAP)
    if err2:
        flags.append(f"LITE 2 {err2}")

    spc_color = sp.group("color").upper()
    if spc_color == "BLACK":
        spc_type = "BLACK SS"
    else:
        spc_type = f"{spc_color} ALUMINUM SPACER"
        flags.append(f"SPC TYPE code not confirmed for spacer color '{spc_color}' - verify")
    if re.search(r"ARGON", sp.group("rest"), re.IGNORECASE):
        flags.append("Argon fill on the sheet -- confirm it's on the Cardinal order")
    if shadow:
        flags.append(f"SHADOW BARS ({shadow.group(1)})" + (f" w/ BUMP ON ({bump.group(1) or bump.group(2)})" if bump else ""))

    return {
        "thk1": p1.group("thk"),
        "lite1": lite1_code or "",
        "thk2": p2.group("thk"),
        "lite2": lite2_code or "",
        "spc_type": spc_type,
        "spc_size": sp.group("size"),
        "shadow_code": shadow.group(1) if shadow else "",
        "bump_code": (bump.group(1) or bump.group(2)) if bump else "",
    }, flags


# ---------------------------------------------------------------------------
# Item name / description
# ---------------------------------------------------------------------------
def item_name(job, unit, w, h):
    size = f'{w}" x {h}"' if w and h else "SHAPED GLASS - SIZE?"
    return f'{size} (Job# {job} Unit# {unit})'


def description(makeup, order_line, oa, include_order_line=True):
    d = makeup
    if include_order_line and order_line:
        d += f" (Order Line #{order_line})"
    if oa:
        d += f" OA: {oa}"
    return d.strip()


def build_result(sheet):
    units = []
    for u in sheet["units"]:
        _parsed, spec_flags = parse_spec(u["makeup"])
        units.append({
            "unit": u["unit"],
            "qty": u["qty"],
            "dim": u["dim"],
            "oa": u["oa"],
            "vendor": u["vendor"],
            "type": u["type"],
            "spec": u["makeup"],
            "order_line": u["order_line"],
            "name": item_name(sheet["project"], u["unit"], u["w"], u["h"]),
            "description": description(u["makeup"], u["order_line"], u["oa"]),
            "flags": u["flags"] + spec_flags,
        })
    return {
        "job": sheet["project"] or None,
        "project_name": sheet["job_name"] or None,
        "jdm": sheet["jdm"] or None,
        "unit_type": sheet["unit_type"],
        "ship_date": sheet["ship_date"],
        "logo": sheet["logo"],
        "reorder": sheet["reorder"],
        "reorder_reason": sheet["reason"],
        "sheet_flags": sheet["flags"],
        "units": units,
    }


def is_scanned(path):
    """True for copier scans: every page is one full-page picture. Some
    copiers add their own (often garbled) hidden text layer to the picture,
    so text being present doesn't mean it's a system-generated PDF."""
    saw_scan_page = False
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            area = page.width * page.height
            covered = max(((im["x1"] - im["x0"]) * (im["bottom"] - im["top"]) for im in page.images), default=0)
            if covered >= 0.9 * area:
                saw_scan_page = True
            elif page.chars:
                return False  # real text on a page that isn't a picture
    return saw_scan_page


def parse_glass_pdf(path):
    """Parse a green-copy glass sheet / glass reorder form PDF.

    Returns {"job", "project_name", "jdm", "unit_type", "ship_date", "logo",
    "reorder", "reorder_reason", "sheet_flags", "units": [...]}, where each
    unit dict has: unit, qty, dim, oa, vendor, type, spec, order_line, name,
    description, flags (list of strings -- non-empty means "review before
    creating").

    Raises ValueError if no UNIT# blocks are found (wrong kind of PDF).
    """
    scanned = is_scanned(path)
    rapid_pages = None
    if scanned:
        import glass_ocr
        try:
            lines, rapid_pages = glass_ocr.read_scanned_pdf(path)
        except glass_ocr.OCRUnavailable as exc:
            raise ValueError(f"This PDF is a scan, and scan reading isn't set up on the server: {exc}")
    else:
        lines = extract_lines(path)
    all_text = "\n".join(ln.text for ln in lines)
    if not (re.search(r"OVERALL DIM\.?:", all_text, re.IGNORECASE) and "UNIT#" in all_text):
        raise ValueError(
            "This doesn't look like a glass sheet -- no UNIT# / OVERALL DIM. found."
            + (" The scan may be too faint or crooked to read; try rescanning it straight, or use the "
               "system-generated PDF." if scanned else ""))
    sheet = parse_sheet(lines)
    if not sheet["units"]:
        raise ValueError("No UNIT# blocks could be read from this PDF. Send it over so the parser can be updated.")
    if scanned:
        import glass_ocr
        header = glass_ocr.header_from_rapid(rapid_pages)
        if header["project"] and not re.fullmatch(r"\d{4,}", sheet["project"] or ""):
            sheet["project"] = header["project"]
            sheet["job_name"] = header["job_name"] or sheet["job_name"]
            sheet["jdm"] = header["jdm"] or sheet["jdm"]
        elif header["project"] and header["project"] != sheet["project"]:
            sheet["flags"].append(f"Project # unclear on the scan (read as {sheet['project']} and "
                                  f"{header['project']}) -- check it against the paper")
        if not re.fullmatch(r"\d{4,}", sheet["project"] or ""):
            sheet["flags"].append("Couldn't read the project # from the scan -- fix the Job# in each item name")
        glass_ocr.cross_check_units(sheet["units"], rapid_pages, sheet["flags"])
        for u in sheet["units"]:
            u["flags"].insert(0, glass_ocr.SCAN_FLAG)
    result = build_result(sheet)
    result["scanned"] = scanned
    return result
