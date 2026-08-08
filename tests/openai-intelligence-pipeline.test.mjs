import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

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
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
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

test("missing triage IDs are retried with only the missing records", async () => {
  const calls = [];
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = JSON.parse(body.messages[1].content);
      calls.push(user.candidates.map((row) => row.externalId));
      if (calls.length === 1) return chatResponse({ triage: [triageItem("a")] });
      return chatResponse({ triage: [triageItem("b")] });
    },
  });
  const result = await provider.triageConversations({
    business,
    candidates: [candidate("a"), candidate("b")],
    models: openai.DEFAULT_OPENAI_MODELS,
    coverageRetries: 1,
  });
  assert.deepEqual(calls, [["a", "b"], ["b"]]);
  assert.deepEqual(result.value.map((row) => row.externalId), ["a", "b"]);
  assert.equal(result.usage.inputTokens, 20);
  assert.equal(result.usage.outputTokens, 10);
});

test("persistent missing triage IDs fail explicitly instead of becoming irrelevant", async () => {
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    fetchImpl: async () => chatResponse({ triage: [triageItem("a")] }),
  });
  await assert.rejects(
    provider.triageConversations({
      business,
      candidates: [candidate("a"), candidate("b")],
      models: openai.DEFAULT_OPENAI_MODELS,
      coverageRetries: 1,
    }),
    /coverage remained incomplete.*b/i,
  );
});

test("unknown triage IDs are rejected", async () => {
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    fetchImpl: async () => chatResponse({ triage: [triageItem("unknown")] }),
  });
  await assert.rejects(
    provider.triageConversations({
      business,
      candidates: [candidate("a")],
      models: openai.DEFAULT_OPENAI_MODELS,
    }),
    /unknown externalId unknown/i,
  );
});

test("duplicate triage IDs are rejected", async () => {
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    fetchImpl: async () => chatResponse({ triage: [triageItem("a"), triageItem("a")] }),
  });
  await assert.rejects(
    provider.triageConversations({
      business,
      candidates: [candidate("a")],
      models: openai.DEFAULT_OPENAI_MODELS,
    }),
    /duplicate externalId a/i,
  );
});

test("deep qualification preserves multidimensional intelligence and reply risk separately", async () => {
  const deep = {
    externalId: "a",
    leadStatus: "potential_customer",
    demandSignals: ["pain", "switching"],
    intelligenceTags: ["problem_signal", "competitor_intelligence", "objection"],
    productFit: "high",
    painSeverity: "high",
    intent: "switching",
    timing: "current",
    evidenceQuality: "high",
    replyability: "low",
    communityRisk: "high",
    problemSummary: "Current workflow is failing",
    competitorMentioned: "Asana",
    whyItMatters: "The matched author is actively trying to replace the current workflow.",
    shouldReply: false,
    autoReplyAllowed: false,
    requiresHumanReview: true,
    replyAngle: null,
    mentionProduct: false,
    disclosureRequired: false,
  };
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    fetchImpl: async () => chatResponse({ qualifications: [deep] }),
  });
  const base = candidate("a");
  const matched = {
    externalId: base.externalId,
    kind: base.kind,
    author: base.author,
    body: base.body,
    createdAt: base.createdAt,
  };
  const result = await provider.qualifyConversations({
    business,
    conversations: [{
      ...base,
      structuredContext: {
        originalPost: matched,
        matched,
        parentChain: [],
        replies: [],
        surroundingComments: [],
      },
    }],
    models: openai.DEFAULT_OPENAI_MODELS,
  });
  assert.equal(result.value[0].qualification.leadStatus, "potential_customer");
  assert.deepEqual(result.value[0].qualification.intelligenceTags, [
    "problem_signal",
    "competitor_intelligence",
    "objection",
  ]);
  assert.equal(result.value[0].qualification.communityRisk, "high");
  assert.equal(result.value[0].qualification.shouldReply, false);
  assert.equal(result.value[0].qualification.autoReplyAllowed, false);
});
