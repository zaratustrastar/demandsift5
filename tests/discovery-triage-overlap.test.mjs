import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./helpers/load-ts-module.mjs";
import { scanWorkflowHarness } from "./helpers/scan-workflow-harness.mjs";
import { business, candidate, triage, chatResponse, requestCandidates } from "./fixtures/scan-replay/factories.mjs";
const { OpenAiProvider, DEFAULT_OPENAI_MODELS: models } = await loadTsModule("lib/providers/openai.server.ts");
const { createDiscoveryTriageCoordinator, newDiscoveryTriageCheckpoint } = await loadTsModule("lib/server/discovery-triage-coordinator.ts");
const { triageInputVersion } = await loadTsModule("lib/ai/triage-dispatcher.ts");
const turn = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
const response = candidates => ({ candidates, sourceMode: "live", searchPlan: [], diagnostics: {
  queryCount: 3, fetchedCandidates: candidates.length, normalizedCandidates: candidates.length,
  verifiedRecentCandidates: candidates.length, rejectedByReason: {}, laneQueryCounts: {}, degraded: false } });
function providerFor(fixture, calls, { onCall, judge = row => triage(row.externalId), embeddingsFail = false } = {}) {
  const provider = new OpenAiProvider({ apiKey: "fixture", apiStyle: "chat", maxRetries: 0,
    fetchImpl: async (_url, init) => {
      const rows = requestCandidates(init); calls.push(rows); await onCall?.(rows);
      return chatResponse(rows.map(judge));
    } });
  provider.qualifyConversations = async request => { fixture.submissions.push(request); throw fixture.stop; };
  provider.embed = async request => {
    if (embeddingsFail) throw new Error("fixture embedding unavailable");
    return { value: request.texts.map((_text, index) => index > 0 && index <= 50 ? [0, 1] : [1, 0]),
      usage: { inputTokens: 0, outputTokens: 0 }, model: "fixture", estimatedCostUsd: 0 };
  };
  fixture.state.ai = provider; return provider;
}

test("workflow starts AI before late search finishes, never blocks the chunk hook, and rechecks richer evidence", async t => {
  const fixture = await scanWorkflowHarness(t, { count: 26, env: { SCAN_OVERLAP_DISCOVERY_TRIAGE: "1" } });
  const calls = [], firstAi = deferred(), releaseAi = deferred(), chunkReturned = deferred(), lastSearch = deferred();
  const richer = { ...fixture.rows[0], body: `${fixture.rows[0].body} New evidence: evaluating a replacement this week.`, metrics: { score: 10, comments: 50 } };
  const final = [richer, ...fixture.rows.slice(1)];
  providerFor(fixture, calls, { onCall: async () => { firstAi.resolve(); await releaseAi.promise; },
    judge: row => triage(row.externalId, row.externalId === "depth25" ? {} : { intent: "problem_aware", demandSignal: "pain" }) });
  fixture.state.reddit.discover = async (_request, hooks) => {
    await hooks.onChunkSucceeded(response(fixture.rows.slice(0, 25))); chunkReturned.resolve();
    await lastSearch.promise; return response(final);
  };
  const running = assert.rejects(fixture.workflow.runScan(fixture.scan.id), error => error === fixture.stop);
  await Promise.all([firstAi.promise, chunkReturned.promise]);
  assert.equal(calls.flat().length, 25); assert.equal(fixture.submissions.length, 0);
  releaseAi.resolve(); await turn(); lastSearch.resolve(); await running;
  assert.equal(calls.flat().filter(row => row.externalId === "depth0").length, 2);
  assert.equal(calls.flat().findLast(row => row.externalId === "depth0").body, richer.body);
  assert.equal(calls.flat().filter(row => row.externalId === "depth25").length, 1);
  assert.ok(fixture.submissions[0].conversations.some(row => row.externalId === "depth25"));
  assert.equal(fixture.submissions[0].conversations.length, 8);
  assert.equal(fixture.scan.triageCoverage.complete, true); assert.equal(fixture.scan.triageCoverage.expected, 26);
  assert.equal(fixture.scan.triageCheckpointVersions.depth0, triageInputVersion({ business: fixture.scan.discoveryProfile.business, models }, richer));
});

for (const embeddingsFail of [false, true]) test(`450-candidate final pool and shortlist match baseline (embedding failure=${embeddingsFail})`, async t => {
  const runs = [];
  for (const enabled of [false, true]) await t.test(enabled ? "overlap" : "sequential", async child => {
    const fixture = await scanWorkflowHarness(child, { count: 450, env: { SCAN_OVERLAP_DISCOVERY_TRIAGE: enabled ? "1" : "0" } });
    const calls = []; providerFor(fixture, calls, { embeddingsFail });
    child.mock.method(console, "error", () => {});
    fixture.state.reddit.discover = async (_request, hooks) => {
      for (const count of [100, 250, 450]) { await hooks.onChunkSucceeded(response(fixture.rows.slice(0, count))); await turn(); }
      return response(fixture.rows);
    };
    await assert.rejects(fixture.workflow.runScan(fixture.scan.id), error => error === fixture.stop);
    const expected = embeddingsFail ? 450 : 400;
    assert.equal(fixture.scan.triageCoverage.expected, expected); assert.equal(fixture.scan.triageCoverage.complete, true);
    assert.ok(calls.flat().length <= expected + (enabled ? 100 : 0));
    if (enabled) assert.equal(fixture.scan.discoveryTriageCheckpoint.submittedVersions.length, 100);
    runs.push({ eligible: Object.keys(fixture.scan.triageProcessing).sort(), shortlist: fixture.submissions[0].conversations.map(row => row.externalId) });
  });
  assert.deepEqual(runs[1], runs[0]);
});

test("restart after partial discovery reuses exact saved early judgments without resubmission", async t => {
  const fixture = await scanWorkflowHarness(t, { count: 26, env: { SCAN_OVERLAP_DISCOVERY_TRIAGE: "1" } });
  const calls = [], earlySaved = deferred(); let interrupted = true;
  providerFor(fixture, calls);
  const originalSave = fixture.state.repository.saveScan;
  fixture.state.repository.saveScan = async scan => {
    await originalSave(scan);
    if (Object.keys(scan.discoveryTriageCheckpoint?.judgments ?? {}).length === 25) earlySaved.resolve();
  };
  fixture.state.reddit.discover = async (_request, hooks) => {
    if (interrupted) { await hooks.onChunkSucceeded(response(fixture.rows.slice(0, 25))); await earlySaved.promise; throw new Error("fixture lost final poll"); }
    assert.equal(hooks.resumeFrom.candidates.length, 25);
    return response(fixture.rows);
  };
  await assert.rejects(fixture.workflow.runScan(fixture.scan.id), error => error.code === "reddit_discovery_failed");
  assert.equal(Object.keys(fixture.scan.discoveryTriageCheckpoint.judgments).length, 25);
  assert.equal(fixture.submissions.length, 0); interrupted = false; calls.length = 0;
  await assert.rejects(fixture.workflow.runScan(fixture.scan.id, { resumeRunning: true }), error => error === fixture.stop);
  assert.deepEqual(calls.flat().map(row => row.externalId), ["depth25"]);
  assert.equal(fixture.scan.triageCoverage.complete, true);
});

test("future records can become eligible at a later wall clock and short batches flush", async () => {
  let now = new Date("2026-08-31T12:00:00Z"); const checkpoint = newDiscoveryTriageCheckpoint();
  const called = deferred(); const rows = [candidate("future", { createdAt: "2026-08-31T12:10:00Z" })];
  const provider = new OpenAiProvider({ apiKey: "fixture", apiStyle: "chat", maxRetries: 0,
    fetchImpl: async (_url, init) => { called.resolve(); return chatResponse(requestCandidates(init).map(row => triage(row.externalId))); } });
  const coordinator = createDiscoveryTriageCoordinator({ provider, checkpoint, request: { business, models },
    since: "2025-08-31T12:00:00Z", now: () => now, flushDelayMs: 1, onCheckpoint: async () => {} });
  coordinator.offer(rows); assert.equal(checkpoint.submittedVersions.length, 0);
  now = new Date("2026-08-31T12:11:00Z"); coordinator.offer(rows); await called.promise;
  const final = await coordinator.finish(rows); assert.equal(final.retained.size, 1);
});

test("speculation reservation is bounded across versions/restarts and bad numeric configuration", async () => {
  const checkpoint = newDiscoveryTriageCheckpoint();
  const provider = new OpenAiProvider({ apiKey: "fixture", apiStyle: "chat", maxRetries: 0,
    fetchImpl: async (_url, init) => chatResponse(requestCandidates(init).map(row => triage(row.externalId))) });
  const rows = Array.from({ length: 250 }, (_, i) => candidate(`bound${i}`));
  const options = { provider, checkpoint, request: { business, models }, since: "2025-08-31T00:00:00Z",
    maxCandidates: NaN, onCheckpoint: async () => {} };
  const coordinator = createDiscoveryTriageCoordinator(options); coordinator.offer(rows); await coordinator.finish(rows);
  assert.equal(checkpoint.submittedVersions.length, 100);
  const resumed = createDiscoveryTriageCoordinator(options);
  resumed.offer(rows.map(row => ({ ...row, body: `${row.body} More detail.` })));
  const final = await resumed.finish(rows);
  assert.equal(checkpoint.submittedVersions.length, 100); assert.equal(final.reused, 100);
});
