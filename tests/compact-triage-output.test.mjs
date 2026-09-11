import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./helpers/load-ts-module.mjs";
import { business, candidate, fixtures, triage, chatResponse } from "./fixtures/scan-replay/factories.mjs";
import { scanWorkflowHarness } from "./helpers/scan-workflow-harness.mjs";

const openai = await loadTsModule("lib/providers/openai.server.ts");
const dispatcher = await loadTsModule("lib/ai/triage-dispatcher.ts");
const configuration = await loadTsModule("lib/server/scan-configuration.ts");

function semanticCandidates() {
  return fixtures.semanticCases.map(row => candidate(row.id, {
    title: row.title,
    body: row.body,
    discoveryLanes: row.signal === "switching" ? ["competitor_switching"] : ["problem_pain"],
  }));
}

function semanticJudgment(row, verbose = false) {
  const result = triage(row.id, {
    relevant: row.worthReviewing,
    intent: row.intent,
    demandSignal: row.signal,
    problem: row.signal === "none" ? null : "Client document workflow pain",
    productFit: row.worthReviewing ? "high" : "low",
    timing: row.signal === "none" ? "unknown" : "current",
    replyability: row.worthReviewing ? "medium" : "low",
    worthEnriching: row.worthReviewing,
    reason: "The supplied candidate matches the fixture's labeled commercial-relevance decision.",
  });
  if (!verbose) return result;
  return { ...result,
    problem: result.problem == null ? null : `${result.problem}; this deliberately long fixture prose verifies compact mode does not truncate a valid provider response or trigger repair merely for harmless verbosity.`,
    reason: `${result.reason} This deliberately long second sentence is valid structured output and remains accepted because the compact limits are prompt guidance, not a lossy local transformation.`,
  };
}

async function run(compactOutput, output = row => semanticJudgment(row)) {
  const requests = [];
  const provider = new openai.OpenAiProvider({ apiKey: "fixture", apiStyle: "chat", maxRetries: 0,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body); requests.push(body);
      const ids = JSON.parse(body.messages[1].content).candidates.map(row => row.externalId);
      return chatResponse(ids.map(id => output(fixtures.semanticCases.find(row => row.id === id))));
    },
  });
  const result = await provider.triageConversations({ business, candidates: semanticCandidates(),
    models: openai.DEFAULT_OPENAI_MODELS, coverageRetries: 0, compactOutput });
  return { result, requests };
}

test("compact triage stays off even when explicitly requested -- SCAN_SPEED_KILL_SWITCH overrides it", () => {
  // See lib/server/scan-configuration.ts's SCAN_SPEED_KILL_SWITCH: the whole
  // scan-speed rollout (this flag included) was retired at operator request.
  // SCAN_COMPACT_TRIAGE=1 alone was never enough to turn this on in
  // production anyway (it required 100% rollout too), but this test used to
  // demonstrate the flag *can* flip on with the right config; now it
  // demonstrates that no config can, which is the current intended behavior.
  const off = configuration.resolveScanConfiguration({});
  const explicitlyRequested = configuration.resolveScanConfiguration({ SCAN_COMPACT_TRIAGE: "1", SCAN_COMPACT_TRIAGE_ROLLOUT_PERCENT: "100" });
  assert.equal(off.flags.compactTriage, false);
  assert.equal(explicitlyRequested.flags.compactTriage, false);
  assert.equal(configuration.environmentForScan(explicitlyRequested, { SCAN_COMPACT_TRIAGE: "1" }).SCAN_COMPACT_TRIAGE, undefined);
});

test("compact policy has an exact checkpoint/cache version without invalidating legacy keys", () => {
  const row = semanticCandidates()[0];
  const context = { business, models: openai.DEFAULT_OPENAI_MODELS };
  assert.equal(dispatcher.triageInputVersion(context, row), dispatcher.triageInputVersion({ ...context, compactOutput: false }, row));
  assert.notEqual(dispatcher.triageInputVersion(context, row), dispatcher.triageInputVersion({ ...context, compactOutput: true }, row));
});

test("compact mode preserves all input evidence, schema, output allowance, IDs and categorical decisions", async () => {
  const legacy = await run(false);
  const compact = await run(true);
  assert.equal(legacy.requests.length, 1);
  assert.equal(compact.requests.length, 1);

  const legacyRequest = legacy.requests[0], compactRequest = compact.requests[0];
  assert.deepEqual(JSON.parse(compactRequest.messages[1].content), JSON.parse(legacyRequest.messages[1].content));
  assert.deepEqual(JSON.parse(compactRequest.messages[0].content.split("\n").at(-1)), JSON.parse(legacyRequest.messages[0].content.split("\n").at(-1)));
  assert.equal(compactRequest.max_tokens, legacyRequest.max_tokens);
  assert.match(compactRequest.messages[0].content, /problem to one short clause.*reason to one short clause/);
  assert.doesNotMatch(legacyRequest.messages[0].content, /problem to one short clause/);

  const decisions = rows => rows.map(({ externalId, triage: value }) => ({ externalId,
    relevant: value.relevant, intent: value.intent, demandSignal: value.demandSignal,
    productFit: value.productFit, timing: value.timing, replyability: value.replyability,
    worthEnriching: value.worthEnriching }));
  assert.deepEqual(decisions(compact.result.value), decisions(legacy.result.value));
  assert.deepEqual(compact.result.value.map(row => row.externalId), fixtures.semanticCases.map(row => row.id));
  assert.equal(compact.result.coverage.complete, true);
});

test("compact guidance never truncates or repairs a valid verbose response", async () => {
  const compact = await run(true, row => semanticJudgment(row, true));
  assert.equal(compact.requests.length, 1);
  assert.ok(compact.result.value.some(row => (row.triage.problem?.length ?? 0) > 160));
  assert.ok(compact.result.value.every(row => row.triage.reason.length > 200));
  assert.equal(compact.result.coverage.complete, true);
});

test("the real workflow never requests compact output while the kill switch is on, even with the flag configured", async t => {
  const fixture = await scanWorkflowHarness(t, { count: 1, env: { SCAN_COMPACT_TRIAGE: "1", SCAN_COMPACT_TRIAGE_ROLLOUT_PERCENT: "100" } });
  const original = fixture.state.ai.triageConversations;
  const seen = [];
  fixture.state.ai.triageConversations = request => { seen.push(request.compactOutput); return original(request); };
  await assert.rejects(fixture.workflow.runScan(fixture.scan.id), error => error === fixture.stop);
  assert.deepEqual(seen, [false]);
  assert.equal(fixture.scan.runConfiguration.flags.compactTriage, false);
});
