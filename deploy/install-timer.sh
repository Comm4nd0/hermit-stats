#!/bin/sh
# Install the nightly update as a systemd user timer for the current user, wherever the repo lives.
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
uv=$(command -v uv) || { echo "uv not found on PATH" >&2; exit 1; }
units=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user

mkdir -p "$units" "$repo/logs"
sed -e "s|@REPO@|$repo|g" -e "s|@UV@|$uv|g" -e "s|@UVDIR@|$(dirname "$uv")|g" \
    "$repo/deploy/hermit-stats.service" > "$units/hermit-stats.service"
cp "$repo/deploy/hermit-stats.timer" "$units/"

systemctl --user daemon-reload
systemctl --user enable --now hermit-stats.timer
# Keep user timers running when nobody is logged in (headless servers).
loginctl enable-linger "$(id -un)" 2>/dev/null || echo "Run: sudo loginctl enable-linger $(id -un)"

systemctl --user list-timers hermit-stats.timer
