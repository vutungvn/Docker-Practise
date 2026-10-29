#!/usr/bin/env bash
# Shared helpers for evidence-before.sh and verify-after.sh (run from Git Bash / Linux / macOS).
set -uo pipefail

# Git Bash on Windows rewrites "/app" into "C:/Program Files/Git/app" - disable that.
export MSYS_NO_PATHCONV=1
export DOCKER_BUILDKIT=1

cd "$(dirname "$0")/.."

SECRET_DB_PASSWORD="MatKhau123"
SECRET_JWT="shopfast-secret-key-2026"

title() { printf '\n\033[1;36m=== %s ===\033[0m\n' "$*"; }
run()   { printf '\033[2m$ %s\033[0m\n' "$*"; eval "$@"; }

now_ms() { date +%s%3N; }

# Size shown by `docker images`, converted to MB (handles kB/MB/GB).
image_size_mb() {
  docker image ls --format '{{.Size}}' "$1" | head -1 | awk '
    /GB$/ { sub("GB",""); printf "%.0f", $1*1000; next }
    /MB$/ { sub("MB",""); printf "%.0f", $1; next }
    /kB$/ { sub("kB",""); printf "%.0f", $1/1000; next }'
}

# Change one line of source code, remembering the original so it can be restored.
APP_FILE="src/app.ts"
touch_source() {
  cp "$APP_FILE" "$APP_FILE.bak"
  sed -i "s/version: '[^']*'/version: 'v$(date +%s)'/" "$APP_FILE"
}
restore_source() { [ -f "$APP_FILE.bak" ] && mv "$APP_FILE.bak" "$APP_FILE"; }
trap restore_source EXIT
