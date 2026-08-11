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
    jobsToBeDone: ["identify buyers ready to evaluate", "separate demand from noise"],
    workarounds: ["manual Reddit searches", "spreadsheets"],
    triggerEvents: ["launching a new SaaS product"],
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

test("builds an eight-query seven-signal demand plan", () => {
  const plan = redditModule.buildApifyRedditSearchPlan(searchRequest);

  assert.equal(plan.length, 8);

  const counts = Object.fromEntries(
    [
      "direct_buying_intent",
      "problem_pain",
      "competitor_switching",
      "category_recommendation",
      "brand_competitor_mentions",
      "workaround",
      "timing",
    ]
      .map((lane) => [lane, plan.filter((entry) => entry.lane === lane).length]),
  );

  assert.deepEqual(counts, {
    direct_buying_intent: 1,
    problem_pain: 2,
    competitor_switching: 1,
    category_recommendation: 1,
    brand_competitor_mentions: 1,
    workaround: 1,
    timing: 1,
  });

  assert.ok(
    plan.some(
      (entry) =>
        entry.lane === "problem_pain" &&
        entry.query.includes("find intent"),
    ),
  );

  assert.ok(
    plan.every((entry) => !/[()]/.test(entry.query) && !/\b(?:AND|OR)\b/.test(entry.query)),
    "Trudax searches should use plain keyword phrases, not Reddit Boolean syntax",
  );

  assert.ok(
    plan.some(
      (entry) =>
        entry.lane === "competitor_switching" &&
        /legacy monitor/i.test(entry.query),
    ),
    JSON.stringify(plan),
  );

  assert.deepEqual(
    redditModule.buildApifyRedditSearches(searchRequest),
    plan.map((entry) => entry.query),
  );
});

test("Basecamp demand plan searches indirect pain and redistributes only from evidence-backed pools", () => {
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
      jobsToBeDone: [
        "keep client projects organized",
        "coordinate tasks files and deadlines",
      ],
      workarounds: [
        "email threads",
        "spreadsheets",
      ],
      triggerEvents: [
        "team growth creates coordination overhead",
      ],
      buyerIntent: ["recommendations"],
      competitors: ["Asana"],
      excludedTerms: [],
      ambiguityRisks: ["mountain basecamp", "travel base camp"],
    },
    limit: 25,
  });

  assert.equal(plan.length, 8);

  const painQueries = plan
    .filter((entry) => entry.lane === "problem_pain")
    .map((entry) => entry.query);

  assert.ok(
    painQueries.some((query) =>
      query.includes("documents email"),
    ),
  );

  assert.ok(
    painQueries.some((query) =>
      query.includes("client deadlines"),
    ),
    JSON.stringify(plan),
  );

  assert.ok(painQueries.every((query) => !/basecamp/i.test(query)));
  assert.ok(
    painQueries.every((query) => !/project management software/i.test(query)),
  );

  assert.equal(
    plan.filter((entry) => entry.lane === "workaround").length,
    1,
  );

  assert.equal(
    plan.filter((entry) => entry.lane === "competitor_switching").length,
    1,
  );

  assert.equal(
    plan.filter((entry) => entry.lane === "category_recommendation").length,
    1,
  );

  assert.equal(
    plan.filter((entry) => entry.lane === "brand_competitor_mentions").length,
    1,
  );

  assert.equal(
    plan.filter((entry) => entry.lane === "timing").length,
    1,
  );
});

test("discovery is lightweight and does not perform enrichment", async () => {
  const calls = [];
  const unrelatedActorItem = {
    ...documentedActorItem,
    id: "t3_noise123",
    parsedId: "noise123",
    url: "https://www.reddit.com/r/shortstories/comments/noise123/a_story_about_a_mountain/",
    title: "A story about a mountain",
    body: "I wrote a short story about a mountain trail and would appreciate feedback.",
    communityName: "r/shortstories",
    parsedCommunityName: "shortstories",
  };
  const competitorMentionOnly = {
    ...documentedActorItem,
    id: "t3_mention123",
    parsedId: "mention123",
    url: "https://www.reddit.com/r/SaaS/comments/mention123/legacy_monitor_release_notes/",
    title: "Legacy Monitor release notes",
    body: "Here is a neutral summary of the latest Legacy Monitor feature release.",
  };
  const competitorSwitchingItem = {
    ...documentedActorItem,
    id: "t3_switch123",
    parsedId: "switch123",
    url: "https://www.reddit.com/r/SaaS/comments/switch123/legacy_monitor_alternative/",
    title: "Looking for a Legacy Monitor alternative",
    body: "We need to replace Legacy Monitor because it has become overkill for our workflow.",
  };

  const provider = new redditModule.ApifyRedditTestProvider({
    actorId: "trudax/reddit-scraper",
    token: "private-apify-token",
    maximumItems: 40,
    enrichmentLimit: 8,
    enrichmentComments: 6,
    timeoutMs: 20_000,
    fetchImpl: async (url, init = {}) => {
      const parsedUrl = new URL(url);
      const input = init.body ? JSON.parse(init.body) : null;
      calls.push({ url: parsedUrl, init, input });

      if (parsedUrl.pathname.includes("/actors/") && parsedUrl.pathname.endsWith("/runs")) {
        return new Response(JSON.stringify({
          data: {
            id: "run-discovery",
            status: "SUCCEEDED",
            defaultDatasetId: "dataset-discovery",
          },
        }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }

      if (parsedUrl.pathname.includes("/datasets/dataset-discovery/items")) {
        return new Response(JSON.stringify([
          documentedActorItem,
          unrelatedActorItem,
          competitorMentionOnly,
          competitorSwitchingItem,
        ]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      throw new Error(`Unexpected mocked Apify URL: ${parsedUrl}`);
    },
  });

  const result = await provider.discover({
    ...searchRequest,
    since: new Date(Date.now() - (6 * 86_400_000)).toISOString(),
  });

  assert.equal(calls.length, 2);
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates[0].externalId, "abc123");
  assert.equal(result.candidates[0].createdAt, documentedActorItem.createdAt);
  assert.equal(result.candidates[0].sourceMode, "apify-test");
  assert.equal(result.candidates[1].externalId, "switch123");
  assert.deepEqual(
    new Set(result.candidates[1].discoveryLanes),
    new Set(["competitor_switching", "brand_competitor_mentions"]),
  );
  assert.equal(result.diagnostics.fetchedCandidates, 4);
  assert.equal(result.diagnostics.verifiedRecentCandidates, 2);
  assert.equal(result.diagnostics.rejectedByReason.query_mismatch, 2);

  const startCall = calls[0];
  const discovery = startCall.input;

  assert.equal(startCall.url.origin, "https://api.apify.com");
  assert.equal(startCall.url.searchParams.has("token"), false);
  assert.equal(startCall.init.method, "POST");
  assert.equal(startCall.init.headers.authorization, "Bearer private-apify-token");

  assert.equal(discovery.searchPosts, true);
  assert.equal(discovery.searchComments, false);
  assert.equal(discovery.skipComments, true);
  assert.equal(discovery.includeMediaLinks, false);
  assert.equal(discovery.maxComments, 0);
  assert.equal(discovery.time, "week");
  assert.equal(Object.hasOwn(discovery, "postDateLimit"), false);
  assert.equal(Object.hasOwn(discovery, "commentDateLimit"), false);
  assert.deepEqual(discovery.proxy.apifyProxyGroups, ["RESIDENTIAL"]);

  assert.equal(calls[1].init.method, "GET");
  assert.match(calls[1].url.pathname, /\/datasets\/dataset-discovery\/items$/);
});

test("discovery rejects unverified timestamps instead of inventing recency", async () => {
  const calls = [];

  const provider = new redditModule.ApifyRedditTestProvider({
    actorId: "trudax/reddit-scraper",
    token: "private-apify-token",
    fetchImpl: async (url, init = {}) => {
      const parsedUrl = new URL(url);
      calls.push({ url: parsedUrl, init });

      if (parsedUrl.pathname.includes("/actors/") && parsedUrl.pathname.endsWith("/runs")) {
        return new Response(JSON.stringify({
          data: {
            id: "run-missing-time",
            status: "SUCCEEDED",
            defaultDatasetId: "dataset-missing-time",
          },
        }), { status: 201 });
      }

      if (parsedUrl.pathname.includes("/datasets/dataset-missing-time/items")) {
        return new Response(JSON.stringify([
          { ...documentedActorItem, createdAt: undefined },
        ]), { status: 200 });
      }

      throw new Error(`Unexpected mocked Apify URL: ${parsedUrl}`);
    },
  });

  const result = await provider.discover(searchRequest);

  assert.equal(calls.length, 2);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.diagnostics.rejectedByReason.missing_timestamp, 1);
});

test("enrichment is a separate call and returns structured speaker context", async () => {
  const calls = [];
  let actorRun = 0;

  const provider = new redditModule.ApifyRedditTestProvider({
    actorId: "trudax/reddit-scraper",
    token: "private-apify-token",
    maximumItems: 40,
    enrichmentLimit: 8,
    enrichmentComments: 6,
    fetchImpl: async (url, init = {}) => {
      const parsedUrl = new URL(url);
      const input = init.body ? JSON.parse(init.body) : null;
      calls.push({ url: parsedUrl, init, input });

      if (parsedUrl.pathname.includes("/actors/") && parsedUrl.pathname.endsWith("/runs")) {
        actorRun += 1;

        return new Response(JSON.stringify({
          data: {
            id: actorRun === 1 ? "run-discovery" : "run-enrichment",
            status: "SUCCEEDED",
            defaultDatasetId: actorRun === 1
              ? "dataset-discovery"
              : "dataset-enrichment",
          },
        }), { status: 201 });
      }

      if (parsedUrl.pathname.includes("/datasets/dataset-discovery/items")) {
        return new Response(JSON.stringify([documentedActorItem]), {
          status: 200,
        });
      }

      if (parsedUrl.pathname.includes("/datasets/dataset-enrichment/items")) {
        return new Response(JSON.stringify([
          documentedActorItem,
          documentedComment,
        ]), {
          status: 200,
        });
      }

      throw new Error(`Unexpected mocked Apify URL: ${parsedUrl}`);
    },
  });

  const discovery = await provider.discover(searchRequest);

  assert.equal(calls.length, 2);

  const enrichment = await provider.enrich({
    candidates: discovery.candidates,
    maxComments: 6,
  });

  assert.equal(calls.length, 4);
  assert.equal(enrichment.diagnostics.requested, 1);
  assert.equal(enrichment.diagnostics.enriched, 1);
  assert.equal(enrichment.diagnostics.failed, 0);

  const conversation = enrichment.conversations[0];
  assert.equal(conversation.structuredContext.matched.author, "public_user");
  assert.equal(conversation.structuredContext.replies.length, 1);
  assert.equal(conversation.structuredContext.replies[0].author, "helpful_user");
  assert.match(conversation.threadContext, /helpful_user/);

  const enrichmentStart = calls[2];
  const input = enrichmentStart.input;

  assert.deepEqual(input.startUrls, [{ url: documentedActorItem.url }]);
  assert.equal(input.skipComments, false);
  assert.equal(input.includeMediaLinks, true);
  assert.equal(input.maxItems, redditModule.APIFY_REDDIT_ENRICHMENT_MIN_ITEMS);
  assert.equal(input.maxComments, 6);
  assert.equal(input.maxPostCount, 1);
  assert.equal("searches" in input, false);
  assert.equal(conversation.externalId, discovery.candidates[0].externalId);
  assert.equal(conversation.permalink, discovery.candidates[0].permalink);
});

test("startUrls enrichment never falls below the Trudax Actor minimum", async () => {
  const calls = [];
  const provider = new redditModule.ApifyRedditTestProvider({
    actorId: "trudax/reddit-scraper-lite",
    token: "private-apify-token",
    enrichmentComments: 0,
    fetchImpl: async (url, init = {}) => {
      const parsedUrl = new URL(url);
      const input = init.body ? JSON.parse(init.body) : null;
      calls.push({ url: parsedUrl, input });

      if (parsedUrl.pathname.includes("/actors/") && parsedUrl.pathname.endsWith("/runs")) {
        return new Response(JSON.stringify({
          data: {
            id: "run-enrichment-minimum",
            status: "SUCCEEDED",
            defaultDatasetId: "dataset-enrichment-minimum",
          },
        }), { status: 201 });
      }

      if (parsedUrl.pathname.includes("/datasets/dataset-enrichment-minimum/items")) {
        return new Response(JSON.stringify([documentedActorItem]), { status: 200 });
      }

      throw new Error(`Unexpected mocked Apify URL: ${parsedUrl}`);
    },
  });

  await provider.enrich({
    candidates: [{
      externalId: "abc123",
      kind: "post",
      subreddit: "SaaS",
      title: "Looking for demand intelligence",
      body: "What do people recommend?",
      author: "public_user",
      permalink: documentedActorItem.url,
      createdAt: "2026-08-05T10:00:00.000Z",
      score: 14,
      comments: 3,
      queryLane: "explicit_demand",
      query: "demand intelligence recommendations",
      sourceId: "apify:trudax/reddit-scraper-lite",
      provenance: {
        sourceType: "reddit",
        sourceUrl: documentedActorItem.url,
        retrievedAt: "2026-08-05T10:05:00.000Z",
        sourceId: "apify:trudax/reddit-scraper-lite",
      },
    }],
    maxComments: 0,
  });

  const start = calls[0];
  assert.equal(start.input.maxItems, redditModule.APIFY_REDDIT_ENRICHMENT_MIN_ITEMS);
  assert.equal(start.url.searchParams.get("maxItems"), String(redditModule.APIFY_REDDIT_ENRICHMENT_MIN_ITEMS));
  assert.equal(start.input.maxPostCount, 1);
  assert.equal(start.input.maxComments, 0);
  assert.deepEqual(start.input.startUrls, [{ url: documentedActorItem.url }]);
  assert.equal("searches" in start.input, false);
});

test("enrichment only opens the candidates selected by the workflow", async () => {
  const calls = [];
  let actorRun = 0;

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
    fetchImpl: async (url, init = {}) => {
      const parsedUrl = new URL(url);
      const input = init.body ? JSON.parse(init.body) : null;
      calls.push({ url: parsedUrl, init, input });

      if (parsedUrl.pathname.includes("/actors/") && parsedUrl.pathname.endsWith("/runs")) {
        actorRun += 1;

        return new Response(JSON.stringify({
          data: {
            id: actorRun === 1 ? "run-discovery" : "run-enrichment",
            status: "SUCCEEDED",
            defaultDatasetId: actorRun === 1
              ? "dataset-discovery"
              : "dataset-enrichment",
          },
        }), { status: 201 });
      }

      if (parsedUrl.pathname.includes("/datasets/dataset-discovery/items")) {
        return new Response(JSON.stringify([
          documentedActorItem,
          second,
        ]), { status: 200 });
      }

      if (parsedUrl.pathname.includes("/datasets/dataset-enrichment/items")) {
        return new Response(JSON.stringify([
          documentedActorItem,
        ]), { status: 200 });
      }

      throw new Error(`Unexpected mocked Apify URL: ${parsedUrl}`);
    },
  });

  const discovery = await provider.discover(searchRequest);

  assert.equal(discovery.candidates.length, 2);

  await provider.enrich({
    candidates: [discovery.candidates[0]],
  });

  const enrichmentStart = calls[2];
  assert.deepEqual(
    enrichmentStart.input.startUrls,
    [{ url: documentedActorItem.url }],
  );
});

test("enrichment failure is recorded and never silently promoted", async () => {
  let actorRun = 0;

  const provider = new redditModule.ApifyRedditTestProvider({
    actorId: "trudax/reddit-scraper",
    token: "private-apify-token",
    fetchImpl: async (url) => {
      const parsedUrl = new URL(url);

      if (parsedUrl.pathname.includes("/actors/") && parsedUrl.pathname.endsWith("/runs")) {
        actorRun += 1;

        if (actorRun === 1) {
          return new Response(JSON.stringify({
            data: {
              id: "run-discovery",
              status: "SUCCEEDED",
              defaultDatasetId: "dataset-discovery",
            },
          }), { status: 201 });
        }

        return new Response("upstream failed", { status: 503 });
      }

      if (parsedUrl.pathname.includes("/datasets/dataset-discovery/items")) {
        return new Response(JSON.stringify([
          documentedActorItem,
        ]), { status: 200 });
      }

      throw new Error(`Unexpected mocked Apify URL: ${parsedUrl}`);
    },
  });

  const discovery = await provider.discover(searchRequest);

  const result = await provider.enrich({
    candidates: discovery.candidates,
  });

  assert.deepEqual(result.conversations, []);
  assert.equal(result.diagnostics.requested, 1);
  assert.equal(result.diagnostics.enriched, 0);
  assert.equal(result.diagnostics.failed, 1);
});

test("controlled live enrichment probe opens and maps one selected thread", {
  skip: process.env.APIFY_LIVE_ENRICHMENT_PROBE !== "true",
  timeout: 480_000,
}, async () => {
  const token = process.env.APIFY_TOKEN?.trim();
  assert.ok(token, "APIFY_TOKEN is required when the live probe is enabled");

  const selectedUrl = "https://www.reddit.com/r/smallbusinessuk/comments/1vk6db7/apps_for_efficient_team_work/";
  const trace = {
    input: null,
    runId: "",
    datasetId: "",
    statuses: [],
    datasetItems: 0,
  };

  const provider = new redditModule.ApifyRedditTestProvider({
    actorId: "trudax/reddit-scraper-lite",
    token,
    enrichmentLimit: 1,
    enrichmentComments: 6,
    fetchImpl: async (url, init = {}) => {
      const parsedUrl = new URL(url);
      if (
        init.method === "POST" &&
        parsedUrl.pathname.includes("/actors/") &&
        parsedUrl.pathname.endsWith("/runs")
      ) {
        trace.input = JSON.parse(init.body);
      }

      const response = await fetch(url, init);
      if (
        parsedUrl.pathname.includes("/actors/") ||
        parsedUrl.pathname.includes("/actor-runs/")
      ) {
        const payload = await response.clone().json().catch(() => null);
        if (payload?.data) {
          trace.runId = payload.data.id || trace.runId;
          trace.datasetId = payload.data.defaultDatasetId || trace.datasetId;
          if (payload.data.status) trace.statuses.push(payload.data.status);
        }
      }
      if (parsedUrl.pathname.includes("/datasets/") && response.ok) {
        const payload = await response.clone().json().catch(() => null);
        if (Array.isArray(payload)) trace.datasetItems = payload.length;
      }
      return response;
    },
  });

  const result = await provider.enrich({
    candidates: [{
      provider: "apify-test",
      sourceMode: "apify-test",
      externalId: "1vk6db7",
      kind: "post",
      subreddit: "smallbusinessuk",
      title: "Apps for efficient team work",
      body: "Apps for efficient team work",
      permalink: selectedUrl,
      createdAt: "2026-08-10T00:00:00.000Z",
      metrics: { score: 0, comments: 0 },
      matchedQuery: "apps for efficient team work",
      matchedQueries: ["apps for efficient team work"],
      discoveryLanes: ["explicit_demand"],
      provenance: {
        id: "reddit_apify_live_probe_1vk6db7",
        kind: "reddit",
        provider: "apify-test",
        providerExternalId: "1vk6db7",
        url: selectedUrl,
        title: "Apps for efficient team work",
        excerpt: "Apps for efficient team work",
        contentHash: "live-probe-1vk6db7",
        observedAt: "2026-08-10T00:00:00.000Z",
        isMock: false,
        metadata: { testOnly: true },
      },
    }],
    maxComments: 6,
  });

  assert.equal(trace.input.maxItems, redditModule.APIFY_REDDIT_ENRICHMENT_MIN_ITEMS);
  assert.equal(trace.input.maxPostCount, 1);
  assert.equal(trace.input.maxComments, 6);
  assert.deepEqual(trace.input.startUrls, [{ url: selectedUrl }]);
  assert.equal("searches" in trace.input, false);
  assert.ok(trace.runId, "Actor run metadata should include a run id");
  assert.ok(trace.datasetId, "Actor run metadata should include a dataset id");
  assert.equal(trace.statuses.at(-1), "SUCCEEDED");
  assert.ok(trace.datasetItems > 0, "Actor dataset should contain usable records");
  assert.equal(result.diagnostics.enriched, 1);
  assert.equal(result.diagnostics.failed, 0);
  assert.equal(result.conversations.length, 1);
  assert.equal(result.conversations[0].externalId, "1vk6db7");
  assert.equal(result.conversations[0].permalink, selectedUrl);
  assert.ok(result.conversations[0].body);
  assert.ok(result.conversations[0].structuredContext.matched.body);

  console.log("LIVE_APIFY_ENRICHMENT_PROBE", JSON.stringify({
    runId: trace.runId,
    status: trace.statuses.at(-1),
    datasetId: trace.datasetId,
    datasetItems: trace.datasetItems,
    parsedConversations: result.conversations.length,
    matchedExternalId: result.conversations[0].externalId,
    replies: result.conversations[0].structuredContext.replies.length,
  }));
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
