"""
Cardinal Glass Output

Converts a filled-in Panda glass Reorder Form into the CSV format Cardinal's
ordering system expects. Supports both single-unit orders (Order) and
multi-unit POs covering many units under one job (Batch), and flags the
recurring data-quality issues found across real orders: filename/PO
mismatches, missing JOB # columns, dropped-digit dimensions, unit-label
typos on grouped sub-units, unrecognized logo codes, mismatched spacer
sizes, and -- new -- unit sizes that exceed Cardinal's own published
Size Limit Guidelines for that glass thickness.

USAGE
-----
Single unit:
    from cardinal_glass_output import Order, Ply, generate_csv
    order = Order(po_number=..., job_number=..., unit_number=..., qty=...,
                   overall_thickness=..., plies=[Ply(...), Ply(...)],
                   spacer_type="BLACK SS", spacer_size=...,
                   width=..., height=...)
    generate_csv(order)

Multiple units under one PO (e.g. a whole job's worth of glass):
    from cardinal_glass_output import Batch, LineItem, Ply, GridBars, generate_batch_csv
    batch = Batch(po_number=..., job_number=..., items=[LineItem(...), ...])
    generate_batch_csv(batch)

Or just run this file directly to regenerate the reference examples:

    python3 cardinal_glass_output.py

Each order/batch produces one CSV in ./output/, named after the PO number.
"""

import csv
import datetime
import os
import re
import warnings
from dataclasses import dataclass, field
from typing import List, Optional, Tuple

# ---------------------------------------------------------------------------
# Glass type codes -> Cardinal's short codes (extend as new products appear)
# ---------------------------------------------------------------------------
GLASS_CODES = {
    "366": "Q366",
    "180": "Q180",
    "i89": "I89",
    "I89": "I89",
    "CLEAR": "CLEAR",
}

EXCEL_EPOCH = datetime.date(1899, 12, 30)


# ---------------------------------------------------------------------------
# Cardinal Size Limit Guidelines (Technical Service Bulletin #IG23, 04/2024)
# and Glass Thickness Nomenclature (Cardinal Technical Glass Guide, Figure
# 42-1) -- both from cardinalcorp.com. Only the nominal thicknesses Cardinal
# itself explicitly maps to a metric row are included here; a ply whose
# thickness isn't a key below has NO confirmed Cardinal limit to check
# against (notably 3/8" and up -- see check_size_limits()).
#
# Columns, all from Bulletin IG23:
#   annealed_max_sqft, annealed_max_length_in,
#   hs_max_sqft,
#   tempered_max_sqft, hs_temp_max_length_in, max_short_side_temp_in
# ---------------------------------------------------------------------------
SIZE_LIMIT_GUIDELINES = {
    # thickness -> (mm, annealed_max_sqft, annealed_max_len_in, hs_max_sqft,
    #               tempered_max_sqft, hs_temp_max_len_in, max_short_side_temp_in)
    "1/8": (3.0, 15, 80, 20, 20, 80, 36),
    "5/32": (3.9, 24, 90, 30, 30, 90, 48),
    "3/16": (4.7, 33, 100, 50, 50, 120, 60),
    "1/4": (5.7, 50, 120, 60, 60, 144, 72),
}


def check_size_limits(ply: "Ply", width_in: float, height_in: float) -> List[str]:
    """Checks one ply's thickness/size against Cardinal's published Size
    Limit Guidelines (Bulletin #IG23, 04/2024). Returns a list of flag
    strings -- empty if within limits, or if we have no confirmed Cardinal
    data for this thickness (in which case a single "verify manually" flag
    is returned instead of silently passing or silently failing)."""
    row = SIZE_LIMIT_GUIDELINES.get(ply.thickness)
    if row is None:
        return [
            f'No published Cardinal size limit for {ply.thickness}" glass -- '
            "verify manually against Cardinal's Size Limit Guidelines (Bulletin IG23) before ordering."
        ]

    _mm, ann_sqft, ann_len, hs_sqft, temp_sqft, hs_temp_len, short_side_temp = row
    sq_ft = (width_in * height_in) / 144.0
    max_side = max(width_in, height_in)
    min_side = min(width_in, height_in)

    flags = []
    if ply.tempered:
        if temp_sqft is None:
            flags.append(f'{ply.thickness}" glass has no tempered rating per Cardinal Bulletin IG23 -- use annealed or a different thickness.')
        elif sq_ft > temp_sqft:
            flags.append(f'{ply.thickness}" tempered lite is {sq_ft:.1f} sq ft, over Cardinal\'s {temp_sqft} sq ft max (Bulletin IG23).')
        if max_side > hs_temp_len:
            flags.append(f'{ply.thickness}" tempered lite\'s longest side is {max_side:.2f}", over Cardinal\'s {hs_temp_len}" max length (Bulletin IG23).')
        if min_side > short_side_temp:
            flags.append(f'{ply.thickness}" tempered lite\'s short side is {min_side:.2f}", over Cardinal\'s {short_side_temp}" max short-side dimension (Bulletin IG23).')
    else:
        if sq_ft > ann_sqft:
            flags.append(f'{ply.thickness}" annealed lite is {sq_ft:.1f} sq ft, over Cardinal\'s {ann_sqft} sq ft max (Bulletin IG23).')
        if max_side > ann_len:
            flags.append(f'{ply.thickness}" annealed lite\'s longest side is {max_side:.2f}", over Cardinal\'s {ann_len}" max length (Bulletin IG23).')

    return flags


@dataclass
class Ply:
    """One glass ply in the makeup, e.g. 3/16" Cardinal 366 Low-E Temp."""
    thickness: str            # e.g. "3/16", "1/4", "3/8"
    glass_type: str = ""      # key into GLASS_CODES, e.g. "366", "i89", "CLEAR" -- ignored if `code` is set
    tempered: bool = True     # almost always True in the samples seen
    code: Optional[str] = None  # precomputed final lite code (e.g. "T:Q366") -- overrides glass_type/tempered lookup


@dataclass
class GridBars:
    """Shadow-bar / grid config. axis='width' divides BASE (-> # WIDE +
    HORZ BAR POS columns); axis='height' divides LEFT (-> # HIGH + VERT BAR
    POS columns). Positions are computed as equal divisions unless given
    explicitly. This mirrors the pattern found in every shadow-bar row of
    31036.csv (e.g. a bar at the midpoint for 1 bar, thirds for 2 bars...)."""
    axis: str                       # "width" or "height"
    count: int                      # number of bars (creates count+1 panes)
    m_code: str = "1790"            # shadow bar code, from "SHADOW BARS (1790)"
    bump_on: str = "99"             # from "BUMP ON (99)"
    grid_style: str = "COLONIAL STANDARD"
    ig_bar_code: str = "BI"
    positions: Optional[List[float]] = None  # override auto equal-division


@dataclass
class LineItem:
    """One unit/line within a Batch (one PO can cover many units)."""
    unit_number: str                   # e.g. "Unit# 8" or "17.1,3" (range shorthand)
    qty: int
    overall_thickness: str
    plies: List[Ply]
    width: str
    height: str
    grid: Optional[GridBars] = None
    spacer_size: Optional[str] = None  # auto-computed from OA - THK1 - THK2 if omitted


@dataclass
class Batch:
    """Multiple line items under one PO — the common real-world shape seen
    in 31036.csv (61 units, one PO, incrementing PO LINE)."""
    po_number: str
    job_number: Optional[str]
    items: List[LineItem]
    logo: str = "PANDA"
    request_date: Optional[datetime.date] = None
    date_format: str = "mdy"           # "mdy" -> 9/22/2026, "serial" -> Excel serial
    spacer_type: str = "BLACK SS"


@dataclass
class Order:
    """Mirrors the fields on the Panda Glass Reorder Form / PO."""
    po_number: str
    job_number: Optional[str]          # PROJECT# on the reorder form
    unit_number: str                   # e.g. "Unit# 8"
    qty: int
    overall_thickness: str             # OA:, e.g. '1 3/16"'
    plies: List[Ply]                   # 2 or 3 plies, outer-to-outer
    spacer_type: str                   # e.g. "BLACK SS"
    spacer_size: str                   # e.g. "5/8", "11/16"
    width: str                         # e.g. '61 1/4"'
    height: str                        # e.g. '95 1/2"'
    logo: str = "PANDA"                # default per-plant logo; override per job
    breather_tubes: bool = False
    request_date: Optional[datetime.date] = None  # defaults to today
    po_line: int = 1


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _to_float(dim_piece: str) -> float:
    """'1/2' -> 0.5, '3/4' -> 0.75, '' -> 0.0"""
    dim_piece = dim_piece.strip()
    if not dim_piece:
        return 0.0
    if "/" in dim_piece:
        num, den = dim_piece.split("/")
        return float(num) / float(den)
    return float(dim_piece)


def _fraction_str(value: float, denom: int = 16) -> str:
    """0.5 -> '1/2' style string, reduced, at the given denominator."""
    num = round(value * denom)
    if num == 0:
        return ""
    from math import gcd
    g = gcd(int(num), denom)
    return f"{int(num) // g}/{denom // g}"


def compute_spacer_size(overall_thickness: str, thk1: str, thk2: str) -> str:
    """SPC SIZE = OA - THK1 - THK2, matching every real order checked
    (e.g. 1" OA - 3/16" - 3/16" = 5/8" spacer). Computing this instead of
    hand-typing it prevents exactly the kind of silent mismatch that would
    make Cardinal build the wrong airspace."""
    oa_whole, oa_frac = split_dimension(overall_thickness.replace('"', ''))
    oa_val = float(oa_whole or 0) + _to_float(oa_frac)
    remaining = round(oa_val - _to_float(thk1) - _to_float(thk2), 4)
    return _fraction_str(remaining, 16) or "0"


def expand_unit_range(label: str) -> str:
    """Normalizes a unit label to Cardinal's 'Unit# ...' convention.
    - 'N.a,b' (comma shorthand) -> 'Unit# N.a N.b' (full second sub-unit
      number, never truncated -- this is what eliminates the '6.1 6.13' /
      '9.1 9.13' typo class seen in 31036.csv).
    - '001.2' (zero-padded, from the production doc) -> 'Unit# 1.2'
    - '002.0' -> 'Unit# 2' (a trailing '.0' sub-unit is dropped entirely)
    - '007' -> 'Unit# 7' (leading zeros stripped)
    """
    label = label.strip()
    if label.lower().startswith("unit#"):
        label = label[5:].strip()
    m = re.match(r"^(\d+)\.(\d+),(\d+)$", label)
    if m:
        base, a, b = m.groups()
        return f"Unit# {int(base)}.{a} {int(base)}.{b}"
    m = re.match(r"^(\d+)\.(\d+)-(\d+)$", label)  # e.g. "5.1-3", left as-is
    if m:
        base, a, b = m.groups()
        return f"Unit# {int(base)}.{a}-{b}"
    m = re.match(r"^0*(\d+)\.(\d+)$", label)
    if m:
        base, frac = m.groups()
        return f"Unit# {base}" if frac == "0" else f"Unit# {base}.{frac}"
    m = re.match(r"^0*(\d+)$", label)
    if m:
        return f"Unit# {m.group(1)}"
    return f"Unit# {label}"


def divide_equally(total: float, count: int) -> List[float]:
    """N bars -> N+1 equal panes -> N cumulative bar positions from one edge.
    Matches 31036.csv (e.g. 100.8125 / 2 panes -> one bar at 50.39)."""
    pane = total / (count + 1)
    return [round(pane * (i + 1), 2) for i in range(count)]


def split_dimension(dim: str) -> Tuple[str, str]:
    """'61 1/4\"' -> ('61', '1/4'). '92\"' -> ('92', '')."""
    cleaned = dim.replace('"', "").strip()
    m = re.match(r"^(\d+)\s*(\d+/\d+)?$", cleaned)
    if not m:
        raise ValueError(f"Can't parse dimension: {dim!r}")
    whole, frac = m.groups()
    return whole, (frac or "")


def dimension_to_inches(dim: str) -> float:
    whole, frac = split_dimension(dim)
    return float(whole or 0) + _to_float(frac)


def line_item_from_parsed_unit(unit: dict) -> Tuple[Optional["LineItem"], List[str]]:
    """Bridge from one unit dict parsed by glass_pdf_parser.parse_glass_pdf()
    to a Cardinal LineItem. Returns (line_item, flags): line_item is None,
    with the reason appended to flags, whenever a value needed to build a
    real order (both lite codes, a width x height split) isn't confirmed --
    this never guesses a Ply that glass_pdf_parser itself couldn't map."""
    import glass_pdf_parser as _gpp

    flags = list(unit.get("flags", []))
    parsed, spec_flags = _gpp.parse_spec(unit["spec"])
    if parsed is None:
        return None, flags + spec_flags

    if not parsed["lite1"]:
        flags.append("LITE 1 code unmapped -- can't build a Cardinal line item without it.")
    if not parsed["lite2"]:
        flags.append("LITE 2 code unmapped -- can't build a Cardinal line item without it.")
    if not parsed["lite1"] or not parsed["lite2"]:
        return None, flags

    m = re.match(r"^\s*(.+?)\s*X\s*(.+?)\s*$", unit["dim"], re.IGNORECASE)
    if not m:
        return None, flags + [f'Could not split "{unit["dim"]}" into width x height.']
    width_str, height_str = f'{m.group(1)}"', f'{m.group(2)}"'

    try:
        item = LineItem(
            unit_number=unit["unit"],
            qty=unit["qty"],
            overall_thickness=unit["oa"],
            plies=[
                Ply(thickness=parsed["thk1"], code=parsed["lite1"]),
                Ply(thickness=parsed["thk2"], code=parsed["lite2"]),
            ],
            width=width_str, height=height_str,
            spacer_size=parsed["spc_size"],
        )
    except ValueError as exc:
        return None, flags + [str(exc)]

    item.spc_type_parsed = parsed["spc_type"]  # stashed for the caller to compare against the batch's uniform SPC TYPE
    return item, flags


def to_excel_serial(d: datetime.date) -> int:
    return (d - EXCEL_EPOCH).days


def _row_from_header(header: List[str], values: dict) -> list:
    """Builds a row list matching header order/length, defaulting to ''."""
    return [values.get(col, "") for col in header]


def lite_code(ply: Ply) -> str:
    if ply.code:
        return ply.code
    code = GLASS_CODES.get(ply.glass_type)
    if code is None:
        raise ValueError(f"Unknown glass type {ply.glass_type!r}; add it to GLASS_CODES")
    prefix = "T:" if ply.tempered else ""
    return f"{prefix}{code}"


# ---------------------------------------------------------------------------
# CSV generation
# ---------------------------------------------------------------------------
def generate_csv(order: Order, output_dir: str = "output") -> str:
    """Writes the Cardinal CSV for one order and returns its file path."""
    _validate(order)

    req_date = order.request_date or datetime.date.today()
    w_whole, w_frac = split_dimension(order.width)
    h_whole, h_frac = split_dimension(order.height)

    os.makedirs(output_dir, exist_ok=True)
    # Filename always matches PO number, per the 3-of-4 convention we saw.
    path = os.path.join(output_dir, f"{order.po_number}.csv")

    if len(order.plies) == 2:
        # Exact 41-column header, taken from the reference CSVs (31061/62/63).
        header = [
            "PO NUMBER", "REQUEST DATE", "JOB #", "PO LINE", "QTY", "UNIT #",
            "LOGO FILE", "OVERALL", "THK 1", "LITE 1", "THK 2", "LITE 2",
            "SPC TYPE", "SPC SIZE", "SHAPE", "BASE", "N/D", "LEFT", "N/D",
            "RIGHT", "N/D", "TOP", "N/D", "S1", "N/D-16THN/D", "TUBES",
            "GRID STYLE", "M CODE", "OFFSET", "BUMP-ON",
            "IG BAR INDEX/PLCMNT CODE", "# WIDE", "# HIGH",
            "HORZ BAR POS #1", "HORZ BAR POS #2", "HORZ BAR POS #3",
            "HORZ BAR POS #4", "VERT BAR POS # 1", "VERT BAR POS # 2",
            "VERT BAR POS # 3", "VERT BAR POS # 4",
        ]
        p1, p2 = order.plies
        values = {
            "PO NUMBER": order.po_number,
            "REQUEST DATE": to_excel_serial(req_date),
            "JOB #": order.job_number or "",
            "PO LINE": order.po_line,
            "QTY": order.qty,
            "UNIT #": order.unit_number,
            "LOGO FILE": order.logo,
            "OVERALL": order.overall_thickness,
            "THK 1": p1.thickness, "LITE 1": lite_code(p1),
            "THK 2": p2.thickness, "LITE 2": lite_code(p2),
            "SPC TYPE": order.spacer_type, "SPC SIZE": order.spacer_size,
            "BASE": w_whole, "LEFT": h_whole,
            "TUBES": "Yes" if order.breather_tubes else "",
        }
        # width/height fraction lives in the *second* "N/D" occurrence after
        # BASE and after LEFT respectively — handled by column position below.
        row = _row_from_header(header, values)
        # Fix the two positional N/D fraction columns (BASE's and LEFT's),
        # since "N/D" is not a unique header name.
        base_idx = header.index("BASE")
        left_idx = header.index("LEFT")
        row[base_idx + 1] = w_frac
        row[left_idx + 1] = h_frac
    elif len(order.plies) == 3:
        # This template has no JOB # column — see _validate() warning.
        header = [
            "PO NUMBER", "REQUEST DATE", "PO LINE", "QTY", "UNIT #",
            "LOGO FILE", "OVERALL", "SPC TYPE", "SPC SIZE", "THK 1", "LITE 1",
            "THK 2", "LITE 2", "THK 3", "LITE 3", "TUBES", "SHAPE", "BASE",
            "N/D", "LEFT", "N/D", "GRID STYLE", "# VERT", "# HORZ", "M CODE",
        ]
        p1, p2, p3 = order.plies
        values = {
            "PO NUMBER": order.po_number,
            "REQUEST DATE": req_date.strftime("%d-%b").lstrip("0"),
            "PO LINE": order.po_line, "QTY": order.qty,
            "UNIT #": order.unit_number, "LOGO FILE": order.logo,
            "OVERALL": order.overall_thickness,
            "SPC TYPE": order.spacer_type, "SPC SIZE": order.spacer_size,
            "THK 1": p1.thickness, "LITE 1": lite_code(p1),
            "THK 2": p2.thickness, "LITE 2": lite_code(p2),
            "THK 3": p3.thickness, "LITE 3": lite_code(p3),
            "TUBES": "Yes" if order.breather_tubes else "",
            "BASE": w_whole, "LEFT": h_whole,
        }
        row = _row_from_header(header, values)
        base_idx = header.index("BASE")
        left_idx = header.index("LEFT")
        row[base_idx + 1] = w_frac
        row[left_idx + 1] = h_frac
    else:
        raise ValueError("Only 2-ply or 3-ply makeups are supported currently")

    # Note: the reference 2-ply files are saved with a UTF-8 BOM; the 3-ply
    # file is not. Matching each template's existing convention exactly,
    # since we don't know which Cardinal's intake actually requires.
    encoding = "utf-8-sig" if len(order.plies) == 2 else "utf-8"
    with open(path, "w", newline="", encoding=encoding) as f:
        writer = csv.writer(f)
        writer.writerow(header)
        writer.writerow(row)

    return path


def generate_batch_csv(batch: Batch, output_dir: str = "output") -> str:
    """Writes a multi-line-item CSV (one PO, many units) — the 31036.csv shape.
    Only supports 2-ply items for now (all real batches seen use 2 plies)."""
    req_date = batch.request_date or datetime.date.today()
    header = [
        "PO NUMBER", "REQUEST DATE", "JOB #", "PO LINE", "QTY", "UNIT #",
        "LOGO FILE", "OVERALL", "THK 1", "LITE 1", "THK 2", "LITE 2",
        "SPC TYPE", "SPC SIZE", "SHAPE", "BASE", "N/D", "LEFT", "N/D",
        "RIGHT", "N/D", "TOP", "N/D", "S1", "N/D-16THN/D", "TUBES",
        "GRID STYLE", "M CODE", "OFFSET", "BUMP-ON",
        "IG BAR INDEX/PLCMNT CODE", "# WIDE", "# HIGH",
        "HORZ BAR POS #1", "HORZ BAR POS #2", "HORZ BAR POS #3",
        "HORZ BAR POS #4", "VERT BAR POS # 1", "VERT BAR POS # 2",
        "VERT BAR POS # 3", "VERT BAR POS # 4",
    ]
    base_idx = header.index("BASE")
    left_idx = header.index("LEFT")

    if batch.date_format == "serial":
        req_date_val = to_excel_serial(req_date)
    else:
        req_date_val = f"{req_date.month}/{req_date.day}/{req_date.year}"

    os.makedirs(output_dir, exist_ok=True)
    path = os.path.join(output_dir, f"{batch.po_number}.csv")

    rows = []
    for i, item in enumerate(batch.items, start=1):
        if len(item.plies) != 2:
            raise ValueError("generate_batch_csv currently supports 2-ply items only")
        p1, p2 = item.plies
        w_whole, w_frac = split_dimension(item.width)
        h_whole, h_frac = split_dimension(item.height)
        spacer_size = item.spacer_size or compute_spacer_size(
            item.overall_thickness, p1.thickness, p2.thickness
        )

        for flag in check_size_limits(p1, dimension_to_inches(item.width), dimension_to_inches(item.height)) + \
                    check_size_limits(p2, dimension_to_inches(item.width), dimension_to_inches(item.height)):
            warnings.warn(f"PO {batch.po_number} unit {item.unit_number}: {flag}")

        values = {
            "PO NUMBER": batch.po_number,
            "REQUEST DATE": req_date_val,
            "JOB #": batch.job_number or "",
            "PO LINE": i,
            "QTY": item.qty,
            "UNIT #": expand_unit_range(item.unit_number),
            "LOGO FILE": batch.logo,
            "OVERALL": item.overall_thickness,
            "THK 1": p1.thickness, "LITE 1": lite_code(p1),
            "THK 2": p2.thickness, "LITE 2": lite_code(p2),
            "SPC TYPE": batch.spacer_type, "SPC SIZE": spacer_size,
            "BASE": w_whole, "LEFT": h_whole,
        }
        if item.grid:
            g = item.grid
            w_total = float(w_whole or 0) + _to_float(w_frac)
            h_total = float(h_whole or 0) + _to_float(h_frac)
            if g.positions is None:
                warnings.warn(
                    f"Unit {item.unit_number}: shadow-bar positions were "
                    "auto-computed as equal divisions, but real jobs seen so "
                    "far use specific pane sizes from the shop/muntin "
                    "drawing, not equal division. Verify against the glass "
                    "details drawing before ordering."
                )
            positions = g.positions or divide_equally(
                w_total if g.axis == "width" else h_total, g.count
            )
            values.update({
                "GRID STYLE": g.grid_style, "M CODE": g.m_code,
                "BUMP-ON": g.bump_on, "IG BAR INDEX/PLCMNT CODE": g.ig_bar_code,
            })
            if g.axis == "width":
                values["# WIDE"] = g.count
                for j, pos in enumerate(positions):
                    values[f"HORZ BAR POS #{j + 1}"] = pos
            else:
                values["# HIGH"] = g.count
                for j, pos in enumerate(positions):
                    values[f"VERT BAR POS # {j + 1}"] = pos

        row = _row_from_header(header, values)
        row[base_idx + 1] = w_frac
        row[left_idx + 1] = h_frac
        rows.append(row)

    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f)
        writer.writerow(header)
        writer.writerows(rows)

    return path


def _validate(order: Order) -> None:
    """Flags the same issues we found comparing the reference files, plus
    Cardinal's published Size Limit Guidelines (Bulletin IG23)."""
    if len(order.plies) == 3 and order.job_number:
        warnings.warn(
            f"PO {order.po_number}: job number {order.job_number!r} was provided, "
            "but the 3-ply CSV template has no JOB # column — it will be lost. "
            "Consider asking Cardinal to add a JOB # column to this template."
        )
    if len(order.plies) == 2 and not order.job_number:
        warnings.warn(f"PO {order.po_number}: missing JOB #.")
    if order.logo not in ("PANDA", "WINDSOR"):
        warnings.warn(
            f"PO {order.po_number}: logo file {order.logo!r} isn't one of the "
            "recognized names (PANDA, WINDSOR) — double check this is the "
            "intended Cardinal logo code before sending, not a stray internal ID."
        )

    width_in = dimension_to_inches(order.width)
    height_in = dimension_to_inches(order.height)
    for ply in order.plies:
        for flag in check_size_limits(ply, width_in, height_in):
            warnings.warn(f"PO {order.po_number} {order.unit_number}: {flag}")


# ---------------------------------------------------------------------------
# EXAMPLES — the four reference orders, reconstructed from their reorder
# forms/POs. Running this file regenerates matching CSVs in ./output/ and
# will print any validation warnings.
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    examples = [
        Order(
            po_number="31062", job_number="223039", unit_number="Unit# 2",
            qty=5, overall_thickness='1"',
            plies=[Ply("3/16", "366"), Ply("3/16", "CLEAR")],
            spacer_type="BLACK SS", spacer_size="5/8",
            width='33 3/4"', height='92"', logo="00000_107",
            breather_tubes=False,
            request_date=datetime.date(2026, 9, 22),
        ),
        Order(
            po_number="31061", job_number="4500841019", unit_number="Unit# 1",
            qty=5, overall_thickness='1"',
            plies=[Ply("3/16", "366"), Ply("3/16", "CLEAR")],
            spacer_type="BLACK SS", spacer_size="5/8",
            width='32 7/8"', height='92 7/8"', logo="WINDSOR",
            breather_tubes=True,
            request_date=datetime.date(2026, 9, 22),
        ),
        Order(
            po_number="31063", job_number="87145", unit_number="Unit# 8",
            qty=1, overall_thickness='1 3/16"',
            plies=[Ply("1/4", "366"), Ply("1/4", "i89")],
            spacer_type="BLACK SS", spacer_size="11/16",
            width='61 1/4"', height='95 1/2"', logo="PANDA",
            breather_tubes=False,
            request_date=datetime.date(2026, 9, 22),
        ),
        Order(
            po_number="31066", job_number="90746", unit_number="Unit# 1",
            qty=2, overall_thickness='1 1/2"',
            plies=[Ply("3/8", "366"), Ply("1/4", "180"), Ply("1/4", "i89")],
            spacer_type="BLACK SS", spacer_size="9/16",
            width='78 1/8"', height='91 1/8"', logo="PANDA",
            breather_tubes=True,
            request_date=datetime.date(2026, 9, 22),
        ),
    ]

    for order in examples:
        path = generate_csv(order)
        print(f"Wrote {path}")
