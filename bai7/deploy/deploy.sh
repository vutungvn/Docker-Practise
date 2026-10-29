#!/usr/bin/env bash
# Deploy one ShopFast version to one environment on the current Docker host.
#
#   deploy.sh <staging|production> <commit-sha>              backup -> migrate -> switch -> verify
#   deploy.sh <staging|production> <commit-sha> --rollback   migrate (a no-op, see ROLLBACK.md) -> switch -> verify
#
# Any failure leaves the environment on the version that was running before.
source "$(dirname "$0")/lib.sh"
TARGET=${2:?usage: deploy.sh <staging|production> <commit-sha> [--rollback]}
MODE=deploy
[ "${3:-}" = "--rollback" ] && MODE=rollback
: "${DB_PASSWORD:?DB_PASSWORD is required (set it as a secret of the $ENV_NAME environment)}"
export DB_PASSWORD APP_VERSION=$TARGET

# ---- 1. One deploy per environment at a time --------------------------------------------------------------
# CI already serialises deploys with a `concurrency` group; this lock also covers people running the script.
LOCK="$STATE_DIR/$ENV_NAME.lock"
mkdir "$LOCK" 2>/dev/null ||
  fail "another deploy/rollback of $ENV_NAME is in progress ($(cat "$LOCK/owner" 2>/dev/null))"
trap 'rm -rf "$LOCK"' EXIT
echo "$MODE $TARGET pid=$$ since $(date -u +%FT%TZ)" >"$LOCK/owner"

CURRENT=$(state_get current)
log "$MODE: ${CURRENT:-<nothing>} -> $TARGET"
gh_output previous "$CURRENT"
gh_output version "$TARGET"

if [ "$TARGET" = "$CURRENT" ]; then
  log "already serving $TARGET, nothing to do"
  gh_output result unchanged
  exit 0
fi

# ---- 2. Never let an older pipeline run overwrite a newer release -------------------------------------------
if [ "$MODE" = deploy ] && [ -n "$CURRENT" ] && git merge-base --is-ancestor "$TARGET" "$CURRENT" 2>/dev/null; then
  log "skip: $TARGET is an ancestor of the running $CURRENT (a newer merge was deployed first)"
  gh_output result skipped-older
  exit 0
fi

ensure_image "$IMAGE:$TARGET" || fail "image $IMAGE:$TARGET not found - only built commits can be deployed"
"${COMPOSE[@]}" up -d --wait db >/dev/null

# ---- 3. Backup + migrate before any traffic reaches the new version ----------------------------------------
# On rollback the older image only knows migrations that are already applied, so migrate changes nothing
# (it only builds the schema on an empty database); the backup is skipped to keep rollback fast.
if [ "$MODE" = deploy ]; then
  BACKUP="$STATE_DIR/backups/$ENV_NAME-$(date +%Y%m%d-%H%M%S)-before-${TARGET:0:7}.sql.gz"
  "${COMPOSE[@]}" exec -T db pg_dump -U shopfast -d shopfast | gzip >"$BACKUP" || fail "backup failed, nothing changed"
  log "backup: $BACKUP"
fi

"${COMPOSE[@]}" run --rm -T --no-deps app node dist/migrate-cli.js ||
  fail "migration rolled back by Postgres - schema unchanged, ${CURRENT:-the previous version} keeps serving"

# ---- 4. Switch the app container and verify it ------------------------------------------------------------
served_version() {
  "${COMPOSE[@]}" exec -T app wget -qO- http://127.0.0.1:3000/version 2>/dev/null |
    sed -n 's/.*"version":"\([^"]*\)".*/\1/p'
}

log "switching app to $TARGET"
if "${COMPOSE[@]}" up -d --no-deps --wait --wait-timeout 60 app 2>/dev/null && [ "$(served_version)" = "$TARGET" ]; then
  [ -n "$CURRENT" ] && state_set previous "$CURRENT"
  state_set current "$TARGET"
  echo "$(date -u +%FT%TZ) $MODE $ENV_NAME ${CURRENT:-none} -> $TARGET $(elapsed)s" >>"$STATE_DIR/releases.log"
  log "OK: $ENV_NAME serves $TARGET (took $(elapsed)s)"
  gh_output result "$MODE"
  gh_output duration "$(elapsed)"
  exit 0
fi

# ---- 5. New version unhealthy: put the previous one back -----------------------------------------------------
"${COMPOSE[@]}" logs --tail 15 app || true
if [ -n "$CURRENT" ]; then
  log "health check failed -> automatic rollback to $CURRENT"
  APP_VERSION=$CURRENT "${COMPOSE[@]}" up -d --no-deps --wait --wait-timeout 60 app >/dev/null 2>&1 ||
    log "WARNING: automatic rollback did not become healthy either - run ROLLBACK.md manually"
fi
fail "$TARGET did not become healthy within 60s"
