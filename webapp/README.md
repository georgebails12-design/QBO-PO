# Purchase Order Tool -- Web Version

Browser-based version of the QuickBooks Purchase Order tool, behind
individual logins. Same business logic as the desktop app
(`qbo_client.py`, `glass_pdf_parser.py`, `cardinal_glass_output.py`),
different front end.

## Local setup

```bash
python -m venv venv
venv/Scripts/activate   # or source venv/bin/activate on Linux
pip install -r requirements.txt
```

Copy `qbo_config.json` and `qbo_tokens.json` from the desktop tool's
folder into this one (same format -- the refresh token is portable, no
need to redo the QuickBooks OAuth flow). **Never commit these** -- both
are gitignored.

Create at least one login:

```bash
python manage_users.py add jsmith "Jane Smith"
```

Run it:

```bash
python app.py
```

Open <http://127.0.0.1:5050>.

## Logo

Drop the Panda Windows & Doors logo at `static/panda_logo.png` (PNG,
transparent or white background, ~600px wide). If it's missing, the
header/login page fall back to a plain text wordmark automatically --
nothing breaks either way.

## Production deployment

1. **Never use `python app.py`'s built-in server in production** -- it
   says so itself. Use a real WSGI server, e.g.:

   ```bash
   pip install waitress
   waitress-serve --host=127.0.0.1 --port=5050 app:app
   ```

   (or gunicorn on Linux: `gunicorn -w 2 -b 127.0.0.1:5050 app:app`)

2. **Set `FLASK_SECRET_KEY`** in the environment to a long random value
   (e.g. `python -c "import secrets; print(secrets.token_hex(32))"`).
   Without it, a key is generated once and saved to `flask_secret_key`
   (gitignored) next to `app.py`, so logins survive restarts and are shared
   by every worker. Delete that file to force everyone to log in again.

3. **Put a reverse proxy in front** (nginx, or Hostinger's own site
   config) that terminates HTTPS and forwards to `127.0.0.1:5050`. Never
   expose the Flask/WSGI port directly to the internet.

4. **Copy `qbo_config.json` / `qbo_tokens.json` onto the server** the
   same way you would locally -- outside of git, directly onto the
   filesystem (scp, sftp, or the host's file manager). Since the app's
   own public URL is now real, you can also simplify future reconnects
   by using `https://<your-domain>/` itself as the registered redirect
   URI instead of the GitHub Pages bridge page the desktop tool uses --
   that would need a small `/oauth/callback` route added here if you
   want that (not built yet, since the copied refresh token already
   works for daily use without reconnecting).

5. **Create real user accounts** with `manage_users.py` on the server,
   not the test one used during development.

## What's here vs. the desktop app

Full feature parity with the Tkinter tool: vendor/item/account/customer
type-ahead, Category Details + Item Details grids (with Customer/Project
per line and an "Apply to All Lines" shortcut), Q#/Project and PO #
(with auto-suggest), New Item creation, category-to-account mapping
management, Import Glass PDF with the same size-limit-aware Cardinal CSV
export. The one difference: reference data (vendors/items/accounts/
customers) is refreshed on-demand via a background job polled from the
page, since QuickBooks paginates at 1000 records/request and this
company's lists are large (thousands of each).

## Commission bills

`commission_bills.py` turns the payroll commission workbook
(`Payroll_Com_<date>.xlsx`) into one QuickBooks Bill per row, using the same
QuickBooks connection as the PO app. Run it from the app folder on the server:

```bash
venv/bin/pip install -r requirements.txt                       # once, for openpyxl
venv/bin/python commission_bills.py Payroll_Com_Oct_26th_2026.xlsx           # preview
venv/bin/python commission_bills.py Payroll_Com_Oct_26th_2026.xlsx --post    # create bills
```

Each bill: vendor = sales rep (column B), bill date = payment date (I),
due date = payroll date from the sheet name ("Oct 26") or `--due-date`,
bill no. = "17506 Final", memo = the line description, Q Number/PO # = column M
(the custom field is found from existing bills, or pass `--q-field-id`), category `6800 Sales Commissions`, class
`Operations`, customer = column F, amount = commission (O). Reps are mapped
to vendors in `commission_vendors.json` (a shared deal like "TE" lists
each vendor; the "2nd Comm" column is billed to the vendor under the
`"2nd Comm"` key). Bills that already exist (same
number and vendor) are skipped, so re-running is safe. `--export file.csv`
also writes the bills in the QuickBooks import-sheet layout.

### Commission support (scanned backup)

`commission_support.py` checks the scanned commission support PDF against
the workbook. It flags rows with no support page and invoice numbers in
the scan that aren't on the sheet, and splits the scan into one PDF per
invoice. Run it with `--attach` after posting to attach each invoice's PDF
to its bills (safe to re-run):

```bash
venv/bin/python commission_support.py Payroll_Com_Nov_9th_2026.xlsx support.pdf            # check
venv/bin/python commission_support.py Payroll_Com_Nov_9th_2026.xlsx support.pdf --attach   # after posting
```

### Commission Bills page

`/commissions` (Commission Bills in the menu) does the same steps from the browser:
1. Upload the commission workbook and the scanned support, and enter the payroll date and the first row of this payroll.
2. **Check** shows the bills, totals by vendor, rows that can't be billed, and missing or extra support.
3. **Post bills** creates them. Bills already in QuickBooks are skipped, so it's safe to click twice.
4. **Attach support** adds each invoice's scanned pages to all of its bills.

Each run is kept in `downloads/commissions/<id>/` (gitignored, excluded from deploys). Reopen a run with `?run=<id>`.

## Adjust Bills (pay foreign-currency bills in dollars)

Bills entered at a foreign-currency amount (e.g. ELVIAL invoices in euros) and paid
with one USD wire won't match the payment. `bill_adjust.py` re-prices the bills so
they add up to exactly the dollars paid. The payment is spread over the bills in
proportion to their amounts (one rate for the whole payment):

```bash
venv/bin/python bill_adjust.py ELVIAL 00125 06306 04502 04501 --total 73341.31            # preview
venv/bin/python bill_adjust.py ELVIAL 00125 06306 04502 04501 --total 73341.31 --apply    # update
```

- Bill numbers can be the full number (`INV-K-06306`) or just the ending (`06306`).
- `--mode scale` (default) multiplies every line by the rate, so item and job costs
  carry the real USD cost. `--mode line --account "<account>"` instead keeps the
  lines and adds one "Exchange difference" line per bill.
- Only fully unpaid, home-currency bills are changed. Part-paid bills are refused,
  and so are bills in a multicurrency foreign currency, which should be paid at the
  day's exchange rate instead.
- Each bill's memo records the original amount, rate and date. Re-running with the
  same total does nothing.

The **Adjust Bills** page (`/bill-adjust`) does the same from the browser: Preview,
then Update bills. After that, pay the bills in QuickBooks with the wire as usual.

## Glass Acknowledgement (Cardinal order acknowledgement -> PO)

`order_ack.py` reads Cardinal's "Order Acknowledgement Summary" PDF, finds the
purchase order by the PO # on it, checks every glass size against the PO, and puts
Cardinal's cost and requested date on the PO:

```bash
venv/bin/python order_ack.py Order_Acknowledgement_Summary.pdf                    # preview
venv/bin/python order_ack.py Order_Acknowledgement_Summary.pdf --apply --attach   # update the PO
```

- Lines are matched by size: Cardinal's `40 3/8X86 5/16` against the PO item
  `40 3/8" x 86 5/16" (Job# ... Unit# ...)`, compared in inches. Repeated sizes go
  to the line with the same quantity and the closest line number.
- Flagged: sizes not on the PO (with the closest PO line within an inch), width
  and height swapped, quantity different from the PO, PO lines the
  acknowledgement doesn't cover, and Cardinal's own arithmetic/total.
- Matched lines get Rate = Cardinal's unit price (per piece) and Amount = qty x rate.
  Quantities and unmatched lines are never changed.
- The Requested Date goes in the PO due date (`--date-field due`, default), the PO
  date (`txn`), or nowhere (`none`). A memo line records the acknowledgement date,
  sales order, line count, total and requested date, once.
- `--attach` attaches the PDF to the PO (once). Closed POs are refused. Re-running
  changes nothing.

The **Glass Acknowledgement** page (`/order-ack`) does the same: upload the PDF,
**Check**, then **Update PO**. Uploads are kept in `downloads/order_ack/`.
