import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./helpers/load-ts-module.mjs";

const directAi = await loadTsModule("lib/server/ai.ts");
const providerModule = await loadTsModule("lib/providers/openai.server.ts");

test("a compatible non-OpenAI gateway uses the basic chat payload for website analysis", async () => {
  const previous = {
    key: process.env.OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL,
    apiStyle: process.env.OPENAI_API_STYLE,
    model: process.env.OPENAI_ANALYSIS_MODEL,
  };
  const originalFetch = globalThis.fetch;
  let request;
  process.env.OPENAI_API_KEY = "gateway-key";
  process.env.OPENAI_BASE_URL = "https://api.surplusintelligence.ai/v1";
  delete process.env.OPENAI_API_STYLE;
  process.env.OPENAI_ANALYSIS_MODEL = "gpt-5.6-sol";
  globalThis.fetch = async (url, init) => {
    request = { url: String(url), body: JSON.parse(init.body) };
    return new Response(JSON.stringify({
      id: "chat_test",
      choices: [{
        message: {
          content: JSON.stringify({
            name: "Acme",
            summary: "Acme routes AI requests to lower-cost capacity.",
            productCategory: "AI model routing software",
            customerProblemQueries: ["AI inference costs too high"],
            targetAudience: ["AI application teams"],
            problemsSolved: ["Reduce AI inference cost"],
            features: ["Model routing"],
            competitors: [],
            irrelevantTopics: ["retail resale"],
          }),
        },
      }],
      usage: { prompt_tokens: 100, completion_tokens: 40 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const result = await directAi.analyzeWebsiteWithOpenAi("https://acme.example", [{
      url: "https://acme.example",
      title: "Acme",
      text: "Acme routes AI requests to lower-cost capacity.",
      sourceId: "website:1",
    }]);
    assert.equal(result.profile.name, "Acme");
    assert.equal(result.discovery.productCategory, "AI model routing software");
    assert.deepEqual(result.discovery.customerProblemQueries, ["AI inference costs too high"]);
    assert.equal(result.usage.inputTokens, 100);
    assert.equal(request.url, "https://api.surplusintelligence.ai/v1/chat/completions");
    assert.equal(request.body.model, "gpt-5.6-sol");
    assert.ok(Array.isArray(request.body.messages));
    assert.equal(request.body.text, undefined);
    assert.equal(request.body.reasoning, undefined);
    assert.equal(request.body.store, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous.key === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous.key;
    if (previous.baseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = previous.baseUrl;
    if (previous.apiStyle === undefined) delete process.env.OPENAI_API_STYLE;
    else process.env.OPENAI_API_STYLE = previous.apiStyle;
    if (previous.model === undefined) delete process.env.OPENAI_ANALYSIS_MODEL;
    else process.env.OPENAI_ANALYSIS_MODEL = previous.model;
  }
});

test("conversation classification uses chat JSON on compatible gateways", async () => {
  let request;
  const provider = new providerModule.OpenAiProvider({
    apiKey: "gateway-key",
    baseUrl: "https://api.surplusintelligence.ai/v1",
    fetchImpl: async (url, init) => {
      request = { url: String(url), body: JSON.parse(init.body) };
      return new Response(JSON.stringify({
        id: "chat_classify",
        choices: [{ message: { content: JSON.stringify({
          classifications: [{
            externalId: "reddit-1",
            relevance: 0.9,
            buyerIntent: 0.8,
            customerProblem: 0.7,
            competitorComplaint: 0,
            semanticSimilarity: 0.75,
            recommendedAction: "reply_helpfully",
            communityRisk: "low",
            problemSummary: "Needs a lower-cost AI routing option",
            competitorMentioned: null,
            rationale: ["Explicit cost and routing need"],
          }],
        }) } }],
        usage: { prompt_tokens: 200, completion_tokens: 80 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await provider.classifyConversations({
    business: {
      workspaceId: "workspace-1",
      businessId: "business-1",
      problemsSolved: { value: ["lower inference cost"] },
    },
    conversations: [{
      externalId: "reddit-1",
      sourceMode: "apify-test",
      subreddit: "LocalLLaMA",
      title: "Lower model costs",
      body: "What router should I use?",
      metrics: { score: 4, comments: 2 },
    }],
    models: {
      analysisModel: "gpt-5.6-sol",
      economyModel: "gpt-5.6-sol",
      embeddingModel: "venice-embed-1",
    },
  });
  assert.equal(result.value.length, 1);
  assert.equal(result.value[0].classification.recommendedAction, "reply_helpfully");
  assert.equal(request.url, "https://api.surplusintelligence.ai/v1/chat/completions");
  assert.equal(request.body.max_tokens, 5000);
  assert.equal(request.body.response_format, undefined);
});
