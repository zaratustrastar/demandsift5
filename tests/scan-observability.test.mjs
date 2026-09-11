import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadTsModule } from "./helpers/load-ts-module.mjs";
import { business, candidate, triage, chatResponse, requestCandidates } from "./fixtures/scan-replay/factories.mjs";

const { createScanTrace, traceProvider } = await loadTsModule("lib/server/scan-observability.ts");
const { resolveScanConfiguration, environmentForScan } = await loadTsModule("lib/server/scan-configuration.ts");
const { OpenAiProvider, DEFAULT_OPENAI_MODELS, createOpenAiProviderFromEnv } = await loadTsModule("lib/providers/openai.server.ts");
const { HarshmaurRedditProvider } = await loadTsModule("lib/providers/reddit-harshmaur.server.ts");

test("trace durations are monotonic, independent, and not double-ended", () => {
  const events = []; let clock = 0; let wall = "2026-08-31T12:00:00Z";
  const trace = createScanTrace({ scanId: "scan_fixture", jobId: "job_fixture", jobAttempt: 2 }, {
    sink: event => events.push(event), monotonicNow: () => clock, wallNow: () => wall,
  });
  const first = trace.start("ai.request"); clock = 10;
  const second = trace.start("ai.request"); clock = 25; wall = "2026-08-31T11:00:00Z";
  first("succeeded"); clock = 30; second("failed"); second("succeeded");
  assert.deepEqual(events.filter(e => e.event === "end").map(e => e.durationMs), [25, 20]);
  assert.equal(new Set(events.map(e => e.spanId)).size, 2);
  assert.ok(events.every(e => e.jobId === "job_fixture" && e.jobAttempt === 2));
});

test("trace allowlist drops arbitrary payloads, URLs, credentials and error text", () => {
  const events = []; const trace = createScanTrace({ scanId: "scan_fixture" }, { sink: e => events.push(e) });
  trace.milestone("safe", { candidates: 4, model: "gpt-5.6-luna", operation: "conversation_triage",
    prompt: "private prompt", email: "person@example.com", headers: { Authorization: "Bearer secret" },
    error: "provider echoed secret", route: "https://user:secret@example.com/path?key=secret", category: "sk-secret", unresolved: NaN });
  const serialized = JSON.stringify(events);
  for (const secret of ["private prompt", "person@", "Authorization", "secret", "provider echoed"]) assert.ok(!serialized.includes(secret));
  assert.deepEqual(events[0].attributes, { candidates: 4, model: "gpt-5.6-luna", operation: "conversation_triage" });
});

for (const [label, sink] of [["throwing", () => { throw new Error("collector down"); }],
  ["rejecting", async () => { throw new Error("collector down"); }], ["hung", () => new Promise(() => {})]]) {
  test(`${label} telemetry cannot fail or block real work`, async () => {
    const trace = createScanTrace({ scanId: "scan_fixture" }, { sink });
    assert.equal(await trace.measure("fixture", async () => 42), 42);
    const expected = new Error("real provider failure");
    await assert.rejects(trace.measure("fixture", async () => { throw expected; }), error => error === expected);
  });
}

test("provider wrapper preserves class receiver, returned result and errors", async () => {
  const events = []; const trace = createScanTrace({ scanId: "scan_fixture" }, { sink: e => events.push(e) });
  class Provider { #value = 7; get name() { return "fixture"; } async classify() { return this.#value; } }
  const provider = traceProvider(new Provider(), trace, ["classify"]);
  assert.equal(await provider.classify({ candidates: [1, 2] }), 7);
  assert.equal(provider.name, "fixture");
  assert.equal(events[0].attributes.candidates, 2);
});

test("configuration persists only allowlisted settings, never credentials or endpoint text", () => {
  const config = resolveScanConfiguration({ OPENAI_API_KEY: "fixture-ai-key", APIFY_TOKEN: "fixture-apify-key",
    DATABASE_URL: "postgres://secret", OPENAI_BASE_URL: "https://private.example/path?key=private-key",
    REDDIT_TRIAGE_BUDGET: "399" });
  const serialized = JSON.stringify(config);
  for (const value of ["fixture-ai-key", "fixture-apify-key", "postgres://", "private.example", "private-key", "DATABASE_URL", "APIFY_TOKEN"]) assert.ok(!serialized.includes(value));
  assert.equal(config.environment.REDDIT_TRIAGE_BUDGET, "399");
  assert.deepEqual(Object.values(config.flags), [false, false, false]);
});

test("resume freezes specified and absent settings, with independent current credentials", () => {
  const original = { OPENAI_API_KEY: "old-key", REDDIT_TRIAGE_BUDGET: "399", APIFY_REDDIT_ENRICHMENT_LIMIT: "0" };
  const receipt = JSON.parse(JSON.stringify(resolveScanConfiguration(original)));
  const resumed = environmentForScan(receipt, { ...original, OPENAI_API_KEY: "rotated-key", REDDIT_TRIAGE_BUDGET: "20",
    HARSHMAUR_REDDIT_POSTS_PER_QUERY: "5", OPENAI_ECONOMY_MODEL: "other-model", APIFY_REDDIT_ENRICHMENT_LIMIT: "12" });
  assert.equal(resumed.REDDIT_TRIAGE_BUDGET, "399");
  assert.equal(resumed.APIFY_REDDIT_ENRICHMENT_LIMIT, "0");
  assert.equal(resumed.OPENAI_API_KEY, "rotated-key");
  assert.equal(resumed.HARSHMAUR_REDDIT_POSTS_PER_QUERY, undefined);
  assert.equal(resumed.OPENAI_ECONOMY_MODEL, undefined);
});

test("resume never silently changes accepted routing or AI/fallback availability", () => {
  const off = resolveScanConfiguration({});
  const resumed = environmentForScan(off, { OPENAI_API_KEY: "new-key", OPENAI_DIRECT_FALLBACK_API_KEY: "new-fallback" });
  assert.equal(resumed.OPENAI_API_KEY, undefined); assert.equal(resumed.OPENAI_DIRECT_FALLBACK_API_KEY, undefined);
  const on = resolveScanConfiguration({ OPENAI_API_KEY: "key", OPENAI_DIRECT_FALLBACK_API_KEY: "fallback" });
  assert.throws(() => environmentForScan(on, {}), /requires.*credentials/);
  assert.throws(() => environmentForScan(on, { OPENAI_API_KEY: "key" }), /fallback credentials/);
  assert.throws(() => environmentForScan(off, { OPENAI_BASE_URL: "https://changed.example" }), /routing changed/);
});

test("configuration identity excludes acceptance clock and credential rotation", () => {
  const first = resolveScanConfiguration({ OPENAI_API_KEY: "key", REDDIT_TRIAGE_BUDGET: "400" });
  assert.equal(first.id, resolveScanConfiguration({ OPENAI_API_KEY: "rotated", REDDIT_TRIAGE_BUDGET: "400" }).id);
  assert.notEqual(first.id, resolveScanConfiguration({ OPENAI_API_KEY: "key", REDDIT_TRIAGE_BUDGET: "399" }).id);
});

test("AI attempt events include transport failure without usage", async () => {
  const events = []; const usage = [];
  const provider = new OpenAiProvider({ apiKey: "fixture-key", apiStyle: "chat", maxRetries: 0,
    onRequest: e => events.push(e), onUsage: e => usage.push(e), fetchImpl: async () => { throw new Error("private upstream detail"); } });
  await assert.rejects(provider.triageConversations({ business, candidates: [candidate("failed")], models: DEFAULT_OPENAI_MODELS, coverageRetries: 0 }));
  assert.deepEqual(events.map(e => e.phase), ["start", "end"]);
  assert.equal(events[1].category, "transport_error");
  assert.equal(usage.length, 0);
  assert.ok(!JSON.stringify(events).includes("private upstream detail"));
});

test("concurrent batches have separate request identities and emit ordinary usage", async () => {
  const events = []; const usage = [];
  const provider = new OpenAiProvider({ apiKey: "fixture-key", apiStyle: "chat", maxRetries: 0,
    onRequest: e => events.push(e), onUsage: e => usage.push(e), fetchImpl: async (_url, init) => chatResponse(requestCandidates(init).map(row => triage(row.externalId))) });
  const result = await provider.triageConversations({ business, candidates: Array.from({ length: 26 }, (_, i) => candidate(`trace_${i}`)), models: DEFAULT_OPENAI_MODELS });
  assert.equal(result.value.length, 26); assert.equal(usage.length, 2);
  assert.equal(new Set(events.map(e => e.requestIndex)).size, 2);
  assert.equal(events.filter(e => e.phase === "end" && e.category === "http_success").length, 2);
});

test("bad request and diagnostic collectors do not alter structured recovery", async () => {
  let calls = 0;
  const provider = new OpenAiProvider({ apiKey: "fixture-key", apiStyle: "chat", maxRetries: 0,
    onRequest: () => { throw new Error("collector"); }, onDiagnostic: async () => { throw new Error("collector"); },
    fetchImpl: async (_url, init) => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ choices: [{ message: { content: "not JSON" }, finish_reason: "stop" }] }));
      return chatResponse(requestCandidates(init).map(row => triage(row.externalId)));
    } });
  const result = await provider.triageConversations({ business, candidates: [candidate("recovery")], models: DEFAULT_OPENAI_MODELS });
  assert.equal(result.value.length, 1); assert.equal(calls, 2);
});

test("accepted provider configuration retains current operational defaults", () => {
  const ai = createOpenAiProviderFromEnv({ OPENAI_API_KEY: "fixture-key" }).configurationForDiagnostics();
  assert.equal(ai.timeoutMs, 90_000); assert.equal(ai.maxRetries, 2); assert.equal(ai.triageConcurrency, 4); assert.equal(ai.triageBatchSize, 25);
  const reddit = new HarshmaurRedditProvider({ token: "fixture-token" }).configurationForDiagnostics();
  assert.equal(reddit.postsPerQuery, 50); assert.equal(reddit.queriesPerRun, 1); assert.equal(reddit.enrichmentLimit, 0);
  assert.ok(!JSON.stringify(reddit).includes("fixture-token"));
});

test("actor events close failed runs without leaking query inputs", async () => {
  const events = [];
  const provider = new HarshmaurRedditProvider({ token: "fixture-token", discoveryRetryAttempts: 1,
    onActorRun: e => events.push(e), fetchImpl: async () => new Response(JSON.stringify({ data: { id: "actor_fixture", status: "FAILED" } })) });
  await assert.rejects(provider.discover({ queries: { productCategories: ["confidential query"] }, limit: 40, since: "2026-01-01" }));
  assert.equal(events[0].phase, "start"); assert.equal(events.at(-1).outcome, "failed");
  assert.equal(events.at(-1).actorRunId, "actor_fixture");
  assert.ok(!JSON.stringify(events).includes("confidential"));
});

test("workflow persists configuration before external work, and uses the accepted environment", async () => {
  const source = await readFile(new URL("../lib/server/scan-workflow.ts", import.meta.url), "utf8");
  const run = source.slice(source.indexOf("export async function runScan("));
  assert.ok(run.indexOf("await persistScan(scan)") < run.indexOf('await setStage(scan, "website", "active")'));
  assert.match(run, /environmentForScan\(scan.runConfiguration\)/);
  assert.match(run, /createRedditProviderFromEnv\(env/);
  assert.match(run, /const aiProvider = scanAiProvider\(scan, env\)/);
  assert.match(run, /triageCandidateBudget\(env\)/);
  assert.equal(/process\.env\./.test(run), false);
});
