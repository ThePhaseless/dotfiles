#!/usr/bin/env bash
# Asynchronous chezmoi updater.

set -euo pipefail

REPO="${CHEZMOI_REPO_PATH:-$HOME/.local/share/chezmoi}"
LOCKFILE="/tmp/chezmoi-auto-update.lock"

# Acquire exclusive lock
exec 9>"$LOCKFILE" || exit 0
if ! flock -n 9; then
    echo "[$(date)] Updater already running. Exiting."
    exit 0
fi

echo "[$(date)] Starting background update..."

# Check if repo is clean before updating to avoid destroying/blocking local work
if [ -n "$(git -C "$REPO" status --porcelain)" ]; then
    echo "[$(date)] Warning: Local uncommitted changes detected in Chezmoi repo. Skipping update."
    exit 0
fi

# Update and apply via chezmoi (natively handles git pull)
if command -v chezmoi >/dev/null 2>&1; then
    chezmoi update --apply || echo "[$(date)] Chezmoi update failed."
else
    echo "[$(date)] Error: chezmoi command not found."
    exit 1
fi

echo "[$(date)] Update finished successfully."
exit 0
