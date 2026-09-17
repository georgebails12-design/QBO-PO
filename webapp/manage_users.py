"""
manage_users.py
================
Command-line user management for the Purchase Order web app's login.
Run this directly on the server (never over an unauthenticated channel).

    python manage_users.py add jsmith "Jane Smith"
    python manage_users.py list
    python manage_users.py remove jsmith
"""
import getpass
import sys

import auth


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return

    command = sys.argv[1]

    if command == "add":
        if len(sys.argv) < 3:
            print("Usage: python manage_users.py add <username> [display name]")
            return
        username = sys.argv[2]
        name = " ".join(sys.argv[3:]) or username
        password = getpass.getpass(f"Password for {username}: ")
        confirm = getpass.getpass("Confirm password: ")
        if password != confirm:
            print("Passwords didn't match.")
            return
        if not password:
            print("Password can't be empty.")
            return
        auth.add_user(username, password, name)
        print(f"Added user {username!r} ({name}).")

    elif command == "list":
        users = auth.load_users()
        if not users:
            print("No users yet.")
            return
        for username, entry in users.items():
            print(f"  {username}  ({entry.get('name', username)})")

    elif command == "remove":
        if len(sys.argv) < 3:
            print("Usage: python manage_users.py remove <username>")
            return
        username = sys.argv[2]
        auth.remove_user(username)
        print(f"Removed user {username!r} (if it existed).")

    else:
        print(__doc__)


if __name__ == "__main__":
    main()
