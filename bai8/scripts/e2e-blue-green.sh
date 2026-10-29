#!/usr/bin/env bash
# End-to-end proof of the chosen strategy while simulated users keep using the system:
#   init v1 -> deploy v2 -> rollback -> deploy v2 -> finish -> contract
# Measures failed requests, dropped realtime connections, container count and every duration.
# Usage: bash scripts/e2e-blue-green.sh      (STARTUP_DELAY_SECONDS=25 by default, like production)
# Exit code = number of failed checks.
set -uo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.." || exit 1

export DB_PASSWORD=${DB_PASSWORD:-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')}
export STARTUP_DELAY_SECONDS=${STARTUP_DELAY_SECONDS:-25} DRAIN_SECONDS=${DRAIN_SECONDS:-10}
export LB_PORT=${LB_PORT:-8080} PREVIEW_PORT=${PREVIEW_PORT:-8081}
CLIENTS=${CLIENTS:-60}
BG="bash scripts/blue-green.sh"
PASS=0
FAIL=0
TIMES=()

title() { printf '\n\033[1;36m=== %s ===\033[0m\n' "$*"; }
check() {
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
timed() { # timed "<label>" <command...>: run, print its log, remember the duration
  local label=$1 start rc
  shift
  start=$(date +%s%3N)
  "$@" 2>&1 | grep -E '^\[blue-green' | sed 's/^/    /'
  rc=${PIPESTATUS[0]}
  TIMES+=("$label|$(awk -v ms=$(($(date +%s%3N) - start)) 'BEGIN { printf "%.1f", ms / 1000 }')s")
  return "$rc"
}
stat() { node -p "const s=require('./.state/traffic.json'); $1" 2>/dev/null; }
apps() { docker compose ps -q --status running app-blue app-green | grep -c .; }
version_on() { curl -s "http://localhost:$1/version" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p'; }
price_on() { curl -s "http://localhost:$1/products" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).find(p=>p.name==='$2')?.price))"; }
cleanup() {
  touch .state/stop 2>/dev/null
  sleep 1
  docker compose --profile tools down -v --remove-orphans >/dev/null 2>&1
  rm -rf .state nginx/generated/upstreams.conf*
}
trap cleanup EXIT

title "Build v1 and v2"
docker build -q --build-arg APP_VERSION=v1 -t shopfast-bai8:v1 . >/dev/null || exit 1
docker build -q --build-arg APP_VERSION=v2 -t shopfast-bai8:v2 . >/dev/null || exit 1
rm -rf .state && mkdir -p .state

title "Init: 4 x v1 behind nginx (warm-up ${STARTUP_DELAY_SECONDS}s per container)"
timed "init v1 (4 containers start in parallel)" $BG init v1
check "B01 4 API containers, live serves v1" "[ \$(apps) = 4 ] && [ \"\$(version_on $LB_PORT)\" = v1 ]"

title "Simulated users: HTTP ~40 req/s + $CLIENTS realtime connections"
node tools/traffic.mjs --url "http://localhost:$LB_PORT" --clients "$CLIENTS" --rps 40 \
  --out .state/traffic.json --stop-file .state/stop >/dev/null 2>&1 &
TRAFFIC=$!
sleep 4
echo "realtime connections open: $(stat 's.ws.open')"

title "Deploy v2 (blue/green)"
timed "deploy v2: total" $BG deploy v2
PEAK=$(apps)
check "B02 Peak during deploy = $PEAK containers (<= 2 x 4 budget)" "[ $PEAK -le 8 ]"
check "B03 Live serves v2, old v1 still up as standby on the preview port" \
  "[ \"\$(version_on $LB_PORT)\" = v2 ] && [ \"\$(version_on $PREVIEW_PORT)\" = v1 ]"

title "Trap 1: v1 and v2 running at the same time on one database"
curl -s -XPOST -H 'content-type: application/json' -d '{"name":"Dat qua v1","price":111}' "http://localhost:$PREVIEW_PORT/products" >/dev/null
curl -s -XPOST -H 'content-type: application/json' -d '{"name":"Dat qua v2","price":222}' "http://localhost:$LB_PORT/products" >/dev/null
echo "written by v1 -> read by v2: $(price_on "$LB_PORT" 'Dat qua v1') | written by v2 -> read by v1: $(price_on "$PREVIEW_PORT" 'Dat qua v2')"
check "B04 v1 write visible to v2 and v2 write visible to v1" \
  "[ \"\$(price_on $LB_PORT 'Dat qua v1')\" = 111 ] && [ \"\$(price_on $PREVIEW_PORT 'Dat qua v2')\" = 222 ]"

title "Trap 2: realtime users moved, not dropped"
sleep $((DRAIN_SECONDS + 3))
echo "realtime: open=$(stat 's.ws.open') on v2=$(stat 's.ws.onVersion.v2 ?? 0') on v1=$(stat 's.ws.onVersion.v1 ?? 0') graceful=$(stat 's.ws.graceful') abrupt=$(stat 's.ws.abrupt')"
check "B05 All $CLIENTS realtime clients reconnected to v2 via planned 1012 close" \
  "[ \"\$(stat 's.ws.onVersion.v2')\" = $CLIENTS ] && [ \"\$(stat 's.ws.abrupt')\" = 0 ] && [ \"\$(stat 's.ws.graceful')\" -ge $CLIENTS ]"

title "Rollback (requirement: < 2 minutes)"
timed "rollback to v1 (standby warm)" $BG rollback
RB=$(printf '%s\n' "${TIMES[@]}" | grep '^rollback' | cut -d'|' -f2 | tr -d s)
check "B06 Rollback took ${RB}s (< 120s) and live serves v1" \
  "awk 'BEGIN { exit !($RB < 120) }' && [ \"\$(version_on $LB_PORT)\" = v1 ]"
check "B07 Contract refused while a v1 container is still running" "! $BG contract"

title "Deploy v2 again, then end the observation window"
timed "deploy v2 again (green still warm)" $BG deploy v2
sleep $((DRAIN_SECONDS + 3))
timed "finish: stop standby" $BG finish
check "B08 Back to 4 containers, all v2" "[ \$(apps) = 4 ] && [ \"\$(version_on $LB_PORT)\" = v2 ]"

title "Contract (next release) and its safety net"
timed "contract migration" $BG contract
check "B09 After contract v2 still serves products" "curl -sf http://localhost:$LB_PORT/products | grep -q 'Dat qua v1'"
check "B10 Rollback to v1 is now refused (it needs the dropped column)" "! $BG rollback"

title "Whole run seen by the simulated users"
touch .state/stop
wait $TRAFFIC
node -e "const s=require('./.state/traffic.json'); console.log(JSON.stringify({http: {ok: s.http.ok, failed: s.http.failed, resentAfterKeepAliveClose: s.http.retried ?? 0, servedBy: s.http.servedBy, failures: s.http.failures}, ws: s.ws}, null, 1))"
check "B11 Zero failed HTTP requests across 3 switches" "[ \"\$(stat 's.http.failed')\" = 0 ] && [ \"\$(stat 's.http.ok')\" -gt 1000 ]"
check "B12 Zero abruptly dropped realtime connections" "[ \"\$(stat 's.ws.abrupt')\" = 0 ] && [ \"\$(stat 's.ws.connectFailures ?? 0')\" = 0 ]"

title "Timings"
printf '%s\n' "${TIMES[@]}" | awk -F'|' '{ printf "  %-45s %8s\n", $1, $2 }'
echo "  longest realtime reconnect gap seen by a user: $(stat 's.ws.maxReconnectMs') ms"

title "Result: $PASS passed, $FAIL failed"
exit "$FAIL"
