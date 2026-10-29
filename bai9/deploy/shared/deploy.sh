#!/usr/bin/env bash
# Deploy <sha> to <env>, verify it under traffic, and roll back automatically if verification fails.
#
#   deploy.sh <staging|production> <commit-sha>
#
# Required env: IMAGE (ghcr.io/<owner>/shopfast-bai9), DB_PASSWORD (GitHub Environment secret)
# Optional env: FAULT_MODE (demo only), LB_PORT (8080)
#               DEPLOY_STATE=registry|file - where "the version serving <env>" is remembered
#                 registry: image tags <env> / <env>-previous (CI runners are throwaway)
#                 file:     .state/<env>/current (local runs)
#
# Steps (each one prints a timestamped line, and the step outputs feed the GitHub job summary):
#   1 resolve stable version     2 start stable (simulates the environment as it is right now)
#   3 migrate with the candidate 4 start candidate, wait until ready     5 switch traffic
#   6 verify (verify.mjs + no restarts)  -> pass: 7 promote  | fail: 7 automatic rollback to stable
set -euo pipefail
export MSYS_NO_PATHCONV=1
# pwd -W: Git Bash on Windows must hand Docker a C:/ path; plain pwd elsewhere.
HERE=$(cd "$(dirname "$0")" && (pwd -W 2>/dev/null || pwd))
ROOT=$(cd "$HERE/../.." && (pwd -W 2>/dev/null || pwd))

ENV_NAME=${1:?usage: deploy.sh <staging|production> <commit-sha>}
TARGET=${2:?usage: deploy.sh <staging|production> <commit-sha>}
[ -f "$ROOT/deploy/environments/$ENV_NAME.env" ] || { echo "unknown environment: $ENV_NAME" >&2; exit 2; }
: "${IMAGE:?IMAGE is required}" "${DB_PASSWORD:?DB_PASSWORD is required (GitHub Environment secret)}"

# Layer 2: environment-specific, non-secret settings.
set -a
# shellcheck disable=SC1090
. "$ROOT/deploy/environments/$ENV_NAME.env"
set +a

STATE=${DEPLOY_STATE:-file}
STATE_DIR="$ROOT/.state/$ENV_NAME"
mkdir -p "$STATE_DIR"
export DEPLOY_ENV=$ENV_NAME IMAGE DB_PASSWORD CANDIDATE_VERSION=$TARGET FAULT_MODE=${FAULT_MODE:-none}
export LB_PORT=${LB_PORT:-8080} UPSTREAM_DIR=$STATE_DIR
COMPOSE=(docker compose -p "shopfast-bai9-$ENV_NAME" -f "$HERE/compose.yml")
T0=$(date +%s)

log() { echo "[$ENV_NAME +$(($(date +%s) - T0))s] $*"; }
out() { if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1=$2" >>"$GITHUB_OUTPUT"; fi; }
served() { curl -s --max-time 2 "http://localhost:$LB_PORT/version" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'; }
wait_served() { for _ in $(seq 1 50); do [ "$(served)" = "$1" ] && return 0; sleep 0.2; done; return 1; }
route_to() { # stable|candidate
  echo "upstream live { server $1:3000 max_fails=1 fail_timeout=3s; }" >"$STATE_DIR/upstream.conf"
  if [ -n "$("${COMPOSE[@]}" ps -q --status running lb)" ]; then
    "${COMPOSE[@]}" exec -T lb nginx -t -q && "${COMPOSE[@]}" exec -T lb nginx -s reload
  else
    "${COMPOSE[@]}" up -d --no-deps lb
  fi
}
restarts() { # total restarts of the candidate containers
  local ids
  ids=$("${COMPOSE[@]}" ps -aq candidate)
  if [ -z "$ids" ]; then echo 0; return; fi
  # shellcheck disable=SC2086 # one id per word
  docker inspect -f '{{.RestartCount}}' $ids | awk '{ s += $1 } END { print s + 0 }'
}
pointer_get() {
  if [ "$STATE" = registry ]; then
    docker pull -q "$IMAGE:$ENV_NAME" >/dev/null 2>&1 || return 0
    docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE:$ENV_NAME"
  else
    cat "$STATE_DIR/current" 2>/dev/null || true
  fi
}
pointer_set() { # <tag suffix> <sha>
  if [ "$STATE" = registry ]; then
    docker tag "$IMAGE:$2" "$IMAGE:$ENV_NAME$1" && docker push -q "$IMAGE:$ENV_NAME$1" >/dev/null
  else
    echo "$2" >"$STATE_DIR/current$1"
  fi
}

# ---- 1-2. the environment as it is now ------------------------------------------------------------------------
STABLE=$(pointer_get)
export STABLE_VERSION=${STABLE:-none}
out stable "${STABLE:-none}"
log "1 stable=${STABLE:-<none, first deploy>} candidate=$TARGET fault=$FAULT_MODE"
docker image inspect "$IMAGE:$TARGET" >/dev/null 2>&1 || docker pull -q "$IMAGE:$TARGET" >/dev/null ||
  { log "FAILED: image $IMAGE:$TARGET not found - only built and scanned commits can be deployed"; exit 1; }
"${COMPOSE[@]}" up -d --wait db >/dev/null 2>&1
if [ -n "$STABLE" ]; then
  MIGRATE_VERSION=$STABLE "${COMPOSE[@]}" run --rm -T migrate >/dev/null
  "${COMPOSE[@]}" up -d --no-deps --wait --scale "stable=$APP_REPLICAS" stable >/dev/null 2>&1
  route_to stable
  wait_served "$STABLE" || { log "stable $STABLE does not serve"; exit 1; }
  log "2 stable $STABLE serving x$APP_REPLICAS"
fi

# ---- 3-5. roll out the candidate --------------------------------------------------------------------------------
MIGRATE_VERSION=$TARGET "${COMPOSE[@]}" run --rm -T migrate ||
  { log "FAILED: migration rolled back by Postgres, ${STABLE:-nothing} keeps serving"; out result migration-failed; exit 1; }
log "3 migrated with $TARGET"
"${COMPOSE[@]}" up -d --no-deps --wait --wait-timeout 90 --scale "candidate=$APP_REPLICAS" candidate >/dev/null 2>&1 ||
  { log "FAILED: candidate never became ready, ${STABLE:-nothing} keeps serving"; out result not-ready; exit 1; }
log "4 candidate ready x$APP_REPLICAS"
route_to candidate
wait_served "$TARGET" || { route_to stable; log "FAILED: switch not visible"; exit 1; }
log "5 traffic switched to $TARGET"

# ---- 6. verify under traffic --------------------------------------------------------------------------------------
log "6 verifying for up to ${VERIFY_SECONDS}s at ${VERIFY_RPS} req/s (max errors $MAX_ERROR_RATE, max p95 ${MAX_P95_MS}ms)"
REPORT=$(node "$HERE/verify.mjs" --url "http://localhost:$LB_PORT" --seconds "$VERIFY_SECONDS" --rps "$VERIFY_RPS" \
  --max-error-rate "$MAX_ERROR_RATE" --max-p95-ms "$MAX_P95_MS" --min-requests "$MIN_REQUESTS" --expect-version "$TARGET") || true
[ -n "$REPORT" ] || REPORT='{"pass":false,"reasons":["verify.mjs produced no report"]}'
# Last criterion: no candidate container may have crashed/restarted during the window.
REPORT=$(node -e '
  const r = JSON.parse(process.argv[1]);
  r.restarts = Number(process.argv[2]);
  if (r.restarts > 0) { r.pass = false; r.reasons.push(r.restarts + " container restart(s)"); }
  console.log(JSON.stringify(r));' "$REPORT" "$(restarts)")
case "$REPORT" in *'"pass":true'*) VERIFY_RC=0 ;; *) VERIFY_RC=1 ;; esac
echo "$REPORT" >"$STATE_DIR/verify.json"
out verify "$REPORT"
log "  verify: $REPORT"

if [ "$VERIFY_RC" -eq 0 ]; then
  # ---- 7a. promote ------------------------------------------------------------------------------------------------
  [ -n "$STABLE" ] && pointer_set -previous "$STABLE"
  pointer_set "" "$TARGET"
  "${COMPOSE[@]}" stop stable >/dev/null 2>&1 || true
  log "7 PROMOTED: $ENV_NAME now runs $TARGET (total $(($(date +%s) - T0))s)"
  out result deployed
  exit 0
fi

# ---- 7b. automatic rollback ---------------------------------------------------------------------------------------
if [ -z "$STABLE" ]; then
  log "7 FAILED on the first deploy - nothing to roll back to"
  out result failed-first-deploy
  exit 1
fi
RB0=$(date +%s%3N)
route_to stable
wait_served "$STABLE"
RB_MS=$(($(date +%s%3N) - RB0))
CHECK=$(node "$HERE/verify.mjs" --url "http://localhost:$LB_PORT" --seconds 5 --rps "$VERIFY_RPS" \
  --max-error-rate "$MAX_ERROR_RATE" --max-p95-ms "$MAX_P95_MS" --min-requests 20 --expect-version "$STABLE") || true
"${COMPOSE[@]}" stop candidate >/dev/null 2>&1 || true
log "7 AUTOMATIC ROLLBACK: traffic back on $STABLE in ${RB_MS}ms; stable re-check: $CHECK"
out result rolled-back
out rollback_ms "$RB_MS"
exit 1
