import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./helpers/load-ts-module.mjs";
import { scanWorkflowHarness } from "./helpers/scan-workflow-harness.mjs";
const { runtimeProgress, recordScanWork, refreshRuntimeProgress, scanStatusSnapshot } = await loadTsModule("lib/server/scan-progress.ts");
const seed = () => ({ id: "fixture_progress", workspaceId: "fixture_workspace", websiteUrl: "", status: "queued", result: null,
  progress: [], createdAt: "2026-08-31T12:00:00Z", updatedAt: "2026-08-31T12:00:00Z", error: null });

test("legacy progress uses unknown counters, never invents complete coverage from status", () => {
  const row = seed(); row.status = "complete";
  const value = refreshRuntimeProgress(row);
  assert.equal(value.phase, "complete"); assert.equal(value.canonicalEligible, null);
  assert.equal(value.coverageComplete, null); assert.equal(value.queries.succeeded, null);
  assert.equal(value.runStartedAt, null); assert.equal(value.lastWorkAt, null);
});

test("heartbeat refresh and polling cannot change the last real work timestamp", () => {
  const row = seed(); row.execution = { heartbeatAt: "2026-08-31T12:00:00Z" };
  recordScanWork(row, "2026-08-31T12:00:01Z");
  row.execution.heartbeatAt = "2026-08-31T12:10:00Z";
  for (let i = 0; i < 3; i++) {
    const status = scanStatusSnapshot(row);
    assert.equal(status.runtimeProgress.heartbeatAt, row.execution.heartbeatAt);
    assert.equal(status.runtimeProgress.lastWorkAt, "2026-08-31T12:00:01Z");
  }
});

test("coverage requires complete searches, complete triage and the entire selected deep-review target", () => {
  const row = seed(), value = runtimeProgress(row);
  value.discoveryComplete = false; row.triageCoverage = { expected: 2, succeeded: 2, pending: 0, unresolved: 0, complete: true };
  value.deepReview = { target: 2, completed: 2, threadsVerified: 0 };
  assert.equal(refreshRuntimeProgress(row).coverageComplete, false);
  value.discoveryComplete = true; value.deepReview.completed = 1;
  assert.equal(refreshRuntimeProgress(row).coverageComplete, false);
  value.deepReview.completed = 2;
  assert.equal(refreshRuntimeProgress(row).coverageComplete, true);
  assert.equal(value.deepReview.threadsVerified, 0);
});

test("the compact read model keeps concurrent stages and excludes evidence, secrets and internal IDs", () => {
  const row = seed(); row.status = "running";
  row.progress = [{ id: "discovery", status: "active" }, { id: "triage", status: "active" }];
  Object.assign(row, { websiteSnapshot: { secret: "raw_crawl_sentinel" }, result: { secret: "raw_report_sentinel" },
    execution: { token: "owner_token_sentinel", heartbeatAt: "2026-08-31T12:05:00Z" },
    durableJob: { id: "internal_job_sentinel", acceptedAt: row.createdAt }, contextText: "context_sentinel" });
  const value = scanStatusSnapshot(row), encoded = JSON.stringify(value);
  assert.equal(value.progress.filter(stage => stage.status === "active").length, 2);
  assert.equal(value.durableAccepted, true);
  assert.doesNotMatch(encoded, /sentinel/); assert.ok(encoded.length < 3000);
});

test("real workflow counts unique completed judgments, not duplicate batch callbacks", async t => {
  const h = await scanWorkflowHarness(t, { count: 12 });
  const original = h.state.ai.triageConversations;
  h.state.ai.triageConversations = async request => {
    const value = await original(request);
    await request.onBatchSucceeded(value.value);
    await request.onBatchSucceeded(value.value);
    return value;
  };
  await assert.rejects(h.workflow.runScan(h.scan.id), /fixture_stop_at_qualification/);
  const progress = h.saved.at(-1).runtimeProgress;
  assert.equal(progress.triage.succeeded, 12); assert.equal(progress.triage.expected, 12);
  assert.equal(progress.triage.promising, 12); assert.equal(progress.canonicalEligible, 12);
  assert.equal(progress.deepReview.target, 8); assert.equal(progress.deepReview.completed, 0);
  assert.equal(progress.deepReview.threadsVerified, 0); assert.equal(progress.coverageComplete, false);
});
