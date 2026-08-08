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
    productTerms: ["DemandSift"],
    productCategories: ["demand intelligence software"],
    customerProblems: ["find buyer intent", "too many irrelevant mentions"],
    buyerIntent: ["recommendations", "alternative"],
    competitors: ["Legacy Monitor"],
    excludedTerms: ["Reddit monitoring"],
  },
  limit: 20,
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

const lightweightActorItem = {
  ...documentedActorItem,
  body: "How do you find buyer intent without collecting thousands of irrelevant mentions? &amp; what would you recommend? submitted by /u/public_user [link] [comments]",
  createdAt: undefined,
};

const documentedComment = {
  id: "t1_reply456",
  parsedId: "reply456",
  parentId: "t3_abc123",
  url: "https://www.reddit.com/r/SaaS/comments/abc123/looking_for_demand_intelligence/reply456/",
  username: "helpful_user",
  body: "The useful part is separating active evaluation from broad brand mentions.",
  numberOfReplies: 2,
  upVotes: 8,
  createdAt: "2026-08-06T13:00:00.000Z",
  dataType: "comment",
};

test("builds a bounded demand-oriented Apify search set", () => {
  const searches = redditModule.buildApifyRedditSearches(searchRequest);
  assert.ok(searches.length > 0 && searches.length <= 8);
  assert.ok(searches.some((query) => query.startsWith('"demand intelligence software" AND')));
  assert.ok(searches.some((query) => query.startsWith("demandsift AND")));
  assert.ok(searches.some((query) => query.includes("find AND buyer AND intent")));
  assert.ok(searches.some((query) => query.includes("legacy monitor") && query.includes("alternative")));
  assert.ok(searches.every((query) => query.includes('NOT ("reddit monitoring")')));
});

test("turns Basecamp-style website evidence into concise buyer searches", () => {
  const searches = redditModule.buildApifyRedditSearches({
    queries: {
      productTerms: [
        "Basecamp",
        "Project pages with customizable built-in tools",
        "To-do lists, subtasks, assignments, due dates, and Hill Charts",
      ],
      productCategories: ["project management software"],
      customerProblems: [
        "projects scattered across too many tools",
        "can't track project deadlines",
        "Work scattered across separate apps, emails, chats, and browser tabs",
      ],
      buyerIntent: ["recommendations", "alternative"],
      competitors: ["Slack", "WhatsApp"],
      excludedTerms: [],
    },
    limit: 20,
  });

  assert.deepEqual(searches, [
    '"project management software" AND (recommendations OR recommend OR alternative OR options)',
    '"project management software" AND ("looking for" OR "need a" OR "what are you using" OR "which tool")',
    "basecamp AND (alternative OR switching OR frustrated OR problem OR issue OR notifications)",
    'basecamp AND "project management software"',
    "(projects AND scattered AND many AND tools) AND (tool OR software OR solution OR help)",
    "(can AND track AND project AND deadlines) AND (tool OR software OR solution OR help)",
    'slack AND (alternative OR switching OR frustrated OR problem) AND "project management software"',
    'whatsapp AND (alternative OR switching OR frustrated OR problem) AND "project management software"',
  ]);
  assert.equal(searches.some((term) => term.includes("customizable built-in tools")), false);
  assert.equal(searches.some((term) => term.includes("separate apps, emails")), false);
});

test("does not search broad navigation and marketplace words", () => {
  const searches = redditModule.buildApifyRedditSearches({
    queries: {
      productTerms: ["Surplus Intelligence", "Models", "Buy", "Sell"],
      productCategories: ["AI inference marketplace"],
      customerProblems: ["Save", "API", "lower inference costs"],
      buyerIntent: ["recommendations"],
      competitors: [],
      excludedTerms: [],
    },
    limit: 20,
  });
  assert.equal(searches[0].startsWith('"ai inference marketplace" AND'), true);
  assert.equal(searches.some((query) => query.startsWith('"surplus intelligence" AND')), true);
  for (const generic of ["Models", "Buy", "Sell", "Save", "API"]) {
    assert.equal(searches.includes(generic), false);
  }
});

test("normalizes documented actor items and preserves test provenance", () => {
  const conversation = redditModule.normalizeApifyRedditItem(
    documentedActorItem,
    "oAuCIx3ItNrs2okjQ",
    ["buyer intent"],
  );
  assert.ok(conversation);
  assert.equal(conversation.sourceMode, "apify-test");
  assert.equal(conversation.kind, "post");
  assert.equal(conversation.subreddit, "SaaS");
  assert.equal(conversation.externalId, "abc123");
  assert.equal(conversation.metrics.comments, 14);
  assert.equal(conversation.provenance.isMock, false);
  assert.equal(conversation.provenance.metadata.testOnly, true);
  assert.equal(conversation.provenance.metadata.acquisitionMethod, "web-scraping");

  const cleaned = redditModule.normalizeApifyRedditItem(
    { ...documentedActorItem, body: lightweightActorItem.body },
    "trudax/reddit-scraper",
  );
  assert.equal(cleaned.body.includes("&amp;"), false);
  assert.equal(cleaned.body.includes("submitted by"), false);

  assert.equal(
    redditModule.normalizeApifyRedditItem(
      { ...documentedActorItem, id: "adult", parsedId: "adult", over18: true },
      "oAuCIx3ItNrs2okjQ",
    ),
    null,
  );
  assert.equal(
    redditModule.normalizeApifyRedditItem(
      { ...documentedActorItem, dataType: "community" },
      "oAuCIx3ItNrs2okjQ",
    ),
    null,
  );
  assert.equal(
    redditModule.normalizeApifyRedditItem(
      { ...documentedActorItem, id: "bot", parsedId: "bot", username: "AutoModerator" },
      "oAuCIx3ItNrs2okjQ",
    ),
    null,
  );
});

test("rejects Basecamp homonyms before paid enrichment but keeps real product demand", () => {
  const request = {
    queries: {
      productTerms: ["Basecamp"],
      productCategories: ["project management software"],
      customerProblems: ["work scattered across too many apps", "missed project deadlines"],
      buyerIntent: ["recommendations", "alternative"],
      competitors: ["Slack"],
      excludedTerms: [],
    },
    limit: 20,
  };
  assert.equal(
    redditModule.isApifyCandidateRelevant(
      { title: "Dusy Basin Basecamp", body: "Taken from basecamp on the Thunderbolt traverse." },
      request,
    ),
    false,
  );
  assert.equal(
    redditModule.isApifyCandidateRelevant(
      {
        title: "Project management software for children's books?",
        body: "I need a project management tool to share files and comments with my illustrator.",
      },
      request,
    ),
    true,
  );
  assert.equal(
    redditModule.isApifyCandidateRelevant(
      {
        title: "Basecamp notifications are breaking my workflow",
        body: "How can I stop the notifications without moving the workflow back to Slack?",
      },
      request,
    ),
    true,
  );
});

test("calls only the fixed Apify API origin and keeps the token out of the URL", async () => {
  const calls = [];
  const provider = new redditModule.ApifyRedditTestProvider({
    actorId: "trudax/reddit-scraper",
    token: "private-apify-token",
    maximumItems: 40,
    enrichmentLimit: 8,
    enrichmentComments: 6,
    timeoutMs: 20_000,
    fetchImpl: async (url, init) => {
      const call = { url: new URL(url), init, input: JSON.parse(init.body) };
      calls.push(call);
      const payload = calls.length === 1
        ? [lightweightActorItem]
        : [documentedActorItem, documentedComment];
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const result = await provider.search({
    ...searchRequest,
    since: "2026-08-01T00:00:00.000Z",
  });
  assert.equal(result.sourceMode, "apify-test");
  assert.equal(result.conversations.length, 1);
  assert.equal(result.conversations[0].createdAt, documentedActorItem.createdAt);
  assert.match(result.conversations[0].threadContext, /separating active evaluation/);
  assert.equal(result.conversations[0].body.includes("&amp;"), false);
  assert.equal(result.diagnostics.fetchedCandidates, 1);
  assert.equal(result.diagnostics.normalizedCandidates, 1);
  assert.equal(result.diagnostics.locallyMatchedCandidates, 1);
  assert.equal(result.diagnostics.enrichmentAttempts, 1);
  assert.equal(result.diagnostics.enrichedConversations, 1);
  assert.equal(result.diagnostics.verifiedRecentConversations, 1);
  assert.equal(result.diagnostics.missingVerifiedTimestamps, 0);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url.origin, "https://api.apify.com");
    assert.equal(call.url.pathname.includes("trudax~reddit-scraper"), true);
    assert.equal(call.url.searchParams.has("token"), false);
    assert.equal(call.init.headers.authorization, "Bearer private-apify-token");
  }
  const discovery = calls[0].input;
  assert.equal(discovery.searchPosts, true);
  assert.equal(discovery.searchComments, true);
  assert.equal(discovery.includeMediaLinks, false);
  assert.equal(discovery.skipComments, true);
  assert.equal(discovery.sort, "relevance");
  assert.equal(discovery.time, "month");
  assert.equal(discovery.postDateLimit, "2026-08-01T00:00:00.000Z");
  assert.equal(discovery.commentDateLimit, "2026-08-01T00:00:00.000Z");
  assert.equal(discovery.includeNSFW, false);
  assert.equal(discovery.maxItems, 40);
  assert.equal(discovery.maxPostCount, 6);
  assert.equal(discovery.maxComments, 0);
  assert.deepEqual(discovery.proxy.apifyProxyGroups, ["RESIDENTIAL"]);
  assert.deepEqual(discovery.searches, redditModule.buildApifyRedditSearches(searchRequest));

  const enrichment = calls[1].input;
  assert.deepEqual(enrichment.startUrls, [{ url: documentedActorItem.url }]);
  assert.equal(enrichment.includeMediaLinks, true);
  assert.equal(enrichment.skipComments, false);
  assert.equal(enrichment.maxComments, 6);
  assert.equal("searches" in enrichment, false);
});

test("never invents a Reddit creation date when enrichment cannot verify it", async () => {
  let calls = 0;
  const provider = new redditModule.ApifyRedditTestProvider({
    actorId: "trudax/reddit-scraper",
    token: "private-apify-token",
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify([lightweightActorItem]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const result = await provider.search(searchRequest);
  assert.equal(calls, 2);
  assert.deepEqual(result.conversations, []);
  assert.equal(result.diagnostics.enrichmentAttempts, 1);
  assert.equal(result.diagnostics.enrichedConversations, 0);
  assert.equal(result.diagnostics.verifiedRecentConversations, 0);
  assert.equal(result.diagnostics.missingVerifiedTimestamps, 1);
});

test("can use a complete discovery record if thread enrichment temporarily fails", async () => {
  let calls = 0;
  const provider = new redditModule.ApifyRedditTestProvider({
    actorId: "trudax/reddit-scraper",
    token: "private-apify-token",
    fetchImpl: async () => {
      calls += 1;
      if (calls === 2) {
        return new Response("upstream unavailable", { status: 503 });
      }
      return new Response(JSON.stringify([documentedActorItem]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const result = await provider.search(searchRequest);
    assert.equal(result.conversations.length, 1);
    assert.equal(result.conversations[0].createdAt, documentedActorItem.createdAt);
    assert.equal(result.diagnostics.enrichmentFallbacks, 1);
    assert.equal(result.diagnostics.enrichedConversations, 0);
  } finally {
    console.error = originalConsoleError;
  }
});

test("requires an explicit test-mode opt in before selecting Apify", () => {
  const baseEnv = {
    APP_RUNTIME_ENV: "production",
    REDDIT_PROVIDER: "apify-test",
    APIFY_TOKEN: "private-apify-token",
    APIFY_REDDIT_ACTOR_ID: "trudax/reddit-scraper",
  };
  assert.throws(
    () => redditModule.createRedditProviderFromEnv(baseEnv),
    /test-only/,
  );
  const selected = redditModule.createRedditProviderFromEnv({
    ...baseEnv,
    APIFY_REDDIT_TEST_MODE: "true",
  });
  assert.equal(selected.name, "apify-reddit-test");
  assert.equal(selected.sourceMode, "apify-test");
});
