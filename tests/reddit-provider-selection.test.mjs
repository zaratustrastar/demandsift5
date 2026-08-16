import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

/**
 * Trudax and Harshmaur must be interchangeable behind one contract.
 *
 * The risk this guards against is a half-integration: a parser that exists but
 * that the factory never constructs, or a provider whose discover() returns a
 * shape the scan workflow cannot consume. Both are exercised here through the
 * real factory with a stubbed Apify, so selection and normalization are proven
 * rather than assumed.
 */

const u = (c) => `data:text/javascript;base64,${Buffer.from(c).toString("base64")}`;
const cc = (s, f) => ts.transpileModule(s, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: f,
}).outputText;

const here = (p) => new URL(p, import.meta.url);
const stub = u("export {};");

const ranking = u(cc(
  (await readFile(here("../lib/intelligence/opportunity-ranking.ts"), "utf8"))
    .replaceAll('"@/lib/domain/types"', JSON.stringify(stub)), "r.ts"));
const natural = u(cc(
  (await readFile(here("../lib/providers/reddit-natural-queries.ts"), "utf8"))
    .replaceAll('"@/lib/providers/contracts"', JSON.stringify(stub))
    .replaceAll('"@/lib/intelligence/opportunity-ranking"', JSON.stringify(ranking)), "n.ts"));

let harshSrc = await readFile(here("../lib/providers/reddit-harshmaur.server.ts"), "utf8");
harshSrc = harshSrc
  .replaceAll('"@/lib/domain/types"', JSON.stringify(stub))
  .replaceAll('"@/lib/providers/contracts"', JSON.stringify(stub))
  .replaceAll('"@/lib/intelligence/opportunity-ranking"', JSON.stringify(ranking))
  .replaceAll('"@/lib/providers/reddit-natural-queries"', JSON.stringify(natural));
const harshmaurModule = u(cc(harshSrc, "h.ts"));
const { HarshmaurRedditProvider } = await import(harshmaurModule);

let redditSrc = await readFile(here("../lib/providers/reddit.server.ts"), "utf8");
redditSrc = redditSrc
  .replaceAll('"@/lib/providers/mock-reddit"', JSON.stringify(u(
    "export class MockRedditProvider{name='mock-reddit';sourceMode='mock';async discover(){return{candidates:[],searchPlan:[],sourceMode:'mock',diagnostics:{}}}async enrich(){return{conversations:[],sourceMode:'mock',diagnostics:{}}}}")))
  .replaceAll('"@/lib/providers/reddit-harshmaur.server"', JSON.stringify(harshmaurModule))
  .replaceAll('"@/lib/intelligence/opportunity-ranking"', JSON.stringify(ranking))
  .replaceAll('"@/lib/server/runtime-env"', JSON.stringify(u(
    "export function isProductionRuntime(env=process.env){return (env.APP_RUNTIME_ENV||env.NODE_ENV)==='production';}")))
  .replaceAll('"@/lib/providers/contracts"', JSON.stringify(stub))
  .replaceAll('"@/lib/domain/types"', JSON.stringify(stub));
const reddit = await import(u(cc(redditSrc, "reddit.server.ts")));

const tvcp = {
  queries: {
    productTerms: ["TVCP", "Android TV parental control app"],
    brandTerms: ["TVCP"],
    productCategories: ["Android TV parental control app"],
    customerProblems: ["kids watching TV too long", "block youtube on the tv"],
    jobsToBeDone: ["limit screen time on the television"],
    buyerIntent: ["recommendations"],
    competitors: ["Google Family Link"],
    excludedTerms: [],
  },
  limit: 250,
  since: new Date(Date.now() - 7 * 86_400_000).toISOString(),
};

function harshmaurRecord(index, term) {
  return {
    id: `t3_h${index}`,
    type: "post",
    title: `Parental controls on Android TV part ${index}`,
    body: "My kids watch youtube on the tv for hours and I cannot set limits.",
    subreddit: "r/AndroidTV",
    author: `parent_${index}`,
    url: `/r/AndroidTV/comments/h${index}/parental_controls`,
    createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    score: 5,
    numberOfComments: 2,
    searchTerm: term,
  };
}

/** Minimal Apify stub: one run-sync response, then dataset pages. */
function stubApify(records) {
  return async (url) => {
    const href = String(url);
    if (href.includes("/run-sync")) {
      return new Response(JSON.stringify({ data: { defaultDatasetId: "ds_1" } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    const offset = Number(new URL(href).searchParams.get("offset") ?? 0);
    const limit = Number(new URL(href).searchParams.get("limit") ?? 100);
    return new Response(JSON.stringify(records.slice(offset, offset + limit)), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
}

test("the factory constructs Harshmaur only when explicitly selected", () => {
  const env = {
    REDDIT_PROVIDER: "harshmaur",
    APIFY_TOKEN: "test-token",
    APP_RUNTIME_ENV: "production",
  };
  const provider = reddit.createRedditProviderFromEnv(env);
  assert.equal(provider.name, "apify-harshmaur-reddit");
  assert.equal(provider.sourceMode, "live");
});

test("selecting apify-test still yields Trudax, unchanged", () => {
  const provider = reddit.createRedditProviderFromEnv({
    REDDIT_PROVIDER: "apify-test",
    APIFY_REDDIT_TEST_MODE: "true",
    APIFY_REDDIT_ACTOR_ID: "trudax/reddit-scraper-lite",
    APIFY_TOKEN: "test-token",
    APP_RUNTIME_ENV: "production",
  });
  assert.notEqual(provider.name, "apify-harshmaur-reddit");
  // Swapping the actor id must never be the way Harshmaur gets selected.
  const viaActorId = reddit.createRedditProviderFromEnv({
    REDDIT_PROVIDER: "apify-test",
    APIFY_REDDIT_TEST_MODE: "true",
    APIFY_REDDIT_ACTOR_ID: "harshmaur/reddit-scraper",
    APIFY_TOKEN: "test-token",
    APP_RUNTIME_ENV: "production",
  });
  assert.notEqual(viaActorId.name, "apify-harshmaur-reddit");
});

test("an unknown provider name is rejected rather than guessed", () => {
  assert.throws(() => reddit.createRedditProviderFromEnv({
    REDDIT_PROVIDER: "not-a-provider",
    APIFY_TOKEN: "t",
    APP_RUNTIME_ENV: "production",
  }));
});

test("discover() returns the shared contract the scan workflow consumes", async () => {
  const records = [
    harshmaurRecord(1, "android tv parental control"),
    harshmaurRecord(2, "screen time tv"),
  ];
  const provider = new HarshmaurRedditProvider({
    token: "test-token",
    fetchImpl: stubApify(records),
  });
  const result = await provider.discover(tvcp);

  assert.equal(result.sourceMode, "live");
  assert.equal(result.candidates.length, 2);
  assert.ok(result.searchPlan.length > 0, "per-term plan entries enable attribution");
  for (const candidate of result.candidates) {
    // Exactly the fields the workflow depends on.
    for (const field of ["provider", "externalId", "kind", "subreddit", "body", "createdAt", "permalink", "metrics", "matchedQueries", "provenance"]) {
      assert.ok(field in candidate, `candidate missing ${field}`);
    }
    assert.equal(candidate.provenance.isMock, false);
    assert.ok(candidate.provenance.contentHash);
  }
  assert.equal(result.diagnostics.fetchedCandidates, 2);
  assert.equal(result.diagnostics.normalizedCandidates, 2);
  assert.ok(result.diagnostics.queryCount > 0);
});

test("searchTerm attribution survives the whole provider path", async () => {
  const provider = new HarshmaurRedditProvider({
    token: "t",
    fetchImpl: stubApify([harshmaurRecord(9, "block youtube tv")]),
  });
  const { candidates } = await provider.discover(tvcp);
  assert.deepEqual(candidates[0].matchedQueries, ["block youtube tv"]);
  assert.equal(candidates[0].provenance.metadata.searchTerm, "block youtube tv");
});

test("enrichment is honest about being discovery-only", async () => {
  const provider = new HarshmaurRedditProvider({ token: "t", fetchImpl: stubApify([]) });
  const result = await provider.enrich({
    candidates: [
      {
        provider: "apify-harshmaur-reddit", sourceMode: "live", externalId: "t3_x",
        kind: "post", subreddit: "AndroidTV", body: "b", createdAt: new Date().toISOString(),
        metrics: { score: 1, comments: 0 }, matchedQueries: [], discoveryLanes: [],
        provenance: { id: "p", kind: "reddit", provider: "apify-harshmaur-reddit", contentHash: "h", observedAt: new Date().toISOString(), isMock: false },
      },
    ],
  });
  // Claiming full-context review it never fetched would corrupt the coverage
  // gate downstream, so this reports zero enriched and one fallback.
  assert.equal(result.diagnostics.enriched, 0);
  assert.equal(result.diagnostics.fallbackUsed, 1);
  assert.equal(result.conversations[0].enriched, false);
});

test("actor input never leaks intent sentences or startUrls", async () => {
  let captured = null;
  const provider = new HarshmaurRedditProvider({
    token: "t",
    fetchImpl: async (url, init) => {
      if (String(url).includes("/run-sync")) {
        captured = JSON.parse(init.body);
        return new Response(JSON.stringify({ data: { defaultDatasetId: "d" } }), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    },
  });
  await provider.discover(tvcp);
  assert.ok(captured);
  assert.equal(captured.searchCommunities, false);
  assert.equal(captured.searchSort, "new");
  assert.equal("startUrls" in captured, false);
  assert.equal("crawlCommentsPerPost" in captured, false);
  for (const term of captured.searchTerms) {
    assert.ok(term.split(" ").length <= 4, `intent-shaped term: "${term}"`);
  }
});
