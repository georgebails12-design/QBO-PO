"""
n8n_requests.py
===============
Requests submitted through Fillout land on the monday.com "Purchasing
Requests" board. An n8n workflow copies each new one into the n8n data table
"PO Requests to Review", and a second n8n workflow ("PO Requests Review
API") lets this app read that table and record decisions:

    GET  <base>/po-requests?status=pending   -> {"requests": [...]}
    POST <base>/po-requests/review           {monday_item_id, decision, reviewed_by, note, po_number}

sync() pulls the pending ones into the PO Requests review table (once per
submission -- the monday item id is the external id). When a monday request
is rejected here, or its PO is created, push_decision() sends Declined /
Approved (+ PO #) back, which n8n writes to the table and to monday's
Request Status column. A decision that couldn't be sent is retried on the
next sync.

Configure with N8N_WEBHOOK_BASE (default https://n8n.pandawd.online/webhook)
and the API key n8n expects in the X-PO-Key header: N8N_API_KEY in the
environment or the n8n_api_key file next to app.py (gitignored). Without a
key the sync is off.
"""

import os
import threading
import time

import requests

import lookup
import po_requests

APP_DIR = os.path.dirname(os.path.abspath(__file__))
KEY_FILE = os.path.join(APP_DIR, "n8n_api_key")
DEFAULT_BASE = "https://n8n.pandawd.online/webhook"
SYNC_EVERY_SECONDS = 60
TIMEOUT = 15

_sync_lock = threading.Lock()
_last_sync = {"at": 0.0, "result": None}


def _config():
    key = os.environ.get("N8N_API_KEY")
    if not key and os.path.exists(KEY_FILE):
        with open(KEY_FILE, "r", encoding="utf-8") as f:
            key = f.read().strip()
    return (os.environ.get("N8N_WEBHOOK_BASE") or DEFAULT_BASE).rstrip("/"), key


def enabled():
    return bool(_config()[1])


def _fields_from_row(row):
    """A 'PO Requests to Review' row -> fields for po_requests (lenient, like Fillout)."""
    vendor = (row.get("vendor") or "").strip()
    lines = []
    for item in row.get("items") or []:
        details = [item.get("details") or ""]
        if item.get("vendor") and item["vendor"] != vendor:
            details.append(f"Vendor: {item['vendor']}")
        if item.get("unit"):
            details.append(f"Unit: {item['unit']}")
        lines.append({"item_name": item.get("item") or "", "description": ", ".join(d for d in details if d),
                      "qty": item.get("qty") or 1})
    memo = [row.get("notes") or ""]
    if row.get("request_type"):
        memo.append(f"Request type: {row['request_type']}")
    if row.get("job_number") and row.get("project"):
        memo.append(f"Job #: {row['job_number']}")
    fields = po_requests.clean_request({
        "requester_name": row.get("requester") or "",
        "requester_email": row.get("requester_email") or "",
        "vendor_name": vendor,
        "q_project": row.get("project") or row.get("job_number") or "",
        "location": row.get("location") or "",
        "needed_by": (row.get("needed_by") or "")[:10],
        "memo": "\n".join(m for m in memo if m),
        "lines": lines,
    }, source="monday")
    fields["external_id"] = f"monday:{row['monday_item_id']}"
    fields["monday"] = {
        "item_id": str(row["monday_item_id"]),
        "url": row.get("monday_url") or "",
        "name": row.get("request_name") or "",
        "request_number": row.get("request_number") or "",
        "files": row.get("files") or [],
        "decision_sent": None,
    }
    return fields


def sync(force=False):
    """Imports pending monday requests; returns {"enabled", "new", "error", "at"}.
    Runs at most once a minute (per app process) unless forced."""
    if not enabled():
        return {"enabled": False, "new": 0, "error": None, "at": None}
    with _sync_lock:
        if not force and _last_sync["result"] and time.time() - _last_sync["at"] < SYNC_EVERY_SECONDS:
            return _last_sync["result"]
        result = {"enabled": True, "new": 0, "error": None, "at": time.time()}
        base, key = _config()
        try:
            resp = requests.get(f"{base}/po-requests", params={"status": "pending"},
                                headers={"X-PO-Key": key}, timeout=TIMEOUT)
            resp.raise_for_status()
            rows = resp.json().get("requests") or []
        except (requests.RequestException, ValueError) as exc:
            result["error"] = f"Could not read monday requests from n8n: {exc}"
            rows = []
        for row in rows:
            if not row.get("monday_item_id"):
                continue
            fields = _fields_from_row(row)
            lookup.resolve_request(fields)
            who = fields["requester_name"] or fields["requester_email"] or "monday"
            req, created = po_requests.add_request(fields, f"{who} (monday)")
            if created:
                result["new"] += 1
            elif req["status"] != "open" and not (req.get("monday") or {}).get("decision_sent"):
                push_decision(req)  # decided here earlier but n8n didn't hear about it
        _last_sync.update(at=result["at"], result=result)
        return result


def push_decision(req):
    """Tells n8n (and so monday) a monday request was approved (PO created) or
    declined. Returns None on success, else an error message."""
    monday = req.get("monday") or {}
    if req.get("source") != "monday" or not monday.get("item_id") or req["status"] == "open":
        return None
    base, key = _config()
    if not key:
        return "n8n is not configured (no N8N_API_KEY)."
    decision = "approved" if req["status"] == "converted" else "declined"
    try:
        resp = requests.post(f"{base}/po-requests/review", headers={"X-PO-Key": key}, timeout=TIMEOUT, json={
            "monday_item_id": monday["item_id"], "decision": decision,
            "reviewed_by": req.get("reviewed_by") or "", "note": req.get("note") or "",
            "po_number": req.get("po_doc_number") or "",
        })
        resp.raise_for_status()
        if not resp.json().get("ok"):
            raise ValueError(resp.json().get("error") or "n8n did not accept the decision")
    except (requests.RequestException, ValueError) as exc:
        return f"Could not send the decision to monday: {exc}"
    po_requests.update_request(req["number"], monday=dict(monday, decision_sent=decision))
    return None
