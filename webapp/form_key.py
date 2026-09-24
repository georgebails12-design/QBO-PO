"""
form_key.py
===========
The shared key in links handed to people without a login (the public PO
request form). Anyone with the link can use it, so treat it like a
password: PO_FORM_KEY from the environment, or one generated once and
saved to form_key (gitignored, never overwritten by deploys).

Print the key and the form link with:

    python form_key.py https://po.pandawd.online

Delete form_key (and restart the app) to revoke every link handed out.
"""

import hmac
import os
import secrets
import sys

APP_DIR = os.path.dirname(os.path.abspath(__file__))
KEY_FILE = os.path.join(APP_DIR, "form_key")


def get_key():
    env_key = os.environ.get("PO_FORM_KEY")
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


if __name__ == "__main__":
    base = (sys.argv[1] if len(sys.argv) > 1 else "https://po.pandawd.online").rstrip("/")
    print(f"Form key:  {get_key()}")
    print(f"Form link: {base}/request-form?key={get_key()}")
