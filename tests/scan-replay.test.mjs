import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./helpers/load-ts-module.mjs";
import { business, candidate, triage, fixtures, chatResponse, requestCandidates } from "./fixtures/scan-replay/factories.mjs";

const pipeline = await loadTsModule("lib/intelligence/reddit-pipeline.ts");
const embedding = await loadTsModule("lib/intelligence/embedding-prefilter.ts");
const openai = await loadTsModule("lib/providers/openai.server.ts");
const { HarshmaurRedditProvider } = await loadTsModule("lib/providers/reddit-harshmaur.server.ts");
const clean = (candidates, profile = business) => pipeline.cleanDiscoveryCandidates({
  candidates, business: profile, since: fixtures.since, now: new Date(fixtures.now),
});

for (const fixture of fixtures.semanticCases) {
  test(`replay cleaning preserves the ${fixture.id} case`, () => {
    const result = clean([candidate(fixture.id, { title: fixture.title, body: fixture.body })]);
    assert.equal(result.survivors.length, fixture.clean ? 1 : 0);
    if (fixture.rejection) assert.equal(result.rejectedByReason[fixture.rejection], 1);
  });
}

test("replay selects indirect pain, switching and relevant non-leads from supplied judgments", () => {
  const cases = fixtures.semanticCases.filter(f => f.clean && f.worthReviewing);
  const rows = cases.map(f => candidate(f.id, { title: f.title, body: f.body }));
  const judgments = new Map(cases.map(f => [f.id, triage(f.id, {
    intent: f.intent, demandSignal: f.signal, worthEnriching: f.worthReviewing,
  })]));
  const selected = pipeline.selectCandidatesForEnrichment({ candidates: rows, triageById: judgments, budget: 8 });
  assert.deepEqual(new Set(selected.map(r => r.externalId)), new Set(cases.map(f => f.id)));
});

test("replay zero-result audit retains an independent check of a strong retrieval lane", () => {
  const row = candidate("zero-audit");
  const selected = pipeline.selectZeroResultAuditCandidates({ candidates: [row], budget: 3,
    triageById: new Map([[row.externalId, triage(row.externalId, {
      relevant: false, intent: "informational", demandSignal: "none", worthEnriching: false,
    })]]),
  });
  assert.equal(selected[0]?.externalId, row.externalId);
});

test("replay richer late duplicates replace the earlier record", () => {
  const early = candidate("duplicate", { body: "Missing monthly client documents." });
  const late = candidate("duplicate", { body: "Missing monthly client documents. We have now missed three deadlines and need a new workflow this week.",
    provenance: { ...early.provenance, contentHash: "fixture_changed_content" } });
  const result = clean([early, structuredClone(early), late]);
  assert.equal(result.survivors.length, 1);
  assert.equal(result.survivors[0].body, late.body);
  assert.equal(result.rejectedByReason.duplicate, 2);
});

test("replay uses discovery time for future-date checks, not scan creation time", () => {
  const row = candidate("fresh", { createdAt: "2026-08-30T11:59:00.000Z" });
  assert.equal(clean([row]).survivors.length, 1);
  assert.equal(clean([candidate("future", { createdAt: "2026-08-31T12:00:00.000Z" })]).survivors.length, 0);
});

test("replay context-only and changed business profiles reach the actual AI request", async () => {
  const received = [];
  const provider = new openai.OpenAiProvider({ apiKey: "fixture-key", apiStyle: "chat", maxRetries: 0,
    fetchImpl: async (_url, init) => {
      received.push(JSON.parse(JSON.parse(init.body).messages[1].content).business);
      return chatResponse(requestCandidates(init).map(r => triage(r.externalId)));
    },
  });
  const context = { ...structuredClone(business), websiteUrl: "", canonicalDomain: "" };
  const changed = { ...structuredClone(business), summary: { ...business.summary, value: "A different verified business scope." } };
  for (const profile of [context, changed]) await provider.triageConversations({ business: profile,
    candidates: [candidate("profile")], models: openai.DEFAULT_OPENAI_MODELS, coverageRetries: 0 });
  assert.equal(received[0].websiteUrl, "");
  assert.equal(received[1].summary.value, changed.summary.value);
});

for (const count of fixtures.poolSizes) {
  test(`replay AI batching covers all ${count} candidates without changing scope`, async () => {
    const requested = [];
    const rows = Array.from({ length: count }, (_, i) => candidate(`pool_${i}`));
    const provider = new openai.OpenAiProvider({ apiKey: "fixture-key", apiStyle: "chat", maxRetries: 0,
      fetchImpl: async (_url, init) => {
        const batch = requestCandidates(init);
        requested.push(batch.map(r => r.externalId));
        return chatResponse(batch.map(r => triage(r.externalId)));
      },
    });
    const result = await provider.triageConversations({ business, candidates: rows, models: openai.DEFAULT_OPENAI_MODELS, coverageRetries: 0 });
    assert.deepEqual(result.value.map(r => r.externalId), rows.map(r => r.externalId));
    assert.equal(new Set(requested.flat()).size, count);
    assert.ok(requested.every(batch => batch.length <= 25));
  });
}

for (const count of [399, 400, 401, 450]) {
  test(`replay global embedding selection accounts for every ID in a ${count}-record pool`, () => {
    const rows = Array.from({ length: count }, (_, i) => ({ externalId: `embedding_${i}`, similarity: 0.8 - i / 2000 }));
    const result = embedding.prioritizeCandidates(rows, { budget: 400, floor: 0.12, minimumPool: 40 });
    assert.equal(result.retained.length, Math.min(400, count));
    assert.equal(new Set([...result.retained, ...result.dropped]).size, count);
    const unavailable = embedding.prioritizeCandidates(rows.map(r => ({ ...r, similarity: null })), { budget: 400, floor: 0.12, minimumPool: 40 });
    assert.equal(unavailable.retained.length, count, "missing embeddings cannot silently discard candidates");
  });
}

test("replay a late stronger candidate can displace an early weaker candidate", () => {
  const early = candidate("early");
  const late = candidate("late");
  const selected = pipeline.selectCandidatesForEnrichment({ candidates: [early, late], budget: 1,
    triageById: new Map([[early.externalId, triage(early.externalId, { intent: "informational", demandSignal: "none" })],
      [late.externalId, triage(late.externalId)]]),
  });
  assert.equal(selected[0].externalId, "late");
});

test("replay a failed AI batch retains successful sibling checkpoints for resume", async () => {
  const checkpoint = new Map();
  const rows = Array.from({ length: 26 }, (_, i) => candidate(`recovery_${i}`));
  let fail = true;
  const requested = [];
  const provider = new openai.OpenAiProvider({ apiKey: "fixture-key", apiStyle: "chat", maxRetries: 0,
    fetchImpl: async (_url, init) => {
      const batch = requestCandidates(init);
      requested.push(batch.map(r => r.externalId));
      if (fail && batch.some(r => r.externalId === "recovery_25")) throw new Error("synthetic transport failure");
      return chatResponse(batch.map(r => triage(r.externalId)));
    },
  });
  const request = { business, candidates: rows, models: openai.DEFAULT_OPENAI_MODELS, coverageRetries: 0,
    onBatchSucceeded: items => items.forEach(item => checkpoint.set(item.externalId, item.triage)) };
  await assert.rejects(provider.triageConversations(request), /network request failed/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(checkpoint.size, 25);
  fail = false;
  requested.length = 0;
  const result = await provider.triageConversations({ ...request, resumeFrom: checkpoint });
  assert.equal(result.value.length, 26);
  assert.deepEqual(requested.flat(), ["recovery_25"]);
});

test("replay thread-fetch authentication failure is terminal and does not invent verification", async (t) => {
  t.mock.method(console, "error", () => {});
  let requests = 0;
  const provider = new HarshmaurRedditProvider({ token: "fixture-token", enrichmentLimit: 8,
    fetchImpl: async () => {
      requests += 1;
      return new Response(JSON.stringify({ error: { message: "synthetic forbidden thread" } }), { status: 403 });
    },
  });
  await assert.rejects(provider.enrich({ candidates: [candidate("abc123")], maxComments: 6 }), error => error.code === "provider_auth_failed");
  assert.equal(requests, 1);
});

test("replay preserves prior discovery and reports missing coverage when all remaining chunks fail", async () => {
  const queries = { productCategories: ["client document tracking"], customerProblems: ["missing client deadlines"], competitors: ["LedgerDesk"] };
  const prior = { candidates: [candidate("prior")], sourceMode: "live",
    searchPlan: [{ lane: "category_recommendation", query: "client document tracking", seed: "client document tracking" }],
    diagnostics: { queryCount: 1, fetchedCandidates: 1, normalizedCandidates: 1, verifiedRecentCandidates: 1,
      rejectedByReason: {}, laneQueryCounts: { category_recommendation: 1 } },
  };
  const requestedQueries = [];
  const events = [];
  let shouldFail = true;
  const provider = new HarshmaurRedditProvider({ token: "fixture-token", queriesPerRun: 1, discoveryRetryAttempts: 1,
    fetchImpl: async (_url, init) => {
      if (String(_url).includes("/datasets/")) return Response.json([]);
      const input = JSON.parse(init.body);
      requestedQueries.push(new URL(input.startUrls[0].url).searchParams.get("q"));
      return new Response(JSON.stringify({ data: { id: "fixture_run", status: shouldFail ? "FAILED" : "SUCCEEDED", defaultDatasetId: "fixture_dataset" } }), { status: 200 });
    },
  });
  const result = await provider.discover({ queries, limit: 250, since: fixtures.since }, { resumeFrom: prior, onProgress: value => events.push(value) });
  assert.equal(result.candidates[0].externalId, "prior");
  assert.notEqual(result, prior);
  assert.equal(result.diagnostics.degraded, true);
  assert.equal(result.diagnostics.queriesSucceeded, 1);
  assert.equal(result.diagnostics.queriesFailed, 2);
  assert.equal(result.diagnostics.queryCount, 3);
  assert.equal(prior.diagnostics.degraded, undefined, "the saved prior checkpoint is not mutated");
  assert.equal(requestedQueries.length, 2);
  assert.equal(result.searchPlan.length, 1);
  assert.ok(!requestedQueries.includes("client document tracking"));
  assert.deepEqual(events.at(-1), { planned: 3, succeeded: 1, active: 0, retrying: 0, failed: 2, pending: 0 });
  shouldFail = false;
  const recovered = await provider.discover({ queries, limit: 250, since: fixtures.since }, { resumeFrom: result, onProgress: value => events.push(value) });
  assert.equal(recovered.diagnostics.degraded, false);
  assert.equal(recovered.diagnostics.queriesSucceeded, 3); assert.equal(recovered.diagnostics.queriesFailed, 0);
  assert.deepEqual(events.at(-1), { planned: 3, succeeded: 3, active: 0, retrying: 0, failed: 0, pending: 0 });
  const attempts = requestedQueries.length;
  await provider.discover({ queries, limit: 250, since: fixtures.since }, { resumeFrom: recovered });
  assert.equal(requestedQueries.length, attempts, "fully recovered discovery makes no new paid request");
});

test("query progress counts unique searches across explicit rate-limit retries and concurrent completions", async () => {
  const events = [];
  let attempts = 0;
  const provider = new HarshmaurRedditProvider({ token: "fixture-token", queriesPerRun: 1, discoveryRetryAttempts: 2,
    fetchImpl: async url => {
      if (String(url).includes("/datasets/")) return Response.json([]);
      attempts += 1;
      if (attempts === 1) return new Response("fixture unavailable", { status: 429, headers: { "retry-after": "0" } });
      return Response.json({ data: { id: `fixture_${attempts}`, status: "SUCCEEDED", defaultDatasetId: "fixture_dataset" } });
    },
  });
  await provider.discover({ queries: { productCategories: ["client document tracking"], customerProblems: ["missing client deadlines"], competitors: ["LedgerDesk"] },
    limit: 250, since: fixtures.since }, { onProgress: value => events.push(value) });
  assert.equal(attempts, 4); assert.ok(events.some(value => value.retrying === 1));
  assert.ok(events.some(value => value.active > 1));
  for (const value of events) {
    assert.equal(value.planned, 3);
    assert.equal(value.succeeded + value.failed + value.retrying + value.active + value.pending, 3);
  }
  assert.deepEqual(events.at(-1), { planned: 3, succeeded: 3, active: 0, retrying: 0, failed: 0, pending: 0 });
});
