#!/usr/bin/env bash
# Part 2 - automated test cases for the fixed Dockerfile. Exit code = number of failed cases.
# Usage: bash scripts/verify-after.sh
source "$(dirname "$0")/lib.sh"

IMG=shopfast:after
CTR=sf-after
PORT=3002
LOG=build-after.log
PASS=0; FAIL=0

check() { # check "<id> <description>" <command...>
  local name="$1"; shift
  if eval "$@" >/dev/null 2>&1; then
    printf '\033[32m[PASS]\033[0m %s\n' "$name"; PASS=$((PASS + 1))
  else
    printf '\033[31m[FAIL]\033[0m %s\n' "$name"; FAIL=$((FAIL + 1))
  fi
}
cleanup() { docker rm -f "$CTR" "$CTR-nosecret" >/dev/null 2>&1; rm -f "$LOG"; restore_source; }
trap cleanup EXIT

[ -f .env ] || { echo "Missing .env - run: cp .env.example .env (and fill values)"; exit 1; }

title "Build"
start=$(now_ms)
docker build --no-cache --progress=plain -t "$IMG" . >"$LOG" 2>&1
BUILD_RC=$?
echo "Cold build (no cache): $(( ($(now_ms) - start) / 1000 ))s"
check "TC01 Image builds successfully" "[ $BUILD_RC -eq 0 ]"
[ $BUILD_RC -eq 0 ] || { tail -30 "$LOG"; exit 1; }

title "Size"
SIZE_MB=$(image_size_mb "$IMG")
echo "shopfast:after = ${SIZE_MB} MB (docker images)  |  compressed = $(( $(docker image inspect -f '{{.Size}}' $IMG) / 1000000 )) MB"
check "TC02 Image size < 250 MB" "[ ${SIZE_MB:-9999} -lt 250 ]"

title "Build cache"
start=$(now_ms); docker build --progress=plain -t "$IMG" . >"$LOG" 2>&1; T_NOCHANGE=$(( $(now_ms) - start ))
echo "Rebuild, nothing changed: $((T_NOCHANGE / 1000)).$(( (T_NOCHANGE % 1000) / 100 ))s"
check "TC03 Rebuild with no change < 10s" "[ $T_NOCHANGE -lt 10000 ]"

touch_source
start=$(now_ms); docker build --progress=plain -t "$IMG" . >"$LOG" 2>&1; T_CHANGE=$(( $(now_ms) - start ))
echo "Rebuild after 1-line change in $APP_FILE: $((T_CHANGE / 1000)).$(( (T_CHANGE % 1000) / 100 ))s"
check "TC04 Rebuild after 1-line source change < 20s" "[ $T_CHANGE -lt 20000 ]"
check "TC05 npm ci layers reused from cache (not re-run)" \
  "[ \$(grep -cE 'npm ci' $LOG) -ge 2 ] && ! grep -qE 'added [0-9]+ packages' $LOG"
restore_source
docker build -q -t "$IMG" . >/dev/null 2>&1   # rebuild with original source for the runtime tests

title "Secrets"
check "TC06 docker history has no secret strings" \
  "! docker history --no-trunc $IMG | grep -qE '$SECRET_DB_PASSWORD|$SECRET_JWT|DATABASE_URL|JWT_SECRET'"
check "TC07 Image config Env has no DATABASE_URL / JWT_SECRET" \
  "! docker image inspect $IMG --format '{{json .Config.Env}}' | grep -qE 'DATABASE_URL|JWT_SECRET'"
docker rm -f "$CTR" >/dev/null 2>&1; docker create --name "$CTR" "$IMG" >/dev/null
check "TC08 Whole filesystem (docker export) contains no secret value" \
  "! docker export $CTR | grep -aqE '$SECRET_DB_PASSWORD|$SECRET_JWT'"
docker rm -f "$CTR" >/dev/null

title "Image content"
APP_LS=$(docker run --rm --entrypoint ls "$IMG" -A /app | tr '\n' ' ')
echo "/app contains: $APP_LS"
check "TC09 /app only has dist, node_modules, package.json" "[ '$APP_LS' = 'dist node_modules package.json ' ]"
check "TC10 No .ts source / .env / tests in image" \
  "[ -z \"\$(docker run --rm --entrypoint find $IMG /app -path /app/node_modules -prune -o \( -name '*.ts' -o -name '.env' -o -name '*.spec.*' \) -print)\" ]"
check "TC11 No devDependencies (typescript, jest, ts-node-dev)" \
  "docker run --rm --entrypoint sh $IMG -c '! ls -d node_modules/typescript node_modules/jest node_modules/ts-node-dev 2>/dev/null | grep -q .'"

title "User & start command"
echo "User=$(docker image inspect -f '{{.Config.User}}' $IMG)  Cmd=$(docker image inspect -f '{{json .Config.Cmd}}' $IMG)  uid=$(docker run --rm --entrypoint id $IMG -u)"
check "TC12 Runs as non-root user (uid != 0)" "[ \"\$(docker run --rm --entrypoint id $IMG -u)\" != 0 ]"
check "TC13 App user cannot modify app code" "! docker run --rm --entrypoint touch $IMG /app/dist/main.js"
check "TC14 CMD is production: node dist/main.js" \
  "[ '$(docker image inspect -f '{{json .Config.Cmd}}' $IMG)' = '[\"node\",\"dist/main.js\"]' ]"
check "TC15 NODE_ENV=production baked in" \
  "docker image inspect $IMG --format '{{json .Config.Env}}' | grep -q 'NODE_ENV=production'"

title "Runtime"
docker run -d --name "$CTR-nosecret" "$IMG" >/dev/null; sleep 3
NOSECRET_STATE=$(docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}}' "$CTR-nosecret")
echo "Started without secrets -> $NOSECRET_STATE | log: $(docker logs "$CTR-nosecret" 2>&1 | head -1)"
check "TC16 Without secrets: container exits with code 1 (fail fast)" "[ '$NOSECRET_STATE' = 'exited exit=1' ]"

docker run -d --name "$CTR" -p "$PORT:3000" --env-file .env "$IMG" >/dev/null; sleep 3
HEALTH=$(curl -s "http://localhost:$PORT/health")
echo "GET /health -> $HEALTH"
check "TC17 With --env-file: GET /health = 200 & status ok" \
  "[ \"\$(curl -s -o /dev/null -w '%{http_code}' http://localhost:$PORT/health)\" = 200 ] && echo '$HEALTH' | grep -q '\"status\":\"ok\"'"
check "TC18 /health response does not leak secrets" "! echo '$HEALTH' | grep -qE '$SECRET_DB_PASSWORD|$SECRET_JWT'"
check "TC19 GET /products returns the catalog" "curl -s http://localhost:$PORT/products | grep -q 'ShopFast'"
echo "Processes: $(docker exec "$CTR" ps -o pid,user,args | tail -n +2 | grep -v 'ps -o' | tr -s ' ' | tr '\n' ';')"
check "TC20 PID 1 is node dist/main.js running as node" \
  "docker exec $CTR ps -o pid,user,args | grep -E '^ *1 +node +node dist/main.js'"
echo "RAM: $(docker stats --no-stream --format '{{.MemUsage}}' "$CTR")"
for _ in $(seq 1 20); do
  [ "$(docker inspect -f '{{.State.Health.Status}}' "$CTR")" = healthy ] && break; sleep 1
done
check "TC21 HEALTHCHECK reports healthy" "[ \"\$(docker inspect -f '{{.State.Health.Status}}' $CTR)\" = healthy ]"
start=$(now_ms); docker stop "$CTR" >/dev/null; T_STOP=$(( $(now_ms) - start ))
echo "docker stop took $((T_STOP / 1000)).$(( (T_STOP % 1000) / 100 ))s, exit=$(docker inspect -f '{{.State.ExitCode}}' "$CTR")"
check "TC22 Graceful shutdown on SIGTERM (< 5s, exit 0)" \
  "[ $T_STOP -lt 5000 ] && [ \"\$(docker inspect -f '{{.State.ExitCode}}' $CTR)\" = 0 ] && docker logs $CTR | grep -q 'received SIGTERM'"

title "Result: $PASS passed, $FAIL failed"
exit "$FAIL"
