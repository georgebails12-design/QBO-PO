"""
auth.py
=======
Minimal individual-login authentication for the Purchase Order web app.

Users live in users.json (gitignored -- never commit real credentials).
Create accounts with manage_users.py on the server:

    python manage_users.py add jsmith "Jane Smith"

(it prompts for a password rather than taking one on the command line).
No external auth dependency -- just Flask sessions + Werkzeug's own
password hashing.
"""
import functools
import json
import os

from flask import redirect, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

APP_DIR = os.path.dirname(os.path.abspath(__file__))
USERS_FILE = os.path.join(APP_DIR, "users.json")


def load_users():
    if not os.path.exists(USERS_FILE):
        return {}
    with open(USERS_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def save_users(users):
    with open(USERS_FILE, "w", encoding="utf-8") as f:
        json.dump(users, f, indent=2)


def add_user(username, password, name=None):
    users = load_users()
    users[username] = {"password_hash": generate_password_hash(password), "name": name or username}
    save_users(users)
    return users


def remove_user(username):
    users = load_users()
    users.pop(username, None)
    save_users(users)
    return users


def verify_login(username, password):
    entry = load_users().get(username)
    if not entry:
        return False
    return check_password_hash(entry["password_hash"], password)


def current_user():
    username = session.get("username")
    if not username:
        return None
    entry = load_users().get(username)
    if not entry:
        return None
    return {"username": username, "name": entry.get("name", username)}


def login_required(view):
    @functools.wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("username"):
            if request.path.startswith("/api/"):
                return {"error": "Not logged in."}, 401
            return redirect(url_for("login", next=request.path))
        return view(*args, **kwargs)
    return wrapped
