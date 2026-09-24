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

## PO Requests

**PO Requests** (top nav, `/requests`) is a review queue in front of the
Purchase Order page:

1. Anyone with a login fills in the request form: vendor, Q#/Project,
   customer, needed-by date, notes, and lines. Lines can be existing
   QuickBooks items or free text when the item doesn't exist yet. Nothing
   goes to QuickBooks at this point.
2. The reviewer opens a request from the queue and clicks **Review &
   Create PO**. The Purchase Order page opens already filled in from the
   request. Free-text lines are highlighted so the reviewer picks or
   creates the item. Nothing has to be typed a second time.
3. When the PO is created, the request is marked with the PO number. A
   request that's already been turned into a PO can't be loaded or
   converted again.

Duplicate checks: a request for the same vendor with the same Q#/Project,
or with at least 60% of the same lines, counts as a possible duplicate
(see `po_requests.py`).
- Submitting one asks for confirmation (**Submit Anyway**).
- The queue flags open requests that look like each other.
- The review screen and the PO page also check the vendor's last 50 POs
  in QuickBooks the same way.

Requests are stored in `po_requests.json` next to `app.py`. It's
gitignored and deploys never overwrite it.

## Public purchase request form

`/request-form` is a form for people without a login, such as field staff.
It could replace the Fillout form. It asks for:
- name and email
- vendor and project name
- location and needed-by date
- items with details and quantities
- notes and attached files (up to 10, 25MB each)

Submissions land in the **Requests to Review** table on the PO Requests
page, marked "Name (form)". Nothing goes to QuickBooks, and the form never
shows anything from QuickBooks.

The table:
- shows every field from the form (requester, email, vendor, project,
  location, needed-by, items, notes, files);
- can be searched and filtered (waiting for review / pushed to POs /
  rejected / all);
- highlights overdue needed-by dates;
- exports to CSV (text starting with `=`, `+`, `-` or `@` is quoted so
  Excel won't run it as a formula).

Each row has **Push to PO**, which opens the purchase order form filled in
from the request so it can be checked before anything is created, and
**Reject**. Click a row for full details and the duplicate checks.

On review:
- the vendor is matched to QuickBooks by name (or picked by hand);
- each line needs its QuickBooks item picked, and the requester's details
  are kept as the line description;
- location, notes and the requester's name and email go into the PO memo;
- the attached files are uploaded onto the PO in QuickBooks when it's
  created.

The link carries a secret key. Print it on the server with:

```bash
python form_key.py https://po.pandawd.online
```

Anyone with the link can submit requests, so share it like a password.
Delete `form_key` and restart the app to revoke it and get a new one. The
key file and the uploaded files (`request_uploads/`) are gitignored and
deploys never overwrite them. You can set `PO_FORM_KEY` in the environment
instead.
