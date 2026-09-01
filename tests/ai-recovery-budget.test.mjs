import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./helpers/load-ts-module.mjs";
import { scanWorkflowHarness } from "./helpers/scan-workflow-harness.mjs";
import { business, candidate, triage, chatResponse, requestCandidates } from "./fixtures/scan-replay/factories.mjs";
const { AiRecoveryBudget, retryAfterMs } = await loadTsModule("lib/ai/recovery-budget.ts");
const { OpenAiProvider, DEFAULT_OPENAI_MODELS: models } = await loadTsModule("lib/providers/openai.server.ts");
const { triageInputVersion } = await loadTsModule("lib/ai/triage-dispatcher.ts");
const { scanPipelineErrorCode, jobWillRetryScanFailure } = await loadTsModule("lib/server/job-retry-classification.ts");
const request = candidates => ({ business, models, candidates, coverageRetries: 3 });
const resultError = (status, code, retryAfter) => new Response(JSON.stringify({ error: { code, message: "synthetic upstream error" } }),
  { status, headers: retryAfter ? { "retry-after": retryAfter } : {} });

function budget(options = {}) {
  let clock = 1_000_000; const ledger = {}, waits = [], saves = [];
  const recovery = new AiRecoveryBudget({ ledger, now: () => clock,
    delay: async ms => { waits.push(ms); clock += ms; }, onChange: async () => saves.push(structuredClone(ledger)), ...options });
  return { recovery, ledger, waits, saves, advance: ms => { clock += ms; } };
}

test("Retry-After accepts seconds/date, rejects malformed negatives, and is never capped early", () => {
  assert.equal(retryAfterMs("120"), 120_000);
  assert.equal(retryAfterMs("0.5"), 500); assert.equal(retryAfterMs("-1"), undefined);
  assert.equal(retryAfterMs(""), undefined); assert.equal(retryAfterMs("nonsense"), undefined);
  assert.equal(retryAfterMs("Mon, 31 Aug 2026 12:02:00 GMT", Date.parse("2026-08-31T12:00:00Z")), 120_000);
});

test("reserves before HTTP; missing-ID recovery consumes only those IDs", async () => {
  const b = budget(); let calls = 0;
  const provider = new OpenAiProvider({ apiKey: "fixture", apiStyle: "chat", maxRetries: 0, recovery: b.recovery,
    fetchImpl: async (_url, init) => {
      calls++; assert.equal(b.saves.length, calls);
      const rows = requestCandidates(init);
      return chatResponse([triage(calls === 1 ? rows[0].externalId : "b")]);
    } });
  const rows = [candidate("a"), candidate("b")]; const result = await provider.triageConversations(request(rows));
  assert.equal(result.coverage.complete, true);
  assert.equal(b.ledger[triageInputVersion(request(rows), rows[0])].requests, 1);
  assert.equal(b.ledger[triageInputVersion(request(rows), rows[1])].requests, 2);
});

test("earlier direct fallback shares the same budget instead of multiplying coverage retries", async () => {
  const b = budget(); let primary = 0, fallback = 0;
  const direct = new OpenAiProvider({ apiKey: "fixture-direct", apiStyle: "chat", maxRetries: 0, recovery: b.recovery,
    fetchImpl: async (_url, init) => { fallback++; return chatResponse(requestCandidates(init).map(row => triage(row.externalId))); } });
  const provider = new OpenAiProvider({ apiKey: "fixture", apiStyle: "chat", maxRetries: 1, recovery: b.recovery, directFallback: direct,
    fetchImpl: async () => { primary++; throw new Error("synthetic transport failure"); } });
  const result = await provider.triageConversations(request([candidate("a")]));
  assert.equal(result.coverage.complete, true); assert.equal(primary, 2); assert.equal(fallback, 1);
  assert.equal(Object.values(b.ledger)[0].requests, 3);
});

test("429 recovery waits the full server cooldown and returns complete coverage", async () => {
  const b = budget(); let calls = 0;
  const provider = new OpenAiProvider({ apiKey: "fixture", apiStyle: "chat", maxRetries: 1, recovery: b.recovery,
    fetchImpl: async (_url, init) => ++calls === 1 ? resultError(429, "rate_limit_exceeded", "120")
      : chatResponse(requestCandidates(init).map(row => triage(row.externalId))) });
  const result = await provider.triageConversations(request([candidate("a")]));
  assert.equal(result.coverage.complete, true); assert.deepEqual(b.waits, [120_000]);
});

test("persisted cooldown survives a new provider instance and fallback does not reset it", async () => {
  const b = budget(); let calls = 0;
  const first = new OpenAiProvider({ apiKey: "fixture", apiStyle: "chat", maxRetries: 0, recovery: b.recovery,
    fetchImpl: async () => { calls++; return resultError(429, "rate_limit_exceeded", "120"); } });
  await assert.rejects(first.triageConversations({ ...request([candidate("a")]), coverageRetries: 0 }));
  const resumed = new OpenAiProvider({ apiKey: "fixture", apiStyle: "chat", maxRetries: 0, recovery: b.recovery,
    fetchImpl: async (_url, init) => { calls++; return chatResponse(requestCandidates(init).map(row => triage(row.externalId))); } });
  assert.equal((await resumed.triageConversations(request([candidate("a")]))).coverage.complete, true);
  assert.equal(calls, 2); assert.deepEqual(b.waits, [120_000]);
});

test("repair/coverage/job retries cannot reset exhausted exact-input attempts", async () => {
  const b = budget({ maxRequests: 3 }); let calls = 0;
  const makeProvider = () => new OpenAiProvider({ apiKey: "fixture", apiStyle: "chat", maxRetries: 0, recovery: b.recovery,
    fetchImpl: async () => { calls++; return chatResponse([]); } });
  let error;
  try { await makeProvider().triageConversations(request([candidate("a")])); } catch (caught) { error = caught; }
  assert.equal(error.code, "ai_recovery_exhausted"); assert.equal(calls, 3);
  await assert.rejects(makeProvider().triageConversations(request([candidate("a")])), e => e.code === "ai_recovery_exhausted");
  assert.equal(calls, 3); assert.equal(scanPipelineErrorCode(error), "ai_recovery_exhausted");
  assert.equal(jobWillRetryScanFailure({ code: error.code, jobAttempts: 1, jobMaxAttempts: 5 }), false);
});

test("deadline and excessive Retry-After stop without reporting successful coverage", async () => {
  const b = budget({ deadlineMs: 30_000 }); let calls = 0;
  const provider = new OpenAiProvider({ apiKey: "fixture", apiStyle: "chat", maxRetries: 1, recovery: b.recovery,
    fetchImpl: async () => { calls++; return resultError(429, "rate_limit_exceeded", "120"); } });
  await assert.rejects(provider.triageConversations(request([candidate("a")])), e => e.code === "ai_recovery_exhausted");
  assert.equal(calls, 1); assert.equal(b.waits.length, 0);
  b.advance(31_000);
  await assert.rejects(provider.triageConversations(request([candidate("a")])), e => e.code === "ai_recovery_exhausted");
  assert.equal(calls, 1);
});

for (const [status, code, expected] of [[401, "invalid_api_key", "provider_auth_failed"], [403, "forbidden", "provider_auth_failed"],
  [429, "insufficient_quota", "provider_quota_exhausted"], [400, "invalid_request", "provider_invalid_request"]]) {
  test(`${status}/${code} is terminal without HTTP, coverage, or direct fallback repetition`, async () => {
    const b = budget(); let primary = 0, fallback = 0;
    const direct = new OpenAiProvider({ apiKey: "fixture-direct", apiStyle: "chat", fetchImpl: async () => { fallback++; return chatResponse([]); } });
    const provider = new OpenAiProvider({ apiKey: "fixture", apiStyle: "chat", recovery: b.recovery, directFallback: direct,
      fetchImpl: async () => { primary++; return resultError(status, code); } });
    await assert.rejects(provider.triageConversations(request([candidate("a")])), e => e.code === expected);
    assert.equal(primary, 1); assert.equal(fallback, 0);
    assert.equal(jobWillRetryScanFailure({ code: expected, jobAttempts: 1, jobMaxAttempts: 5 }), false);
  });
}

test("nonempty length-truncated JSON is split after bounded repair, not misclassified as a negative", async () => {
  const b = budget(); let calls = 0;
  const provider = new OpenAiProvider({ apiKey: "fixture", apiStyle: "chat", recovery: b.recovery,
    fetchImpl: async (_url, init) => {
      calls++; const rows = requestCandidates(init);
      if (rows.length > 1) return new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "{" } }], usage: {} }));
      return chatResponse(rows.map(row => triage(row.externalId)));
    } });
  const result = await provider.triageConversations(request([candidate("a"), candidate("b")]));
  assert.equal(result.coverage.complete, true); assert.equal(calls, 5);
  assert.ok(Object.values(b.ledger).every(row => row.requests === 4));
});

test("workflow persists exact-input counters and successful judgments across an interrupted attempt", async t => {
  const fixture = await scanWorkflowHarness(t, { count: 26, env: { SCAN_COORDINATED_RETRIES: "1" } });
  let broken = true; const called = [];
  fixture.state.createAiProvider = (_env, options = {}) => {
    const provider = new OpenAiProvider({ ...options, apiKey: "fixture", apiStyle: "chat", maxRetries: 0,
      fetchImpl: async (_url, init) => {
        const rows = requestCandidates(init); called.push(...rows.map(row => row.externalId));
        assert.ok(fixture.saved.some(scan => Object.keys(scan.aiRecoveryLedger ?? {}).length > 0), "reservation precedes HTTP");
        if (broken && rows.some(row => row.externalId === "depth25")) return new Response(JSON.stringify({ choices: [{ message: { content: "invalid JSON" } }], usage: {} }));
        return chatResponse(rows.map(row => triage(row.externalId)));
      } });
    provider.qualifyConversations = async req => { fixture.submissions.push(req); throw fixture.stop; };
    return provider;
  };
  await assert.rejects(fixture.workflow.runScan(fixture.scan.id), error => error.code === "triage_coverage_incomplete");
  const key = triageInputVersion({ business: fixture.scan.discoveryProfile.business, models }, fixture.rows[25]);
  assert.equal(fixture.scan.aiRecoveryLedger[key].requests, 3);
  assert.equal(Object.keys(fixture.scan.triageCheckpoint).length, 25);
  broken = false; called.length = 0;
  await assert.rejects(fixture.workflow.runScan(fixture.scan.id, { resumeRunning: true }), error => error === fixture.stop);
  assert.deepEqual(called, ["depth25"]); assert.equal(fixture.scan.aiRecoveryLedger[key].requests, 4);
  assert.equal(fixture.scan.triageCoverage.complete, true); assert.equal(fixture.submissions[0].conversations.length, 8);
  assert.equal(fixture.scan.runConfiguration.effective.ai.coordinatedRetries, true);
});
