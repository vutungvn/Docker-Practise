// Post-deploy verification: synthetic traffic through the load balancer, judged against the thresholds of
// deploy/environments/<env>.env. Exit code 0 = healthy, 1 = roll back. Prints a JSON report on stdout.
//
// A release FAILS if any of these is true (checked on the whole window, and every 5 s for a fast fail):
//   error rate        > MAX_ERROR_RATE   (non-2xx or network error)
//   p95 latency       > MAX_P95_MS
//   requests          < MIN_REQUESTS     (not enough evidence to call it healthy)
//   served by another version than --expect-version  (traffic did not reach the new release)
// Fast fail inside the window: a 5 s slice with >= 20 requests and error rate > 10x the limit (min 20 %)
// or p95 > 2x the limit stops the check early, so a broken release is rolled back within seconds.
// (deploy.sh adds one more criterion: no container restart during the window.)
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const url = arg('url', 'http://localhost:8080');
const seconds = Number(arg('seconds', 30));
const rps = Number(arg('rps', 20));
const maxErrorRate = Number(arg('max-error-rate', 0.01));
const maxP95 = Number(arg('max-p95-ms', 400));
const minRequests = Number(arg('min-requests', 100));
const expectVersion = arg('expect-version', '');

const SLICE_MS = 5000;
const p95 = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
};

const samples = []; // { at, ok, ms, version }
async function probe(path) {
  const started = performance.now();
  try {
    const res = await fetch(url + path, { signal: AbortSignal.timeout(3000) });
    await res.arrayBuffer();
    samples.push({
      at: Date.now(),
      ok: res.ok,
      ms: performance.now() - started,
      version: res.headers.get('x-version'),
    });
  } catch {
    samples.push({ at: Date.now(), ok: false, ms: performance.now() - started, version: null });
  }
}

function judge(list, { final }) {
  const failed = list.filter((s) => !s.ok).length;
  const errorRate = list.length ? failed / list.length : 0;
  const latency = p95(list.map((s) => s.ms));
  const reasons = [];
  if (final) {
    if (errorRate > maxErrorRate)
      reasons.push(`error rate ${(errorRate * 100).toFixed(1)}% > ${maxErrorRate * 100}%`);
    if (latency > maxP95) reasons.push(`p95 ${latency.toFixed(0)} ms > ${maxP95} ms`);
    if (list.length < minRequests) reasons.push(`only ${list.length} requests < ${minRequests}`);
    const wrong = list.filter((s) => s.ok && expectVersion && s.version !== expectVersion).length;
    if (wrong) reasons.push(`${wrong} responses not served by ${expectVersion}`);
  } else if (list.length >= 20) {
    if (errorRate > Math.max(0.2, maxErrorRate * 10))
      reasons.push(`fast fail: ${(errorRate * 100).toFixed(0)}% errors in 5 s`);
    if (latency > maxP95 * 2) reasons.push(`fast fail: p95 ${latency.toFixed(0)} ms in 5 s`);
  }
  return {
    requests: list.length,
    failed,
    errorRate: Number(errorRate.toFixed(4)),
    p95Ms: Math.round(latency),
    reasons,
  };
}

const start = Date.now();
const inflight = new Set();
let verdict = null;
// Paced by elapsed time, not by the timer period: OS timer granularity (~15.6 ms on Windows) would otherwise
// silently lower the real rate and fail MIN_REQUESTS for a perfectly healthy release.
let sent = 0;
const timer = setInterval(() => {
  const due = Math.floor(((Date.now() - start) / 1000) * rps) - sent;
  for (let i = 0; i < due; i++, sent++) {
    // 9 of 10 requests hit the catalog (the business path), 1 of 10 the readiness endpoint.
    const p = probe(sent % 10 === 9 ? '/ready' : '/products').finally(() => inflight.delete(p));
    inflight.add(p);
  }
}, 10);

const slicer = setInterval(() => {
  const slice = judge(
    samples.filter((s) => s.at > Date.now() - SLICE_MS),
    { final: false },
  );
  if (slice.reasons.length) verdict = { early: true, slice };
  if (verdict || Date.now() - start >= seconds * 1000) finish();
}, SLICE_MS);

async function finish() {
  clearInterval(timer);
  clearInterval(slicer);
  await Promise.allSettled([...inflight]);
  const total = judge(samples, { final: true });
  const reasons = [...(verdict?.slice.reasons ?? []), ...total.reasons];
  const report = {
    ...total,
    pass: reasons.length === 0,
    reasons,
    stoppedEarly: Boolean(verdict),
    durationSec: Math.round((Date.now() - start) / 1000),
    thresholds: { maxErrorRate, maxP95Ms: maxP95, minRequests, expectVersion },
  };
  console.log(JSON.stringify(report));
  process.exit(report.pass ? 0 : 1);
}
