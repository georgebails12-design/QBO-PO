#!/usr/bin/env bash
# Pull-based deploy for the live PO app (po.pandawd.online).
#
# Run by the po-app-update.timer systemd unit every few minutes. Checks the
# latest commit on main; if webapp/ changed since the last deploy, copies it
# into APP_DIR, installs requirements if they changed, restarts the service
# and checks the login page. If the app doesn't come back, the previous code
# is restored and the service restarted again.
#
# Files the app writes on the server are never overwritten (see EXCLUDES).
set -euo pipefail

REPO="georgebails12-design/QBO-PO"
BRANCH="main"
APP_DIR="/home/george/po-app"
APP_OWNER="george"
SERVICE="po-app"
HEALTH_URL="http://127.0.0.1:8030/login"
STATE_DIR="/var/lib/po-app-update"
BACKUP_DIR="$STATE_DIR/backups"

EXCLUDES=(
  --exclude=./qbo_config.json
  --exclude=./qbo_tokens.json
  --exclude=./qbo_reference_cache.json
  --exclude=./users.json
  --exclude=./flask_secret_key
  --exclude=./po_categories.json
  --exclude=./downloads
  --exclude=./venv
  --exclude=./__pycache__
)

mkdir -p "$STATE_DIR" "$BACKUP_DIR"
exec 9>"$STATE_DIR/lock"
flock -n 9 || exit 0

sha=$(curl -fsS -H "Accept: application/vnd.github.sha" \
  "https://api.github.com/repos/$REPO/commits/$BRANCH")
[ "$sha" = "$(cat "$STATE_DIR/last_sha" 2>/dev/null)" ] && exit 0

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "https://codeload.github.com/$REPO/tar.gz/$sha" \
  | tar -xz -C "$tmp" --strip-components=1
src="$tmp/webapp"
[ -f "$src/app.py" ] || { echo "no webapp/app.py in $sha, skipping"; exit 1; }

tree_hash=$(cd "$src" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -d' ' -f1)
if [ "$tree_hash" = "$(cat "$STATE_DIR/last_tree" 2>/dev/null)" ]; then
  echo "$sha" > "$STATE_DIR/last_sha"
  exit 0
fi

echo "Deploying $sha"
backup="$BACKUP_DIR/$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
tar -C "$APP_DIR" "${EXCLUDES[@]}" -czf "$backup" .

old_req=$(sha256sum "$APP_DIR/requirements.txt" 2>/dev/null | cut -d' ' -f1 || true)
tar -C "$src" "${EXCLUDES[@]}" -cf - . | tar -C "$APP_DIR" -xf -
chown -R "$APP_OWNER:$APP_OWNER" "$APP_DIR"
if [ "$old_req" != "$(sha256sum "$APP_DIR/requirements.txt" | cut -d' ' -f1)" ]; then
  runuser -u "$APP_OWNER" -- "$APP_DIR/venv/bin/pip" install -q -r "$APP_DIR/requirements.txt"
fi

systemctl restart "$SERVICE"
healthy=""
for _ in $(seq 1 15); do
  sleep 2
  if curl -fsS -o /dev/null "$HEALTH_URL"; then healthy=1; break; fi
done

if [ -z "$healthy" ]; then
  echo "Health check failed for $sha -- restoring previous code from $backup"
  tar -C "$APP_DIR" -xzf "$backup"
  chown -R "$APP_OWNER:$APP_OWNER" "$APP_DIR"
  systemctl restart "$SERVICE"
  # Record the sha so a broken commit isn't retried every few minutes;
  # the next commit on main will be tried as normal.
  echo "$sha" > "$STATE_DIR/last_sha"
  exit 1
fi

echo "$sha" > "$STATE_DIR/last_sha"
echo "$tree_hash" > "$STATE_DIR/last_tree"
echo "$sha" > "$APP_DIR/DEPLOYED_COMMIT"
ls -1t "$BACKUP_DIR"/*.tar.gz | tail -n +6 | xargs -r rm -f
echo "Deployed $sha"
