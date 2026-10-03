#!/usr/bin/env bash
# Builds ~/.local/bin/swarmail and runs its server as a systemd user service on 127.0.0.1:18765.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
[[ "$(id -u)" -ne 0 ]] || { echo 'Run as your normal user, without sudo.' >&2; exit 1; }
BUN="$(command -v bun)" || { echo 'bun is not on PATH; install it from https://bun.sh' >&2; exit 1; }
UNIT=swarmail.service
UNITS="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

mkdir -p "$HOME/.local/bin" "$UNITS"
"$BUN" "$ROOT/scripts/build.ts"
install -m 0644 "$ROOT/systemd/$UNIT" "$UNITS/$UNIT"
systemctl --user daemon-reload
systemctl --user enable "$UNIT" >/dev/null
systemctl --user restart "$UNIT"
for _ in $(seq 1 20); do
  curl -fs -m 2 -o /dev/null http://127.0.0.1:18765/healthz && break
  sleep 0.5
done
curl -fsS -m 2 -o /dev/null http://127.0.0.1:18765/healthz \
  || { echo "Service started but /healthz is not answering; check: systemctl --user status $UNIT" >&2; exit 1; }
# Linger keeps the user manager, and the server, running after the last login session ends.
if loginctl enable-linger "$USER" 2>/dev/null; then
  echo 'Linger enabled; the server survives logout.'
else
  echo 'Could not enable linger; run: sudo loginctl enable-linger "$USER"' >&2
fi
echo 'swarmail enabled on http://127.0.0.1:18765 (localhost only, no auth).'
