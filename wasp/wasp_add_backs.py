"""
wasp_add_backs.py
=================
Add stock back into WASP InventoryCloud from a CSV of
(item_number, location_code, quantity) rows -- e.g. the handwritten
"Add Backs" sheets.

Uses the WASP public API "Add Inventory" transaction:

    POST {base_url}/public-api/transactions/item/add
    Authorization: Bearer <API token>

Plain REST calls via `requests`, same style as qbo_client.py.

Credentials (never commit them) come from environment variables, or from
wasp_config.json next to this file (gitignored):

    WASP_BASE_URL   e.g. https://yourcompany.waspinventorycloud.com
    WASP_API_TOKEN  the API token from WASP (Settings -> Access Tokens)
    WASP_SITE_NAME  the WASP site the locations belong to

Usage:

    # Dry run (default): shows exactly what would be sent, sends nothing
    python wasp_add_backs.py add_backs_2026-09-25.csv

    # Actually post to WASP
    python wasp_add_backs.py add_backs_2026-09-25.csv --commit

Rows with something in the `check` column are skipped unless you pass
--include-flagged, so questionable handwriting reads don't go in blind.
"""

import argparse
import csv
import datetime
import json
import os
import sys

import requests

APP_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(APP_DIR, "wasp_config.json")
ADD_PATH = "/public-api/transactions/item/add"


class WaspError(Exception):
    pass


def load_settings(args):
    file_cfg = {}
    if os.path.exists(CONFIG_FILE):
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            file_cfg = json.load(f)

    def pick(cli, env, key):
        return cli or os.environ.get(env) or file_cfg.get(key)

    base_url = pick(args.base_url, "WASP_BASE_URL", "base_url")
    token = os.environ.get("WASP_API_TOKEN") or file_cfg.get("api_token")
    site = pick(args.site, "WASP_SITE_NAME", "site_name")
    return (base_url or "").rstrip("/"), token, site


def read_rows(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        rows = []
        for i, r in enumerate(csv.DictReader(f), start=2):
            item = (r.get("item_number") or "").strip()
            if not item:
                continue
            rows.append({
                "line": i,
                "item_number": item,
                "location_code": (r.get("location_code") or "").strip(),
                "quantity": float(r["quantity"]),
                "check": (r.get("check") or "").strip(),
                "source": (r.get("source") or "").strip(),
            })
        return rows


def build_record(row, site, notes, date_acquired):
    return {
        "ItemNumber": row["item_number"],
        "Quantity": row["quantity"],
        "SiteName": site,
        "LocationCode": row["location_code"],
        "DateAcquired": date_acquired,
        "Notes": notes,
    }


def post_add(base_url, token, records):
    resp = requests.post(
        base_url + ADD_PATH,
        headers={
            "Authorization": "Bearer " + token,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        json=records,
        timeout=30,
    )
    try:
        body = resp.json()
    except ValueError:
        body = {"raw": resp.text[:500]}
    if resp.status_code >= 400:
        raise WaspError(f"HTTP {resp.status_code}: {json.dumps(body)[:500]}")
    # WASP returns 200 with HasError/Messages for per-record problems.
    if isinstance(body, dict) and body.get("HasError"):
        msgs = [m.get("Message", str(m)) for m in body.get("Messages") or []]
        raise WaspError("; ".join(msgs) or json.dumps(body)[:500])
    return body


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[1])
    ap.add_argument("csv_file")
    ap.add_argument("--commit", action="store_true", help="actually post to WASP")
    ap.add_argument("--include-flagged", action="store_true",
                    help="also send rows that have a note in the `check` column")
    ap.add_argument("--site", help="WASP site name (overrides WASP_SITE_NAME)")
    ap.add_argument("--base-url", help="overrides WASP_BASE_URL")
    ap.add_argument("--notes", default="Add back",
                    help="note attached to each transaction")
    args = ap.parse_args()

    base_url, token, site = load_settings(args)
    rows = read_rows(args.csv_file)
    date_acquired = datetime.date.today().isoformat()
    notes = f"{args.notes} ({os.path.basename(args.csv_file)})"

    to_send = [r for r in rows if args.include_flagged or not r["check"]]
    skipped = [r for r in rows if r not in to_send]

    print(f"{len(rows)} rows read, {len(to_send)} to send, {len(skipped)} flagged/skipped")
    print(f"Site: {site or '(NOT SET)'}   Mode: {'COMMIT' if args.commit else 'DRY RUN'}\n")
    for r in skipped:
        print(f"  SKIP  line {r['line']:>2}  {r['item_number']:<22} {r['location_code']:<16} "
              f"x{r['quantity']:g}   <- {r['check']}")

    if not args.commit:
        print("\nWould send:")
        for r in to_send:
            print("  " + json.dumps(build_record(r, site, notes, date_acquired)))
        print("\nDry run only. Re-run with --commit to post to WASP.")
        return 0

    missing = [n for n, v in (("WASP_BASE_URL", base_url), ("WASP_API_TOKEN", token),
                              ("WASP_SITE_NAME", site)) if not v]
    if missing:
        print("Missing settings: " + ", ".join(missing), file=sys.stderr)
        return 2

    # One row per request so a bad item/location only fails that row.
    ok, failed = 0, []
    for r in to_send:
        label = f"line {r['line']:>2}  {r['item_number']:<22} {r['location_code']:<16} x{r['quantity']:g}"
        try:
            post_add(base_url, token, [build_record(r, site, notes, date_acquired)])
            ok += 1
            print(f"  OK    {label}")
        except (WaspError, requests.RequestException) as e:
            failed.append((r, str(e)))
            print(f"  FAIL  {label}   {e}")

    print(f"\n{ok} added, {len(failed)} failed, {len(skipped)} skipped (flagged)")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
