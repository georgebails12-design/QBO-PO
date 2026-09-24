"""
po_requests.py
==============
PO requests: someone fills in a form with what they need ordered, it waits
in a review queue, and whoever creates POs loads it into the Purchase Order
page with one click instead of re-typing it.

Requests come from two places: the PO Requests page (logged-in users,
vendor/items picked from QuickBooks) and the public request form
(/request-form, no login -- vendor/items typed as text, plus the
requester's name, email, location and attached files).

Requests live in po_requests.json next to app.py, and attached files in
request_uploads/<number>/ (both gitignored, never overwritten by deploys).
Every write goes through a file lock so several WSGI workers can't clobber
each other.

Duplicate checks (the point of the queue, besides not re-typing):
  * find_similar_requests -- another open/converted request for the same
    vendor with the same Q#/Project, or mostly the same lines.
  * find_similar_pos -- the same test against existing QuickBooks POs
    (already formatted by qbo_client.format_purchase_order).
"""

import contextlib
import json
import os
import re
import threading
import time

from werkzeug.utils import secure_filename

try:
    import fcntl
except ImportError:  # Windows dev box -- the thread lock still covers the single-process dev server
    fcntl = None

APP_DIR = os.path.dirname(os.path.abspath(__file__))
REQUESTS_FILE = os.path.join(APP_DIR, "po_requests.json")
LOCK_FILE = REQUESTS_FILE + ".lock"
UPLOAD_DIR = os.path.join(APP_DIR, "request_uploads")

MAX_FILES = 10
MAX_FILE_BYTES = 25 * 1024 * 1024  # QuickBooks' own attachment limit
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

STATUSES = ("open", "converted", "rejected")
LINE_OVERLAP_THRESHOLD = 0.6   # share of the larger order's lines that must match to call two orders "similar"
DUPLICATE_WINDOW_DAYS = 90     # older requests aren't considered duplicates

_THREAD_LOCK = threading.Lock()


@contextlib.contextmanager
def _locked():
    with _THREAD_LOCK:
        if fcntl is None:
            yield
            return
        with open(LOCK_FILE, "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)


def _load():
    if not os.path.exists(REQUESTS_FILE):
        return {"next_number": 1, "requests": []}
    with open(REQUESTS_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def _save(data):
    tmp = REQUESTS_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, REQUESTS_FILE)


# ---------------------------------------------------------------------------
# Cleaning submitted data
# ---------------------------------------------------------------------------
def _num(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def clean_request(data, public=False):
    """Validates a submitted form and returns the fields we store, or raises
    ValueError with a message safe to show on the page. public: the no-login
    request form -- vendor is typed text (matched to QuickBooks on review)
    and the requester's name and email are required."""
    vendor_id = str(data.get("vendor_id") or "").strip() or None
    vendor_name = (data.get("vendor_name") or "").strip()
    if public:
        vendor_id = None
        if not vendor_name:
            raise ValueError("Enter the vendor.")
    elif not vendor_id or not vendor_name:
        raise ValueError("Pick a vendor from the list.")

    requester_name = (data.get("requester_name") or "").strip()
    requester_email = (data.get("requester_email") or "").strip()
    if public and not requester_name:
        raise ValueError("Enter your name.")
    if public and not EMAIL_RE.match(requester_email):
        raise ValueError("Enter a valid email address.")

    lines = []
    for line in data.get("lines") or []:
        item_id = str(line.get("item_id") or "").strip() or None
        item_name = (line.get("item_name") or "").strip()
        description = (line.get("description") or "").strip()
        if not (item_id or item_name or description):
            continue
        qty = _num(line.get("qty"), 1.0)
        if qty <= 0:
            raise ValueError(f'Quantity must be more than 0 ("{item_name or description}").')
        lines.append({
            "item_id": item_id, "item_name": item_name, "description": description,
            "qty": qty, "rate": max(_num(line.get("rate")), 0.0),
        })
    if not lines:
        raise ValueError("Add at least one line.")

    customer = data.get("customer") or {}
    return {
        "source": "form" if public else "app",
        "vendor_id": vendor_id,
        "vendor_name": vendor_name,
        "customer": {"id": str(customer.get("id") or "") or None, "name": (customer.get("name") or "").strip()},
        "q_project": (data.get("q_project") or "").strip(),
        "location": (data.get("location") or "").strip(),
        "needed_by": (data.get("needed_by") or "").strip(),
        "requester_name": requester_name,
        "requester_email": requester_email,
        "memo": (data.get("memo") or "").strip(),
        "lines": lines,
        "attachments": [],
    }


# ---------------------------------------------------------------------------
# CRUD
# ---------------------------------------------------------------------------
def list_requests(status=None):
    with _locked():
        requests_ = _load()["requests"]
    if status:
        requests_ = [r for r in requests_ if r["status"] == status]
    return sorted(requests_, key=lambda r: r["number"], reverse=True)


def get_request(number):
    with _locked():
        return next((r for r in _load()["requests"] if r["number"] == number), None)


def add_request(fields, submitted_by):
    with _locked():
        data = _load()
        req = dict(fields, number=data["next_number"], status="open", submitted_by=submitted_by,
                   submitted_at=time.time(), reviewed_by=None, reviewed_at=None,
                   po_id=None, po_doc_number=None, note="")
        data["next_number"] += 1
        data["requests"].append(req)
        _save(data)
    return req


def update_request(number, **changes):
    """Applies changes to one request; returns it, or None if it doesn't exist."""
    with _locked():
        data = _load()
        req = next((r for r in data["requests"] if r["number"] == number), None)
        if req is None:
            return None
        req.update(changes)
        _save(data)
    return req


def save_attachments(number, files):
    """Stores uploaded files (werkzeug FileStorage) under request_uploads/<number>/
    and records them on the request. Raises ValueError for too many/too big."""
    files = [f for f in files if f and f.filename]
    if len(files) > MAX_FILES:
        raise ValueError(f"Attach at most {MAX_FILES} files.")
    folder = os.path.join(UPLOAD_DIR, str(number))
    os.makedirs(folder, exist_ok=True)
    saved = []
    for i, f in enumerate(files):
        stored_name = f"{i}_{secure_filename(f.filename) or 'file'}"
        path = os.path.join(folder, stored_name)
        f.save(path)
        size = os.path.getsize(path)
        if size > MAX_FILE_BYTES:
            os.unlink(path)
            raise ValueError(f'"{f.filename}" is too large (25MB limit per file).')
        saved.append({"file_name": f.filename, "stored_name": stored_name, "size": size,
                      "content_type": f.mimetype or "application/octet-stream"})
    return update_request(number, attachments=saved)


def attachment_path(req, index):
    """Path on disk of a request's index-th attachment, or None."""
    attachments = req.get("attachments") or []
    if not 0 <= index < len(attachments):
        return None
    return os.path.join(UPLOAD_DIR, str(req["number"]), attachments[index]["stored_name"])


def mark_converted(number, po_id, po_doc_number, reviewed_by):
    return update_request(number, status="converted", po_id=po_id, po_doc_number=po_doc_number,
                          reviewed_by=reviewed_by, reviewed_at=time.time())


# ---------------------------------------------------------------------------
# Duplicate detection
# ---------------------------------------------------------------------------
def _norm(text):
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def _line_keys(lines):
    """One key per line: the QuickBooks item when there is one, else the text."""
    keys = set()
    for line in lines:
        if line.get("item_id"):
            keys.add(f"item:{line['item_id']}")
        else:
            text = _norm(line.get("description") or line.get("item_name") or line.get("name"))
            if text:
                keys.add(f"text:{text}")
    return keys


def _overlap(a, b):
    if not a or not b:
        return 0.0
    return len(a & b) / max(len(a), len(b))


def _same_vendor(a, b):
    """Form requests only have the vendor's name, not its QuickBooks id."""
    if a.get("vendor_id") and b.get("vendor_id"):
        return a["vendor_id"] == b["vendor_id"]
    return _norm(a.get("vendor_name")) == _norm(b.get("vendor_name"))


def _match_reasons(q_project, keys, other_q_project, other_keys):
    reasons = []
    if q_project and _norm(q_project) == _norm(other_q_project):
        reasons.append(f"same Q#/Project ({other_q_project})")
    share = _overlap(keys, other_keys)
    if share >= LINE_OVERLAP_THRESHOLD:
        shared = len(keys & other_keys)
        reasons.append(f"{shared} of {len(keys)} line(s) match")
    return reasons


def find_similar_requests(fields, exclude_number=None, pool=None):
    """Open/converted requests for the same vendor that look like the same
    order. pool: the requests to search (defaults to all of them)."""
    cutoff = time.time() - DUPLICATE_WINDOW_DAYS * 86400
    keys = _line_keys(fields["lines"])
    matches = []
    for other in list_requests() if pool is None else pool:
        if other["number"] == exclude_number or other["status"] == "rejected":
            continue
        if not _same_vendor(other, fields) or other["submitted_at"] < cutoff:
            continue
        reasons = _match_reasons(fields["q_project"], keys, other["q_project"], _line_keys(other["lines"]))
        if reasons:
            matches.append({
                "number": other["number"], "status": other["status"], "submitted_by": other["submitted_by"],
                "submitted_at": other["submitted_at"], "po_doc_number": other["po_doc_number"],
                "reasons": reasons,
            })
    return matches


def find_similar_pos(fields, formatted_pos):
    """QuickBooks POs (qbo_client.format_purchase_order output, same vendor)
    that look like the same order."""
    keys = _line_keys(fields["lines"])
    matches = []
    for po in formatted_pos:
        reasons = _match_reasons(fields["q_project"], keys, po.get("q_project"), _line_keys(po.get("lines") or []))
        if reasons:
            matches.append({
                "id": po["id"], "doc_number": po.get("doc_number"), "txn_date": po.get("txn_date"),
                "total": po.get("total"), "status": po.get("status"), "reasons": reasons,
            })
    return matches
