"""
qbo_client.py
=============
Thin QuickBooks Online (QBO) Accounting API client used by
purchase_order_gui.py and qbo_auth_setup.py.

Handles:
  * OAuth2 (authorization-code) token exchange / refresh, persisted to
    qbo_tokens.json (never committed -- see .gitignore).
  * App credentials (Client ID/Secret, environment) persisted to
    qbo_config.json (never committed).
  * Reading vendors, items, and accounts from QBO.
  * Creating a two-sided (buy + sell) Item with the Income/Expense accounts
    pulled from the category -> account mapping in po_categories.json.
  * Creating a real PurchaseOrder transaction in QBO.

No QBO SDK dependency -- plain REST calls via `requests`, same style as the
WASP API calls in wasp_pick_editor.py.
"""

import json
import os
import time
import urllib.parse

import requests

APP_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_FILE = os.path.join(APP_DIR, "qbo_config.json")
TOKENS_FILE = os.path.join(APP_DIR, "qbo_tokens.json")
CATEGORIES_FILE = os.path.join(APP_DIR, "po_categories.json")
REFERENCE_CACHE_FILE = os.path.join(APP_DIR, "qbo_reference_cache.json")

AUTH_URL = "https://appcenter.intuit.com/connect/oauth2"
TOKEN_URL = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer"
SCOPE = "com.intuit.quickbooks.accounting"
MINOR_VERSION = "65"

TOKEN_REFRESH_MARGIN_SECONDS = 300  # refresh if access token expires within 5 min


class QBOError(Exception):
    """Raised for QBO auth/config/API errors, with a message safe to show in the GUI."""


# ---------------------------------------------------------------------------
# Config (Client ID / Secret / environment) and token persistence
# ---------------------------------------------------------------------------
def load_config():
    if not os.path.exists(CONFIG_FILE):
        return None
    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def save_config(client_id, client_secret, environment, redirect_uri):
    config = {
        "client_id": client_id,
        "client_secret": client_secret,
        "environment": environment,  # "sandbox" or "production"
        "redirect_uri": redirect_uri,
    }
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)
    return config


def load_tokens():
    if not os.path.exists(TOKENS_FILE):
        return None
    with open(TOKENS_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def save_tokens(access_token, refresh_token, expires_in, realm_id):
    tokens = {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "expires_at": time.time() + float(expires_in),
        "realm_id": realm_id,
    }
    with open(TOKENS_FILE, "w", encoding="utf-8") as f:
        json.dump(tokens, f, indent=2)
    return tokens


def is_connected():
    return load_config() is not None and load_tokens() is not None


# ---------------------------------------------------------------------------
# OAuth2 flow
# ---------------------------------------------------------------------------
def build_authorization_url(client_id, redirect_uri, state):
    params = {
        "client_id": client_id,
        "response_type": "code",
        "scope": SCOPE,
        "redirect_uri": redirect_uri,
        "state": state,
    }
    return f"{AUTH_URL}?{urllib.parse.urlencode(params)}"


def exchange_code_for_tokens(client_id, client_secret, code, redirect_uri):
    resp = requests.post(
        TOKEN_URL,
        auth=(client_id, client_secret),
        headers={"Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded"},
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
        },
        timeout=30,
    )
    if resp.status_code != 200:
        raise QBOError(f"Token exchange failed ({resp.status_code}): {resp.text}")
    return resp.json()


def _refresh_access_token(config, tokens):
    resp = requests.post(
        TOKEN_URL,
        auth=(config["client_id"], config["client_secret"]),
        headers={"Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded"},
        data={
            "grant_type": "refresh_token",
            "refresh_token": tokens["refresh_token"],
        },
        timeout=30,
    )
    if resp.status_code != 200:
        raise QBOError(
            "QuickBooks refresh token is no longer valid -- reconnect via qbo_auth_setup.py. "
            f"({resp.status_code}: {resp.text})"
        )
    data = resp.json()
    return save_tokens(
        access_token=data["access_token"],
        refresh_token=data.get("refresh_token", tokens["refresh_token"]),
        expires_in=data["expires_in"],
        realm_id=tokens["realm_id"],
    )


def get_valid_access_token():
    """Return a non-expired access token, refreshing it first if needed."""
    config = load_config()
    tokens = load_tokens()
    if not config or not tokens:
        raise QBOError("Not connected to QuickBooks yet -- run qbo_auth_setup.py first.")

    if tokens["expires_at"] - time.time() < TOKEN_REFRESH_MARGIN_SECONDS:
        tokens = _refresh_access_token(config, tokens)

    return tokens["access_token"], tokens["realm_id"], config["environment"]


# ---------------------------------------------------------------------------
# Low-level API helpers
# ---------------------------------------------------------------------------
def _api_base(environment, realm_id):
    host = "sandbox-quickbooks.api.intuit.com" if environment == "sandbox" else "quickbooks.api.intuit.com"
    return f"https://{host}/v3/company/{realm_id}"


def _headers(access_token):
    return {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json",
        "Content-Type": "application/json",
    }


def _get(path, params=None):
    access_token, realm_id, environment = get_valid_access_token()
    url = f"{_api_base(environment, realm_id)}/{path}"
    query = dict(params or {})
    query["minorversion"] = MINOR_VERSION
    resp = requests.get(url, headers=_headers(access_token), params=query, timeout=30)
    if resp.status_code != 200:
        raise QBOError(f"QuickBooks GET {path} failed ({resp.status_code}): {resp.text}")
    return resp.json()


def _post(path, payload):
    access_token, realm_id, environment = get_valid_access_token()
    url = f"{_api_base(environment, realm_id)}/{path}"
    resp = requests.post(
        url, headers=_headers(access_token), params={"minorversion": MINOR_VERSION},
        data=json.dumps(payload), timeout=30,
    )
    if resp.status_code not in (200, 201):
        raise QBOError(f"QuickBooks POST {path} failed ({resp.status_code}): {resp.text}")
    return resp.json()


def _query(sql):
    """Run a QBO SQL-like query, transparently paging through all results."""
    results = []
    start = 1
    page_size = 1000
    while True:
        paged_sql = f"{sql} STARTPOSITION {start} MAXRESULTS {page_size}"
        data = _get("query", params={"query": paged_sql})
        query_response = data.get("QueryResponse", {})
        entity_key = next((k for k in query_response if k != "startPosition" and k != "maxResults" and k != "totalCount"), None)
        rows = query_response.get(entity_key, []) if entity_key else []
        results.extend(rows)
        if len(rows) < page_size:
            break
        start += page_size
    return results


def get_company_info():
    access_token, realm_id, environment = get_valid_access_token()
    data = _get(f"companyinfo/{realm_id}")
    return data.get("CompanyInfo", {})


# ---------------------------------------------------------------------------
# Vendors / Items / Accounts
# ---------------------------------------------------------------------------
def get_vendors():
    rows = _query("SELECT Id, DisplayName, CompanyName, Active FROM Vendor WHERE Active = true ORDER BY DisplayName")
    return [{"id": v["Id"], "name": v.get("DisplayName") or v.get("CompanyName")} for v in rows]


def get_items():
    rows = _query(
        "SELECT Id, Name, Description, UnitPrice, PurchaseCost, Type, Active "
        "FROM Item WHERE Active = true ORDER BY Name"
    )
    items = []
    for it in rows:
        items.append({
            "id": it["Id"],
            "name": it.get("Name"),
            "description": it.get("Description", ""),
            "unit_price": it.get("UnitPrice"),
            "purchase_cost": it.get("PurchaseCost"),
            "type": it.get("Type"),
        })
    return items


def get_item_categories():
    """QuickBooks' own Product/Service Categories (Item entities with Type == 'Category')."""
    rows = _query(
        "SELECT Id, Name, Active FROM Item WHERE Type = 'Category' AND Active = true ORDER BY Name"
    )
    return [{"id": c["Id"], "name": c["Name"]} for c in rows]


def get_customers():
    """Customers and QBO 'Projects' (sub-customers) -- used for the Customer/Project field on PO lines."""
    rows = _query(
        "SELECT Id, DisplayName, FullyQualifiedName, Active FROM Customer WHERE Active = true ORDER BY FullyQualifiedName"
    )
    return [{"id": c["Id"], "name": c.get("FullyQualifiedName") or c.get("DisplayName")} for c in rows]


def get_accounts(account_type=None):
    """account_type: e.g. 'Expense', 'Cost of Goods Sold', 'Income' -- or None for all."""
    sql = "SELECT Id, Name, AccountType, AccountSubType, Active FROM Account WHERE Active = true"
    if account_type:
        sql += f" AND AccountType = '{account_type}'"
    sql += " ORDER BY Name"
    rows = _query(sql)
    return [{"id": a["Id"], "name": a["Name"], "account_type": a.get("AccountType")} for a in rows]


def create_item(name, description, price, income_account_id, expense_account_id, item_type="NonInventory"):
    """Create a two-sided QBO Item (bought and sold) using the accounts mapped to its category."""
    payload = {
        "Name": name,
        "Type": item_type,
        "IncomeAccountRef": {"value": str(income_account_id)},
        "ExpenseAccountRef": {"value": str(expense_account_id)},
        "UnitPrice": price,
        "PurchaseCost": price,
        "Description": description,
        "PurchaseDesc": description,
        "TrackQtyOnHand": False,
    }
    data = _post("item", payload)
    item = data.get("Item", {})
    return {"id": item.get("Id"), "name": item.get("Name")}


# This company's "Q#/Project" custom field on PurchaseOrder (confirmed via a live PO: DefinitionId "2").
Q_PROJECT_CUSTOM_FIELD_DEFINITION_ID = "2"
Q_PROJECT_CUSTOM_FIELD_NAME = "Q#/Project"


def suggest_next_po_number():
    """This company has Custom Transaction Numbers on -- QuickBooks won't
    auto-assign a PO number via the API, so suggest one by incrementing the
    most recently created PO's number. Returns None if that can't be inferred."""
    data = _get("query", params={
        "query": "SELECT DocNumber FROM PurchaseOrder ORDERBY MetaData.CreateTime DESC MAXRESULTS 1"
    })
    rows = data.get("QueryResponse", {}).get("PurchaseOrder", [])
    if not rows:
        return None
    doc_number = (rows[0].get("DocNumber") or "").strip()
    if doc_number.isdigit():
        return str(int(doc_number) + 1)
    return None


def create_purchase_order(
    vendor_id, item_lines=None, category_lines=None, memo=None, txn_date=None,
    ship_to_addr=None, q_project=None, doc_number=None,
):
    """
    item_lines: list of {"item_id", "description", "qty", "unit_price", "customer_id"?}
    category_lines: list of {"account_id", "description", "amount", "customer_id"?}
    (matches QuickBooks' own PO screen: "Item details" lines reference a
    Product/Service; "Category details" lines post straight to an account.)
    """
    po_lines = []

    for line in (item_lines or []):
        qty = float(line["qty"])
        unit_price = float(line["unit_price"])
        detail = {"ItemRef": {"value": str(line["item_id"])}, "Qty": qty, "UnitPrice": unit_price}
        if line.get("customer_id"):
            detail["CustomerRef"] = {"value": str(line["customer_id"])}
        po_lines.append({
            "DetailType": "ItemBasedExpenseLineDetail",
            "Amount": round(qty * unit_price, 2),
            "Description": line.get("description", ""),
            "ItemBasedExpenseLineDetail": detail,
        })

    for line in (category_lines or []):
        detail = {"AccountRef": {"value": str(line["account_id"])}}
        if line.get("customer_id"):
            detail["CustomerRef"] = {"value": str(line["customer_id"])}
        po_lines.append({
            "DetailType": "AccountBasedExpenseLineDetail",
            "Amount": round(float(line["amount"]), 2),
            "Description": line.get("description", ""),
            "AccountBasedExpenseLineDetail": detail,
        })

    payload = {
        "VendorRef": {"value": str(vendor_id)},
        "Line": po_lines,
    }
    if doc_number:
        payload["DocNumber"] = str(doc_number)
    if memo:
        payload["PrivateNote"] = memo
    if txn_date:
        payload["TxnDate"] = txn_date
    if ship_to_addr:
        payload["ShipAddr"] = ship_to_addr
    if q_project:
        payload["CustomField"] = [{
            "DefinitionId": Q_PROJECT_CUSTOM_FIELD_DEFINITION_ID,
            "Name": Q_PROJECT_CUSTOM_FIELD_NAME,
            "Type": "StringType",
            "StringValue": q_project,
        }]

    data = _post("purchaseorder", payload)
    po = data.get("PurchaseOrder", {})
    return {"id": po.get("Id"), "doc_number": po.get("DocNumber"), "raw": po}


# ---------------------------------------------------------------------------
# Category -> account mapping (limits which categories the GUI offers)
# ---------------------------------------------------------------------------
def load_categories():
    if not os.path.exists(CATEGORIES_FILE):
        return {}
    with open(CATEGORIES_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def save_categories(categories):
    with open(CATEGORIES_FILE, "w", encoding="utf-8") as f:
        json.dump(categories, f, indent=2)


def set_category(name, income_account_id, income_account_name, expense_account_id, expense_account_name):
    categories = load_categories()
    categories[name] = {
        "income_account": {"id": income_account_id, "name": income_account_name},
        "expense_account": {"id": expense_account_id, "name": expense_account_name},
    }
    save_categories(categories)
    return categories


def delete_category(name):
    categories = load_categories()
    categories.pop(name, None)
    save_categories(categories)
    return categories


# ---------------------------------------------------------------------------
# Local cache of vendors/items/accounts/customers -- these lists can be
# thousands of records each (QuickBooks paginates at 1000/request), so we
# avoid re-fetching all of them from QuickBooks on every app launch.
# ---------------------------------------------------------------------------
def load_reference_cache():
    if not os.path.exists(REFERENCE_CACHE_FILE):
        return None
    with open(REFERENCE_CACHE_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def save_reference_cache(vendors, items, accounts, customers):
    cache = {
        "fetched_at": time.time(),
        "vendors": vendors,
        "items": items,
        "accounts": accounts,
        "customers": customers,
    }
    with open(REFERENCE_CACHE_FILE, "w", encoding="utf-8") as f:
        json.dump(cache, f)
    return cache
