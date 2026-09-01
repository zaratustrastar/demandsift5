import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./helpers/load-ts-module.mjs";
import { business, candidate, triage, chatResponse, requestCandidates } from "./fixtures/scan-replay/factories.mjs";
const { RequestGate, BoundedBatchDispatcher, abortableDelay } = await loadTsModule("lib/ai/bounded-dispatcher.ts");
const { createTriageDispatcher, triageInputVersion } = await loadTsModule("lib/ai/triage-dispatcher.ts");
const { OpenAiProvider, DEFAULT_OPENAI_MODELS: models } = await loadTsModule("lib/providers/openai.server.ts");
const turn = () => new Promise(resolve => setImmediate(resolve));
const context = { business, models, coverageRetries: 0 };

for (const count of [0, 1, 25, 26, 276, 400, 450]) test(`compatibility: ${count} candidates retain order and exact coverage`, async () => {
  let active = 0, peak = 0, calls = 0;
  const rows = Array.from({ length: count }, (_, i) => candidate(`r${i}`));
  const provider = new OpenAiProvider({ apiKey: "fixture", apiStyle: "chat", maxRetries: 0,
    fetchImpl: async (_url, init) => {
      calls++; peak = Math.max(peak, ++active); await turn(); active--;
      return chatResponse(requestCandidates(init).map(row => triage(row.externalId)));
    } });
  const result = await provider.triageConversations({ ...context, candidates: rows });
  assert.deepEqual(result.value.map(row => row.externalId), rows.map(row => row.externalId));
  assert.equal(result.coverage.complete, true); assert.equal(calls, Math.ceil(count / 25));
  assert.ok(peak <= 4); assert.equal(result.usage.outputTokens, calls * 5);
});

test("recursive length splits and direct fallback share the primary HTTP permit cap", async () => {
  let active = 0, peak = 0, fallbackCalls = 0, primaryCalls = 0;
  const fallback = new OpenAiProvider({ apiKey: "fixture-direct", apiStyle: "chat", maxRetries: 0,
    fetchImpl: async (_url, init) => {
      fallbackCalls++; peak = Math.max(peak, ++active); await turn(); active--;
      return chatResponse(requestCandidates(init).map(row => triage(row.externalId)));
    } });
  const provider = new OpenAiProvider({ apiKey: "fixture", apiStyle: "chat", maxRetries: 0, directFallback: fallback,
    fetchImpl: async (_url, init) => {
      primaryCalls++; peak = Math.max(peak, ++active); await turn(); active--;
      if (requestCandidates(init).length <= 6) throw new Error("synthetic network failure");
      return new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "" } }], usage: {} }));
    } });
  const result = await provider.triageConversations({ ...context, candidates: Array.from({ length: 100 }, (_, i) => candidate(`r${i}`)) });
  assert.equal(result.coverage.complete, true); assert.equal(result.value.length, 100);
  assert.ok(primaryCalls > 4 && fallbackCalls > 4); assert.equal(peak, 4);
});

test("one incremental dispatcher buffers, deduplicates exact versions, and snapshots evidence", async () => {
  const seen = [], checkpoints = []; let clock = 10;
  const provider = { triageConversations: async request => {
    seen.push(request.candidates); const value = request.candidates.map(row => ({ externalId: row.externalId, triage: triage(row.externalId) }));
    await request.onBatchSucceeded(value); return { value };
  } };
  const dispatcher = createTriageDispatcher(provider, context, { now: () => clock++, onJudgments: (rows, versions) => checkpoints.push({ rows, versions }) });
  const original = candidate("a"), version = triageInputVersion(context, original);
  dispatcher.submit([original]); dispatcher.submit([original]); assert.equal(seen.length, 0);
  original.body = "richer later evidence";
  dispatcher.submit([original]);
  const batches = await dispatcher.drain(); dispatcher.dispose();
  assert.equal(batches.length, 2); assert.equal(seen[0][0].body.includes("Fixture"), true);
  assert.equal(seen[1][0].body, original.body); assert.equal(checkpoints[0].versions.get("a"), version);
  assert.notEqual(checkpoints[1].versions.get("a"), version);
  assert.ok(batches.every(row => row.finishedAt > row.startedAt));
});

test("versions include all evidence, business, models, and stable object key order", () => {
  const row = candidate("a"), initial = triageInputVersion(context, row);
  assert.equal(triageInputVersion(context, Object.fromEntries(Object.entries(row).reverse())), initial);
  for (const change of [{ author: "new" }, { metrics: { score: 200, comments: 30 } }, { discoveryLanes: ["competitor"] }, { matchedQueries: ["new"] }, { createdAt: "2030-01-01" }]) {
    assert.notEqual(triageInputVersion(context, { ...row, ...change }), initial);
  }
  assert.notEqual(triageInputVersion({ ...context, models: { ...models, economyModel: "different" } }, row), initial);
  assert.notEqual(triageInputVersion({ ...context, business: { ...business, version: 3 } }, row), initial);
});

test("cancellation aborts active transport, prevents queued calls and interrupts backoff", async () => {
  let calls = 0;
  const parent = new AbortController();
  const provider = new OpenAiProvider({ apiKey: "fixture", apiStyle: "chat", maxRetries: 2,
    fetchImpl: async (_url, init) => { calls++; await abortableDelay(10_000, init.signal); throw new Error("not reached"); } });
  const dispatcher = createTriageDispatcher(provider, { ...context, signal: parent.signal });
  dispatcher.submit(Array.from({ length: 200 }, (_, i) => candidate(`r${i}`)));
  const running = dispatcher.drain(); const rejection = assert.rejects(running, { name: "AbortError" });
  await turn(); assert.equal(calls, 4); parent.abort(); await rejection; await turn();
  assert.equal(calls, 4); dispatcher.dispose();
  const controller = new AbortController();
  const delay = assert.rejects(abortableDelay(10_000, controller.signal), { name: "AbortError" });
  controller.abort(); await delay;
});

test("gate cancellation removes queued permits and holds permits through work completion", async () => {
  const gate = new RequestGate(1); let release; let queuedCalled = false;
  const first = gate.run(() => new Promise(resolve => { release = resolve; })); await turn();
  const controller = new AbortController();
  const queued = assert.rejects(gate.run(async () => { queuedCalled = true; }, controller.signal), { name: "AbortError" });
  assert.equal(gate.queued, 1); controller.abort(); await queued;
  assert.equal(gate.queued, 0); assert.equal(gate.active, 1); release(); await first;
  assert.equal(gate.active, 0); assert.equal(queuedCalled, false);
});

test("fatal failure drains successful siblings without dispatching queued batches", async () => {
  let release; const calls = [], saved = [];
  const dispatcher = new BoundedBatchDispatcher({ batchSize: 1, concurrency: 2, process: async items => {
    const id = items[0].value; calls.push(id);
    if (id === 0) throw new Error("fixture failure");
    await new Promise(resolve => { release = resolve; }); saved.push(id);
  } });
  dispatcher.submit([0, 1, 2].map(value => ({ key: String(value), value })));
  let settled = false; const running = dispatcher.drain();
  const rejection = assert.rejects(running, /fixture failure/).then(() => { settled = true; });
  await turn(); assert.equal(settled, false); release(); await rejection;
  assert.deepEqual(calls, [0, 1]); assert.deepEqual(saved, [1]); assert.equal(dispatcher.queuedItems, 0);
  dispatcher.dispose();
});
