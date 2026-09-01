import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./helpers/load-ts-module.mjs";
import { business, candidate, triage, chatResponse, requestCandidates } from "./fixtures/scan-replay/factories.mjs";

const openai = await loadTsModule("lib/providers/openai.server.ts");
const capacity = await loadTsModule("lib/ai/capacity.ts");
const bounded = await loadTsModule("lib/ai/bounded-dispatcher.ts");
const configuration = await loadTsModule("lib/server/scan-configuration.ts");

function slowResponder(state, delayMs = 15) {
  return async (_url, init) => {
    state.active++;
    state.peak = Math.max(state.peak, state.active);
    state.calls++;
    const rows = requestCandidates(init);
    await new Promise(resolve => setTimeout(resolve, delayMs));
    state.active--;
    return chatResponse(rows.map(row => triage(row.externalId)));
  };
}

test("two factory-created providers share one process request ceiling", async () => {
  const state = { active: 0, peak: 0, calls: 0 };
  const env = { OPENAI_API_KEY: "fixture", OPENAI_API_STYLE: "chat", AI_REQUEST_CONCURRENCY: "6", AI_TRIAGE_BATCH_SIZE: "25" };
  const options = { fetchImpl: slowResponder(state), maxRetries: 0 };
  const first = openai.createOpenAiProviderFromEnv(env, options);
  const second = openai.createOpenAiProviderFromEnv(env, options);
  const request = offset => ({ business, models: openai.DEFAULT_OPENAI_MODELS, coverageRetries: 0,
    candidates: Array.from({ length: 100 }, (_, index) => candidate(`shared_${offset + index}`)) });
  const [a, b] = await Promise.all([first.triageConversations(request(0)), second.triageConversations(request(100))]);
  assert.equal(a.coverage.complete, true); assert.equal(b.coverage.complete, true);
  assert.equal(state.calls, 8);
  assert.ok(state.peak > 4, `expected the explicit six-call experiment to use more than four permits, saw ${state.peak}`);
  assert.ok(state.peak <= 6, `two scans exceeded their shared six-call ceiling: ${state.peak}`);
});

test("capacity defaults are preserved, frozen, and invalid values fail visibly", () => {
  const defaults = configuration.resolveScanConfiguration({});
  assert.equal(defaults.environment.AI_TRIAGE_BATCH_SIZE, "25");
  assert.equal(defaults.environment.AI_REQUEST_CONCURRENCY, "4");
  const tuned = configuration.resolveScanConfiguration({ AI_TRIAGE_BATCH_SIZE: "20", AI_REQUEST_CONCURRENCY: "6" });
  assert.notEqual(tuned.id, defaults.id);
  const resumed = configuration.environmentForScan(tuned, { AI_TRIAGE_BATCH_SIZE: "25", AI_REQUEST_CONCURRENCY: "4" });
  assert.equal(resumed.AI_TRIAGE_BATCH_SIZE, "20"); assert.equal(resumed.AI_REQUEST_CONCURRENCY, "6");
  for (const env of [{ AI_TRIAGE_BATCH_SIZE: "0" }, { AI_TRIAGE_BATCH_SIZE: "31" }, { AI_TRIAGE_BATCH_SIZE: "2.5" },
    { AI_REQUEST_CONCURRENCY: "0" }, { AI_REQUEST_CONCURRENCY: "9" }, { AI_REQUEST_CONCURRENCY: "many" }]) {
    assert.throws(() => configuration.resolveScanConfiguration(env), error => error.code === "scan_configuration_invalid");
  }
});

test("configured batch size and concurrency control real triage dispatch", async () => {
  const state = { active: 0, peak: 0, calls: 0 };
  const provider = new openai.OpenAiProvider({ apiKey: "fixture", apiStyle: "chat", maxRetries: 0,
    triageBatchSize: 20, requestConcurrency: 3, fetchImpl: slowResponder(state, 10) });
  const result = await provider.triageConversations({ business, models: openai.DEFAULT_OPENAI_MODELS, coverageRetries: 0,
    candidates: Array.from({ length: 61 }, (_, index) => candidate(`configured_${index}`)) });
  assert.equal(result.coverage.complete, true); assert.equal(state.calls, 4);
  assert.ok(state.peak > 1 && state.peak <= 3);
  assert.equal(provider.configurationForDiagnostics().triageBatchSize, 20);
  assert.equal(provider.configurationForDiagnostics().triageConcurrency, 3);
});

test("a shared gate can tighten during mixed rollout without admitting new excess work", async () => {
  const gate = new bounded.RequestGate(6);
  let active = 0, peakAfterTightening = 0;
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  const first = Array.from({ length: 6 }, () => gate.run(async () => { active++; await hold; active--; }));
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(active, 6);
  gate.capAt(4);
  const queued = gate.run(async () => { active++; peakAfterTightening = Math.max(peakAfterTightening, active); active--; });
  release();
  await Promise.all([...first, queued]);
  assert.equal(gate.limit, 4);
  assert.ok(peakAfterTightening <= 4);
});

test("a local request gate composes with an account-wide outer permit", async () => {
  let outerActive = 0, outerPeak = 0, outerCalls = 0;
  const outer = new bounded.RequestGate(2);
  const gate = new bounded.RequestGate(4, {
    run: (operation, signal) => outer.run(async () => {
      outerCalls++; outerActive++; outerPeak = Math.max(outerPeak, outerActive);
      try { return await operation(); } finally { outerActive--; }
    }, signal),
  });
  await Promise.all(Array.from({ length: 8 }, () => gate.run(async () => {
    await new Promise(resolve => setTimeout(resolve, 5));
  })));
  assert.equal(outerCalls, 8);
  assert.equal(outerPeak, 2);
});

test("direct option validation uses the same safe ranges", () => {
  assert.deepEqual(capacity.aiCapacityFromOptions({}), { triageBatchSize: 25, requestConcurrency: 4 });
  assert.throws(() => new openai.OpenAiProvider({ apiKey: "fixture", triageBatchSize: 40 }), error => error.code === "scan_configuration_invalid");
  assert.throws(() => new openai.OpenAiProvider({ apiKey: "fixture", requestConcurrency: 12 }), error => error.code === "scan_configuration_invalid");
});
