"""
glass_pdf_parser.py
====================
Parses a Panda Windows & Doors "Production Doc / Shop Drawing" glass
breakdown PDF into one entry per UNIT# block, each with a derived Item
Name / Description ready to become a QuickBooks Item.

This is the parsing core of panda_glass_to_excel.py (see the sibling
"Python Tools Non Web Based" repo for the original Excel-exporting CLI)
kept here as its own module so purchase_order_gui.py can use it directly
without depending on files outside this repo.

Notes on scope / how to extend -- carried over from the original tool:
  - THK 1, LITE 1, THK 2, LITE 2, SPC TYPE, SPC SIZE are parsed out of each
    unit's "BREAKDOWN:" spec text using SPEC_RE below, then the two lite
    descriptions are looked up in LITE1_MAP / LITE2_MAP.
  - Only glass types validated so far are auto-mapped: "CARDINAL 366 LOW-E
    TEMP" (-> T:Q366), "CLEAR TEMP" (-> T:CLEAR), "SATIN ETCHED[/#N]"
    (-> T:SATIN ETCH). Anything else is left blank and flagged in "flags"
    rather than guessed -- add new entries to LITE1_MAP / LITE2_MAP as new
    glass types show up.
  - This module intentionally has no price -- a production doc/shop
    drawing has no pricing on it. Price is entered by hand when reviewing
    the parsed rows before creating QuickBooks Items from them.
"""

import re

import pdfplumber

DIM_TOKEN = r'\d+(?:\s\d+/\d+)?[\"\']?'  # trailing " (or a typo apostrophe) optional

UNIT_RE = re.compile(
    r"UNIT#\s*([\d.,\s-]+?)\s*VENDOR:\s*(.*?)\s*-\s*TYPE:\s*(.*?)\s*"
    r"QTY:\s*(\d+)\s*-\s*OVERALL DIM\.:\s*(.+?)\s*-\s*OA:\s*(" + DIM_TOKEN + r")"
    r"(?:\s*BREAKDOWN:\s*(.*?))?(?=UNIT#|GREEN COPY|$)",
    re.IGNORECASE | re.DOTALL,
)

# Confirmed mappings only -- see module docstring for how to extend these.
LITE1_MAP = {
    "CARDINAL 366 LOW-E TEMP": "T:Q366",
}
LITE2_MAP = {
    "CLEAR TEMP": "T:CLEAR",
    "SATIN ETCHED": "T:SATIN ETCH",
}

SPEC_RE = re.compile(
    r'(?P<thk1>\d+/\d+)"\s*(?P<lite1>.+?)\s*\+\s*'
    r'(?P<spc>\d+/\d+)"\s*(?P<spc_color>[A-Z]+)\s+ALUMINUM SPACER\s*'
    r'(?:w/\s*BREA[TH]+ER TUBES)?\s*'
    r'(?:\+\s*SHADOW BARS\s*\((?P<shadow1>[^)]+)\)\s*(?:w/\s*BUMP ON\s*\((?P<bump1>[^)]+)\))?)?\s*'
    r'\+\s*(?P<thk2>\d+/\d+)"\s*'
    r'(?P<lite2>[A-Z0-9 #]+?)'
    r'(?:\s*w/\s*SHADOW BARS\s*\(\s*(?:M[- ]?CODE)?[- ]?\s*(?P<shadow2>[\w-]+)\s*\))?'
    r'\s*$',
    re.IGNORECASE,
)


def extract_text(path):
    pages = []
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            pages.append(page.extract_text() or "")
    return "\n".join(pages)


def flatten(text):
    return re.sub(r"\s+", " ", text).strip()


def parse_header(flat):
    job_m = re.search(r"PROJECT#:.*?(\d{4,7})\b", flat)
    job = job_m.group(1) if job_m else None

    name_m = re.search(r"PROJECT NAME:\s*JDM:\s*PROJECT#:\s*(.*?)\s+(\S+)\s+(\d{4,7})\b", flat)
    project_name = name_m.group(1).strip() if name_m else None
    jdm = name_m.group(2) if name_m else None

    return job, project_name, jdm


def clean_glass_type(type_str):
    """Strip a stray trailing row-number that sometimes bleeds into this
    field from the PDF's row-number column sitting on the same line."""
    return re.sub(r"\s+\d+$", "", type_str).strip()


def parse_units(flat):
    items = []
    for m in UNIT_RE.finditer(flat):
        items.append({
            "unit": m.group(1).strip(),
            "vendor": m.group(2).strip(),
            "type": clean_glass_type(m.group(3)),
            "qty": int(m.group(4)),
            "dim": m.group(5).strip(),
            "oa": m.group(6).strip(),
            "spec": re.sub(r"\s+", " ", (m.group(7) or "").strip()),
        })
    return items


def resolve_lite(text, mapping):
    key = re.sub(r"\s+", " ", text.strip().upper())
    if key in mapping:
        return mapping[key], None
    # Tolerate a trailing "#4"-style suffix (e.g. "SATIN ETCHED #4")
    base_key = re.sub(r"\s*#\d+$", "", key).strip()
    if base_key in mapping:
        return mapping[base_key], None
    return None, f"code not mapped for '{text.strip()}'"


def parse_spec(spec):
    """Returns (parsed_dict_or_None, list_of_flag_strings)."""
    m = SPEC_RE.search(spec)
    if not m:
        return None, ["spec breakdown did not match the expected pattern - THK/LITE/SPC columns left blank, verify manually"]

    flags = []

    lite1_code, err1 = resolve_lite(m.group("lite1"), LITE1_MAP)
    if err1:
        flags.append(f"LITE 1 {err1}")

    lite2_code, err2 = resolve_lite(m.group("lite2"), LITE2_MAP)
    if err2:
        flags.append(f"LITE 2 {err2}")

    spc_color = m.group("spc_color").strip().upper()
    if spc_color == "BLACK":
        spc_type = "BLACK SS"
    else:
        spc_type = f"{spc_color} ALUMINUM SPACER"
        flags.append(f"SPC TYPE code not confirmed for spacer color '{spc_color}' - verify")

    shadow = m.group("shadow1") or m.group("shadow2")
    bump = m.group("bump1")
    if shadow:
        note = f"SHADOW BARS ({shadow})" + (f" w/ BUMP ON ({bump})" if bump else "")
        flags.append(note)

    parsed = {
        "thk1": m.group("thk1"),
        "lite1": lite1_code or "",
        "thk2": m.group("thk2"),
        "lite2": lite2_code or "",
        "spc_type": spc_type,
        "spc_size": m.group("spc"),
        "shadow_code": shadow or "",
        "bump_code": bump or "",
    }
    return parsed, flags


def dim_flags(dim):
    flags = []
    if not re.search(r"X", dim, re.IGNORECASE):
        flags.append('source doc is missing the "X" between width/height - verify dimension')
    if dim.rstrip().endswith("'"):
        flags.append("source doc ends this dimension with ' instead of \" - verify with Panda")
    return flags


def item_name(job, unit, dim):
    dim_lower_x = re.sub(r"\s*X\s*", " x ", dim, flags=re.IGNORECASE)
    return f'{dim_lower_x} (Job# {job} Unit# {unit})'


def description(spec, oa):
    return f"{spec} OA: {oa}".strip()


def parse_glass_pdf(path):
    """Parse a Production Doc / Shop Drawing PDF.

    Returns {"job", "project_name", "jdm", "units": [...]}, where each unit
    dict has: unit, qty, dim, oa, vendor, type, spec, name, description,
    flags (list of strings -- non-empty means "review before creating").

    Raises ValueError if no UNIT# blocks are found (wrong kind of PDF).
    """
    raw_text = extract_text(path)
    flat = flatten(raw_text)

    job, project_name, jdm = parse_header(flat)
    raw_units = parse_units(flat)
    if not raw_units:
        raise ValueError("No UNIT# blocks were found in this PDF. Is this a Panda production doc / shop drawing?")

    units = []
    for u in raw_units:
        _parsed, spec_flags = parse_spec(u["spec"])
        flags = dim_flags(u["dim"]) + spec_flags
        units.append({
            **u,
            "name": item_name(job, u["unit"], u["dim"]),
            "description": description(u["spec"], u["oa"]),
            "flags": flags,
        })

    return {"job": job, "project_name": project_name, "jdm": jdm, "units": units}
