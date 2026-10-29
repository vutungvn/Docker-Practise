// Simulated users during a deploy: a steady stream of HTTP requests plus long-lived realtime connections.
// Uses the fetch/WebSocket built into Node >= 22, so it needs no dependencies.
//
//   node tools/traffic.mjs --url http://localhost:8080 --clients 50 --rps 40 --out .state/traffic.json --stop-file .state/stop
//
// Runs until --stop-file appears (or --seconds elapse) and keeps --out updated every second with:
//   http.failed       requests that did not get a 2xx (the "nobody can be served" rule)
//   ws.abrupt         realtime connections dropped without the planned 1012 close (the realtime trap)
//   ws.graceful       planned hand-overs (server sent "reconnect" + close 1012, client reconnected)
import { existsSync, writeFileSync } from 'node:fs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const url = arg('url', 'http://localhost:8080');
const clients = Number(arg('clients', 50));
const rps = Number(arg('rps', 40));
const seconds = Number(arg('seconds', 0));
const out = arg('out', '');
const stopFile = arg('stop-file', '');
const wsUrl = url.replace(/^http/, 'ws') + '/ws';

const stats = {
  http: { ok: 0, failed: 0, servedBy: {}, failures: [] },
  ws: {
    clients,
    open: 0,
    opened: 0,
    graceful: 0,
    abrupt: 0,
    abruptCodes: {},
    maxReconnectMs: 0,
    onVersion: {},
  },
  startedAt: new Date().toISOString(),
};
let stopping = false;

// ---- HTTP: one request every 1000/rps ms, each on its own timer so a slow one does not stall the rest -------
// A reused keep-alive connection can be closed by the load balancer (e.g. nginx reload) at the exact moment a
// request is sent on it. Browsers and OkHttp transparently resend an idempotent GET once in that case
// (RFC 9110 9.2.2); we do the same and count it in http.retried, so it stays visible. Any other error,
// any non-2xx status and a second failure all count as failed.
const RESEND_ONCE = new Set(['UND_ERR_SOCKET', 'ECONNRESET']);

async function getProducts(attempt = 1) {
  try {
    const res = await fetch(`${url}/products`, { signal: AbortSignal.timeout(5000) });
    await res.arrayBuffer();
    if (!res.ok) return fail(`HTTP ${res.status}`);
    stats.http.ok++;
    const by = res.headers.get('x-served-by') ?? '?';
    stats.http.servedBy[by] = (stats.http.servedBy[by] ?? 0) + 1;
  } catch (err) {
    const reason = err.cause?.code ?? err.name ?? String(err);
    if (attempt === 1 && RESEND_ONCE.has(reason)) {
      stats.http.retried = (stats.http.retried ?? 0) + 1;
      return getProducts(2);
    }
    fail(reason);
  }
}

const inflight = new Set();
const httpTimer = setInterval(() => {
  const p = getProducts().finally(() => inflight.delete(p));
  inflight.add(p);
}, 1000 / rps);

function fail(reason) {
  const now = new Date().toISOString();
  stats.http.failed++;
  stats.http.firstFailedAt ??= now;
  stats.http.lastFailedAt = now;
  if (stats.http.failures.length < 20) stats.http.failures.push({ at: new Date().toISOString(), reason });
}

// ---- Realtime clients ---------------------------------------------------------------------------------------
const sockets = new Set();
function connect(id, lostAt = 0) {
  const ws = new WebSocket(wsUrl);
  let opened = false;
  let version = '';
  ws.onopen = () => {
    opened = true;
    stats.ws.opened++;
    stats.ws.open++;
    sockets.add(ws);
    if (lostAt) stats.ws.maxReconnectMs = Math.max(stats.ws.maxReconnectMs, Date.now() - lostAt);
  };
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'hello') {
      version = msg.version;
      stats.ws.onVersion[version] = (stats.ws.onVersion[version] ?? 0) + 1;
    }
  };
  ws.onclose = (event) => {
    sockets.delete(ws);
    if (opened) stats.ws.open--;
    if (version) stats.ws.onVersion[version]--;
    if (stopping) return;
    if (!opened) stats.ws.connectFailures = (stats.ws.connectFailures ?? 0) + 1;
    else if (event.code === 1012) stats.ws.graceful++;
    else {
      stats.ws.abrupt++;
      stats.ws.abruptCodes[event.code] = (stats.ws.abruptCodes[event.code] ?? 0) + 1;
    }
    // Like a real client: reconnect with a little random jitter, never all at the same instant.
    // A failed attempt keeps the original "lost at" time, so maxReconnectMs is the whole gap the user saw.
    const since = opened ? Date.now() : lostAt || Date.now();
    setTimeout(() => connect(id, since), 100 + Math.random() * 900);
  };
  ws.onerror = () => {}; // onclose follows and does the accounting
}
for (let i = 0; i < clients; i++) setTimeout(() => connect(i), i * 20);

// ---- Reporting / stop -----------------------------------------------------------------------------------------
const write = () => out && writeFileSync(out, JSON.stringify(stats, null, 2));
const started = Date.now();
const reportTimer = setInterval(() => {
  write();
  if ((stopFile && existsSync(stopFile)) || (seconds && Date.now() - started > seconds * 1000)) stop();
}, 1000);

async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(httpTimer);
  clearInterval(reportTimer);
  await Promise.allSettled([...inflight]);
  for (const ws of sockets) ws.close(1000);
  stats.finishedAt = new Date().toISOString();
  write();
  console.log(JSON.stringify(stats, null, 2));
  setTimeout(() => process.exit(0), 200);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
