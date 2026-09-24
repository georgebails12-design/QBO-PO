"""
fillout.py
==========
Turns a Fillout form webhook into a PO request for the review table.

Point the Fillout form's Webhook integration at
    https://<app>/api/fillout-webhook?key=<form key>
(see form_key.py). Either Fillout's standard payload or a custom JSON body
works:

  * standard:  {"submission": {"submissionId", "questions": [{"name", "type", "value"}, ...]}}
  * custom:    {"Vendor": "...", "Project name": "...", "Items": "...", ...}

Questions are matched to request fields by their label using
fillout_fields.json, falling back on the question type (email, date, file
upload). File-upload answers are downloaded from Fillout's storage links so
they can be attached to the PO later.
"""

import ipaddress
import json
import os
import re
import socket
import urllib.parse

import requests

APP_DIR = os.path.dirname(os.path.abspath(__file__))
FIELDS_FILE = os.path.join(APP_DIR, "fillout_fields.json")

TYPE_FALLBACKS = {"EmailInput": "requester_email", "DatePicker": "needed_by", "FileUpload": "files"}
MAX_REDIRECTS = 3


def _norm(label):
    return re.sub(r"[^a-z0-9]+", " ", (label or "").lower()).strip()


def _aliases():
    with open(FIELDS_FILE, "r", encoding="utf-8") as f:
        config = json.load(f)
    return {_norm(alias): field for field, aliases in config.items() if not field.startswith("_")
            for alias in aliases}


def _text(value):
    """Fillout answers can be strings, numbers, lists (multi-select) or
    dicts (address) -- flatten to one string."""
    if value is None:
        return ""
    if isinstance(value, dict):
        return ", ".join(_text(v) for v in value.values() if _text(v))
    if isinstance(value, list):
        return ", ".join(_text(v) for v in value if _text(v))
    return str(value).strip()


def _questions(payload):
    """(submission id, [(label, type, value)]) from either payload shape."""
    submission = payload.get("submission") if isinstance(payload.get("submission"), dict) else payload
    if isinstance(submission.get("questions"), list):
        questions = [(q.get("name") or "", q.get("type") or "", q.get("value")) for q in submission["questions"]]
        return str(submission.get("submissionId") or ""), questions
    questions = [(k, "", v) for k, v in payload.items() if k not in ("submissionId", "submission_id")]
    return str(payload.get("submissionId") or payload.get("submission_id") or ""), questions


def _file_refs(value):
    """[(url, filename)] from a file-upload answer."""
    refs = []
    for v in value if isinstance(value, list) else [value]:
        if isinstance(v, dict) and v.get("url"):
            refs.append((v["url"], v.get("filename") or v.get("name") or ""))
        elif isinstance(v, str):
            refs += [(u.strip(), "") for u in v.split(",") if u.strip().startswith("http")]
    return refs


def _lines(item_value, description, qty):
    """Request lines from the item answer: a table/list of rows, a
    multi-select, several lines of text, or one item."""
    aliases = _aliases()
    if isinstance(item_value, list) and item_value and all(isinstance(r, dict) for r in item_value):
        lines = []
        for row in item_value:
            mapped = {aliases.get(_norm(k)): v for k, v in row.items()}
            lines.append({"item_name": _text(mapped.get("item_name")), "description": _text(mapped.get("description")),
                          "qty": _text(mapped.get("qty")) or 1})
        return lines
    if isinstance(item_value, list):
        names = [_text(v) for v in item_value if _text(v)]
    else:
        names = [n.strip() for n in _text(item_value).splitlines() if n.strip()]
    if len(names) == 1:
        return [{"item_name": names[0], "description": description, "qty": qty or 1}]
    lines = [{"item_name": n, "description": "", "qty": 1} for n in names]
    if description and lines:
        lines[0]["description"] = description
    if not lines and description:
        lines = [{"item_name": "", "description": description, "qty": qty or 1}]
    return lines


def parse(payload):
    """(external id, request data for po_requests.clean_request, [(url, filename)])."""
    submission_id, questions = _questions(payload)
    aliases = _aliases()
    found, files = {}, []
    for label, qtype, value in questions:
        field = aliases.get(_norm(label)) or TYPE_FALLBACKS.get(qtype)
        if field == "files":
            files += _file_refs(value)
        elif field and field not in found:
            found[field] = value
    needed_by = _text(found.get("needed_by"))
    data = {
        "requester_name": _text(found.get("requester_name")),
        "requester_email": _text(found.get("requester_email")),
        "vendor_name": _text(found.get("vendor_name")),
        "q_project": _text(found.get("q_project")),
        "location": _text(found.get("location")),
        "needed_by": needed_by[:10] if re.match(r"\d{4}-\d{2}-\d{2}", needed_by) else needed_by,
        "memo": _text(found.get("memo")),
        "lines": _lines(found.get("item_name"), _text(found.get("description")), _text(found.get("qty"))),
    }
    return (f"fillout:{submission_id}" if submission_id else None), data, files


# ---------------------------------------------------------------------------
# Downloading uploaded files
# ---------------------------------------------------------------------------
def _public_https(url):
    """Only fetch https URLs on public addresses -- never the server's own
    network, whatever a submitted payload claims."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "https" or not parts.hostname:
        return False
    try:
        infos = socket.getaddrinfo(parts.hostname, parts.port or 443)
    except socket.gaierror:
        return False
    return all(ipaddress.ip_address(info[4][0]).is_global for info in infos)


def download(url, filename, max_bytes):
    """(filename, content type, bytes) of one uploaded file; raises ValueError."""
    for _ in range(MAX_REDIRECTS + 1):
        if not _public_https(url):
            raise ValueError("not a public https link")
        resp = requests.get(url, stream=True, timeout=30, allow_redirects=False)
        if resp.is_redirect:
            url = urllib.parse.urljoin(url, resp.headers.get("Location", ""))
            continue
        if resp.status_code != 200:
            raise ValueError(f"download failed ({resp.status_code})")
        content = b""
        for chunk in resp.iter_content(64 * 1024):
            content += chunk
            if len(content) > max_bytes:
                raise ValueError("too large (25MB limit)")
        name = filename or os.path.basename(urllib.parse.urlsplit(url).path) or "file"
        return name, resp.headers.get("Content-Type", "application/octet-stream").split(";")[0], content
    raise ValueError("too many redirects")
