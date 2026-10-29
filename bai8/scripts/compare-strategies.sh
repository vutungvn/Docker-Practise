#!/usr/bin/env bash
# Measure the two rejected strategies under the same simulated load, for the comparison in README section B:
#   (a) recreate - stop all 4 v1 containers, then start 4 v2
#   (b) rolling  - maxSurge 1 / maxUnavailable 0: one v2 up and ready, then one v1 drained and stopped, x4
# Blue/green itself is measured by scripts/e2e-blue-green.sh.
# Usage: bash scripts/compare-strategies.sh   (takes ~4 minutes with the real 25 s warm-up)
set -uo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")/.." || exit 1

export DB_PASSWORD=${DB_PASSWORD:-$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')}
export STARTUP_DELAY_SECONDS=${STARTUP_DELAY_SECONDS:-25} DRAIN_SECONDS=${DRAIN_SECONDS:-10}
export LB_PORT=${LB_PORT:-8080}
BG="bash scripts/blue-green.sh"
UPSTREAMS=nginx/generated/upstreams.conf

title() { printf '\n\033[1;36m=== %s ===\033[0m\n' "$*"; }
now_ms() { date +%s%3N; }
secs() { awk -v ms="$1" 'BEGIN { printf "%.1f", ms / 1000 }'; }
apps() { docker compose ps -q --status running app-blue app-green | grep -c .; }
reload() { docker compose exec -T lb nginx -s reload >/dev/null 2>&1; }
upstreams() { # <server lines...>
  { echo "upstream live {"; for s in "$@"; do echo "  server app-$s:3000 max_fails=1 fail_timeout=3s;"; done; echo "}"
    echo "upstream preview {"; for s in "$@"; do echo "  server app-$s:3000;"; done; echo "}"; } >"$UPSTREAMS"
}
traffic_start() { # <name>
  rm -f .state/stop
  node tools/traffic.mjs --url "http://localhost:$LB_PORT" --clients 40 --rps 40 \
    --out ".state/$1.json" --stop-file .state/stop >/dev/null 2>&1 &
  TRAFFIC=$!
  sleep 4
}
traffic_report() { # <name> <strategy> <duration ms> <peak containers>
  sleep $((DRAIN_SECONDS + 3))
  touch .state/stop
  wait "$TRAFFIC"
  node -e "
    const s = require('./.state/$1.json'), h = s.http;
    const outage = h.firstFailedAt ? ((new Date(h.lastFailedAt) - new Date(h.firstFailedAt)) / 1000).toFixed(1) + 's' : '0s';
    console.log('  ' + JSON.stringify({ strategy: '$2', took: '$(secs "$3")s', peakContainers: $4, httpOk: h.ok, httpFailed: h.failed,
      failedWindow: outage, wsAbrupt: s.ws.abrupt, wsConnectFailures: s.ws.connectFailures ?? 0, maxRealtimeGapMs: s.ws.maxReconnectMs }));"
}
cleanup() {
  touch .state/stop 2>/dev/null
  docker compose --profile tools down -v --remove-orphans >/dev/null 2>&1
  rm -rf .state nginx/generated/upstreams.conf*
}
trap cleanup EXIT

docker build -q --build-arg APP_VERSION=v1 -t shopfast-bai8:v1 . >/dev/null || exit 1
docker build -q --build-arg APP_VERSION=v2 -t shopfast-bai8:v2 . >/dev/null || exit 1

title "(a) Recreate"
rm -rf .state && mkdir -p .state
$BG init v1 >/dev/null 2>&1 || exit 1
MIGRATE_VERSION=v2 docker compose run --rm migrate >/dev/null 2>&1
traffic_start recreate
start=$(now_ms)
docker compose stop -t 60 app-blue >/dev/null 2>&1 # graceful: drain, then exit
BLUE_VERSION=v2 docker compose up -d --no-deps --wait --scale app-blue=4 app-blue >/dev/null 2>&1
took=$(($(now_ms) - start))
traffic_report recreate "recreate" "$took" 4
cleanup

title "(b) Rolling, maxSurge=1 maxUnavailable=0"
rm -rf .state && mkdir -p .state
$BG init v1 >/dev/null 2>&1 || exit 1
MIGRATE_VERSION=v2 docker compose run --rm migrate >/dev/null 2>&1
traffic_start rolling
start=$(now_ms)
peak=0
for i in 1 2 3 4; do
  GREEN_VERSION=v2 docker compose up -d --no-deps --wait --scale "app-green=$i" app-green >/dev/null 2>&1
  [ "$(apps)" -gt "$peak" ] && peak=$(apps)
  if [ "$i" -lt 4 ]; then upstreams blue green; else upstreams green; fi
  reload
  old=$(docker compose ps -q --status running app-blue | head -1)
  docker stop -t 60 "$old" >/dev/null # drain one v1 container, then it exits
  reload # drop its address from nginx
  echo "  step $i: v2=$i v1=$((4 - i)) after $(secs $(($(now_ms) - start)))s"
done
took=$(($(now_ms) - start))
traffic_report rolling "rolling" "$took" "$peak"
echo "  (rollback with this strategy = the same procedure in reverse, so it takes the same time)"
