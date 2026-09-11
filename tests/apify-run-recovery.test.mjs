import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { loadTsModule } from "./helpers/load-ts-module.mjs";
import { scanWorkflowHarness } from "./helpers/scan-workflow-harness.mjs";
const { ApifyRunRecovery } = await loadTsModule("lib/providers/apify-run-recovery.ts");
const { jobWillRetryScanFailure } = await loadTsModule("lib/server/job-retry-classification.ts");
const args = { actorId: "fixture~actor", actorInput: { startUrls: [{ url: "https://www.reddit.com/search/?q=fixture" }] },
  platformMaxItems: 250, wantedItems: 250, maxChargeUsd: 1, timeoutMs: 20_000, token: "fixture-token", label: "Fixture" };
const meta = (id = "run1", status = "SUCCEEDED", dataset = "dataset1") => new Response(JSON.stringify({ data: { id, status, defaultDatasetId: dataset } }));
const isStart = url => new URL(url).pathname.startsWith("/v2/actors/");
const page = data => new Response(JSON.stringify(data));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

for (const failure of ["network", "503", "missing-id"]) test(`ambiguous ${failure} start is not repeated, including after restart`, async () => {
  const ledger = {}; let calls = 0; const saves = [];
  const fetchImpl = async () => {
    calls++; assert.equal(saves.at(-1)[Object.keys(ledger)[0]].status, "STARTING", "intent must be saved before POST");
    if (failure === "network") throw new Error("synthetic lost response");
    return failure === "503" ? new Response("gateway failed", { status: 503 }) : meta("");
  };
  const recovery = new ApifyRunRecovery({ ledger, onChange: async () => saves.push(structuredClone(ledger)) });
  await assert.rejects(recovery.run({ ...args, fetchImpl }), e => e.code === "apify_start_ambiguous");
  const resumed = new ApifyRunRecovery({ ledger: structuredClone(ledger) });
  await assert.rejects(resumed.run({ ...args, fetchImpl }), e => e.code === "apify_start_ambiguous");
  assert.equal(calls, 1); assert.equal(jobWillRetryScanFailure({ code: "apify_start_ambiguous", jobAttempts: 1, jobMaxAttempts: 5 }), false);
});

test("lost dataset GET resumes the successful run, preserving all paginated items without a new POST", async () => {
  const ledger = {}; let posts = 0, inspections = 0, broken = true; const offsets = [];
  const fetchImpl = async url => {
    if (isStart(url)) { posts++; return meta(); }
    if (String(url).includes("/actor-runs/")) { inspections++; return meta(); }
    if (broken) return new Response("temporary dataset failure", { status: 503, headers: { "retry-after": "0" } });
    const params = new URL(url).searchParams, offset = Number(params.get("offset")); offsets.push(offset);
    return page(Array.from({ length: Math.min(100, 250 - offset) }, (_, i) => ({ id: offset + i })));
  };
  await assert.rejects(new ApifyRunRecovery({ ledger }).run({ ...args, fetchImpl }));
  broken = false;
  const rows = await new ApifyRunRecovery({ ledger: structuredClone(ledger) }).run({ ...args, fetchImpl });
  assert.equal(posts, 1); assert.equal(inspections, 1); assert.equal(rows.length, 250);
  assert.deepEqual(offsets, [0, 100, 200]); assert.deepEqual(rows.map(row => row.id), Array.from({ length: 250 }, (_, i) => i));
});

for (const abortStatus of ["ABORTING", "ABORTED"]) test(`${abortStatus}: only a confirmed terminal abort permits a replacement`, async () => {
  const ledger = {}; let posts = 0, secondAttempt = false, aborts = 0;
  const fetchImpl = async url => {
    if (isStart(url)) { posts++; return meta(`run${posts}`, "RUNNING"); }
    if (String(url).endsWith("/abort")) { aborts++; return meta("run1", abortStatus); }
    if (String(url).includes("/actor-runs/")) {
      if (!secondAttempt) return new Response("poll failure", { status: 503, headers: { "retry-after": "0" } });
      return meta(posts === 2 ? "run2" : "run1");
    }
    return page([{ id: "evidence" }]);
  };
  await assert.rejects(new ApifyRunRecovery({ ledger }).run({ ...args, fetchImpl }));
  secondAttempt = true;
  assert.equal((await new ApifyRunRecovery({ ledger }).run({ ...args, fetchImpl })).length, 1);
  assert.equal(aborts, 1); assert.equal(posts, abortStatus === "ABORTED" ? 2 : 1);
});

test("unconfirmed abort failure retains the known run ID and only resumes GETs", async () => {
  const ledger = {}; let posts = 0, recovered = false;
  const fetchImpl = async url => {
    if (isStart(url)) { posts++; return meta("run1", "RUNNING"); }
    if (String(url).endsWith("/abort")) throw new Error("abort response lost");
    if (String(url).includes("/actor-runs/")) return recovered ? meta() : new Response("poll failure", { status: 503, headers: { "retry-after": "0" } });
    return page([{ id: "evidence" }]);
  };
  await assert.rejects(new ApifyRunRecovery({ ledger }).run({ ...args, fetchImpl })); recovered = true;
  await new ApifyRunRecovery({ ledger }).run({ ...args, fetchImpl }); assert.equal(posts, 1);
});

test("failed terminal starts share a durable budget across job attempts", async () => {
  const ledger = {}; let posts = 0;
  const fetchImpl = async () => { posts++; return meta(`run${posts}`, "FAILED"); };
  for (let i = 0; i < 3; i++) await assert.rejects(new ApifyRunRecovery({ ledger }).run({ ...args, fetchImpl }));
  await assert.rejects(new ApifyRunRecovery({ ledger }).run({ ...args, fetchImpl }), e => e.code === "apify_recovery_exhausted");
  assert.equal(posts, 3); assert.equal(Object.values(ledger)[0].attempts, 3);
});

test("ownership cancellation retains a resumable run and does not abort a successor's work", async () => {
  const ledger = {}, controller = new AbortController(), polling = deferred(); let posts = 0, aborts = 0;
  const fetchImpl = async (url, init) => {
    if (isStart(url)) { posts++; return meta("run1", "RUNNING"); }
    if (String(url).endsWith("/abort")) { aborts++; return meta("run1", "ABORTED"); }
    polling.resolve(); return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
  };
  const running = assert.rejects(new ApifyRunRecovery({ ledger }).run({ ...args, fetchImpl, signal: controller.signal }), { name: "AbortError" });
  await polling.promise; controller.abort(); await running;
  await new ApifyRunRecovery({ ledger }).run({ ...args, fetchImpl: async url => {
    assert.equal(isStart(url), false); return String(url).includes("/actor-runs/") ? meta() : page([]);
  } });
  assert.equal(posts, 1); assert.equal(aborts, 0);
});

test("T05 actor checkpoints are adopted and inspected before any paid start", async () => {
  const inputHash = createHash("sha256").update(JSON.stringify({ actorId: args.actorId, actorInput: args.actorInput, platformMaxItems: args.platformMaxItems })).digest("hex");
  const recovery = new ApifyRunRecovery({ ledger: {}, previousRuns: [{ actorId: args.actorId, inputHash, actorRunId: "run1",
    datasetId: "dataset1", startedAt: new Date().toISOString() }] });
  let inspected = 0;
  await recovery.run({ ...args, fetchImpl: async url => {
    assert.equal(isStart(url), false);
    if (String(url).includes("/actor-runs/")) { inspected++; return meta(); } return page([]);
  } });
  assert.equal(inspected, 1);
});

test("concurrent identical requests share a run; intentional mapping recovery remains separate", async () => {
  let posts = 0; const recovery = new ApifyRunRecovery();
  const options = { ...args, fetchImpl: async url => {
    if (isStart(url)) { posts++; return meta(`run${posts}`); }
    return page([{ id: "evidence" }]);
  } };
  const [first, second] = await Promise.all([recovery.run(options), recovery.run(options)]);
  assert.deepEqual(first, second); assert.equal(posts, 1);
  await recovery.run({ ...options, purpose: "mapping-recovery" }); assert.equal(posts, 2);
});

test("Actor capacity spans the run and releases only after a proved terminal state", async () => {
  const events = [];
  const actorCapacity = { acquire: async input => {
    events.push({ type: "acquire", input });
    return { release: async () => { events.push({ type: "release" }); return true; } };
  } };
  await new ApifyRunRecovery({ ledger: {}, actorCapacity, actorCapacityLimit: 3,
    workspaceId: "workspace_one", holderPrefix: "scan:one" }).run({
    ...args,
    fetchImpl: async url => isStart(url) ? meta() : page([]),
  });
  assert.equal(events[0].input.pool, "apify-actor");
  assert.equal(events[0].input.workspaceId, "workspace_one");
  assert.equal(events[0].input.limit, 3);
  assert.match(events[0].input.holderKey, /^scan:one:/u);
  assert.deepEqual(events.map(event => event.type), ["acquire", "release"]);

  const ambiguous = [];
  await assert.rejects(new ApifyRunRecovery({ ledger: {}, actorCapacity: { acquire: async () => ({
    release: async () => { ambiguous.push("release"); return true; },
  }) }, workspaceId: "workspace_one" }).run({
    ...args,
    fetchImpl: async () => { throw new Error("lost start response"); },
  }), error => error.code === "apify_start_ambiguous");
  assert.deepEqual(ambiguous, [], "an ambiguous live Actor must keep its slot for crash reconciliation");
});

test("workflow preserves nonrecoverable actor codes instead of scheduling blind job retries", async t => {
  const fixture = await scanWorkflowHarness(t);
  fixture.state.reddit.discover = async () => { const error = new Error("Synthetic ambiguous actor start"); error.code = "apify_start_ambiguous"; throw error; };
  await assert.rejects(fixture.workflow.runScan(fixture.scan.id, { jobAttempts: 1, jobMaxAttempts: 5 }), error => error.code === "apify_start_ambiguous");
  assert.equal(fixture.scan.status, "failed"); assert.equal(fixture.scan.errorCode, "apify_start_ambiguous");
  assert.equal(fixture.submissions.length, 0);
});
