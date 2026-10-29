#!/usr/bin/env bash
# Shared by deploy.sh and rollback.sh.
#
# Required env: IMAGE        e.g. ghcr.io/vutungvn/shopfast-bai7
#               DB_PASSWORD  per-environment secret
# Optional env: APP_PORT          host port of the app (default 8080)
#               DEPLOY_STATE      where "which version runs where" is remembered:
#                                   file     -> $DEPLOY_STATE_DIR/<env>.current|previous  (long-lived server)
#                                   registry -> image tags <env> and <env>-previous       (throwaway CI runner)
#               DEPLOY_STATE_DIR  default ~/.shopfast (also holds the lock, backups and releases.log)
set -euo pipefail
export MSYS_NO_PATHCONV=1 # Git Bash on Windows: do not rewrite /paths or URLs

ENV_NAME=${1:-}
case "$ENV_NAME" in
  staging | production) ;;
  *) echo "usage: $(basename "$0") <staging|production> ..." >&2; exit 2 ;;
esac
: "${IMAGE:?IMAGE is required}"

export DEPLOY_ENV=$ENV_NAME IMAGE APP_PORT=${APP_PORT:-8080}
STATE=${DEPLOY_STATE:-file}
STATE_DIR=${DEPLOY_STATE_DIR:-$HOME/.shopfast}
# shellcheck disable=SC2034 # used by the scripts that source this file
COMPOSE=(docker compose -p "shopfast-$ENV_NAME" -f "$(dirname "${BASH_SOURCE[0]}")/compose.yml")
STARTED=$(date +%s)
mkdir -p "$STATE_DIR/backups"

log() { echo "[$ENV_NAME $(date +%H:%M:%S)] $*"; }
fail() { log "FAILED: $*"; exit 1; }
elapsed() { echo $(($(date +%s) - STARTED)); }

ensure_image() { docker image inspect "$1" >/dev/null 2>&1 || docker pull -q "$1" >/dev/null 2>&1; }

pointer_tag() { [ "$1" = previous ] && echo "$ENV_NAME-previous" || echo "$ENV_NAME"; }

# state_get current|previous -> commit sha (empty if unknown)
state_get() {
  if [ "$STATE" = registry ]; then
    local ref
    ref="$IMAGE:$(pointer_tag "$1")"
    docker pull -q "$ref" >/dev/null 2>&1 || return 0
    docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$ref"
  else
    cat "$STATE_DIR/$ENV_NAME.$1" 2>/dev/null || true
  fi
}

# state_set current|previous <sha>
state_set() {
  if [ "$STATE" = registry ]; then
    local ref
    ref="$IMAGE:$(pointer_tag "$1")"
    ensure_image "$IMAGE:$2" && docker tag "$IMAGE:$2" "$ref" && docker push -q "$ref" >/dev/null
  else
    echo "$2" >"$STATE_DIR/$ENV_NAME.$1"
  fi
}

# Report to GitHub Actions (step outputs) when running inside a workflow.
gh_output() { if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1=$2" >>"$GITHUB_OUTPUT"; fi; }
