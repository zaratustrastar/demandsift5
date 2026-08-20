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
const queryFamilies = u(cc(
  (await readFile(here("../lib/providers/reddit-query-families.ts"), "utf8"))
    .replaceAll('"@/lib/domain/types"', JSON.stringify(stub))
    .replaceAll('"@/lib/providers/contracts"', JSON.stringify(stub))
    .replaceAll('"@/lib/intelligence/opportunity-ranking"', JSON.stringify(ranking))
    .replaceAll('"@/lib/providers/reddit-natural-queries"', JSON.stringify(natural)), "qf.ts"));
const searchUrl = u(cc(
  await readFile(here("../lib/providers/reddit-search-url.ts"), "utf8"), "su.ts"));
// Compiled from the real sources so retry/backoff selection behavior is
// actually exercised, not assumed away by a stub.
const apifyRetry = u(cc(
  await readFile(here("../lib/providers/apify-retry.ts"), "utf8"), "ar.ts"));
const resilience = u(cc(
  await readFile(here("../lib/server/resilience.ts"), "utf8"), "res.ts"));

let harshSrc = await readFile(here("../lib/providers/reddit-harshmaur.server.ts"), "utf8");
harshSrc = harshSrc
  .replaceAll('"@/lib/domain/types"', JSON.stringify(stub))
  .replaceAll('"@/lib/providers/contracts"', JSON.stringify(stub))
  .replaceAll('"@/lib/intelligence/opportunity-ranking"', JSON.stringify(ranking))
  .replaceAll('"@/lib/providers/reddit-natural-queries"', JSON.stringify(natural))
  .replaceAll('"@/lib/providers/reddit-query-families"', JSON.stringify(queryFamilies))
  .replaceAll('"@/lib/providers/reddit-search-url"', JSON.stringify(searchUrl))
  .replaceAll('"@/lib/providers/apify-retry"', JSON.stringify(apifyRetry))
  .replaceAll('"@/lib/server/resilience"', JSON.stringify(resilience));
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
  .replaceAll('"@/lib/domain/types"', JSON.stringify(stub))
  .replaceAll('"@/lib/providers/apify-retry"', JSON.stringify(apifyRetry))
  .replaceAll('"@/lib/server/resilience"', JSON.stringify(resilience));
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

/**
 * Apify stub following the async contract: POST /runs returns run metadata,
 * GET /actor-runs/<id> reports status, then the dataset pages.
 */
function stubApify(records, options = {}) {
  const calls = [];
  const impl = async (url, init) => {
    const href = String(url);
    calls.push({ href, method: init?.method ?? "GET", body: init?.body });
    if (href.includes("/v2/actors/") && href.includes("/runs")) {
      return new Response(JSON.stringify({
        data: { id: "run_1", status: options.startStatus ?? "RUNNING", defaultDatasetId: "ds_1" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href.includes("/v2/actor-runs/")) {
      return new Response(JSON.stringify({
        data: { id: "run_1", status: options.finalStatus ?? "SUCCEEDED", defaultDatasetId: "ds_1" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const params = new URL(href).searchParams;
    const offset = Number(params.get("offset") ?? 0);
    const limit = Number(params.get("limit") ?? 100);
    return new Response(JSON.stringify(records.slice(offset, offset + limit)), {
      status: 200, headers: { "content-type": "application/json" },
    });
  };
  impl.calls = calls;
  return impl;
}

test("the factory constructs Harshmaur (wrapped with a Trudax fallback) only when explicitly selected, no opt-in flag required", () => {
  const env = {
    REDDIT_PROVIDER: "harshmaur",
    APIFY_TOKEN: "test-token",
    APIFY_REDDIT_ACTOR_ID: "trudax/reddit-scraper-lite",
    APP_RUNTIME_ENV: "production",
  };
  // No HARSHMAUR_RETRIEVAL_EVAL set: Harshmaur is the production default now,
  // not an opt-in retrieval comparison, so this must succeed without it.
  const provider = reddit.createRedditProviderFromEnv(env);
  assert.equal(provider.name, "apify-harshmaur-reddit-with-trudax-fallback");
  assert.equal(provider.sourceMode, "live");
  assert.equal(provider.supportsThreadEnrichment, true);
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
    // Large enough that tvcp's query families fit in a single batch --
    // chunking (multiple independently-retried actor runs) is covered by
    // its own dedicated test below; this one is about the response shape.
    queriesPerRun: 20,
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

test("by default, each query runs as its own dedicated actor run with a per-query post budget", async () => {
  // Regression test for a real production finding: a shared scan-wide post
  // budget divided across query batches meant more (smaller, more precise)
  // queries produced a THINNER per-query budget, not a bigger one. Each
  // query should now get its own run and its own fixed postsPerQuery budget
  // -- tvcp's 3 query families should produce 3 separate actor starts, each
  // with exactly one startUrls entry and maxPostsCount equal to the default
  // postsPerQuery (20), not a divided-down fraction of some larger total.
  const starts = [];
  const provider = new HarshmaurRedditProvider({
    token: "test-token",
    // No queriesPerRun override: this is exactly the production default.
    fetchImpl: async (url, init = {}) => {
      const href = String(url);
      if (href.includes("/v2/actors/") && href.includes("/runs") && init.method === "POST") {
        const input = JSON.parse(init.body);
        starts.push(input);
        return new Response(JSON.stringify({
          data: { id: `run_${starts.length}`, status: "SUCCEEDED", defaultDatasetId: `ds_${starts.length}` },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (href.includes("/datasets/")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected mocked Harshmaur URL: ${href}`);
    },
  });

  await provider.discover(tvcp);

  assert.equal(starts.length, 3, `expected one dedicated actor run per query family, got ${starts.length}`);
  for (const input of starts) {
    assert.equal(input.startUrls.length, 1, "each default-mode run should carry exactly one query");
    assert.equal(input.maxPostsCount, 20, "expected the default postsPerQuery budget, not a divided-down total");
  }
});

test("chunk execution is capped by maxConcurrentDiscoveryRuns instead of firing every query's actor run at once", async () => {
  // Regression test for a real production report: a scan with 6 user-picked
  // queries (3 product, 3 pain, 0 competitors) spawned roughly 23 Apify
  // runs. Root cause: queriesPerRun defaults to 1, so 6 queries meant 6
  // chunks, and every chunk's actor-start request fired at once with no
  // concurrency cap -- well above this Apify account's concurrent-run
  // limit, which queued the excess as "READY" runs that client-side
  // per-chunk retries then piled fresh runs on top of. This pins the fix:
  // at most `maxConcurrentDiscoveryRuns` actor-start requests may be
  // outstanding at once, and all 6 chunks still eventually complete.
  const sixQueries = {
    queries: {
      productTerms: [],
      productCategories: ["project management software", "team task tracker", "kanban board app"],
      customerProblems: ["projects scattered across tools", "cant see project status", "leads falling through cracks"],
      buyerIntent: [],
      competitors: [],
      excludedTerms: [],
    },
    limit: 250,
    since: new Date(Date.now() - 7 * 86_400_000).toISOString(),
  };

  let inFlight = 0;
  let maxObservedInFlight = 0;
  let totalStarts = 0;
  const provider = new HarshmaurRedditProvider({
    token: "test-token",
    maxConcurrentDiscoveryRuns: 2,
    fetchImpl: async (url, init = {}) => {
      const href = String(url);
      if (href.includes("/v2/actors/") && href.includes("/runs") && init.method === "POST") {
        totalStarts += 1;
        inFlight += 1;
        maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight -= 1;
        return new Response(JSON.stringify({
          data: { id: `run_${totalStarts}`, status: "SUCCEEDED", defaultDatasetId: `ds_${totalStarts}` },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (href.includes("/datasets/")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected mocked Harshmaur URL: ${href}`);
    },
  });

  const result = await provider.discover(sixQueries);

  assert.equal(totalStarts, 6, `expected exactly one actor start per query with no spurious retries, got ${totalStarts}`);
  assert.ok(
    maxObservedInFlight <= 2,
    `expected at most 2 concurrent actor-start requests, observed ${maxObservedInFlight}`,
  );
  assert.equal(result.diagnostics.queriesFailed ?? 0, 0);
});

test("a run is explicitly aborted before retry even when the failure is not a client-side timeout", async () => {
  // The concurrency-cap fix alone does not prevent duplicate live runs --
  // what actually prevents them is runActor aborting the run it is giving
  // up on before a retry can start a replacement. That used to only fire
  // on controller.signal.aborted (the client timeout branch); this pins
  // that it now fires for ANY give-up while the run is still non-terminal,
  // using a persistent status-check network failure (not a timeout) as the
  // trigger, so a queued/running run can never be left live while a retry
  // starts a second one for the same query.
  const singleCompetitorQuery = {
    queries: {
      productTerms: [],
      productCategories: [],
      customerProblems: [],
      buyerIntent: [],
      competitors: ["Bark"],
      excludedTerms: [],
    },
    limit: 100,
  };

  let starts = 0;
  const abortedRunIds = [];
  const provider = new HarshmaurRedditProvider({
    token: "test-token",
    discoveryRetryAttempts: 2,
    fetchImpl: async (url, init = {}) => {
      const href = String(url);
      if (href.includes("/v2/actors/") && href.includes("/runs") && init.method === "POST") {
        starts += 1;
        return new Response(JSON.stringify({
          data: { id: `run_${starts}`, status: "READY", defaultDatasetId: "" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (href.includes("/v2/actor-runs/run_1") && href.includes("/abort")) {
        abortedRunIds.push("run_1");
        return new Response(JSON.stringify({ data: { id: "run_1", status: "ABORTED" } }), {
          status: 200, headers: { "content-type": "application/json" },
        });
      }
      if (href.includes("/v2/actor-runs/run_1")) {
        // Persistent network failure checking on the first run's status --
        // not a client timeout, just this call giving up on Apify.
        throw new Error("simulated network failure");
      }
      if (href.includes("/v2/actor-runs/run_2")) {
        return new Response(JSON.stringify({
          data: { id: "run_2", status: "SUCCEEDED", defaultDatasetId: "ds_2" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (href.includes("/datasets/")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected mocked Harshmaur URL: ${href}`);
    },
  });

  const result = await provider.discover(singleCompetitorQuery);

  assert.deepEqual(abortedRunIds, ["run_1"], "the abandoned run_1 must be explicitly aborted");
  assert.equal(starts, 2, "exactly one retry run should replace the aborted one, not more");
  assert.ok(result.candidates.length === 0, "the retried run's empty dataset should still resolve cleanly");
});

test("a Harshmaur run that times out with zero retained records is retried, not silently returned as a clean zero", async () => {
  // Regression test for the exact bug behind a real production report: an
  // Apify run can end TIMED-OUT with a datasetId allocated but nothing ever
  // written to it. Treating that as a usable "partial" result made a total
  // retrieval failure indistinguishable from a scan that genuinely searched
  // and found nothing -- this must retry instead.
  let runStarts = 0;
  const provider = new HarshmaurRedditProvider({
    token: "test-token",
    queriesPerRun: 20, // keep this to one batch; retry behavior is the point here
    discoveryRetryAttempts: 2,
    fetchImpl: async (url, init = {}) => {
      const href = String(url);
      if (href.includes("/v2/actors/") && href.includes("/runs")) {
        runStarts += 1;
        if (runStarts === 1) {
          return new Response(JSON.stringify({
            data: { id: `run_${runStarts}`, status: "TIMED-OUT", defaultDatasetId: "ds_empty" },
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({
          data: { id: `run_${runStarts}`, status: "SUCCEEDED", defaultDatasetId: "ds_ok" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (href.includes("/datasets/ds_empty/items")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (href.includes("/datasets/ds_ok/items")) {
        return new Response(
          JSON.stringify([harshmaurRecord(1, "android tv parental control")]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected mocked Harshmaur URL: ${href}`);
    },
  });

  const result = await provider.discover(tvcp);

  assert.equal(runStarts, 2, "the empty timed-out run must trigger exactly one retry, starting a fresh run");
  assert.equal(result.candidates.length, 1);
  assert.equal(result.diagnostics.degraded, undefined, "a batch that eventually succeeds is not degraded");
});

test("chunked discovery preserves a successful query batch when another batch exhausts its retries", async () => {
  // tvcp's simple, capped query families no longer reliably exceed the
  // default queriesPerRun (4) on their own -- forcing queriesPerRun: 1
  // guarantees multiple batches regardless of exactly how many families the
  // fixture produces, so this still exercises the real chunked path: one
  // batch's actor run always times out with an empty dataset, another
  // always succeeds. The whole discovery call must return the successful
  // batch's candidates rather than throwing away everything because one
  // batch never recovered.
  let runStarts = 0;
  const provider = new HarshmaurRedditProvider({
    token: "test-token",
    discoveryRetryAttempts: 2,
    queriesPerRun: 1,
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes("/v2/actors/") && href.includes("/runs")) {
        runStarts += 1;
        // The very first start call belongs to the first chunk (batches run
        // concurrently, but each chunk's own first fetch call is issued
        // synchronously in array order before any chunk's promise settles).
        // Every batch after it -- including all of the poison batch's own
        // retries -- times out with nothing retained.
        if (runStarts === 1) {
          return new Response(JSON.stringify({
            data: { id: "run_ok", status: "SUCCEEDED", defaultDatasetId: "ds_ok" },
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({
          data: { id: `run_poison_${runStarts}`, status: "TIMED-OUT", defaultDatasetId: "ds_empty" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (href.includes("/datasets/ds_empty/items")) {
        return new Response(JSON.stringify([]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (href.includes("/datasets/ds_ok/items")) {
        return new Response(
          JSON.stringify([harshmaurRecord(1, "android tv parental control"), harshmaurRecord(2, "screen time tv")]),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`Unexpected mocked Harshmaur URL: ${href}`);
    },
  });

  const result = await provider.discover(tvcp);

  assert.ok(runStarts > 2, "more than one query batch, and the failing batch retried, so more than 2 start calls occurred");
  assert.equal(result.candidates.length, 2, "the successful batch's candidates are kept");
  assert.equal(result.diagnostics.degraded, true);
  assert.ok(result.diagnostics.queriesFailed > 0);
  assert.ok(result.diagnostics.queriesSucceeded > 0);
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

test("enrichment without a resolvable permalink is honest about staying discovery-only", async () => {
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
  // No permalink means no thread to crawl. Claiming full-context review it
  // never fetched would corrupt the coverage gate downstream, so this reports
  // zero enriched and one fallback rather than silently skipping the actor
  // call and pretending it succeeded.
  assert.equal(result.diagnostics.enriched, 0);
  assert.equal(result.diagnostics.fallbackUsed, 1);
  assert.equal(result.diagnostics.failureReason, "missing_reddit_thread_urls");
  assert.notEqual(result.conversations[0].provenance.metadata?.enriched, true);
});

test("thread enrichment crawls the candidate's own thread and marks it verified", async () => {
  const postId = "abc123";
  const permalink = `https://www.reddit.com/r/AndroidTV/comments/${postId}/some_title/`;
  const payload = [
    {
      dataType: "post", id: `t3_${postId}`, parsedId: postId, postUrl: permalink,
      title: "Some title", body: "Post body text", authorName: "op",
      communityName: "r/AndroidTV", createdAt: new Date().toISOString(),
    },
    {
      dataType: "comment", id: "c1", postId: `t3_${postId}`, parsedPostId: postId,
      parentId: `t3_${postId}`, parsedParentId: postId, parentKind: "post", depth: 0,
      authorName: "replier1", body: "A real reply to the post",
      commentCreatedAt: new Date().toISOString(), subredditName: "AndroidTV",
    },
    {
      dataType: "comment", id: "c2", postId: `t3_${postId}`, parsedPostId: postId,
      parentId: "t1_c1", parsedParentId: "c1", parentKind: "comment", depth: 1,
      authorName: "replier2", body: "A nested reply to c1",
      commentCreatedAt: new Date().toISOString(), subredditName: "AndroidTV",
    },
  ];
  let captured = null;
  const provider = new HarshmaurRedditProvider({
    token: "t",
    fetchImpl: async (url, init) => {
      const href = String(url);
      if (href.includes("/v2/actors/") && href.includes("/runs")) {
        captured = init?.body ? JSON.parse(init.body) : null;
        return new Response(JSON.stringify({ data: { id: "r", status: "SUCCEEDED", defaultDatasetId: "d" } }), { status: 200 });
      }
      if (href.includes("/v2/actor-runs/")) {
        return new Response(JSON.stringify({ data: { id: "r", status: "SUCCEEDED", defaultDatasetId: "d" } }), { status: 200 });
      }
      if (href.includes("/v2/datasets/")) {
        return new Response(JSON.stringify(payload), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    },
  });

  const candidate = {
    provider: "apify-harshmaur-reddit", sourceMode: "live", externalId: postId,
    kind: "post", subreddit: "AndroidTV", title: "Some title", body: "Post body text",
    author: "op", permalink, createdAt: new Date().toISOString(),
    metrics: { score: 1, comments: 2 }, matchedQueries: [], discoveryLanes: [],
    provenance: { id: "p", kind: "reddit", provider: "apify-harshmaur-reddit", contentHash: "h", observedAt: new Date().toISOString(), isMock: false },
  };
  const result = await provider.enrich({ candidates: [candidate] });

  assert.ok(captured, "the actor must be called");
  assert.equal(captured.crawlCommentsPerPost, true);
  assert.deepEqual(captured.startUrls, [{ url: permalink }]);
  assert.equal(captured.searchTerms.length, 0);

  assert.equal(result.diagnostics.enriched, 1);
  assert.equal(result.diagnostics.failed, 0);
  const conversation = result.conversations[0];
  assert.equal(conversation.provenance.metadata?.enriched, true);
  assert.equal(conversation.structuredContext.replies.length, 1);
  assert.equal(conversation.structuredContext.replies[0].externalId, "c1");
  // The nested reply to c1 is thread context, not a direct reply to the post.
  assert.equal(conversation.structuredContext.surroundingComments.some((row) => row.externalId === "c2"), true);
  assert.ok(conversation.threadContext.includes("A real reply to the post"));
});

function capturingFetch(records = []) {
  let captured = null;
  const impl = async (url, init) => {
    const href = String(url);
    if (href.includes("/v2/actors/") && href.includes("/runs")) {
      captured = JSON.parse(init.body);
      return new Response(JSON.stringify({
        data: { id: "r", status: "SUCCEEDED", defaultDatasetId: "d" },
      }), { status: 200 });
    }
    if (href.includes("/v2/actor-runs/")) {
      return new Response(JSON.stringify({
        data: { id: "r", status: "SUCCEEDED", defaultDatasetId: "d" },
      }), { status: 200 });
    }
    return new Response(JSON.stringify(records), { status: 200 });
  };
  return { impl, get captured() { return captured; } };
}

test("discover() defaults to Direct URL discovery: real reddit.com search URLs, no leaked platform fields", async () => {
  const fetcher = capturingFetch();
  const provider = new HarshmaurRedditProvider({ token: "t", fetchImpl: fetcher.impl });
  await provider.discover(tvcp);
  const captured = fetcher.captured;
  assert.ok(captured);
  assert.equal(captured.searchTerms.length, 0, "Direct URL mode does not use searchTerms");
  assert.equal(captured.searchPosts, true);
  assert.equal(captured.searchComments, false, "comment search is a Keyword-search-only option");
  assert.equal(captured.searchCommunities, false);
  assert.equal(captured.fastMode, false);
  assert.equal(captured.crawlCommentsPerPost, false);
  assert.equal(captured.includeNSFW, false);
  // searchSort/searchTime/postedAfter/commentedAfter are Keyword-search-only
  // fields per the actor's own schema; they must not appear here, since the
  // time window instead lives in each URL's own &t= parameter.
  for (const field of ["searchSort", "searchTime", "postedAfter", "commentedAfter"]) {
    assert.equal(field in captured, false, `${field} does not apply to startUrls`);
  }
  // maxItems belongs on the run URL, never in the actor input.
  assert.equal("maxItems" in captured, false);
  assert.ok(Array.isArray(captured.startUrls) && captured.startUrls.length > 0);
  for (const entry of captured.startUrls) {
    const url = new URL(entry.url);
    assert.equal(url.origin, "https://www.reddit.com");
    assert.equal(url.pathname, "/search/");
    assert.deepEqual([...url.searchParams.keys()].sort(), ["q", "t"]);
    assert.equal(url.searchParams.get("t"), "week");
  }
});

test("the legacy searchTerms path stays reachable as an explicit fallback mode", async () => {
  const fetcher = capturingFetch();
  const provider = new HarshmaurRedditProvider({
    token: "t",
    discoveryMode: "search-terms",
    fetchImpl: fetcher.impl,
  });
  await provider.discover(tvcp);
  const captured = fetcher.captured;
  assert.ok(captured);
  assert.equal("startUrls" in captured, false);
  assert.equal(captured.searchSort, "new");
  assert.equal(captured.searchTime, "week");
  assert.ok(captured.searchTerms.length > 0);
  for (const term of captured.searchTerms) {
    assert.ok(term.split(" ").length <= 4, `intent-shaped term: "${term}"`);
  }
});

test("Direct URL discovery falls back to the searchTerms builder when the profile yields no query families", async () => {
  // redditQueryFamilies includes naturalSearchTerms's own broad output as
  // one of its families, so a profile sparse enough to empty out one
  // empties out the other too -- both attempts land on the same honest
  // "no usable Reddit search terms" error rather than one silently sending
  // zero startUrls.
  const emptyProfile = {
    queries: { productTerms: [], customerProblems: [], competitors: [], excludedTerms: [], buyerIntent: [] },
    limit: 100,
  };
  const provider = new HarshmaurRedditProvider({ token: "t", fetchImpl: capturingFetch().impl });
  await assert.rejects(
    () => provider.discover(emptyProfile),
    /did not produce any usable Reddit search terms/,
  );
});

test("an actual actor failure propagates rather than triggering a second paid run through the fallback", async () => {
  const failing = new HarshmaurRedditProvider({ token: "t", fetchImpl: stubApify([], { finalStatus: "FAILED" }) });
  await assert.rejects(() => failing.discover(tvcp), /ended with status FAILED/);
});

test("execution starts asynchronously and never uses run-sync", async () => {
  const fetchImpl = stubApify([harshmaurRecord(1, "screen time tv")]);
  const provider = new HarshmaurRedditProvider({ token: "t", fetchImpl });
  await provider.discover(tvcp);

  const hrefs = fetchImpl.calls.map((c) => c.href);
  // run-sync returns the actor OUTPUT record, not run metadata, so
  // defaultDatasetId would be missing entirely.
  assert.ok(hrefs.every((h) => !h.includes("run-sync")), "run-sync must not be used");

  const start = fetchImpl.calls.find((c) => c.method === "POST");
  assert.ok(start, "the run must be started with a POST");
  const startUrl = new URL(start.href);
  assert.equal(startUrl.searchParams.get("waitForFinish"), "0");
  // Platform-level cost guards.
  assert.ok(Number(startUrl.searchParams.get("maxItems")) > 0);
  assert.ok(Number(startUrl.searchParams.get("maxTotalChargeUsd")) > 0);

  assert.ok(hrefs.some((h) => h.includes("/v2/actor-runs/")), "status must be polled");
  assert.ok(hrefs.some((h) => h.includes("/v2/datasets/")), "dataset must be paged");
});

test("a failed run raises rather than returning an empty corpus", async () => {
  const provider = new HarshmaurRedditProvider({
    token: "t",
    fetchImpl: stubApify([], { finalStatus: "FAILED" }),
  });
  // Silently returning zero candidates would read as "the market is quiet".
  await assert.rejects(() => provider.discover(tvcp), /ended with status FAILED/);
});

test("harshmaur is production-ready without any opt-in flag, and falls back to Trudax only when Trudax credentials exist", () => {
  const withFallback = reddit.createRedditProviderFromEnv({
    REDDIT_PROVIDER: "harshmaur",
    APIFY_TOKEN: "t",
    APIFY_REDDIT_ACTOR_ID: "trudax/reddit-scraper-lite",
    APP_RUNTIME_ENV: "production",
  });
  assert.equal(withFallback.name, "apify-harshmaur-reddit-with-trudax-fallback");
  assert.equal(withFallback.supportsThreadEnrichment, true);

  // Without a configured Trudax actor id, Harshmaur still runs -- it just has
  // no fallback wired up, rather than failing provider construction over a
  // safety net it may never need.
  const withoutFallback = reddit.createRedditProviderFromEnv({
    REDDIT_PROVIDER: "harshmaur",
    APIFY_TOKEN: "t",
    APP_RUNTIME_ENV: "production",
  });
  assert.equal(withoutFallback.name, "apify-harshmaur-reddit-with-trudax-fallback");
});

test("the Harshmaur wrapper falls back to Trudax only on an actual actor failure, not a partial mapping miss", async () => {
  const primary = new HarshmaurRedditProvider({ token: "t", fetchImpl: stubApify([], { finalStatus: "FAILED" }) });
  const fallbackCalls = [];
  const fallback = {
    name: "apify-reddit-test",
    sourceMode: "apify-test",
    async discover() {
      fallbackCalls.push("discover");
      return { candidates: [], searchPlan: [], sourceMode: "apify-test", diagnostics: {
        queryCount: 0, fetchedCandidates: 0, normalizedCandidates: 0, verifiedRecentCandidates: 0,
        rejectedByReason: {}, laneQueryCounts: {},
      } };
    },
    async enrich() {
      fallbackCalls.push("enrich");
      return { conversations: [], sourceMode: "apify-test", diagnostics: { requested: 0, enriched: 0, failed: 0, fallbackUsed: 0 } };
    },
  };
  const wrapper = new reddit.HarshmaurWithTrudaxFallbackProvider(primary, fallback);
  const result = await wrapper.discover(tvcp);
  assert.deepEqual(fallbackCalls, ["discover"]);
  assert.equal(result.sourceMode, "apify-test");
});


test("the run URL uses Apify's tilde actor path, not a percent-encoded slash", async () => {
  const fetchImpl = stubApify([harshmaurRecord(1, "screen time tv")]);
  // Constructed with the slash form a reader would naturally write.
  const provider = new HarshmaurRedditProvider({
    actorId: "harshmaur/reddit-scraper",
    token: "t",
    fetchImpl,
  });
  await provider.discover(tvcp);

  const start = fetchImpl.calls.find((c) => c.method === "POST");
  assert.ok(start, "the run must be started with a POST");
  assert.ok(
    start.href.includes("harshmaur~reddit-scraper"),
    `run URL must use the tilde form: ${start.href}`,
  );
  assert.ok(
    !start.href.includes("harshmaur%2Freddit-scraper"),
    "a percent-encoded slash resolves to no actor",
  );
});

test("the default actor id is already in tilde form", async () => {
  const fetchImpl = stubApify([]);
  const provider = new HarshmaurRedditProvider({ token: "t", fetchImpl });
  await provider.discover(tvcp);
  const start = fetchImpl.calls.find((c) => c.method === "POST");
  assert.ok(start.href.includes("harshmaur~reddit-scraper"));
});
