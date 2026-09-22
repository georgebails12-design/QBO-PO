"""
app.py
======
Web version of the QuickBooks Purchase Order tool -- same qbo_client.py /
glass_pdf_parser.py / cardinal_glass_output.py business logic as the
desktop app, behind individual logins, reachable by URL.

Run with:
    python app.py
(or via a WSGI server like gunicorn/waitress in production -- see README.md)

Requires FLASK_SECRET_KEY to be set in the environment in production so
login sessions survive a restart; a random one is generated otherwise
(logs everyone out on every restart, but never insecure-by-default).
"""

import concurrent.futures
import os
import secrets
import tempfile
import threading
import time
import uuid

import requests
from flask import Flask, Response, jsonify, redirect, render_template, request, send_file, session, url_for

import auth
import cardinal_glass_output
import glass_pdf_parser
import qbo_client

APP_DIR = os.path.dirname(os.path.abspath(__file__))
DOWNLOAD_DIR = os.path.join(APP_DIR, "downloads")
os.makedirs(DOWNLOAD_DIR, exist_ok=True)

app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY") or secrets.token_hex(32)
app.config["PERMANENT_SESSION_LIFETIME"] = 60 * 60 * 12  # 12 hours

TOKEN_LOCK = threading.Lock()  # serialize QBO token refreshes across concurrent users

REFRESH_JOBS = {}
REFRESH_LOCK = threading.Lock()


def err(message, code=400):
    return jsonify({"error": str(message)}), code


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        if auth.verify_login(username, password):
            session.clear()
            session["username"] = username
            session.permanent = True
            return redirect(request.args.get("next") or url_for("index"))
        return render_template("login.html", error="Invalid username or password."), 401
    return render_template("login.html", error=None)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------
@app.route("/")
@auth.login_required
def index():
    return render_template("purchase_order.html", user=auth.current_user())


@app.route("/categories")
@auth.login_required
def categories_page():
    return render_template("manage_categories.html", user=auth.current_user())


@app.route("/purchase-orders")
@auth.login_required
def purchase_orders_page():
    return render_template("view_purchase_orders.html", user=auth.current_user())


# ---------------------------------------------------------------------------
# Reference data (vendors/items/accounts/customers) -- cached like the
# desktop app; refreshing is slow (thousands of records) so it runs as a
# background job the page polls, instead of blocking the request.
# ---------------------------------------------------------------------------
@app.route("/api/reference")
@auth.login_required
def api_reference():
    cache = qbo_client.load_reference_cache()
    if not cache:
        return jsonify({"vendors": [], "items": [], "accounts": [], "customers": [], "fetched_at": None})
    return jsonify(cache)


@app.route("/api/reference/refresh", methods=["POST"])
@auth.login_required
def api_reference_refresh():
    job_id = uuid.uuid4().hex
    with REFRESH_LOCK:
        REFRESH_JOBS[job_id] = {"status": "running", "error": None}

    def work():
        try:
            with TOKEN_LOCK:
                qbo_client.get_valid_access_token()
            with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                vf = pool.submit(qbo_client.get_vendors)
                itf = pool.submit(qbo_client.get_items)
                af = pool.submit(qbo_client.get_accounts)
                cf = pool.submit(qbo_client.get_customers)
                vendors, items, accounts, customers = vf.result(), itf.result(), af.result(), cf.result()
            qbo_client.save_reference_cache(vendors, items, accounts, customers)
            with REFRESH_LOCK:
                REFRESH_JOBS[job_id] = {"status": "done", "error": None}
        except Exception as exc:  # noqa: BLE001
            with REFRESH_LOCK:
                REFRESH_JOBS[job_id] = {"status": "error", "error": str(exc)}

    threading.Thread(target=work, daemon=True).start()
    return jsonify({"job_id": job_id})


@app.route("/api/reference/refresh/<job_id>")
@auth.login_required
def api_reference_refresh_status(job_id):
    with REFRESH_LOCK:
        job = REFRESH_JOBS.get(job_id)
    if not job:
        return err("Unknown job id.", 404)
    return jsonify(job)


# ---------------------------------------------------------------------------
# Categories
# ---------------------------------------------------------------------------
@app.route("/api/categories")
@auth.login_required
def api_categories():
    return jsonify(qbo_client.load_categories())


@app.route("/api/categories/qbo")
@auth.login_required
def api_categories_qbo():
    with TOKEN_LOCK:
        qbo_client.get_valid_access_token()
    try:
        return jsonify(qbo_client.get_item_categories())
    except qbo_client.QBOError as exc:
        return err(exc, 502)


@app.route("/api/accounts")
@auth.login_required
def api_accounts():
    with TOKEN_LOCK:
        qbo_client.get_valid_access_token()
    try:
        return jsonify(qbo_client.get_accounts())
    except qbo_client.QBOError as exc:
        return err(exc, 502)


@app.route("/api/categories", methods=["POST"])
@auth.login_required
def api_categories_save():
    data = request.get_json(force=True)
    name = (data.get("name") or "").strip()
    income = data.get("income_account") or {}
    expense = data.get("expense_account") or {}
    if not name or not income.get("id") or not expense.get("id"):
        return err("name, income_account, and expense_account are required.")
    qbo_client.set_category(name, income["id"], income.get("name", ""), expense["id"], expense.get("name", ""))
    return jsonify(qbo_client.load_categories())


@app.route("/api/categories/<name>", methods=["DELETE"])
@auth.login_required
def api_categories_delete(name):
    qbo_client.delete_category(name)
    return jsonify(qbo_client.load_categories())


# ---------------------------------------------------------------------------
# Items
# ---------------------------------------------------------------------------
@app.route("/api/items", methods=["POST"])
@auth.login_required
def api_items_create():
    data = request.get_json(force=True)
    name = (data.get("name") or "").strip()
    category = (data.get("category") or "").strip()
    categories = qbo_client.load_categories()
    if not name:
        return err("Name is required.")
    if category not in categories:
        return err("Choose a valid, mapped category.")
    try:
        price = float(data.get("price") or 0)
    except (TypeError, ValueError):
        return err("Price must be a number.")

    mapping = categories[category]
    with TOKEN_LOCK:
        qbo_client.get_valid_access_token()
    try:
        created = qbo_client.create_item(
            name=name, description=(data.get("description") or "").strip(), price=price,
            income_account_id=mapping["income_account"]["id"],
            expense_account_id=mapping["expense_account"]["id"],
        )
    except qbo_client.QBOError as exc:
        return err(exc, 502)

    item = {
        "id": created["id"], "name": created["name"], "description": (data.get("description") or "").strip(),
        "unit_price": price, "purchase_cost": price, "type": "NonInventory",
    }
    cache = qbo_client.load_reference_cache() or {"vendors": [], "items": [], "accounts": [], "customers": [], "fetched_at": time.time()}
    cache["items"].append(item)
    qbo_client.save_reference_cache(cache["vendors"], cache["items"], cache["accounts"], cache["customers"])
    return jsonify(item)


# ---------------------------------------------------------------------------
# Purchase orders
# ---------------------------------------------------------------------------
@app.route("/api/po-number/suggest")
@auth.login_required
def api_po_number_suggest():
    with TOKEN_LOCK:
        qbo_client.get_valid_access_token()
    try:
        return jsonify({"next": qbo_client.suggest_next_po_number()})
    except qbo_client.QBOError as exc:
        return err(exc, 502)


@app.route("/api/purchase-order", methods=["POST"])
@auth.login_required
def api_purchase_order_create():
    data = request.get_json(force=True)
    vendor_id = data.get("vendor_id")
    item_lines = data.get("item_lines") or []
    category_lines = data.get("category_lines") or []
    if not vendor_id:
        return err("vendor_id is required.")
    if not item_lines and not category_lines:
        return err("Add at least one line item or category line.")

    with TOKEN_LOCK:
        qbo_client.get_valid_access_token()
    try:
        result = qbo_client.create_purchase_order(
            vendor_id=vendor_id, item_lines=item_lines, category_lines=category_lines,
            memo=data.get("memo") or None, txn_date=data.get("txn_date") or None,
            q_project=data.get("q_project") or None, doc_number=data.get("doc_number") or None,
        )
    except qbo_client.QBOError as exc:
        return err(exc, 502)

    return jsonify(result)


# ---------------------------------------------------------------------------
# Glass PDF import -> Cardinal CSV
# ---------------------------------------------------------------------------
@app.route("/api/glass-pdf", methods=["POST"])
@auth.login_required
def api_glass_pdf_parse():
    file = request.files.get("file")
    if not file or not file.filename:
        return err("No file uploaded.")
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as tmp:
        file.save(tmp.name)
        tmp_path = tmp.name
    try:
        parsed = glass_pdf_parser.parse_glass_pdf(tmp_path)
    except ValueError as exc:
        return err(exc)
    finally:
        os.unlink(tmp_path)
    return jsonify(parsed)


@app.route("/api/cardinal-csv", methods=["POST"])
@auth.login_required
def api_cardinal_csv():
    data = request.get_json(force=True)
    units = data.get("units") or []
    po_number = (data.get("po_number") or "").strip()
    job_number = data.get("job_number")
    if not po_number:
        return err("po_number is required.")
    if not units:
        return err("No units provided.")

    line_items, skipped, spacer_types_seen = [], [], []
    for unit in units:
        item, flags = cardinal_glass_output.line_item_from_parsed_unit(unit)
        if item is None:
            skipped.append({"unit": unit.get("unit"), "reasons": flags})
            continue
        line_items.append(item)
        spacer_types_seen.append(getattr(item, "spc_type_parsed", None))

    if not line_items:
        return jsonify({"error": "None of the units could be turned into a Cardinal line item.", "skipped": skipped}), 400

    spacer_type = next((s for s in spacer_types_seen if s), "BLACK SS")
    mismatched = [li.unit_number for li, s in zip(line_items, spacer_types_seen) if s and s != spacer_type]

    import warnings
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        batch = cardinal_glass_output.Batch(
            po_number=po_number, job_number=job_number, items=line_items, spacer_type=spacer_type,
        )
        path = cardinal_glass_output.generate_batch_csv(batch, output_dir=DOWNLOAD_DIR)

    return jsonify({
        "download_url": url_for("download_file", name=os.path.basename(path)),
        "count": len(line_items),
        "skipped": skipped,
        "mismatched_spacer": mismatched,
        "warnings": [str(w.message) for w in caught],
    })


# ---------------------------------------------------------------------------
# View existing purchase orders, and file attachments on them
# ---------------------------------------------------------------------------
@app.route("/api/purchase-orders")
@auth.login_required
def api_purchase_orders_search():
    with TOKEN_LOCK:
        qbo_client.get_valid_access_token()
    doc_number = (request.args.get("doc_number") or "").strip() or None
    vendor_id = (request.args.get("vendor_id") or "").strip() or None
    try:
        results = qbo_client.search_purchase_orders(doc_number=doc_number, vendor_id=vendor_id, limit=25)
    except qbo_client.QBOError as exc:
        return err(exc, 502)
    return jsonify([qbo_client.format_purchase_order(po) for po in results])


@app.route("/api/purchase-orders/<po_id>")
@auth.login_required
def api_purchase_order_detail(po_id):
    with TOKEN_LOCK:
        qbo_client.get_valid_access_token()
    try:
        po = qbo_client.get_purchase_order(po_id)
        if not po:
            return err("Purchase order not found.", 404)
        formatted = qbo_client.format_purchase_order(po)
        formatted["attachments"] = qbo_client.get_attachments_for_entity("PurchaseOrder", po_id)
    except qbo_client.QBOError as exc:
        return err(exc, 502)
    return jsonify(formatted)


@app.route("/api/purchase-orders/<po_id>", methods=["PUT"])
@auth.login_required
def api_purchase_order_update(po_id):
    data = request.get_json(force=True)
    item_lines = data.get("item_lines")
    category_lines = data.get("category_lines")
    if (item_lines is not None or category_lines is not None) and not (item_lines or category_lines):
        return err("Add at least one line item or category line.")

    with TOKEN_LOCK:
        qbo_client.get_valid_access_token()
    try:
        qbo_client.update_purchase_order(
            po_id, item_lines=item_lines, category_lines=category_lines,
            memo=data.get("memo"), txn_date=data.get("txn_date") or None, q_project=data.get("q_project"),
        )
        po = qbo_client.get_purchase_order(po_id)
        formatted = qbo_client.format_purchase_order(po)
        formatted["attachments"] = qbo_client.get_attachments_for_entity("PurchaseOrder", po_id)
    except qbo_client.QBOError as exc:
        return err(exc, 502)
    return jsonify(formatted)


@app.route("/api/purchase-orders/<po_id>/pdf")
@auth.login_required
def api_purchase_order_pdf(po_id):
    with TOKEN_LOCK:
        qbo_client.get_valid_access_token()
    try:
        pdf_bytes = qbo_client.get_purchase_order_pdf(po_id)
    except qbo_client.QBOError as exc:
        return err(exc, 502)
    return Response(
        pdf_bytes, mimetype="application/pdf",
        headers={"Content-Disposition": f'inline; filename="PO-{po_id}.pdf"'},
    )


@app.route("/api/purchase-orders/<po_id>/attachments", methods=["POST"])
@auth.login_required
def api_purchase_order_attach(po_id):
    file = request.files.get("file")
    if not file or not file.filename:
        return err("No file uploaded.")
    content = file.read()
    if len(content) > 25 * 1024 * 1024:
        return err("File is too large (25MB limit).")
    with TOKEN_LOCK:
        qbo_client.get_valid_access_token()
    try:
        result = qbo_client.upload_attachment(
            "PurchaseOrder", po_id, file.filename, content, file.mimetype or "application/octet-stream",
        )
    except qbo_client.QBOError as exc:
        return err(exc, 502)
    return jsonify(result)


@app.route("/api/attachments/<attachable_id>", methods=["DELETE"])
@auth.login_required
def api_attachment_delete(attachable_id):
    with TOKEN_LOCK:
        qbo_client.get_valid_access_token()
    try:
        qbo_client.delete_attachment(attachable_id)
    except qbo_client.QBOError as exc:
        return err(exc, 502)
    return jsonify({"deleted": True})


@app.route("/api/attachments/<attachable_id>/download")
@auth.login_required
def api_attachment_download(attachable_id):
    with TOKEN_LOCK:
        qbo_client.get_valid_access_token()
    try:
        temp_url = qbo_client.get_attachment_download_url(attachable_id)
    except qbo_client.QBOError as exc:
        return err(exc, 502)
    upstream = requests.get(temp_url, timeout=30)
    if upstream.status_code != 200:
        return err("Could not download the file from QuickBooks.", 502)
    return Response(upstream.content, mimetype=upstream.headers.get("Content-Type", "application/octet-stream"))


@app.route("/downloads/<name>")
@auth.login_required
def download_file(name):
    path = os.path.join(DOWNLOAD_DIR, name)
    if not os.path.abspath(path).startswith(os.path.abspath(DOWNLOAD_DIR)) or not os.path.exists(path):
        return err("Not found.", 404)
    return send_file(path, as_attachment=True, download_name=name)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5050, debug=False)
