"""
lookup.py
=========
Read-only "is this in QuickBooks?" checks for people outside the PO app --
e.g. whoever fills in the Fillout supplemental form. They don't get a login;
they get a link carrying a shared lookup key.

Only names are exposed (vendor names, item names/descriptions, customer/
project names) -- never emails, prices, or costs -- and everything comes
from the cached reference lists, so nothing here calls QuickBooks or can
change anything in it.

Links use the same key as the public request form (see form_key.py).
Print ready-made links with:

    python lookup.py https://po.pandawd.online
"""

import difflib
import re
import sys

import qbo_client
from form_key import get_key, key_ok  # noqa: F401 -- same link key as the request form

KINDS = ("vendor", "item", "project")
MAX_RESULTS = 20


def _norm(text):
    return re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).strip()


def _entries(kind):
    """[(id, name, detail, [normalized strings to match on])] for one list."""
    cache = qbo_client.load_reference_cache() or {}
    if kind == "vendor":
        return [(v["id"], v["name"], "", [_norm(v["name"])]) for v in cache.get("vendors", []) if v.get("name")]
    if kind == "item":
        return [(it["id"], it["name"], it.get("description") or "", [_norm(it["name"])])
                for it in cache.get("items", []) if it.get("name")]
    # Projects are sub-customers, named "Customer:Project" -- match the project part on its own too.
    return [(c["id"], c["name"], "", [_norm(c["name"]), _norm(c["name"].split(":")[-1])])
            for c in cache.get("customers", []) if c.get("name")]


def search(kind, query):
    """Type-ahead: names containing every word typed, best first."""
    words = _norm(query).split()
    if not words:
        return []
    hits = []
    for _id, name, detail, keys in _entries(kind):
        haystack = " ".join(keys + [_norm(detail)])
        if all(w in haystack for w in words):
            starts = any(k.startswith(words[0]) for k in keys)
            hits.append((0 if starts else 1, name.lower(), name, detail))
    hits.sort()
    return [{"name": name, "detail": detail} for _, _, name, detail in hits[:MAX_RESULTS]]


def all_names(kind):
    """Every name in one list, for filling a whole dropdown."""
    return [{"name": name, "detail": detail} for _id, name, detail, _keys in sorted(_entries(kind), key=lambda e: e[1].lower())]


def check(kind, value, entries=None):
    """{"value", "found", "match", "match_id", "suggestions"}: found means an
    exact match (ignoring case, spaces and punctuation; a full name beats a
    project-part match); otherwise suggest close names."""
    wanted = _norm(value)
    result = {"value": value, "found": False, "match": None, "match_id": None, "suggestions": []}
    if not wanted:
        return result
    entries = _entries(kind) if entries is None else entries
    exact = next((e for e in entries if e[3][0] == wanted), None) or next((e for e in entries if wanted in e[3]), None)
    if exact:
        result.update(found=True, match=exact[1], match_id=exact[0])
        return result
    close = [name for _id, name, _detail, keys in entries if any(wanted in k for k in keys)]
    by_key = {}
    for _id, name, _detail, keys in entries:
        for k in keys:
            by_key.setdefault(k, name)
    for k in difflib.get_close_matches(wanted, list(by_key), n=5, cutoff=0.6):
        close.append(by_key[k])
    result["suggestions"] = list(dict.fromkeys(close))[:5]
    return result


def resolve_request(fields):
    """Matches a typed-in request (public form / Fillout) to QuickBooks:
    exact vendor, project and item names get their QuickBooks ids filled
    in, and fields["qbo_check"] records what didn't match (with
    suggestions) for the review table. Changes fields in place."""
    public = lambda r: {k: r[k] for k in ("found", "match", "suggestions")}  # noqa: E731 -- ids stay server-side
    check_info = {}

    if not fields.get("vendor_id") and fields.get("vendor_name"):
        r = check("vendor", fields["vendor_name"])
        if r["found"]:
            fields["vendor_id"], fields["vendor_name"] = r["match_id"], r["match"]
        check_info["vendor"] = public(r)

    if fields.get("q_project") and not (fields.get("customer") or {}).get("id"):
        r = check("project", fields["q_project"])
        if r["found"]:
            fields["customer"] = {"id": r["match_id"], "name": r["match"]}
        check_info["project"] = public(r)

    items = _entries("item")
    check_info["items"] = []
    for line in fields.get("lines") or []:
        if line.get("item_id") or not line.get("item_name"):
            check_info["items"].append(None)
            continue
        r = check("item", line["item_name"], items)
        if r["found"]:
            line["item_id"], line["item_name"] = r["match_id"], r["match"]
        check_info["items"].append(public(r))

    fields["qbo_check"] = check_info
    return fields


def cache_age():
    cache = qbo_client.load_reference_cache() or {}
    return cache.get("fetched_at")


if __name__ == "__main__":
    base = (sys.argv[1] if len(sys.argv) > 1 else "https://po.pandawd.online").rstrip("/")
    key = get_key()
    print(f"Lookup key: {key}\n")
    print(f"Lookup page:   {base}/lookup?key={key}")
    print(f"Check values:  {base}/lookup?key={key}&vendor=...&item=...&project=...")
    for kind in KINDS:
        print(f"{kind.title()} options: {base}/api/lookup/{kind}?key={key}&q=...")
