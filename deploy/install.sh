#!/usr/bin/env bash
# One-time setup on the VPS (run as root):
#   curl -fsSL https://raw.githubusercontent.com/georgebails12-design/QBO-PO/main/deploy/install.sh | bash
#
# Installs the po-app-update script and a systemd timer that runs it every
# 2 minutes, then runs it once right away. Re-running is safe and also
# refreshes the updater script itself.
set -euo pipefail

RAW="https://raw.githubusercontent.com/georgebails12-design/QBO-PO/main/deploy"

curl -fsSL "$RAW/po-app-update.sh" -o /usr/local/bin/po-app-update
chmod 755 /usr/local/bin/po-app-update

cat > /etc/systemd/system/po-app-update.service <<'UNIT'
[Unit]
Description=Deploy latest QBO-PO main to the PO app
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/po-app-update
UNIT

cat > /etc/systemd/system/po-app-update.timer <<'UNIT'
[Unit]
Description=Check GitHub for PO app updates every 2 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=2min

[Install]
WantedBy=timers.target
UNIT

# The SSH deploy key from the earlier push-based attempt is no longer needed.
[ -f /root/.ssh/authorized_keys ] && sed -i '/github-deploy$/d' /root/.ssh/authorized_keys
rm -f /root/gh_deploy /root/gh_deploy.pub

systemctl daemon-reload
systemctl enable --now po-app-update.timer
echo "Running first deploy..."
systemctl start po-app-update.service || true
journalctl -u po-app-update.service -n 20 --no-pager
