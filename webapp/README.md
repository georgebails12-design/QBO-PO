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
   Without it, a random key is generated on every restart, which logs
   everyone out each time the process restarts.

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
