"""
glass_ocr.py
============
Reads scanned glass sheets (copier scans -- a picture of each page, no text
layer) so glass_pdf_parser can parse them like a system-generated PDF.

How:
  1. Each page is rendered at 300 dpi and colored ink is removed. The
     checkmarks and initials people add to the paper copy are blue/red; the
     printed sheet is black. Without this step the recognizer misreads
     digits a checkmark crosses (e.g. 24 5/8" -> 25/8", qty 1 -> 12).
  2. Tesseract reads the cleaned page. Its own line grouping is used to
     build glass_pdf_parser.Line objects, so the normal sheet parser runs
     unchanged on the result.
  3. If RapidOCR is installed, it reads the page independently as a second
     opinion:
       - the header (project name / JDM / project #) is taken from it when
         Tesseract garbles that boxed area;
       - every unit's qty, size and OA from Tesseract is compared with
         RapidOCR's; any disagreement is flagged on that unit so someone
         checks it against the paper before items are created.

Every unit read from a scan also gets a flag saying so -- a misread digit
is a mis-cut lite, so scans are always confirmed by a person.

Needs the tesseract binary on the server (apt-get install tesseract-ocr)
and the pytesseract / rapidocr_onnxruntime packages from requirements.txt.
"""

import re

import numpy as np
import pdfplumber
from PIL import Image

from glass_pdf_parser import Line

DPI = 300
PT_PER_PX = 72 / DPI
INK_SATURATION = 40      # max(R,G,B) - min(R,G,B) above this = colored ink, removed

SCAN_FLAG = "Read from a scanned copy -- check size, qty and OA against the paper before creating items"


class OCRUnavailable(Exception):
    pass


_rapid = None


def _rapid_engine():
    global _rapid
    if _rapid is None:
        try:
            from rapidocr_onnxruntime import RapidOCR
        except ImportError:
            _rapid = False
        else:
            _rapid = RapidOCR()
    return _rapid or None


def remove_colored_ink(img):
    a = np.asarray(img.convert("RGB")).astype(np.int16)
    sat = a.max(axis=2) - a.min(axis=2)
    gray = a.mean(axis=2)
    return Image.fromarray(np.where(sat > INK_SATURATION, 255, gray).astype(np.uint8))


def _drop_junk_cells(words):
    """Stray marks left of/right of the printed text come out as short
    letter-only fragments ("ee", "wv", "»~") separated by a wide gap --
    drop those trailing cells."""
    line = Line(0, 0, words)
    cells = line.cells()
    if len(cells) < 2:
        return words
    keep = len(cells)
    while keep > 1 and len(cells[keep - 1]) <= 3 and not re.search(r'[\d"]', cells[keep - 1]):
        keep -= 1
    kept_text = " ".join(cells[:keep]).split(" ")
    return words[:len(kept_text)]


def _tesseract_lines(img, page_no):
    try:
        import pytesseract
        data = pytesseract.image_to_data(img, config="--psm 6", output_type=pytesseract.Output.DICT)
    except ImportError as exc:
        raise OCRUnavailable("pytesseract is not installed") from exc
    except Exception as exc:  # TesseractNotFoundError and friends
        raise OCRUnavailable(f"Tesseract OCR isn't available on the server ({exc})") from exc

    grouped = {}
    for i, text in enumerate(data["text"]):
        if not text.strip():
            continue
        key = (data["block_num"][i], data["par_num"][i], data["line_num"][i])
        grouped.setdefault(key, []).append(i)

    lines = []
    for idxs in grouped.values():
        idxs.sort(key=lambda i: data["left"][i])
        words = [(data["left"][i] * PT_PER_PX, (data["left"][i] + data["width"][i]) * PT_PER_PX,
                  data["text"][i]) for i in idxs]
        words = _drop_junk_cells(words)
        y = max((data["top"][i] + data["height"][i]) for i in idxs) * PT_PER_PX
        lines.append(Line(page_no, y, words))
    lines.sort(key=lambda ln: ln.y)
    return lines


def _rapid_boxes(img):
    eng = _rapid_engine()
    if not eng:
        return None
    res, _ = eng(np.asarray(img.convert("RGB")))
    boxes = []
    for box, text, _conf in res or []:
        xs = [p[0] for p in box]
        ys = [p[1] for p in box]
        boxes.append({"x0": min(xs), "x1": max(xs), "y0": min(ys), "y1": max(ys), "text": text})
    boxes.sort(key=lambda b: (b["y0"], b["x0"]))
    return boxes


def read_scanned_pdf(path):
    """Returns (lines, rapid_boxes_per_page). rapid_boxes_per_page is None
    when the second reader isn't installed."""
    lines, rapid_pages = [], []
    with pdfplumber.open(path) as pdf:
        for page_no, page in enumerate(pdf.pages, start=1):
            img = remove_colored_ink(page.to_image(resolution=DPI).original)
            lines.extend(_tesseract_lines(img, page_no))
            rapid_pages.append(_rapid_boxes(img))
    if all(p is None for p in rapid_pages):
        rapid_pages = None
    return lines, rapid_pages


# ---------------------------------------------------------------------------
# Second-reader checks
# ---------------------------------------------------------------------------
def _compact(s):
    """Uppercase, no spaces, letter O read as zero -- for comparing readings."""
    return re.sub(r"\s+", "", s or "").upper().replace("O", "0")


def header_from_rapid(rapid_pages):
    """{"project", "job_name", "jdm"} from the boxes under the PROJECT NAME /
    JDM / PROJECT# labels on page 1."""
    boxes = (rapid_pages or [None])[0] or []

    def below(label_re):
        label = next((b for b in boxes if re.search(label_re, b["text"].replace(" ", ""), re.IGNORECASE)), None)
        if not label:
            return ""
        h = label["y1"] - label["y0"]
        cands = [b for b in boxes
                 if b["y0"] > label["y0"] + h * 0.5 and b["y0"] < label["y1"] + h * 2.5
                 and b["x0"] < label["x1"] and b["x1"] > label["x0"] - h]
        cands.sort(key=lambda b: (b["y0"], abs(b["x0"] - label["x0"])))
        return cands[0]["text"].strip() if cands else ""

    project = below(r"^PROJECT#")
    m = re.search(r"\d{4,}", project.replace("O", "0"))
    return {"project": m.group(0) if m else "",
            "job_name": below(r"^PROJECTNAME"),
            "jdm": below(r"^JDM")}


RAPID_UNIT_RE = re.compile(
    r"QTY:?(\d+?)-?[0O]VERALLDIM\.?:?([\d/]+)\"?[X×]([\d/]+)\"?-?[0O]A:?([\d/]+)\"", re.IGNORECASE)


def cross_check_units(units, rapid_pages):
    """Compare each unit's qty / size / OA with the second reader, in page
    order. Adds flags to the unit dicts in place."""
    if rapid_pages is None:
        for u in units:
            u["flags"].append("Only one OCR reader available -- couldn't double-check this scan")
        return
    stream = "".join(_compact(b["text"]) for page in rapid_pages for b in (page or []))
    readings = [m.groups() for m in RAPID_UNIT_RE.finditer(stream)]
    for i, u in enumerate(units):
        if i >= len(readings):
            u["flags"].append("Second OCR reader couldn't find this unit -- check it against the paper")
            continue
        qty, w, h, oa = readings[i]
        mine = (str(u["qty"]), _compact(u["w"]), _compact(u["h"]), _compact(u["oa"]).rstrip('"'))
        theirs = (qty.lstrip("0") or "0", w, h, oa)
        labels = ("Qty", "Width", "Height", "OA")
        for label, a, b in zip(labels, mine, theirs):
            if a != b:
                u["flags"].append(f"{label} unclear on the scan (read as {a!r} and {b!r}) -- check against the paper")
    if len(readings) > len(units):
        units and units[-1]["flags"].append(
            f"Second OCR reader found {len(readings)} units but {len(units)} were read -- a unit may be missing")
