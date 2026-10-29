#!/usr/bin/env bash
# End-to-end test of deploy/deploy.sh and deploy/rollback.sh on the local Docker host.
# Uses file state and locally built images (v1..v4 stand in for commit SHAs), so no registry is needed.
# Usage: bash scripts/e2e-deploy-local.sh      Exit code = number of failed cases.
set -uo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.." || exit 1

export IMAGE=shopfast-bai7-e2e APP_PORT=18081 DEPLOY_STATE=file
export DB_PASSWORD=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
export DEPLOY_STATE_DIR=$(mktemp -d)
ENV=staging
export DEPLOY_ENV=$ENV APP_VERSION=none # compose needs these even for `exec` and `down`
COMPOSE=(docker compose -p "shopfast-$ENV" -f deploy/compose.yml)
PASS=0
FAIL=0
LOG=$DEPLOY_STATE_DIR/run.log

title() { printf '\n\033[1;36m=== %s ===\033[0m\n' "$*"; }
check() { # check "<name>" <command...>
  local name=$1
  shift
  if eval "$@" >/dev/null 2>&1; then
    printf '\033[32m[PASS]\033[0m %s\n' "$name"
    PASS=$((PASS + 1))
  else
    printf '\033[31m[FAIL]\033[0m %s\n' "$name"
    FAIL=$((FAIL + 1))
  fi
}
served() { curl -s "http://localhost:$APP_PORT/version" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'; }
psql_q() { "${COMPOSE[@]}" exec -T db psql -U shopfast -d shopfast -tAc "$1"; }
deploy() { bash deploy/deploy.sh "$ENV" "$@" >"$LOG" 2>&1; }
cleanup() {
  "${COMPOSE[@]}" down -v >/dev/null 2>&1
  docker rmi "$IMAGE:v1" "$IMAGE:v2" "$IMAGE:v3" "$IMAGE:v4" >/dev/null 2>&1
  rm -rf "$DEPLOY_STATE_DIR"
}
trap cleanup EXIT

title "Build test images"
docker build -q -t "$IMAGE:v1" . >/dev/null || exit 1
docker tag "$IMAGE:v1" "$IMAGE:v2" # same code, different "commit"
ctx=$(mktemp -d)
ctx_docker=$(cygpath -w "$ctx" 2>/dev/null || echo "$ctx") # Docker on Windows cannot see Git Bash /tmp
# v3 ships a migration that passes on an empty DB but fails on data containing duplicate names.
cat >"$ctx/003_unique_product_name.sql" <<'SQL'
ALTER TABLE products ADD COLUMN slug TEXT;
UPDATE products SET slug = lower(replace(name, ' ', '-'));
ALTER TABLE products ADD CONSTRAINT products_name_key UNIQUE (name);
SQL
printf 'FROM %s\nCOPY 003_unique_product_name.sql /app/migrations/\n' "$IMAGE:v1" >"$ctx/Dockerfile"
docker build -q -t "$IMAGE:v3" "$ctx_docker" >/dev/null || exit 1
# v4 starts but never serves HTTP, so its health check fails.
printf 'FROM %s\nCMD ["node", "-e", "setInterval(() => {}, 1000)"]\n' "$IMAGE:v1" >"$ctx/Dockerfile"
docker build -q -t "$IMAGE:v4" "$ctx_docker" >/dev/null || exit 1
rm -rf "$ctx"
echo "images: v1 v2 (good), v3 (bad migration), v4 (unhealthy)"

title "Deploy"
deploy v1
check "E01 First deploy v1 -> serves v1" "[ \"\$(served)\" = v1 ]"
check "E02 Migrations applied (001, 002)" "[ \"\$(psql_q 'SELECT count(*) FROM schema_migrations')\" = 2 ]"
psql_q "INSERT INTO products (name, price) VALUES ('Non luoi trai', 120000)" >/dev/null # real data: duplicate name
deploy v2
check "E03 Deploy v2 -> serves v2, backup written" "[ \"\$(served)\" = v2 ] && ls $DEPLOY_STATE_DIR/backups/*v2*.sql.gz"
deploy v2
check "E04 Deploying the running version again is a no-op" "grep -q 'nothing to do' $LOG"

title "Rollback (< 3 minutes)"
start=$(date +%s)
bash deploy/rollback.sh "$ENV" >"$LOG" 2>&1
RB_RC=$?
RB_SECONDS=$(($(date +%s) - start))
grep -E 'rollback (requested|finished)|OK:' "$LOG"
check "E05 rollback.sh without sha returns to v1" "[ $RB_RC -eq 0 ] && [ \"\$(served)\" = v1 ]"
check "E06 Rollback took ${RB_SECONDS}s (< 180s)" "[ $RB_SECONDS -lt 180 ]"
check "E07 Data written before the rollback is still there" \
  "[ \"\$(psql_q 'SELECT count(*) FROM products')\" = 3 ]"

title "Trap: migration fails halfway"
deploy v3
V3_RC=$?
grep -E 'FAILED|migrate\]' "$LOG"
check "E08 Deploy v3 fails at the migration step" "[ $V3_RC -ne 0 ] && grep -q 'migration rolled back' $LOG"
check "E09 v1 is still serving" "[ \"\$(served)\" = v1 ]"
check "E10 No half-applied schema: no slug column, 003 not recorded" \
  "[ -z \"\$(psql_q \"SELECT 1 FROM information_schema.columns WHERE table_name='products' AND column_name='slug'\")\" ] && [ \"\$(psql_q 'SELECT count(*) FROM schema_migrations')\" = 2 ]"

title "New version unhealthy -> automatic rollback"
deploy v4
V4_RC=$?
grep -E 'automatic rollback|FAILED' "$LOG"
check "E11 Deploy v4 fails its health check" "[ $V4_RC -ne 0 ] && grep -q 'automatic rollback to v1' $LOG"
check "E12 Automatically back on v1 (state unchanged)" \
  "[ \"\$(served)\" = v1 ] && [ \"\$(cat $DEPLOY_STATE_DIR/$ENV.current)\" = v1 ]"

title "Trap: two deploys at the same time"
deploy v2 &
FIRST=$!
sleep 1
bash deploy/deploy.sh "$ENV" v2 >"$LOG.2" 2>&1
SECOND_RC=$?
wait $FIRST
FIRST_RC=$?
grep -h 'in progress' "$LOG.2"
check "E13 Second concurrent deploy is refused" "[ $SECOND_RC -ne 0 ] && grep -q 'in progress' $LOG.2"
check "E14 First deploy completes -> serves v2" "[ $FIRST_RC -eq 0 ] && [ \"\$(served)\" = v2 ]"
check "E15 Lock released afterwards" "[ ! -d $DEPLOY_STATE_DIR/$ENV.lock ]"

title "Release history"
cat "$DEPLOY_STATE_DIR/releases.log"

title "Result: $PASS passed, $FAIL failed"
exit "$FAIL"
