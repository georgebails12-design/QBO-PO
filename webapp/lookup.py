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

The key is PO_LOOKUP_KEY from the environment, or one generated once and
saved to lookup_key (gitignored). Print it and ready-made links with:

    python lookup.py https://po.pandawd.online

Delete lookup_key (and restart the app) to revoke every link handed out.
"""

import difflib
import hmac
import os
import re
import secrets
import sys

import qbo_client

APP_DIR = os.path.dirname(os.path.abspath(__file__))
KEY_FILE = os.path.join(APP_DIR, "lookup_key")

KINDS = ("vendor", "item", "project")
MAX_RESULTS = 20


def get_key():
    env_key = os.environ.get("PO_LOOKUP_KEY")
    if env_key:
        return env_key
    try:
        fd = os.open(KEY_FILE, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        with open(KEY_FILE, "r", encoding="utf-8") as f:
            key = f.read().strip()
        if key:
            return key
        raise RuntimeError(f"{KEY_FILE} is empty -- delete it and restart.")
    key = secrets.token_urlsafe(24)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(key)
    return key


def key_ok(given):
    return bool(given) and hmac.compare_digest(str(given), get_key())


def _norm(text):
    return re.sub(r"[^a-z0-9]+", " ", (text or "").lower()).strip()


def _entries(kind):
    """[(name, detail, [normalized strings to match on])] for one list."""
    cache = qbo_client.load_reference_cache() or {}
    if kind == "vendor":
        return [(v["name"], "", [_norm(v["name"])]) for v in cache.get("vendors", []) if v.get("name")]
    if kind == "item":
        return [(it["name"], it.get("description") or "", [_norm(it["name"])])
                for it in cache.get("items", []) if it.get("name")]
    # Projects are sub-customers, named "Customer:Project" -- match the project part on its own too.
    return [(c["name"], "", [_norm(c["name"]), _norm(c["name"].split(":")[-1])])
            for c in cache.get("customers", []) if c.get("name")]


def search(kind, query):
    """Type-ahead: names containing every word typed, best first."""
    words = _norm(query).split()
    if not words:
        return []
    hits = []
    for name, detail, keys in _entries(kind):
        haystack = " ".join(keys + [_norm(detail)])
        if all(w in haystack for w in words):
            starts = any(k.startswith(words[0]) for k in keys)
            hits.append((0 if starts else 1, name.lower(), name, detail))
    hits.sort()
    return [{"name": name, "detail": detail} for _, _, name, detail in hits[:MAX_RESULTS]]


def check(kind, value):
    """{"value", "found", "match", "suggestions"}: found means an exact match
    (ignoring case, spaces and punctuation); otherwise suggest close names."""
    wanted = _norm(value)
    result = {"value": value, "found": False, "match": None, "suggestions": []}
    if not wanted:
        return result
    entries = _entries(kind)
    for name, _detail, keys in entries:
        if wanted in keys:
            result.update(found=True, match=name)
            return result
    close = [name for name, _detail, keys in entries if any(wanted in k for k in keys)]
    by_key = {}
    for name, _detail, keys in entries:
        for k in keys:
            by_key.setdefault(k, name)
    for k in difflib.get_close_matches(wanted, list(by_key), n=5, cutoff=0.75):
        close.append(by_key[k])
    result["suggestions"] = list(dict.fromkeys(close))[:5]
    return result


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
