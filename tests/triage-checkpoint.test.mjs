import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

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

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

async function compileOpenAiProvider() {
  let source = await readFile(
    new URL("../lib/providers/openai.server.ts", import.meta.url),
    "utf8",
  );
  const usageModule = moduleUrl(`
    export function estimateAiCostUsd() { return 0; }
    export function combineTokenUsage(records) {
      return records.reduce((total, row) => ({
        inputTokens: total.inputTokens + (row.inputTokens || 0),
        outputTokens: total.outputTokens + (row.outputTokens || 0),
        cachedInputTokens: (total.cachedInputTokens || 0) + (row.cachedInputTokens || 0),
        cacheWriteInputTokens: (total.cacheWriteInputTokens || 0) + (row.cacheWriteInputTokens || 0),
      }), { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 });
    }
  `);
  source = source.replaceAll('"@/lib/ai/usage"', JSON.stringify(usageModule));
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "openai.server.ts",
  }).outputText;
  return import(moduleUrl(javascript));
}

const openai = await compileOpenAiProvider();
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
