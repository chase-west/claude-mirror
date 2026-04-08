#!/bin/bash
#
# Auto-update MMM-ClaudeTaskMirror from GitHub.
# Checks for new commits, pulls changes, installs deps, restarts MagicMirror.
#
# Setup (run once):
#   chmod +x scripts/auto-update.sh
#   crontab -e
#   # Add this line (checks every 15 minutes):
#   */15 * * * * /home/pi/MagicMirror/modules/MMM-ClaudeTaskMirror/scripts/auto-update.sh >> /var/log/mmm-update.log 2>&1

set -e

MODULE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$MODULE_DIR"

# Fetch latest from remote
git fetch origin 2>/dev/null || exit 0

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse @{u} 2>/dev/null) || exit 0

if [ "$LOCAL" = "$REMOTE" ]; then
    exit 0
fi

echo "[$(date)] Update available. Pulling changes..."

# Pull changes
git pull --ff-only origin "$(git rev-parse --abbrev-ref HEAD)"

# Reinstall deps if package.json changed
if git diff "$LOCAL" HEAD --name-only | grep -q "package.json"; then
    echo "[$(date)] package.json changed, running npm install..."
    npm install --production
fi

echo "[$(date)] Restarting MagicMirror..."

# Try common restart methods
if command -v pm2 &>/dev/null && pm2 list 2>/dev/null | grep -q "MagicMirror"; then
    pm2 restart MagicMirror
elif systemctl is-active --quiet magicmirror 2>/dev/null; then
    sudo systemctl restart magicmirror
else
    # Try Docker
    if command -v docker &>/dev/null && docker ps --format '{{.Names}}' | grep -q magicmirror; then
        docker restart "$(docker ps --format '{{.Names}}' | grep magicmirror | head -1)"
    else
        echo "[$(date)] Could not auto-restart MagicMirror. Please restart manually."
        exit 1
    fi
fi

echo "[$(date)] Update complete."
