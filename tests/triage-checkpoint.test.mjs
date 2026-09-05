import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./helpers/load-ts-module.mjs";

/**
 * triageConversations() only ever guaranteed full coverage or a thrown
 * error: if one concurrent batch exhausted its own retries (e.g. an OpenAI
 * request timing out -- observed live in production as "OpenAI network
 * request failed: The operation was aborted due to timeout"), the whole
 * call rejected, discarding every other batch's already-successful triage
 * results too. Because triage was never checkpointed, a job retry after
 * such a failure resubmitted every candidate to OpenAI again -- including
 * ones a sibling batch had already classified correctly moments before the
 * failing batch gave up. Combined with TRIAGE_CONCURRENCY running several
 * batches at once (more contention against OpenAI, more chances for one of
 * them to time out), this could make a scan retry the entire triage stage
 * repeatedly without ever finishing.
 *
 * `resumeFrom` (an already-triaged subset, keyed by externalId) and
 * `onBatchSucceeded` (fired once a batch achieves full coverage for its own
 * candidates) let a caller checkpoint progress and skip already-covered
 * candidates on the next attempt, without weakening the existing
 * all-or-throw coverage guarantee for whatever is actually submitted.
 *
 * These tests exercise the real, compiled triageConversations, the same
 * compile pattern already used by triage-batch-concurrency.test.mjs.
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

test("resumeFrom entries are never resubmitted to OpenAI, and appear directly in the result", async () => {
  const requestedIds = [];
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = JSON.parse(body.messages[1].content);
      const ids = user.candidates.map((row) => row.externalId);
      requestedIds.push(...ids);
      return chatResponse({ triage: ids.map(triageItem) });
    },
  });
  const candidates = Array.from({ length: 5 }, (_, index) => candidate(`c${index + 1}`));
  const resumeFrom = new Map([
    ["c1", triageItem("c1")],
    ["c3", triageItem("c3")],
  ]);

  const result = await provider.triageConversations({
    business,
    candidates,
    models: openai.DEFAULT_OPENAI_MODELS,
    coverageRetries: 0,
    resumeFrom,
  });

  assert.deepEqual(requestedIds.sort(), ["c2", "c4", "c5"], "c1 and c3 must never be resubmitted");
  assert.equal(result.value.length, 5, "the returned set still covers every candidate");
  assert.deepEqual(
    result.value.map((row) => row.externalId).sort(),
    ["c1", "c2", "c3", "c4", "c5"],
  );
});

test("if every candidate is already covered by resumeFrom, no OpenAI request is made at all", async () => {
  let calls = 0;
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    fetchImpl: async () => {
      calls += 1;
      throw new Error("should never be called");
    },
  });
  const candidates = [candidate("c1"), candidate("c2")];
  const resumeFrom = new Map([
    ["c1", triageItem("c1")],
    ["c2", triageItem("c2")],
  ]);

  const result = await provider.triageConversations({
    business,
    candidates,
    models: openai.DEFAULT_OPENAI_MODELS,
    coverageRetries: 0,
    resumeFrom,
  });

  assert.equal(calls, 0);
  assert.equal(result.value.length, 2);
});

test("onBatchSucceeded fires once a batch reaches full coverage, with exactly that batch's items", async () => {
  const succeededBatches = [];
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = JSON.parse(body.messages[1].content);
      const ids = user.candidates.map((row) => row.externalId);
      return chatResponse({ triage: ids.map(triageItem) });
    },
  });
  // TRIAGE_BATCH_SIZE is 25, so 40 candidates is exactly 2 batches.
  const candidates = Array.from({ length: 40 }, (_, index) => candidate(`c${index + 1}`));

  await provider.triageConversations({
    business,
    candidates,
    models: openai.DEFAULT_OPENAI_MODELS,
    coverageRetries: 0,
    onBatchSucceeded: (items) => { succeededBatches.push(items.map((i) => i.externalId)); },
  });

  assert.equal(succeededBatches.length, 2, "one checkpoint call per batch");
  const allCheckpointed = succeededBatches.flat().sort();
  assert.deepEqual(allCheckpointed, candidates.map((c) => c.externalId).sort());
});

test("a batch that exhausts its retries still fails the whole call (coverage guarantee unchanged), but the sibling batch's onBatchSucceeded already fired", async () => {
  const succeededBatches = [];
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    maxRetries: 0,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = JSON.parse(body.messages[1].content);
      const ids = user.candidates.map((row) => row.externalId);
      // The second batch (candidates 26-50) always fails outright.
      if (ids[0] === "c26") {
        return new Response(JSON.stringify({ error: { message: "upstream failure" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
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
      onBatchSucceeded: (items) => { succeededBatches.push(items.map((i) => i.externalId)); },
    }),
  );

  // The first batch (c1-c25) succeeded and was checkpointed even though the
  // whole call ultimately rejected -- this is exactly what lets a retried
  // job skip resubmitting it next time.
  assert.equal(succeededBatches.length, 1);
  assert.equal(succeededBatches[0].length, 25);
  assert.equal(succeededBatches[0][0], "c1");
});

test("a checkpoint write that throws does not fail or discard the batch's own successful triage", async () => {
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = JSON.parse(body.messages[1].content);
      const ids = user.candidates.map((row) => row.externalId);
      return chatResponse({ triage: ids.map(triageItem) });
    },
  });
  const candidates = [candidate("c1"), candidate("c2")];

  const result = await provider.triageConversations({
    business,
    candidates,
    models: openai.DEFAULT_OPENAI_MODELS,
    coverageRetries: 0,
    onBatchSucceeded: async () => {
      throw new Error("persistence layer is down");
    },
  });

  assert.equal(result.value.length, 2);
});

test("tolerateUnrecoverableBatches: malformed batches remain unresolved while successful judgments survive", async () => {
  const succeededBatches = [];
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    maxRetries: 0,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = JSON.parse(body.messages[1].content);
      const ids = user.candidates.map((row) => row.externalId);
      // The second batch (c26-c50) always comes back as unparsable JSON,
      // simulating the real production failure ("OpenAI returned malformed
      // structured JSON.") that lost 150 good, already-checkpointed
      // candidates from one real scan.
      if (ids[0] === "c26") {
        return new Response(JSON.stringify({
          id: "chat_test",
          choices: [{ message: { content: "not valid json {{{" } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return chatResponse({ triage: ids.map(triageItem) });
    },
  });
  const candidates = Array.from({ length: 50 }, (_, index) => candidate(`c${index + 1}`));

  const result = await provider.triageConversations({
    business,
    candidates,
    models: openai.DEFAULT_OPENAI_MODELS,
    coverageRetries: 0,
    tolerateUnrecoverableBatches: true,
    onBatchSucceeded: (items) => { succeededBatches.push(items.map((i) => i.externalId)); },
  });

  // Only actual judgments belong in value/checkpoints. An unresolved batch
  // is coverage loss, not a set of fabricated negative relevance decisions.
  assert.equal(result.value.length, 25);
  assert.deepEqual(result.coverage, { expected: 50, succeeded: 25, unresolved: 25, pending: 0, complete: false });
  const byId = new Map(result.value.map((row) => [row.externalId, row]));
  for (let index = 1; index <= 25; index += 1) {
    assert.equal(byId.get(`c${index}`).triage.worthEnriching, true, `c${index} should carry its real triage verdict`);
  }
  for (let index = 26; index <= 50; index += 1) {
    assert.equal(byId.has(`c${index}`), false);
    const outcome = result.processing.find(item => item.externalId === `c${index}`);
    assert.equal(outcome.status, "unresolved");
    assert.equal(outcome.code, "ai_structured_output");
  }

  // Only the resolved batch can be reused; unresolved IDs need recovery.
  assert.equal(succeededBatches.length, 1);
  assert.deepEqual(succeededBatches[0], candidates.slice(0, 25).map((c) => c.externalId));
});

test("tolerateUnrecoverableBatches: empty structured responses remain unresolved too", async () => {
  // Real production finding: a second, distinct failure shape reached the
  // same triageConversations() call and was NOT caught by
  // tolerateUnrecoverableBatches -- OpenAI can also answer with finish_reason
  // "stop" and null/empty content (no JSON at all to even attempt to
  // parse), which openai.server.ts surfaces as "OpenAI returned no
  // structured chat response text (...)" rather than "OpenAI returned
  // malformed structured JSON." This must be tolerated the same way.
  const succeededBatches = [];
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    maxRetries: 0,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = JSON.parse(body.messages[1].content);
      const ids = user.candidates.map((row) => row.externalId);
      if (ids[0] === "c26") {
        return new Response(JSON.stringify({
          id: "chat_test",
          choices: [{ message: { content: null }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 2652 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return chatResponse({ triage: ids.map(triageItem) });
    },
  });
  const candidates = Array.from({ length: 50 }, (_, index) => candidate(`c${index + 1}`));

  const result = await provider.triageConversations({
    business,
    candidates,
    models: openai.DEFAULT_OPENAI_MODELS,
    coverageRetries: 0,
    tolerateUnrecoverableBatches: true,
    onBatchSucceeded: (items) => { succeededBatches.push(items.map((i) => i.externalId)); },
  });

  assert.equal(result.value.length, 25);
  assert.equal(result.coverage.complete, false);
  const byId = new Map(result.value.map((row) => [row.externalId, row]));
  for (let index = 1; index <= 25; index += 1) {
    assert.equal(byId.get(`c${index}`).triage.worthEnriching, true, `c${index} should carry its real triage verdict`);
  }
  for (let index = 26; index <= 50; index += 1) {
    assert.equal(byId.has(`c${index}`), false);
    assert.equal(result.processing.find(item => item.externalId === `c${index}`).status, "unresolved");
  }
  assert.equal(succeededBatches.length, 1);
});

test("without tolerateUnrecoverableBatches, an empty structured response still fails the whole call", async () => {
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    maxRetries: 0,
    fetchImpl: async () => new Response(JSON.stringify({
      id: "chat_test",
      choices: [{ message: { content: null }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2652 },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const candidates = [candidate("c1"), candidate("c2")];

  await assert.rejects(
    provider.triageConversations({
      business,
      candidates,
      models: openai.DEFAULT_OPENAI_MODELS,
      coverageRetries: 0,
    }),
    /no structured chat response text/,
  );
});

test("without tolerateUnrecoverableBatches, the exact same unparsable batch still fails the whole call (default behavior is unchanged)", async () => {
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    maxRetries: 0,
    fetchImpl: async () => new Response(JSON.stringify({
      id: "chat_test",
      choices: [{ message: { content: "not valid json {{{" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  const candidates = [candidate("c1"), candidate("c2")];

  await assert.rejects(
    provider.triageConversations({
      business,
      candidates,
      models: openai.DEFAULT_OPENAI_MODELS,
      coverageRetries: 0,
    }),
    /malformed structured JSON/,
  );
});

test("a batch hit by a transient network/transport failure (fetch itself throws, e.g. a client-side timeout) recovers via retry instead of failing the whole call", async () => {
  // maxRetries: 0 isolates this from post()'s own internal retry loop --
  // every failure here is caught and retried purely by the coverageRetries
  // budget this test is exercising.
  let batchTwoAttempts = 0;
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    maxRetries: 0,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = JSON.parse(body.messages[1].content);
      const ids = user.candidates.map((row) => row.externalId);
      if (ids[0] === "c26") {
        batchTwoAttempts += 1;
        // Fails the first two attempts exactly like the production
        // incident ("OpenAI network request failed: The operation was
        // aborted due to timeout") -- fetch itself never resolves with a
        // Response, it throws.
        if (batchTwoAttempts <= 2) throw new Error("The operation was aborted due to timeout");
      }
      return chatResponse({ triage: ids.map(triageItem) });
    },
  });
  const candidates = Array.from({ length: 50 }, (_, index) => candidate(`c${index + 1}`));

  const result = await provider.triageConversations({
    business,
    candidates,
    models: openai.DEFAULT_OPENAI_MODELS,
    coverageRetries: 2,
  });

  assert.equal(result.value.length, 50);
  assert.equal(batchTwoAttempts, 3, "expected exactly 2 failed attempts then 1 successful attempt");
});

test("a batch whose transport failures persist through every retry still fails the whole call (coverage guarantee unchanged)", async () => {
  let batchTwoAttempts = 0;
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    maxRetries: 0,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = JSON.parse(body.messages[1].content);
      const ids = user.candidates.map((row) => row.externalId);
      if (ids[0] === "c26") {
        batchTwoAttempts += 1;
        throw new Error("The operation was aborted due to timeout");
      }
      return chatResponse({ triage: ids.map(triageItem) });
    },
  });
  const candidates = Array.from({ length: 50 }, (_, index) => candidate(`c${index + 1}`));

  await assert.rejects(
    provider.triageConversations({
      business,
      candidates,
      models: openai.DEFAULT_OPENAI_MODELS,
      coverageRetries: 2,
    }),
    /OpenAI network request failed/,
  );

  // 1 initial attempt + 2 retries = 3, matching coverageRetries: 2 -- proves
  // the retry budget is bounded, not unlimited.
  assert.equal(batchTwoAttempts, 3);
});

test("a genuine HTTP error (status set) is never retried by the network-transport path -- only pure transport failures are", async () => {
  let batchTwoAttempts = 0;
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    maxRetries: 0,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = JSON.parse(body.messages[1].content);
      const ids = user.candidates.map((row) => row.externalId);
      if (ids[0] === "c26") {
        batchTwoAttempts += 1;
        return new Response(JSON.stringify({ error: { message: "upstream failure" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return chatResponse({ triage: ids.map(triageItem) });
    },
  });
  const candidates = Array.from({ length: 50 }, (_, index) => candidate(`c${index + 1}`));

  await assert.rejects(
    provider.triageConversations({
      business,
      candidates,
      models: openai.DEFAULT_OPENAI_MODELS,
      coverageRetries: 2,
    }),
  );

  // A real HTTP error carries a status and is deliberately excluded from
  // the network-transport retry path -- it fails on the very first attempt,
  // exactly as before this change.
  assert.equal(batchTwoAttempts, 1);
});

test("when Surplus's own retries are exhausted, a configured directFallback provider is tried once before the whole call fails", async () => {
  let primaryAttempts = 0;
  let fallbackAttempts = 0;
  const fallback = new openai.OpenAiProvider({
    apiKey: "fallback-key",
    apiStyle: "chat",
    maxRetries: 0,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = JSON.parse(body.messages[1].content);
      const ids = user.candidates.map((row) => row.externalId);
      fallbackAttempts += 1;
      return chatResponse({ triage: ids.map(triageItem) });
    },
  });
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    maxRetries: 0,
    directFallback: fallback,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = JSON.parse(body.messages[1].content);
      const ids = user.candidates.map((row) => row.externalId);
      if (ids[0] === "c26") {
        primaryAttempts += 1;
        throw new Error("The operation was aborted due to timeout");
      }
      return chatResponse({ triage: ids.map(triageItem) });
    },
  });
  const candidates = Array.from({ length: 50 }, (_, index) => candidate(`c${index + 1}`));

  const result = await provider.triageConversations({
    business,
    candidates,
    models: openai.DEFAULT_OPENAI_MODELS,
    coverageRetries: 2,
  });

  assert.equal(result.value.length, 50);
  // 1 initial attempt + 2 retries against Surplus (all failing), then
  // exactly one call to the direct fallback, which succeeds.
  assert.equal(primaryAttempts, 3);
  assert.equal(fallbackAttempts, 1);
});

test("if the directFallback provider also fails, its error surfaces -- not the original Surplus error", async () => {
  const fallback = new openai.OpenAiProvider({
    apiKey: "fallback-key",
    apiStyle: "chat",
    maxRetries: 0,
    fetchImpl: async () => {
      throw new Error("direct OpenAI is also down");
    },
  });
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    maxRetries: 0,
    directFallback: fallback,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = JSON.parse(body.messages[1].content);
      const ids = user.candidates.map((row) => row.externalId);
      if (ids[0] === "c26") {
        throw new Error("The operation was aborted due to timeout");
      }
      return chatResponse({ triage: ids.map(triageItem) });
    },
  });
  const candidates = Array.from({ length: 50 }, (_, index) => candidate(`c${index + 1}`));

  await assert.rejects(
    provider.triageConversations({
      business,
      candidates,
      models: openai.DEFAULT_OPENAI_MODELS,
      coverageRetries: 2,
    }),
    /direct OpenAI is also down/,
  );
});

test("maxTokensField: useMaxCompletionTokens opts a provider into max_completion_tokens; the default keeps max_tokens unchanged", async () => {
  let directBody;
  let surplusBody;
  const direct = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    maxRetries: 0,
    useMaxCompletionTokens: true,
    fetchImpl: async (_url, init) => {
      directBody = JSON.parse(init.body);
      return chatResponse({ triage: [triageItem("c1")] });
    },
  });
  const surplus = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    maxRetries: 0,
    fetchImpl: async (_url, init) => {
      surplusBody = JSON.parse(init.body);
      return chatResponse({ triage: [triageItem("c1")] });
    },
  });

  await direct.triageConversations({
    business,
    candidates: [candidate("c1")],
    models: openai.DEFAULT_OPENAI_MODELS,
    coverageRetries: 0,
  });
  await surplus.triageConversations({
    business,
    candidates: [candidate("c1")],
    models: openai.DEFAULT_OPENAI_MODELS,
    coverageRetries: 0,
  });

  assert.ok("max_completion_tokens" in directBody, "useMaxCompletionTokens: true should send max_completion_tokens");
  assert.ok(!("max_tokens" in directBody), "useMaxCompletionTokens: true should not send max_tokens");
  assert.ok("max_tokens" in surplusBody, "default (useMaxCompletionTokens unset) should keep sending max_tokens");
  assert.ok(!("max_completion_tokens" in surplusBody), "default (useMaxCompletionTokens unset) should not send max_completion_tokens");
});
