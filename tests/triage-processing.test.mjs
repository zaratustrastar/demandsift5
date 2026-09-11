import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./helpers/load-ts-module.mjs";
import { scanWorkflowHarness } from "./helpers/scan-workflow-harness.mjs";
import { business, candidate, triage, chatResponse, requestCandidates } from "./fixtures/scan-replay/factories.mjs";
const { OpenAiProvider, DEFAULT_OPENAI_MODELS, isLegacyUnresolvedTriage, isUsableTriageJudgment } = await loadTsModule("lib/providers/openai.server.ts");
const legacy = id => triage(id, { relevant: false, intent: "informational", demandSignal: "none", problem: undefined,
  productFit: "unknown", timing: "unknown", replyability: "unknown", worthEnriching: false,
  reason: "Skipped: OpenAI could not return usable structured output for this candidate after every retry (synthetic failure)." });
const request = rows => ({ business, candidates: rows, models: DEFAULT_OPENAI_MODELS, coverageRetries: 0 });

test("legacy synthetic failure recognition is narrow and validates checkpoint identity", () => {
  assert.equal(isLegacyUnresolvedTriage(legacy("legacy")), true);
  assert.equal(isUsableTriageJudgment(legacy("legacy"), "legacy"), false);
  const negative = triage("negative", { relevant: false, worthEnriching: false, reason: "An ordinary non-relevant conversation." });
  assert.equal(isLegacyUnresolvedTriage(negative), false); assert.equal(isUsableTriageJudgment(negative, "negative"), true);
  assert.equal(isUsableTriageJudgment(negative, "other"), false);
  assert.equal(isUsableTriageJudgment({ externalId: "missing", relevant: false }, "missing"), false);
});

test("resume re-evaluates legacy failures but retains genuine negative and positive judgments", async () => {
  const calls = [];
  const provider = new OpenAiProvider({ apiKey: "fixture-key", apiStyle: "chat", maxRetries: 0,
    fetchImpl: async (_url, init) => { const rows = requestCandidates(init); calls.push(...rows.map(row => row.externalId)); return chatResponse(rows.map(row => triage(row.externalId))); } });
  const result = await provider.triageConversations({ ...request([candidate("legacy"), candidate("negative"), candidate("positive")]),
    resumeFrom: new Map([["legacy", legacy("legacy")], ["negative", triage("negative", { relevant: false, worthEnriching: false })], ["positive", triage("positive")]]) });
  assert.deepEqual(calls, ["legacy"]); assert.equal(result.value.length, 3); assert.equal(result.coverage.complete, true);
  assert.equal(result.value.find(row => row.externalId === "negative").triage.relevant, false);
});

test("valid partial batch judgments are checkpointed even when remaining coverage exhausts", async () => {
  const checkpoint = []; const outcomes = [];
  const provider = new OpenAiProvider({ apiKey: "fixture-key", apiStyle: "chat", maxRetries: 0,
    fetchImpl: async () => chatResponse([triage("a")]) });
  const result = await provider.triageConversations({ ...request([candidate("a"), candidate("b")]), tolerateUnrecoverableBatches: true,
    onBatchSucceeded: rows => checkpoint.push(...rows), onProcessingUpdated: rows => outcomes.push(...rows) });
  assert.deepEqual(checkpoint.map(row => row.externalId), ["a"]);
  assert.deepEqual(result.value.map(row => row.externalId), ["a"]);
  assert.equal(result.coverage.complete, false);
  assert.equal(outcomes.findLast(row => row.externalId === "b").code, "ai_coverage_incomplete");
});

test("refusal records safe unresolved metadata, never a semantic rejection", async () => {
  const provider = new OpenAiProvider({ apiKey: "fixture-key", apiStyle: "chat", maxRetries: 0,
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { refusal: "private upstream payload" } }], usage: { prompt_tokens: 10, completion_tokens: 1 } })) });
  const result = await provider.triageConversations({ ...request([candidate("refused")]), tolerateUnrecoverableBatches: true });
  assert.deepEqual(result.value, []);
  assert.equal(result.processing[0].status, "unresolved"); assert.equal(result.processing[0].code, "ai_refused");
  assert.equal(result.processing[0].recoverable, false); assert.equal(result.processing[0].attempts, 1);
  assert.ok(!JSON.stringify(result.processing).includes("private upstream"));
});

test("strict failure drains in-flight siblings before returning control", async () => {
  let release; let settled = false; const checkpoint = [];
  const gate = new Promise(resolve => { release = resolve; });
  const provider = new OpenAiProvider({ apiKey: "fixture-key", apiStyle: "chat", maxRetries: 0,
    fetchImpl: async (_url, init) => {
      const rows = requestCandidates(init);
      if (rows[0].externalId === "row25") throw new Error("synthetic transport failure");
      await gate; return chatResponse(rows.map(row => triage(row.externalId)));
    } });
  const running = provider.triageConversations({ ...request(Array.from({ length: 26 }, (_, i) => candidate(`row${i}`))),
    onBatchSucceeded: rows => checkpoint.push(...rows) });
  const rejection = assert.rejects(running, /network request failed/);
  void running.then(() => { settled = true; }, () => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, "a slow successful sibling still owns work");
  release(); await rejection;
  assert.equal(checkpoint.length, 25);
});

test("processing collector failure does not erase a valid judgment", async t => {
  t.mock.method(console, "error", () => {});
  const provider = new OpenAiProvider({ apiKey: "fixture-key", apiStyle: "chat", maxRetries: 0,
    fetchImpl: async (_url, init) => chatResponse(requestCandidates(init).map(row => triage(row.externalId))) });
  const result = await provider.triageConversations({ ...request([candidate("a")]), onProcessingUpdated: () => { throw new Error("storage unavailable"); } });
  assert.equal(result.coverage.complete, true); assert.equal(result.value.length, 1);
});

test("actual workflow fails partial coverage, preserves good work, then resumes only unresolved IDs", async t => {
  const fixture = await scanWorkflowHarness(t, { count: 26 });
  let broken = true; const calls = [];
  const provider = new OpenAiProvider({ apiKey: "fixture-key", apiStyle: "chat", maxRetries: 0,
    fetchImpl: async (_url, init) => {
      const rows = requestCandidates(init); calls.push(rows.map(row => row.externalId));
      if (broken && rows.some(row => row.externalId === "depth25")) return new Response(JSON.stringify({ choices: [{ message: { content: "not JSON" }, finish_reason: "stop" }] }));
      return chatResponse(rows.map(row => triage(row.externalId)));
    } });
  provider.qualifyConversations = async req => { fixture.submissions.push(req); throw fixture.stop; };
  fixture.state.ai = provider;
  await assert.rejects(fixture.workflow.runScan(fixture.scan.id, { jobAttempts: 1, jobMaxAttempts: 5 }), e => e.code === "triage_coverage_incomplete");
  assert.equal(fixture.scan.status, "failed"); assert.equal(fixture.scan.result, null); assert.equal(fixture.submissions.length, 0);
  assert.equal(Object.keys(fixture.scan.triageCheckpoint).length, 25);
  assert.equal(fixture.scan.triageCheckpoint.depth25, undefined);
  assert.deepEqual(fixture.scan.triageCoverage, { expected: 26, succeeded: 25, unresolved: 1, pending: 0, complete: false });
  assert.equal(fixture.scan.triageProcessing.depth25.status, "unresolved");
  const attempts = fixture.scan.triageProcessing.depth25.attempts;
  broken = false; calls.length = 0;
  await assert.rejects(fixture.workflow.runScan(fixture.scan.id, { resumeRunning: true }), e => e === fixture.stop);
  assert.deepEqual(calls.flat(), ["depth25"]);
  assert.equal(fixture.scan.triageCoverage.complete, true);
  assert.equal(fixture.scan.triageProcessing.depth25.status, "succeeded");
  assert.equal(fixture.scan.triageProcessing.depth25.attempts, attempts + 1);
  assert.equal(fixture.submissions[0].conversations.length, 8);
});

test("a provider claiming succeeded without a judgment cannot satisfy workflow coverage", async t => {
  const fixture = await scanWorkflowHarness(t, { count: 1 });
  fixture.state.ai.triageConversations = async req => {
    await req.onProcessingUpdated([{ externalId: "depth0", status: "succeeded", attempts: 1 }]);
    return { value: [], coverage: { complete: true }, usage: { inputTokens: 0, outputTokens: 0 }, model: "fixture", estimatedCostUsd: 0 };
  };
  await assert.rejects(fixture.workflow.runScan(fixture.scan.id), e => e.code === "triage_coverage_incomplete");
  assert.equal(fixture.scan.triageCoverage.succeeded, 0); assert.equal(fixture.scan.triageCoverage.complete, false);
  assert.equal(fixture.scan.triageProcessing.depth0.status, "unresolved");
});

test("actual workflow removes only legacy/malformed checkpoints before provider resume", async t => {
  const fixture = await scanWorkflowHarness(t, { count: 2 });
  fixture.scan.triageCheckpoint = { depth0: legacy("depth0"), depth1: triage("depth1", { relevant: false, worthEnriching: false }) };
  const previous = fixture.state.ai.triageConversations;
  fixture.state.ai.triageConversations = async req => {
    assert.equal(req.resumeFrom.has("depth0"), false); assert.equal(req.resumeFrom.has("depth1"), true);
    return previous(req);
  };
  await assert.rejects(fixture.workflow.runScan(fixture.scan.id), e => e === fixture.stop);
  assert.equal(isLegacyUnresolvedTriage(fixture.scan.triageCheckpoint.depth0), false);
});
