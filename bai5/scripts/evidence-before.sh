#!/usr/bin/env bash
# Part 1 - collect hard evidence for every defect of the original Dockerfile.
# Usage: bash scripts/evidence-before.sh
source "$(dirname "$0")/lib.sh"

IMG=shopfast:before
LOG=before/build.log

# Build context without host node_modules/dist (= a fresh CI checkout that still has .env).
build_before() {
  tar -c --exclude=./node_modules --exclude=./dist . \
    | docker build --progress=plain -f before/Dockerfile -t "$IMG" "$@" - >"$LOG" 2>&1
}

title "D0. COPY . . with the developer's own node_modules -> build breaks"
if [ -d node_modules ]; then
  docker build --no-cache --progress=plain -f before/Dockerfile -t shopfast:before-hostctx . >"$LOG" 2>&1 \
    && echo "Build succeeded (host node_modules happen to be Linux-compatible)" \
    || grep -E 'not found|ERROR: process' "$LOG" | head -3
fi

title "B0. Build the original image from a clean checkout (cold, no cache)"
start=$(now_ms)
build_before --no-cache || { tail -30 "$LOG"; exit 1; }
echo "Cold build time: $(( ($(now_ms) - start) / 1000 ))s"

title "D1. Image size + heavy base image (node:20 = full Debian)"
run "docker image ls --format 'table {{.Repository}}:{{.Tag}}\t{{.Size}}' | grep -E '^(shopfast:before|node:20 )'"
run "docker image ls node:20 --format 'node:20 base = {{.Size}}'"
run "docker history $IMG --format 'table {{.Size}}\t{{.CreatedBy}}' | head -12"

title "D2. Hard-coded secrets are visible to anyone who pulls the image"
run "docker history --no-trunc $IMG | grep -oE '(DATABASE_URL|JWT_SECRET)=[^ ]+'"
run "docker image inspect $IMG --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -E 'DATABASE_URL|JWT_SECRET'"

title "D3. COPY . . without .dockerignore: .env, test/, scripts/, Dockerfile... end up in the image"
run "docker run --rm --entrypoint sh $IMG -c 'ls -la /app'"
run "docker run --rm --entrypoint cat $IMG /app/.env"

title "D4. TypeScript source + devDependencies shipped to production"
run "docker run --rm --entrypoint sh $IMG -c 'find /app/src /app/test -name \"*.ts\"'"
run "docker run --rm --entrypoint sh $IMG -c 'du -sh /app/node_modules; ls /app/node_modules | wc -l; ls -d /app/node_modules/typescript /app/node_modules/jest /app/node_modules/ts-node-dev'"

title "D5. Container runs as root"
run "docker run --rm --entrypoint id $IMG"
run "docker image inspect $IMG --format 'User=\"{{.Config.User}}\"'"

title "D6. Dev start command (npm -> ts-node-dev watch) instead of production"
run "docker image inspect $IMG --format 'Cmd={{json .Config.Cmd}}'"
docker rm -f sf-before >/dev/null 2>&1
docker run -d --name sf-before "$IMG" >/dev/null
sleep 12
run "docker exec sf-before ps -o pid,user,rss,args"
run "docker exec sf-before sh -c 'echo NODE_ENV=\${NODE_ENV:-<unset>}'"
run "docker stats --no-stream --format 'RAM {{.MemUsage}}' sf-before"
run "docker exec sf-before env | grep -E 'DATABASE_URL|JWT_SECRET'"
docker rm -f sf-before >/dev/null

title "D7. Layer order kills the cache: change 1 line -> npm install runs again"
touch_source
start=$(now_ms)
build_before
echo "Rebuild after 1-line change: $(( ($(now_ms) - start) / 1000 ))s"
run "grep -E '^#[0-9]+ \[[0-9]/[0-9]\]|CACHED|added [0-9]+ packages' $LOG | head -12"
restore_source
