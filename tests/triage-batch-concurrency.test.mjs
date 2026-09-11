import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./helpers/load-ts-module.mjs";

/**
 * triageConversations() used to await each TRIAGE_BATCH_SIZE-sized batch
 * fully before starting the next -- a 235-candidate scan waited through
 * ~10 sequential round-trips for no reason, since batches are otherwise
 * fully independent of one another. It now fans batches out across a
 * bounded worker pool (TRIAGE_CONCURRENCY) instead, the same pattern
 * already used for independent Reddit discovery query chunks. These tests
 * exercise the real, compiled triageConversations -- not source-string
 * assertions -- against a slow fetchImpl, proving batches genuinely
 * overlap in time and that final results/coverage are unaffected by the
 * change in scheduling.
 */

const openai = await loadTsModule("lib/providers/openai.server.ts");
const cited = (value) => ({ value, confidence: 0.9, provenanceIds: ["web_1"] });
const business = {
  businessId: "biz_1",
  workspaceId: "ws_1",
  websiteUrl: "https://example.com",
  canonicalDomain: "example.com",
  name: cited("Example"),
  summary: cited("Workflow software for client teams."),
  productCategory: cited("workflow software"),
  targetAudiences: cited([]),
  problemsSolved: cited(["documents buried in email", "missed client deadlines"]),
  features: cited([{ name: "task tracking", description: "track work", verified: true }]),
  competitors: cited([]),
  irrelevantTopics: cited([]),
  productTerms: cited(["Example", "workflow software"]),
  brandTerms: cited(["Example"]),
  customerProblemLanguage: cited(["documents buried in email", "missed client deadlines"]),
  ambiguityRisks: cited([]),
  version: 2,
  generatedAt: "2026-08-09T00:00:00.000Z",
};

function candidate(externalId) {
  return {
    provider: "apify-test",
    sourceMode: "apify-test",
    externalId,
    kind: "post",
    subreddit: "smallbusiness",
    title: "Need a better client workflow",
    body: "Documents are buried in email and we are missing deadlines. What are people using?",
    author: `person_${externalId}`,
    permalink: `https://www.reddit.com/r/smallbusiness/comments/${externalId}/thread/`,
    createdAt: "2026-08-08T12:00:00.000Z",
    metrics: { score: 1, comments: 2 },
    matchedQueries: ["documents AND buried AND email"],
    discoveryLanes: ["problem_pain"],
    provenance: {
      id: `source_${externalId}`,
      kind: "reddit",
      provider: "apify-test",
      providerExternalId: externalId,
      contentHash: `hash_${externalId}`,
      observedAt: "2026-08-09T00:00:00.000Z",
      isMock: false,
    },
  };
}

function triageItem(externalId) {
  return {
    externalId,
    relevant: true,
    intent: "actively_looking",
    demandSignal: "explicit_demand",
    problem: "Missed deadlines and scattered documents",
    productFit: "high",
    timing: "current",
    replyability: "high",
    worthEnriching: true,
    reason: "The author is actively asking for a solution to a verified problem.",
  };
}

function chatResponse(payload) {
  return new Response(JSON.stringify({
    id: "chat_test",
    choices: [{ message: { content: JSON.stringify(payload) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }), {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": "req_test" },
  });
}

function windowsOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

test("100 candidates (4 batches of 25) are triaged with genuinely overlapping requests, not one after another", async () => {
  const windows = [];
  const delayMs = 100;
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = JSON.parse(body.messages[1].content);
      const ids = user.candidates.map((row) => row.externalId);
      const start = Date.now();
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      windows.push({ ids, start, end: Date.now() });
      return chatResponse({ triage: ids.map(triageItem) });
    },
  });
  const candidates = Array.from({ length: 100 }, (_, index) => candidate(`c${index + 1}`));

  const startedAt = Date.now();
  const result = await provider.triageConversations({
    business,
    candidates,
    models: openai.DEFAULT_OPENAI_MODELS,
    coverageRetries: 0,
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(windows.length, 4, "100 candidates at batch size 25 should be exactly 4 batches");
  assert.deepEqual(result.value.map((row) => row.externalId), candidates.map((row) => row.externalId));

  // Strictly sequential would take ~4 * delayMs. With TRIAGE_CONCURRENCY
  // (4) able to run all 4 batches of this test at once, it should land
  // close to ~1 * delayMs. A generous bound (test-runner/JSON overhead is
  // a fixed cost, and a larger delayMs keeps that overhead small relative
  // to it) avoids flakiness while still proving genuine overlap rather
  // than 4 sequential round-trips.
  assert.ok(elapsed < delayMs * 2.5, `expected well under ${delayMs * 4}ms for 4 sequential batches, got ${elapsed}ms`);

  // At least two batches must have genuinely overlapped in time.
  const anyOverlap = windows.some((a, i) => windows.slice(i + 1).some((b) => windowsOverlap(a, b)));
  assert.equal(anyOverlap, true, "expected at least two triage batches to overlap in time");
});

test("batch dispatch is bounded by TRIAGE_CONCURRENCY, not unlimited", async () => {
  let concurrent = 0;
  let peakConcurrent = 0;
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    fetchImpl: async (_url, init) => {
      concurrent += 1;
      peakConcurrent = Math.max(peakConcurrent, concurrent);
      const body = JSON.parse(init.body);
      const user = JSON.parse(body.messages[1].content);
      const ids = user.candidates.map((row) => row.externalId);
      await new Promise((resolve) => setTimeout(resolve, 25));
      concurrent -= 1;
      return chatResponse({ triage: ids.map(triageItem) });
    },
  });
  const candidates = Array.from({ length: 250 }, (_, index) => candidate(`c${index + 1}`));

  await provider.triageConversations({
    business,
    candidates,
    models: openai.DEFAULT_OPENAI_MODELS,
    coverageRetries: 0,
  });

  // 250 candidates at batch size 25 is 10 batches -- peak concurrent
  // requests must never exceed TRIAGE_CONCURRENCY (4), proving this is a
  // bounded pool, not "fire every batch at once."
  assert.ok(peakConcurrent > 1, "expected genuine concurrency (more than 1 in flight at once)");
  assert.ok(peakConcurrent <= 4, `expected at most 4 concurrent triage requests, saw ${peakConcurrent}`);
});

test("DeepSeek triage uses smaller independent batches without dropping candidates", async () => {
  const windows = [];
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = JSON.parse(body.messages[1].content);
      const ids = user.candidates.map((row) => row.externalId);
      windows.push(ids);
      return chatResponse({ triage: ids.map(triageItem) });
    },
  });
  const candidates = Array.from({ length: 26 }, (_, index) => candidate(`deep${index + 1}`));
  const result = await provider.triageConversations({
    business,
    candidates,
    models: { ...openai.DEFAULT_OPENAI_MODELS, economyModel: "deepseek-v4-flash" },
    coverageRetries: 0,
  });

  assert.equal(result.coverage.complete, true);
  assert.equal(result.value.length, 26);
  assert.deepEqual(windows.map((rows) => rows.length).sort((a, b) => b - a), [10, 10, 6]);
});

test("a batch that fails does not corrupt or block sibling batches running concurrently", async () => {
  const windows = [];
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    maxRetries: 0,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = JSON.parse(body.messages[1].content);
      const ids = user.candidates.map((row) => row.externalId);
      windows.push(ids);
      // The second batch (candidates 26-50) always fails outright.
      if (ids[0] === "c26") {
        return new Response(JSON.stringify({ error: { message: "upstream failure" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      return chatResponse({ triage: ids.map(triageItem) });
    },
  });
  const candidates = Array.from({ length: 50 }, (_, index) => candidate(`c${index + 1}`));

  await assert.rejects(
    provider.triageConversations({
      business,
      candidates,
      models: openai.DEFAULT_OPENAI_MODELS,
      coverageRetries: 0,
    }),
  );

  // Both batches must have been dispatched (the failing one does not
  // prevent its sibling from being attempted concurrently).
  assert.equal(windows.length, 2);
});
