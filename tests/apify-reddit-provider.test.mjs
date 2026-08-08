import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

async function compileRedditProvider() {
  let source = await readFile(
    new URL("../lib/providers/reddit.server.ts", import.meta.url),
    "utf8",
  );
  const mockModule = moduleUrl(`
    export class MockRedditProvider {
      name = "mock-reddit";
      sourceMode = "mock";
      async discover() { return { candidates: [], searchPlan: [], sourceMode: "mock", diagnostics: { queryCount: 0, fetchedCandidates: 0, normalizedCandidates: 0, verifiedRecentCandidates: 0, rejectedByReason: {}, laneQueryCounts: {} } }; }
      async enrich() { return { conversations: [], sourceMode: "mock", diagnostics: { requested: 0, enriched: 0, failed: 0, fallbackUsed: 0 } }; }
      async search() { return { conversations: [], sourceMode: "mock" }; }
    }
  `);
  const rankingModule = moduleUrl(`
    export function contentFingerprint(value) {
      let hash = 2166136261;
      for (const character of value) {
        hash ^= character.codePointAt(0);
        hash = Math.imul(hash, 16777619);
      }
      return Math.abs(hash >>> 0).toString(16).padStart(8, "0");
    }
    export function isUsefulSearchPhrase(value) {
      const normalized = normalizeSearchText(value);
      const generic = new Set(["api", "app", "buy", "models", "pricing", "reviews", "save", "sell", "tools"]);
      const tokens = normalized.split(/\\s+/).filter(Boolean);
      return normalized.length >= 4 && tokens.length <= 10 && !tokens.every((token) => generic.has(token));
    }
    export function normalizeSearchText(value) {
      return value
        .normalize("NFKD")
        .replace(/[\\u0300-\\u036f]/g, "")
        .toLowerCase()
        .replace(/https?:\\/\\/\\S+/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/\\s+/g, " ");
    }
  `);
  const runtimeModule = moduleUrl(`
    export function isProductionRuntime(env = process.env) {
      return (env.APP_RUNTIME_ENV || env.NODE_ENV) === "production";
    }
  `);
  const replacements = {
    "@/lib/providers/mock-reddit": mockModule,
    "@/lib/intelligence/opportunity-ranking": rankingModule,
    "@/lib/server/runtime-env": runtimeModule,
  };
  for (const [specifier, replacement] of Object.entries(replacements)) {
    source = source.replaceAll(`"${specifier}"`, JSON.stringify(replacement));
  }
  const javascript = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "reddit.server.ts",
  }).outputText;
  return import(moduleUrl(javascript));
}

const redditModule = await compileRedditProvider();

const searchRequest = {
  queries: {
    productTerms: ["DemandSift", "demand intelligence software"],
    brandTerms: ["DemandSift"],
    productCategories: ["demand intelligence software"],
    customerProblems: ["find buyer intent", "too many irrelevant mentions"],
    buyerIntent: ["recommendations", "alternative"],
    competitors: ["Legacy Monitor"],
    excludedTerms: ["unrelated topic"],
    ambiguityRisks: [],
  },
  limit: 25,
};

const documentedActorItem = {
  id: "t3_abc123",
  parsedId: "abc123",
  url: "https://www.reddit.com/r/SaaS/comments/abc123/looking_for_demand_intelligence/",
  username: "public_user",
  title: "Looking for demand intelligence recommendations",
  communityName: "r/SaaS",
  parsedCommunityName: "SaaS",
  body: "How do you find buyer intent without collecting thousands of irrelevant mentions?",
  numberOfComments: 14,
  upVotes: 21,
  createdAt: "2026-08-06T12:30:00.000Z",
  dataType: "post",
  isAd: false,
  over18: false,
};

const documentedComment = {
  id: "t1_reply456",
  parsedId: "reply456",
  postId: "t3_abc123",
  parentId: "t3_abc123",
  url: "https://www.reddit.com/r/SaaS/comments/abc123/looking_for_demand_intelligence/reply456/",
  username: "helpful_user",
  body: "The useful part is separating active evaluation from broad brand mentions.",
  numberOfReplies: 2,
  upVotes: 8,
  createdAt: "2026-08-06T13:00:00.000Z",
  dataType: "comment",
};

test("builds all explicit search lanes with deterministic bounded syntax", () => {
  const plan = redditModule.buildApifyRedditSearchPlan(searchRequest);
  assert.ok(plan.length >= 5 && plan.length <= 12);
  assert.deepEqual(
    new Set(plan.map((entry) => entry.lane)),
    new Set([
      "direct_buying_intent",
      "problem_pain",
      "competitor_switching",
      "category_recommendation",
      "brand_competitor_mentions",
    ]),
  );
  assert.ok(plan.some((entry) => entry.lane === "problem_pain" && entry.query.includes("find AND buyer AND intent")));
  assert.ok(plan.some((entry) => entry.lane === "competitor_switching" && entry.query.includes("legacy monitor")));
  assert.deepEqual(redditModule.buildApifyRedditSearches(searchRequest), plan.map((entry) => entry.query));
});

test("Basecamp pain lane can search indirect customer pain without brand or category", () => {
  const plan = redditModule.buildApifyRedditSearchPlan({
    queries: {
      productTerms: ["Basecamp", "project management software"],
      brandTerms: ["Basecamp"],
      productCategories: ["project management software"],
      customerProblems: [
        "documents buried in email",
        "missing client deadlines",
        "work scattered across tools",
      ],
      buyerIntent: ["recommendations"],
      competitors: ["Asana"],
      excludedTerms: [],
      ambiguityRisks: ["mountain basecamp", "travel base camp"],
    },
    limit: 25,
  });
  const painQueries = plan.filter((entry) => entry.lane === "problem_pain").map((entry) => entry.query);
  assert.ok(painQueries.some((query) => query.includes("documents AND buried AND email")));
  assert.ok(painQueries.some((query) => query.includes("missing AND client AND deadlines")));
  assert.ok(painQueries.every((query) => !/basecamp/i.test(query)));
  assert.ok(painQueries.every((query) => !/project management software/i.test(query)));
});

test("discovery is lightweight and does not perform enrichment", async () => {
  const calls = [];
  const provider = new redditModule.ApifyRedditTestProvider({
    actorId: "trudax/reddit-scraper",
    token: "private-apify-token",
    maximumItems: 40,
    enrichmentLimit: 8,
    enrichmentComments: 6,
    timeoutMs: 20_000,
    fetchImpl: async (url, init) => {
      calls.push({ url: new URL(url), init, input: JSON.parse(init.body) });
      return new Response(JSON.stringify([documentedActorItem]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const result = await provider.discover({
    ...searchRequest,
    since: "2026-08-01T00:00:00.000Z",
  });
  assert.equal(calls.length, 1);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].externalId, "abc123");
  assert.equal(result.candidates[0].createdAt, documentedActorItem.createdAt);
  assert.equal(result.candidates[0].sourceMode, "apify-test");
  assert.equal(result.diagnostics.fetchedCandidates, 1);
  assert.equal(result.diagnostics.verifiedRecentCandidates, 1);

  const discovery = calls[0].input;
  assert.equal(calls[0].url.origin, "https://api.apify.com");
  assert.equal(calls[0].url.searchParams.has("token"), false);
  assert.equal(calls[0].init.headers.authorization, "Bearer private-apify-token");
  assert.equal(discovery.searchPosts, true);
  assert.equal(discovery.searchComments, true);
  assert.equal(discovery.skipComments, true);
  assert.equal(discovery.includeMediaLinks, false);
  assert.equal(discovery.maxComments, 0);
  assert.equal(discovery.postDateLimit, "2026-08-01T00:00:00.000Z");
  assert.deepEqual(discovery.proxy.apifyProxyGroups, ["RESIDENTIAL"]);
});

test("discovery rejects unverified timestamps instead of inventing recency", async () => {
  let calls = 0;
  const provider = new redditModule.ApifyRedditTestProvider({
    actorId: "trudax/reddit-scraper",
    token: "private-apify-token",
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify([{ ...documentedActorItem, createdAt: undefined }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const result = await provider.discover(searchRequest);
  assert.equal(calls, 1);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.diagnostics.rejectedByReason.missing_timestamp, 1);
});

test("enrichment is a separate call and returns structured speaker context", async () => {
  const calls = [];
  const provider = new redditModule.ApifyRedditTestProvider({
    actorId: "trudax/reddit-scraper",
    token: "private-apify-token",
    maximumItems: 40,
    enrichmentLimit: 8,
    enrichmentComments: 6,
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      const payload = calls.length === 1
        ? [documentedActorItem]
        : [documentedActorItem, documentedComment];
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const discovery = await provider.discover(searchRequest);
  assert.equal(calls.length, 1);
  const enrichment = await provider.enrich({ candidates: discovery.candidates, maxComments: 6 });
  assert.equal(calls.length, 2);
  assert.equal(enrichment.diagnostics.requested, 1);
  assert.equal(enrichment.diagnostics.enriched, 1);
  assert.equal(enrichment.diagnostics.failed, 0);
  const conversation = enrichment.conversations[0];
  assert.equal(conversation.structuredContext.matched.author, "public_user");
  assert.equal(conversation.structuredContext.replies.length, 1);
  assert.equal(conversation.structuredContext.replies[0].author, "helpful_user");
  assert.match(conversation.threadContext, /helpful_user/);

  const input = calls[1];
  assert.deepEqual(input.startUrls, [{ url: documentedActorItem.url }]);
  assert.equal(input.skipComments, false);
  assert.equal(input.includeMediaLinks, true);
  assert.equal(input.maxComments, 6);
  assert.equal("searches" in input, false);
});

test("enrichment only opens the candidates selected by the workflow", async () => {
  const calls = [];
  const second = {
    ...documentedActorItem,
    id: "t3_second",
    parsedId: "second",
    url: "https://www.reddit.com/r/SaaS/comments/second/another_thread/",
    title: "Another demand thread",
  };
  const provider = new redditModule.ApifyRedditTestProvider({
    actorId: "trudax/reddit-scraper",
    token: "private-apify-token",
    fetchImpl: async (_url, init) => {
      const input = JSON.parse(init.body);
      calls.push(input);
      if (calls.length === 1) {
        return new Response(JSON.stringify([documentedActorItem, second]), { status: 200 });
      }
      return new Response(JSON.stringify([documentedActorItem]), { status: 200 });
    },
  });
  const discovery = await provider.discover(searchRequest);
  assert.equal(discovery.candidates.length, 2);
  await provider.enrich({ candidates: [discovery.candidates[0]] });
  assert.deepEqual(calls[1].startUrls, [{ url: documentedActorItem.url }]);
});

test("enrichment failure is recorded and never silently promoted", async () => {
  let call = 0;
  const provider = new redditModule.ApifyRedditTestProvider({
    actorId: "trudax/reddit-scraper",
    token: "private-apify-token",
    fetchImpl: async () => {
      call += 1;
      if (call === 1) return new Response(JSON.stringify([documentedActorItem]), { status: 200 });
      return new Response("upstream failed", { status: 503 });
    },
  });
  const discovery = await provider.discover(searchRequest);
  const result = await provider.enrich({ candidates: discovery.candidates });
  assert.deepEqual(result.conversations, []);
  assert.equal(result.diagnostics.requested, 1);
  assert.equal(result.diagnostics.enriched, 0);
  assert.equal(result.diagnostics.failed, 1);
});

test("factory keeps Apify web scraping behind an explicit test-mode guard", () => {
  assert.throws(
    () => redditModule.createRedditProviderFromEnv({
      NODE_ENV: "production",
      REDDIT_PROVIDER: "apify-test",
      APIFY_REDDIT_ACTOR_ID: "trudax/reddit-scraper",
      APIFY_TOKEN: "secret",
    }),
    /test-only/i,
  );
  const provider = redditModule.createRedditProviderFromEnv({
    NODE_ENV: "production",
    REDDIT_PROVIDER: "apify-test",
    APIFY_REDDIT_TEST_MODE: "true",
    APIFY_REDDIT_ACTOR_ID: "trudax/reddit-scraper",
    APIFY_TOKEN: "secret",
  });
  assert.equal(provider.name, "apify-reddit-test");
  assert.equal(provider.sourceMode, "apify-test");
});
