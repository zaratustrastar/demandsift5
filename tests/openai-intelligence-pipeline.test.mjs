import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./helpers/load-ts-module.mjs";

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


test("triage splits large candidate sets into bounded provider requests", async () => {
  const calls = [];
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = JSON.parse(body.messages[1].content);
      const ids = user.candidates.map((row) => row.externalId);
      calls.push(ids);
      return chatResponse({ triage: ids.map(triageItem) });
    },
  });
  // 57 candidates at the current TRIAGE_BATCH_SIZE (25) should chunk into
  // [25, 25, 7] -- a real scan's few hundred credible candidates chunk the
  // same way, just with more full-size batches. This pins the batch size
  // itself (a deliberate speed lever: fewer, larger sequential round-trips
  // for the same total candidates -- see TRIAGE_BATCH_SIZE's doc comment in
  // openai.server.ts), not just "chunking happens".
  const candidates = Array.from({ length: 57 }, (_, index) => candidate(`batch-${index + 1}`));
  const result = await provider.triageConversations({
    business,
    candidates,
    models: openai.DEFAULT_OPENAI_MODELS,
    coverageRetries: 0,
  });

  assert.deepEqual(calls.map((ids) => ids.length), [25, 25, 7]);
  assert.deepEqual(result.value.map((row) => row.externalId), candidates.map((row) => row.externalId));
});

test("triage splits a persistently length-limited batch instead of failing the scan", async () => {
  const calls = [];
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = JSON.parse(body.messages[1].content);
      const ids = user.candidates.map((row) => row.externalId);
      calls.push(ids);
      if (ids.length > 2) {
        return new Response(JSON.stringify({
          id: "chat_exhausted",
          choices: [{ finish_reason: "length", message: { content: "" } }],
          usage: { prompt_tokens: 10, completion_tokens: body.max_tokens },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return chatResponse({ triage: ids.map(triageItem) });
    },
  });

  const candidates = [candidate("a"), candidate("b"), candidate("c"), candidate("d")];
  const result = await provider.triageConversations({
    business,
    candidates,
    models: openai.DEFAULT_OPENAI_MODELS,
    coverageRetries: 0,
  });

  assert.deepEqual(calls.map((ids) => ids.length), [4, 2, 2]);
  assert.deepEqual(result.value.map((row) => row.externalId), ["a", "b", "c", "d"]);
});

test("an empty length-limited gateway response is retried inside the AI provider", async () => {
  const maxTokens = [];
  const diagnostics = [];
  let calls = 0;
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    onDiagnostic: (event) => diagnostics.push(event),
    fetchImpl: async (_url, init) => {
      calls += 1;
      const body = JSON.parse(init.body);
      maxTokens.push(body.max_tokens);
      if (calls === 1) {
        return new Response(JSON.stringify({
          id: "chat_exhausted",
          choices: [{ finish_reason: "length", message: { content: null } }],
          usage: { prompt_tokens: 100, completion_tokens: body.max_tokens },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return chatResponse({ triage: [triageItem("a")] });
    },
  });

  const result = await provider.triageConversations({
    business,
    candidates: [candidate("a")],
    models: openai.DEFAULT_OPENAI_MODELS,
    coverageRetries: 0,
  });

  assert.deepEqual(maxTokens, [4_000, 8_000]);
  assert.equal(result.value[0].externalId, "a");
  assert.equal(result.usage.inputTokens, 110);
  assert.equal(result.usage.outputTokens, 4_005);
  assert.deepEqual(diagnostics, [{
    kind: "structured_chat_empty_retry",
    operation: "conversation_triage",
    model: openai.DEFAULT_OPENAI_MODELS.economyModel,
    finishReason: "length",
    outputTokens: 4_000,
    requestedMaxTokens: 4_000,
    retryMaxTokens: 8_000,
  }]);
});

test("temporary marketplace seller-capacity errors receive a bounded recovery window", async () => {
  let calls = 0;
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    maxRetries: 0,
    fetchImpl: async () => {
      calls += 1;
      if (calls <= 5) {
        return new Response(JSON.stringify({
          error: { message: "No available sellers for model 'gpt-5.6-sol'" },
        }), {
          status: 530,
          headers: { "content-type": "application/json", "retry-after": "0" },
        });
      }
      return chatResponse({ triage: [triageItem("a")] });
    },
  });

  const result = await provider.triageConversations({
    business,
    candidates: [candidate("a")],
    models: openai.DEFAULT_OPENAI_MODELS,
    coverageRetries: 0,
  });

  assert.equal(calls, 6);
  assert.equal(result.value[0].externalId, "a");
});

test("exhausted seller capacity falls back once to a configured compatible model", async () => {
  const requestedModels = [];
  const diagnostics = [];
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    maxRetries: 0,
    modelFallbacks: {
      [openai.DEFAULT_OPENAI_MODELS.analysisModel]: ["gpt-5.5"],
    },
    onDiagnostic: (event) => diagnostics.push(event),
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      requestedModels.push(body.model);
      if (body.model === openai.DEFAULT_OPENAI_MODELS.analysisModel) {
        return new Response(JSON.stringify({
          error: { message: `No available sellers for model '${body.model}'` },
        }), {
          status: 530,
          headers: { "content-type": "application/json", "retry-after": "0" },
        });
      }
      return chatResponse({
        demandInsights: [],
        competitorSignals: [],
      });
    },
  });

  const result = await provider.generateInsights({
    business,
    opportunities: [],
    marketIntelligence: [],
    models: openai.DEFAULT_OPENAI_MODELS,
  });

  assert.deepEqual(requestedModels, [
    ...Array(6).fill(openai.DEFAULT_OPENAI_MODELS.analysisModel),
    "gpt-5.5",
  ]);
  assert.equal(result.model, "gpt-5.5");
  assert.deepEqual(diagnostics, [{
    kind: "model_capacity_fallback",
    operation: "insight_generation",
    model: openai.DEFAULT_OPENAI_MODELS.analysisModel,
    fallbackModel: "gpt-5.5",
  }]);
});


test("a proven provider timeout falls back once to a configured compatible model", async () => {
  const requestedModels = [];
  const diagnostics = [];
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    maxRetries: 0,
    modelFallbacks: {
      [openai.DEFAULT_OPENAI_MODELS.economyModel]: ["gpt-5.5"],
    },
    onDiagnostic: (event) => diagnostics.push(event),
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      requestedModels.push(body.model);
      if (body.model === openai.DEFAULT_OPENAI_MODELS.economyModel) {
        const error = new Error("The operation was aborted due to timeout");
        error.name = "TimeoutError";
        throw error;
      }
      return chatResponse({ triage: [triageItem("a")] });
    },
  });

  const result = await provider.triageConversations({
    business,
    candidates: [candidate("a")],
    models: openai.DEFAULT_OPENAI_MODELS,
    coverageRetries: 0,
  });

  assert.deepEqual(requestedModels, [openai.DEFAULT_OPENAI_MODELS.economyModel, "gpt-5.5"]);
  assert.equal(result.model, "gpt-5.5");
  assert.deepEqual(diagnostics, [{
    kind: "model_network_timeout_fallback",
    operation: "conversation_triage",
    model: openai.DEFAULT_OPENAI_MODELS.economyModel,
    fallbackModel: "gpt-5.5",
  }]);
});

test("Surplus gets high-quality default analysis and economy fallbacks without affecting other gateways", () => {
  const surplus = openai.openAiModelFallbacksFromEnv({
    OPENAI_BASE_URL: "https://api.surplusintelligence.ai/v1",
    OPENAI_ANALYSIS_MODEL: "gpt-5.6-sol",
    OPENAI_ECONOMY_MODEL: "gpt-5.6-luna",
  });
  const direct = openai.openAiModelFallbacksFromEnv({
    OPENAI_BASE_URL: "https://api.openai.com/v1",
    OPENAI_ANALYSIS_MODEL: "gpt-5.6-sol",
    OPENAI_ECONOMY_MODEL: "gpt-5.6-luna",
  });
  assert.deepEqual(surplus, {
    "gpt-5.6-sol": ["gpt-5.5"],
    "gpt-5.6-luna": ["gpt-5.5"],
  });
  assert.deepEqual(direct, {});
});

test("ordinary upstream failures still respect the configured retry limit", async () => {
  let calls = 0;
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    maxRetries: 1,
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "generic upstream error" } }), {
        status: 500,
        headers: { "content-type": "application/json", "retry-after": "0" },
      });
    },
  });

  await assert.rejects(
    provider.triageConversations({
      business,
      candidates: [candidate("a")],
      models: openai.DEFAULT_OPENAI_MODELS,
      coverageRetries: 0,
    }),
    /generic upstream error/i,
  );
  assert.equal(calls, 2);
});

test("two length-limited empty string responses get a bounded 16000-token recovery attempt", async () => {
  const requests = [];
  const diagnostics = [];
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    onDiagnostic: (event) => diagnostics.push(event),
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push({
        maxTokens: body.max_tokens,
        system: body.messages[0].content,
      });
      if (requests.length < 3) {
        return new Response(JSON.stringify({
          id: `chat_exhausted_${requests.length}`,
          choices: [{ finish_reason: "length", message: { content: "" } }],
          usage: { prompt_tokens: 100, completion_tokens: body.max_tokens },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return chatResponse({ triage: [triageItem("a")] });
    },
  });

  const result = await provider.triageConversations({
    business,
    candidates: [candidate("a")],
    models: openai.DEFAULT_OPENAI_MODELS,
    coverageRetries: 0,
  });

  assert.deepEqual(requests.map((request) => request.maxTokens), [4_000, 8_000, 16_000]);
  assert.equal(requests[0].system.includes("Recovery attempt:"), false);
  assert.equal(requests[1].system.includes("Recovery attempt:"), false);
  assert.equal(requests[2].system.includes("Recovery attempt:"), true);
  assert.equal(result.value[0].externalId, "a");
  assert.equal(result.usage.inputTokens, 210);
  assert.equal(result.usage.outputTokens, 12_005);
  assert.deepEqual(diagnostics.map((event) => ({
    requestedMaxTokens: event.requestedMaxTokens,
    retryMaxTokens: event.retryMaxTokens,
  })), [
    { requestedMaxTokens: 4_000, retryMaxTokens: 8_000 },
    { requestedMaxTokens: 8_000, retryMaxTokens: 16_000 },
  ]);
});

test("empty structured chat responses use the configured comparable fallback model", async () => {
  const requestedModels = [];
  const diagnostics = [];
  const primaryModel = openai.DEFAULT_OPENAI_MODELS.economyModel;
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    modelFallbacks: { [primaryModel]: ["gpt-5.5"] },
    onDiagnostic: (event) => diagnostics.push(event),
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body);
      requestedModels.push(request.model);
      if (request.model === primaryModel) {
        return new Response(JSON.stringify({
          id: `chat_empty_${requestedModels.length}`,
          model: primaryModel,
          choices: [{ finish_reason: "stop", message: { content: null } }],
          usage: { prompt_tokens: 10, completion_tokens: 508 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return chatResponse({ triage: [triageItem("a")] });
    },
  });

  const result = await provider.triageConversations({
    business,
    candidates: [candidate("a")],
    models: openai.DEFAULT_OPENAI_MODELS,
    coverageRetries: 0,
  });

  assert.deepEqual(requestedModels, [primaryModel, primaryModel, primaryModel, "gpt-5.5"]);
  assert.equal(result.model, "gpt-5.5");
  assert.equal(result.value[0].externalId, "a");
  assert.deepEqual(diagnostics.map((event) => event.kind), [
    "structured_chat_empty_retry",
    "structured_chat_empty_retry",
    "model_structured_output_fallback",
  ]);
});

test("malformed structured chat JSON is retried without rerunning discovery", async () => {
  const diagnostics = [];
  let calls = 0;
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    onDiagnostic: (event) => diagnostics.push(event),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({
          id: "chat_malformed",
          choices: [{ finish_reason: "stop", message: { content: '{"triage":[' } }],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return chatResponse({ triage: [triageItem("a")] });
    },
  });

  const result = await provider.triageConversations({
    business,
    candidates: [candidate("a")],
    models: openai.DEFAULT_OPENAI_MODELS,
    coverageRetries: 0,
  });

  assert.equal(calls, 2);
  assert.equal(result.value[0].externalId, "a");
  assert.equal(result.usage.inputTokens, 20);
  assert.equal(result.usage.outputTokens, 9);
  assert.deepEqual(diagnostics, [{
    kind: "structured_chat_malformed_retry",
    operation: "conversation_triage",
    model: openai.DEFAULT_OPENAI_MODELS.economyModel,
    finishReason: "stop",
    outputTokens: 4,
    requestedMaxTokens: 4_000,
    retryMaxTokens: 4_000,
  }]);
});

test("exact string booleans from an OpenAI-compatible gateway are normalized losslessly", async () => {
  let calls = 0;
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    fetchImpl: async () => {
      calls += 1;
      return chatResponse({
        triage: [{
          ...triageItem("a"),
          relevant: "true",
          worthEnriching: "false",
        }],
      });
    },
  });

  const result = await provider.triageConversations({
    business,
    candidates: [candidate("a")],
    models: openai.DEFAULT_OPENAI_MODELS,
    coverageRetries: 0,
  });

  assert.equal(calls, 1);
  assert.equal(result.value[0].triage.relevant, true);
  assert.equal(result.value[0].triage.worthEnriching, false);
});

test("schema-invalid triage output gets a bounded structured retry", async () => {
  const diagnostics = [];
  let calls = 0;
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    onDiagnostic: (event) => diagnostics.push(event),
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) {
        return chatResponse({
          triage: [{ ...triageItem("a"), relevant: null }],
        });
      }
      return chatResponse({ triage: [triageItem("a")] });
    },
  });

  const result = await provider.triageConversations({
    business,
    candidates: [candidate("a")],
    models: openai.DEFAULT_OPENAI_MODELS,
    coverageRetries: 0,
  });

  assert.equal(calls, 2);
  assert.equal(result.value[0].triage.relevant, true);
  assert.equal(diagnostics[0].kind, "structured_chat_invalid_retry");
  assert.equal(diagnostics[0].operation, "conversation_triage");
});

test("persistent missing triage IDs fail explicitly instead of becoming irrelevant", async () => {
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const user = JSON.parse(body.messages[1].content);
      return chatResponse({
        triage: user.candidates.some((row) => row.externalId === "a")
          ? [triageItem("a")]
          : [],
      });
    },
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


test("website provenance cannot masquerade as observed customer demand", async () => {
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    fetchImpl: async () => chatResponse({
      demandInsights: [
        {
          kind: "pain",
          title: "Website-only claim",
          summary: "This must be dropped because it is not Reddit evidence.",
          implication: "No observed demand source supports it.",
          confidence: 0.9,
          provenanceIds: ["web_1"],
        },
        {
          kind: "pain",
          title: "Observed workflow pain",
          summary: "A Reddit author describes missed deadlines.",
          implication: "Answer the concrete workflow problem.",
          confidence: 0.7,
          provenanceIds: ["web_1", "source_a"],
        },
      ],
      competitorSignals: [],
    }),
  });
  const conversation = candidate("a");
  const result = await provider.generateInsights({
    business,
    opportunities: [],
    evidenceConversations: [{ externalId: "a", conversation, qualification: {} }],
    models: openai.DEFAULT_OPENAI_MODELS,
  });
  assert.equal(result.value.demandInsights.length, 1);
  assert.equal(result.value.demandInsights[0].title, "Observed workflow pain");
  assert.deepEqual(result.value.demandInsights[0].provenanceIds, ["source_a"]);
});

test("qualifyConversations: a pure transport failure (fetch itself throws) recovers via retry instead of failing the whole call", async () => {
  let attempts = 0;
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    maxRetries: 0,
    fetchImpl: async () => {
      attempts += 1;
      if (attempts <= 2) throw new Error("The operation was aborted due to timeout");
      return chatResponse({
        qualifications: [{
          externalId: "a",
          leadStatus: "potential_customer",
          demandSignals: ["pain"],
          intelligenceTags: ["problem_signal"],
          productFit: "high",
          painSeverity: "high",
          intent: "switching",
          timing: "current",
          evidenceQuality: "high",
          replyability: "low",
          communityRisk: "low",
          problemSummary: "Current workflow is failing",
          competitorMentioned: null,
          whyItMatters: "The author is actively looking to replace their workflow.",
          shouldReply: false,
          autoReplyAllowed: false,
          requiresHumanReview: true,
          replyAngle: null,
          mentionProduct: false,
          disclosureRequired: false,
        }],
      });
    },
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
      structuredContext: { originalPost: matched, matched, parentChain: [], replies: [], surroundingComments: [] },
    }],
    models: openai.DEFAULT_OPENAI_MODELS,
    coverageRetries: 2,
  });

  assert.equal(result.value.length, 1);
  assert.equal(attempts, 3, "expected exactly 2 failed attempts then 1 successful attempt");
});

test("qualifyConversations: transport failures persisting through every retry still fail the whole call", async () => {
  let attempts = 0;
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    maxRetries: 0,
    fetchImpl: async () => {
      attempts += 1;
      throw new Error("The operation was aborted due to timeout");
    },
  });
  const base = candidate("a");
  const matched = {
    externalId: base.externalId,
    kind: base.kind,
    author: base.author,
    body: base.body,
    createdAt: base.createdAt,
  };
  await assert.rejects(
    provider.qualifyConversations({
      business,
      conversations: [{
        ...base,
        structuredContext: { originalPost: matched, matched, parentChain: [], replies: [], surroundingComments: [] },
      }],
      models: openai.DEFAULT_OPENAI_MODELS,
      coverageRetries: 2,
    }),
    /OpenAI network request failed/,
  );
  assert.equal(attempts, 3);
});

test("qualifyConversations: when Surplus's own retries are exhausted, a configured directFallback provider is tried once before the whole call fails", async () => {
  let primaryAttempts = 0;
  let fallbackAttempts = 0;
  const fallback = new openai.OpenAiProvider({
    apiKey: "fallback-key",
    apiStyle: "chat",
    maxRetries: 0,
    fetchImpl: async () => {
      fallbackAttempts += 1;
      return chatResponse({
        qualifications: [{
          externalId: "a",
          leadStatus: "potential_customer",
          demandSignals: ["pain"],
          intelligenceTags: ["problem_signal"],
          productFit: "high",
          painSeverity: "high",
          intent: "switching",
          timing: "current",
          evidenceQuality: "high",
          replyability: "low",
          communityRisk: "low",
          problemSummary: "Current workflow is failing",
          competitorMentioned: null,
          whyItMatters: "The author is actively looking to replace their workflow.",
          shouldReply: false,
          autoReplyAllowed: false,
          requiresHumanReview: true,
          replyAngle: null,
          mentionProduct: false,
          disclosureRequired: false,
        }],
      });
    },
  });
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    maxRetries: 0,
    directFallback: fallback,
    fetchImpl: async () => {
      primaryAttempts += 1;
      throw new Error("The operation was aborted due to timeout");
    },
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
      structuredContext: { originalPost: matched, matched, parentChain: [], replies: [], surroundingComments: [] },
    }],
    models: openai.DEFAULT_OPENAI_MODELS,
    coverageRetries: 2,
  });

  assert.equal(result.value.length, 1);
  assert.equal(primaryAttempts, 3, "expected exactly 3 exhausted attempts against Surplus");
  assert.equal(fallbackAttempts, 1, "expected exactly one call to the direct fallback");
});

test("a duplicate answer index from analyzeVisibilityMentions is retried, not rejected on the first attempt", async () => {
  // Observed live: a fresh AI Visibility check failed immediately with
  // "OpenAI returned duplicate answer index 1 in visibility mentions."
  // parseVisibilityMentions correctly detected the bad output, but
  // isRetryableStructuredOutputError didn't recognize this message shape
  // (it only matched the similar-but-differently-worded externalId case),
  // so the call skipped the 3-attempt retry this same code path already
  // gives every other structured-output error and failed on attempt one.
  let attempts = 0;
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        // The model claims index 1 twice and never returns index 0.
        return chatResponse({
          results: [
            { index: 1, brandRecommended: true, reasoning: "first" },
            { index: 1, brandRecommended: false, reasoning: "duplicate" },
          ],
        });
      }
      return chatResponse({
        results: [
          { index: 0, brandRecommended: true, reasoning: "ok" },
          { index: 1, brandRecommended: false, reasoning: "ok" },
        ],
      });
    },
  });
  const result = await provider.analyzeVisibilityMentions({
    brandName: "Example",
    answers: [
      { index: 0, question: "best tool for X?", answerText: "Try Example." },
      { index: 1, question: "alternatives to Y?", answerText: "Example is fine." },
    ],
    models: openai.DEFAULT_OPENAI_MODELS,
    workspaceId: "ws_1",
    businessId: "biz_1",
  });
  assert.equal(attempts, 2, "expected the bad first attempt to be retried, not thrown immediately");
  assert.deepEqual(
    result.value.map((row) => row.index).sort(),
    [0, 1],
  );
});

test("an unknown answer index from analyzeVisibilityMentions is also retried", async () => {
  let attempts = 0;
  const provider = new openai.OpenAiProvider({
    apiKey: "test-key",
    apiStyle: "chat",
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) {
        return chatResponse({ results: [{ index: 7, brandRecommended: true, reasoning: "wrong index" }] });
      }
      return chatResponse({ results: [{ index: 0, brandRecommended: true, reasoning: "ok" }] });
    },
  });
  const result = await provider.analyzeVisibilityMentions({
    brandName: "Example",
    answers: [{ index: 0, question: "best tool for X?", answerText: "Try Example." }],
    models: openai.DEFAULT_OPENAI_MODELS,
    workspaceId: "ws_1",
    businessId: "biz_1",
  });
  assert.equal(attempts, 2, "expected the unknown-index attempt to be retried, not thrown immediately");
  assert.equal(result.value[0].index, 0);
});
