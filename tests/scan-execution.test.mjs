import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./helpers/load-ts-module.mjs";
const { maintainScanExecution, sameExecution, liveExecution, ScanExecutionTimeoutError } = await loadTsModule("lib/server/scan-execution.ts");

test("execution identity includes token, worker, job and claimed attempt", () => {
  const lease = { token: "a", jobId: "job", workerId: "worker", attempt: 2, active: true, heartbeatAt: new Date().toISOString() };
  assert.equal(sameExecution(lease, lease), true);
  for (const change of [{ token: "b" }, { jobId: "other" }, { workerId: "other" }, { attempt: 1 }]) {
    assert.equal(sameExecution(lease, { ...lease, ...change }), false);
  }
  assert.equal(liveExecution(lease), true);
  assert.equal(liveExecution({ ...lease, active: false }), false);
  assert.equal(liveExecution({ ...lease, heartbeatAt: "2000-01-01T00:00:00.000Z" }), false);
});

test("loss of ownership aborts in-flight HTTP and prevents scheduling another request", async () => {
  let refreshes = 0, requests = 0, capturedSignal;
  const guard = maintainScanExecution(async () => { refreshes++; });
  const request = guard.wrapFetch(async (_url, init) => {
    requests++; capturedSignal = init.signal;
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  });
  const first = request("https://provider.invalid/fixture");
  await new Promise(resolve => setImmediate(resolve));
  guard.lose();
  await assert.rejects(first, { code: "scan_ownership_lost" });
  await assert.rejects(request("https://provider.invalid/fixture"), { code: "scan_ownership_lost" });
  assert.equal(capturedSignal.aborted, true); assert.equal(requests, 1); assert.equal(refreshes, 1);
  await guard.stop();
});

test("a failed ownership check never makes a network request", async () => {
  const guard = maintainScanExecution(async () => { throw new Error("unavailable DB"); });
  let requests = 0;
  await assert.rejects(guard.wrapFetch(async () => { requests++; return new Response(); })("https://provider.invalid"), { code: "scan_ownership_lost" });
  assert.equal(requests, 0); await guard.stop();
});

test("existing request cancellation is combined with ownership cancellation", async () => {
  const guard = maintainScanExecution(async () => {}), caller = new AbortController();
  let signal;
  await guard.wrapFetch(async (_url, init) => { signal = init.signal; return new Response(); })("https://provider.invalid", { signal: caller.signal });
  caller.abort(); assert.equal(signal.aborted, true); assert.equal(guard.signal.aborted, false);
  await guard.stop();
});

test("heartbeat ownership loss stops an idle executor too", async () => {
  const guard = maintainScanExecution(async () => { throw new Error("reclaimed"); }, 5);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(guard.signal.aborted, true); await guard.stop();
});

test("an absolute duration ceiling aborts an execution even while ownership stays healthy", async () => {
  const guard = maintainScanExecution(async () => {}, 5, 15);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(guard.signal.aborted, true);
  assert.ok(guard.signal.reason instanceof ScanExecutionTimeoutError);
  assert.equal(guard.signal.reason.code, "scan_execution_timeout");
  await guard.stop();
});

test("omitting the duration ceiling never aborts on its own", async () => {
  const guard = maintainScanExecution(async () => {}, 5);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(guard.signal.aborted, false);
  await guard.stop();
});

test("known Apify run identity checkpoints before polling, without storing query text", async () => {
  const { HarshmaurRedditProvider } = await loadTsModule("lib/providers/reddit-harshmaur.server.ts");
  let release, saved, markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const persisted = new Promise(resolve => { release = resolve; });
  const requests = [];
  const provider = new HarshmaurRedditProvider({ token: "fixture-token", discoveryRetryAttempts: 1,
    onActorStarted: async checkpoint => { saved = checkpoint; markStarted(); await persisted; },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), method: init.method });
      return new Response(JSON.stringify({ data: { id: "fixture_run", defaultDatasetId: "fixture_dataset", status: requests.length === 1 ? "RUNNING" : "FAILED" } }));
    },
  });
  const discovery = provider.discover({ queries: { productCategories: ["private fixture category"] }, limit: 40, since: "2026-01-01" });
  const rejected = assert.rejects(discovery);
  await started;
  assert.equal(requests.length, 1); assert.equal(saved.actorRunId, "fixture_run");
  assert.equal(saved.datasetId, "fixture_dataset"); assert.match(saved.inputHash, /^[a-f0-9]{64}$/u);
  assert.ok(!JSON.stringify(saved).includes("private fixture")); assert.ok(!JSON.stringify(saved).includes("fixture-token"));
  release(); await rejected; assert.ok(requests.length > 1);
});
