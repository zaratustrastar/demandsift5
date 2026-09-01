import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./helpers/load-ts-module.mjs";
const { startScanPolling, readScanResponse } = await loadTsModule("lib/client/scan-polling.ts");
const { scanElapsedMs, durationLabel, progressDetail } = await loadTsModule("lib/client/scan-progress-view.ts");
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function clock() {
  let now = 0, next = 0, visible = true;
  const timers = new Map(), listeners = new Set();
  return {
    environment: { visible: () => visible, timer: (callback, delay) => { const id = ++next; timers.set(id, { callback, at: now + delay }); return () => timers.delete(id); },
      subscribeWake: callback => { listeners.add(callback); return () => listeners.delete(callback); } },
    get delays() { return [...timers.values()].map(value => value.at - now).sort((a, b) => a - b); },
    get subscriptions() { return listeners.size; },
    hide() { visible = false; }, show() { visible = true; this.wake(); },
    wake() { for (const callback of listeners) callback(); },
    async advance(ms) {
      now += ms;
      for (const [id, value] of [...timers]) if (value.at <= now) { timers.delete(id); value.callback(); }
      await flush();
    },
  };
}

test("visible polls run every three seconds, hidden polls slow down, focus refreshes immediately", async () => {
  const c = clock(); let calls = 0;
  const poll = startScanPolling({ environment: c.environment, run: async () => { calls++; return false; }, onError: assert.fail });
  await flush(); assert.equal(calls, 1); assert.deepEqual(c.delays, [3000]);
  c.hide(); await c.advance(3000); assert.equal(calls, 2); assert.deepEqual(c.delays, [30000]);
  await c.advance(29999); assert.equal(calls, 2);
  c.show(); await flush(); assert.equal(calls, 3); assert.deepEqual(c.delays, [3000]);
  poll.stop(); assert.deepEqual(c.delays, []); assert.equal(c.subscriptions, 0);
});

test("repeated focus cannot overlap an outstanding request", async () => {
  const c = clock(); let calls = 0, active = 0, maxActive = 0, release;
  const poll = startScanPolling({ environment: c.environment, run: async () => {
    calls++; active++; maxActive = Math.max(maxActive, active);
    if (calls === 1) await new Promise(resolve => { release = resolve; });
    active--; return false;
  }, onError: assert.fail });
  for (let i = 0; i < 5; i++) c.wake();
  assert.equal(calls, 1); release(); await flush();
  assert.deepEqual(c.delays, [0]); await c.advance(0);
  assert.equal(calls, 2); assert.equal(maxActive, 1); poll.stop();
});

test("transient errors retain the scan and back off, then recover without a restart", async () => {
  const c = clock(), connections = []; let calls = 0;
  const poll = startScanPolling({ environment: c.environment, run: async () => {
    calls++; if (calls < 3) throw new TypeError("fixture network request failed"); return false;
  }, onConnectionChange: value => connections.push(value), onError: assert.fail });
  await flush(); assert.deepEqual(c.delays, [1500]);
  await c.advance(1500); assert.deepEqual(c.delays, [3000]);
  await c.advance(3000); assert.deepEqual(connections, [false, false, true]);
  assert.deepEqual(c.delays, [3000]); poll.stop();
});

test("a timed-out request aborts before retry and stop cancels all future requests", async () => {
  const c = clock(); let calls = 0, aborted = 0;
  const poll = startScanPolling({ environment: c.environment, requestTimeoutMs: 100,
    run: signal => new Promise((_, reject) => { calls++; signal.addEventListener("abort", () => { aborted++; reject(signal.reason); }); }), onError: assert.fail });
  await c.advance(100); assert.equal(aborted, 1); assert.deepEqual(c.delays, [1500]);
  await c.advance(1500); assert.equal(calls, 2);
  poll.stop(); await flush(); assert.equal(aborted, 2); assert.deepEqual(c.delays, []);
  c.wake(); await c.advance(60000); assert.equal(calls, 2);
});

test("completion and genuine terminal errors both stop polling", async () => {
  for (const done of [true, false]) {
    const c = clock(); let errors = 0, calls = 0;
    startScanPolling({ environment: c.environment, run: async () => { calls++; if (!done) throw new Error("fixture private scan not found"); return true; }, onError: () => errors++ });
    await flush(); c.wake(); await c.advance(30000);
    assert.equal(calls, 1); assert.equal(errors, done ? 0 : 1); assert.equal(c.subscriptions, 0); assert.deepEqual(c.delays, []);
  }
});

test("proxy/rate-limit/malformed responses reconnect while access errors remain distinct", async () => {
  for (const status of [408, 425, 429, 500, 502, 503]) await assert.rejects(readScanResponse(new Response("fixture proxy error", { status })), TypeError);
  await assert.rejects(readScanResponse(new Response("<html>proxy interrupted</html>")), TypeError);
  await assert.rejects(readScanResponse(Response.json({ error: { message: "Private scan not found" } }, { status: 404 })), /Private scan not found/);
});

test("elapsed time survives reload, freezes at completion and excludes the review pause", () => {
  const progress = { analysisStartedAt: "2026-08-31T12:00:00Z", analysisFinishedAt: "2026-08-31T12:01:00Z", runStartedAt: "2026-08-31T12:31:00Z", finishedAt: null };
  const now = Date.parse("2026-08-31T12:35:00Z");
  assert.equal(scanElapsedMs(progress, now), 5 * 60000);
  assert.equal(scanElapsedMs(structuredClone(progress), now), 5 * 60000);
  progress.finishedAt = "2026-08-31T12:36:00Z";
  assert.equal(scanElapsedMs(progress, now + 24 * 3600000), 6 * 60000);
  assert.equal(scanElapsedMs(undefined, now), null); assert.equal(durationLabel(65100), "1m 5s");
});

test("progress copy uses actual counters and makes unresolved checks explicit", () => {
  const progress = { queries: { planned: 9, succeeded: 6, retrying: 1, failed: 0 }, discoveryComplete: false,
    triage: { succeeded: 175, promising: 12, unresolved: 2 }, deepReview: { target: 8, completed: 3, threadsVerified: 0 }, results: { repliesReady: 2 } };
  assert.match(progressDetail("discovery", progress, "fallback"), /6 of 9 searches finished.*1 search is retrying/);
  assert.match(progressDetail("triage", progress, "fallback"), /175 discussions reviewed; more results may arrive.*2 checks remain unresolved/);
  assert.match(progressDetail("qualification", progress, "fallback"), /3 of 8 selected/);
  assert.match(progressDetail("enrichment", progress, "fallback"), /0 additional public threads verified/);
  assert.match(progressDetail("replies", progress, "fallback"), /2 reply drafts saved/);
});
