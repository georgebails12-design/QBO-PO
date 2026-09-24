"""
assign_item_categories.py
=========================
Moves existing QBO Products/Services into a Product/Service Category, from a
CSV with "Name" and "Category" columns (default: item_category_updates.csv).
Run it on the server, where qbo_tokens.json lives, as the app's user:

    python assign_item_categories.py            # dry run: shows what would change
    python assign_item_categories.py --apply    # makes the changes in QuickBooks

Only items with no category yet (top-level items) are matched by name, so an
item that already sits in a category is never moved. Rows whose name or
category can't be found, or match more than one item, are listed and skipped.
"""
import csv
import os
import sys

import qbo_client

DEFAULT_CSV = os.path.join(qbo_client.APP_DIR, "item_category_updates.csv")

# Read-only fields QBO returns on an Item that don't belong in an update.
READ_ONLY_FIELDS = ("FullyQualifiedName", "Level", "MetaData", "domain", "sparse")


def _norm(name):
    return " ".join((name or "").split()).lower()


def load_rows(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        return [(r["Name"], r["Category"].strip()) for r in csv.DictReader(f) if (r.get("Category") or "").strip()]


def main():
    args = [a for a in sys.argv[1:] if a != "--apply"]
    apply = "--apply" in sys.argv[1:]
    rows = load_rows(args[0] if args else DEFAULT_CSV)

    categories = {}
    for c in qbo_client.get_item_categories():
        categories.setdefault(_norm(c["name"]), []).append(c)

    top_level = {}
    for it in qbo_client._query("SELECT * FROM Item WHERE Active = true"):
        if it.get("Type") == "Category" or it.get("ParentRef"):
            continue
        top_level.setdefault(_norm(it.get("Name")), []).append(it)

    planned, problems = [], []
    for name, category in rows:
        cats = categories.get(_norm(category), [])
        items = top_level.get(_norm(name), [])
        if len(cats) != 1:
            problems.append(f"{name!r}: category {category!r} {'not found' if not cats else 'is ambiguous'}")
        elif len(items) != 1:
            problems.append(f"{name!r}: {'no uncategorized item with this name' if not items else 'matches several items'}")
        else:
            planned.append((items[0], cats[0]))

    for item, cat in planned:
        print(f"{'MOVE' if apply else 'WOULD MOVE'}: {item['Name']!r} -> {cat['name']}")
    for p in problems:
        print(f"SKIP: {p}")

    if not apply:
        print(f"\nDry run: {len(planned)} to move, {len(problems)} skipped. Re-run with --apply to make the changes.")
        return

    moved, failed = 0, 0
    for item, cat in planned:
        payload = {k: v for k, v in item.items() if k not in READ_ONLY_FIELDS}
        payload["SubItem"] = True
        payload["ParentRef"] = {"value": str(cat["id"])}
        try:
            qbo_client._post("item", payload)
            moved += 1
        except qbo_client.QBOError as e:
            failed += 1
            print(f"FAILED: {item['Name']!r}: {e}")
    print(f"\nMoved {moved}, failed {failed}, skipped {len(problems)}.")


if __name__ == "__main__":
    main()
