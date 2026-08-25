import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

/**
 * Regression coverage for a real production incident: a scan interrupted
 * mid-discovery (by a deploy restarting the app, a job-level timeout, or the
 * background worker reclaiming a stale lease) used to redo the ENTIRE
 * discovery stage from scratch on its next attempt -- every query family
 * re-run as a fresh, paid Apify actor call, even the ones that had already
 * succeeded. A single scan with only 3 keyphrases was observed producing 28+
 * actor runs this way, with two runs firing the exact same query 6 minutes
 * apart.
 *
 * discover()/runChunkedDirectDiscovery now accept `resumeFrom` (a prior,
 * possibly-partial discovery result) and `onChunkSucceeded` (fired after
 * each query chunk succeeds, with the running merged result so far). A
 * caller persists that running result as a checkpoint; on the next attempt,
 * only queries missing from the checkpoint are ever re-fetched. These tests
 * exercise the real, compiled HarshmaurRedditProvider -- not a
 * reimplementation -- with a stubbed Apify, the same pattern already used by
 * tests/reddit-provider-selection.test.mjs.
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
const { HarshmaurRedditProvider } = await import(u(cc(harshSrc, "h.ts")));

// Exactly one source per lane -> exactly 3 query families, one per lane.
const business = {
  queries: {
    productCategories: ["android tv parental control app"],
    customerProblems: ["kids watching tv too long"],
    competitors: ["google family link"],
  },
  limit: 250,
  since: new Date(Date.now() - 7 * 86_400_000).toISOString(),
};
const EXPECTED_QUERIES = [
  "android tv parental control app",
  "kids watching tv too long",
  "google family link",
];

function harshmaurRecord(index, term) {
  return {
    id: `t3_h${index}`,
    type: "post",
    title: `Post about ${term} #${index}`,
    body: "Body text describing the relevant problem in enough detail to pass validation and read as a credible post about this topic.",
    subreddit: "r/AndroidTV",
    author: `user_${index}`,
    url: `/r/AndroidTV/comments/h${index}/post`,
    createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    score: 5,
    numberOfComments: 2,
    searchTerm: term,
  };
}

/**
 * One actor run per query, terminal status returned directly on the start
 * response (skips the polling loop entirely, same shortcut the run status
 * check already supports). `failQueries` makes any run for that exact query
 * come back FAILED (retryable, per APIFY_RETRYABLE_RUN_STATUSES) instead of
 * SUCCEEDED, so callers can simulate a query that never recovers.
 */
function makeStub({ failQueries = new Set() } = {}) {
  const starts = [];
  const impl = async (url, init = {}) => {
    const href = String(url);
    if (href.includes("/v2/actors/") && href.includes("/runs") && init.method === "POST") {
      const input = JSON.parse(init.body);
      const query = new URL(input.startUrls[0].url).searchParams.get("q");
      const runId = `run_${starts.length + 1}`;
      const failed = failQueries.has(query);
      starts.push({ query, runId, failed });
      return new Response(JSON.stringify({
        data: { id: runId, status: failed ? "FAILED" : "SUCCEEDED", defaultDatasetId: `ds_${runId}` },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href.includes("/datasets/")) {
      const match = href.match(/datasets\/([^/]+)\/items/);
      const start = starts.find((s) => `ds_${s.runId}` === match?.[1]);
      const params = new URL(href).searchParams;
      const offset = Number(params.get("offset") ?? 0);
      const limit = Number(params.get("limit") ?? 100);
      const records = start && !start.failed
        ? [harshmaurRecord(starts.indexOf(start) + 1, start.query)]
        : [];
      return new Response(JSON.stringify(records.slice(offset, offset + limit)), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch in test stub: ${href}`);
  };
  impl.starts = starts;
  return impl;
}

function queriesOf(response) {
  return response.searchPlan.map((entry) => entry.query).sort();
}

test("onChunkSucceeded fires once per successful query chunk with a running, cumulative checkpoint", async () => {
  const stubFetch = makeStub();
  const provider = new HarshmaurRedditProvider({
    token: "test-token",
    queriesPerRun: 1,
    maxConcurrentDiscoveryRuns: 3,
    fetchImpl: stubFetch,
  });
  const checkpoints = [];
  const result = await provider.discover(business, {
    onChunkSucceeded: (partial) => { checkpoints.push(partial); },
  });

  assert.equal(stubFetch.starts.length, 3, "one actor run per query family");
  // Each successful chunk is folded into the running checkpoint before the
  // next call -- regardless of which chunk happens to finish first under
  // concurrency, the sequence of sizes must be strictly cumulative (1, 2, 3),
  // never smaller than the one before it and never re-fetched.
  assert.deepEqual(checkpoints.map((c) => c.candidates.length), [1, 2, 3]);
  assert.deepEqual(queriesOf(checkpoints.at(-1)), [...EXPECTED_QUERIES].sort());
  assert.equal(result.candidates.length, 3);
  assert.deepEqual(queriesOf(result), [...EXPECTED_QUERIES].sort());
});

test("resumeFrom covering every query skips discovery entirely -- zero new actor runs", async () => {
  const firstStub = makeStub();
  const seedProvider = new HarshmaurRedditProvider({
    token: "test-token",
    queriesPerRun: 1,
    fetchImpl: firstStub,
  });
  const full = await seedProvider.discover(business);
  assert.equal(firstStub.starts.length, 3);

  const secondStub = makeStub();
  const resumedProvider = new HarshmaurRedditProvider({
    token: "test-token",
    queriesPerRun: 1,
    fetchImpl: secondStub,
  });
  const result = await resumedProvider.discover(business, { resumeFrom: full });

  assert.equal(secondStub.starts.length, 0, "every query was already covered by the checkpoint");
  assert.equal(result, full, "the checkpoint is returned directly, not recomputed");
});

test("resumeFrom covering 2 of 3 queries only fetches the missing one, and merges it into the checkpoint", async () => {
  const missingQuery = "google family link";
  const partial = {
    candidates: [
      { ...harshmaurRecordAsCandidate(1, "android tv parental control app") },
      { ...harshmaurRecordAsCandidate(2, "kids watching tv too long") },
    ],
    searchPlan: [
      { lane: "category_recommendation", query: "android tv parental control app", seed: "android tv parental control app" },
      { lane: "pain", query: "kids watching tv too long", seed: "kids watching tv too long" },
    ],
    sourceMode: "live",
    diagnostics: {
      queryCount: 2,
      fetchedCandidates: 2,
      normalizedCandidates: 2,
      verifiedRecentCandidates: 2,
      rejectedByReason: {
        invalid_record: 0, invalid_url: 0, query_mismatch: 0, bot_author: 0,
        deleted: 0, nsfw: 0, missing_timestamp: 0, outside_window: 0,
      },
      laneQueryCounts: { category_recommendation: 1, pain: 1 },
    },
  };

  const stubFetch = makeStub();
  const provider = new HarshmaurRedditProvider({
    token: "test-token",
    queriesPerRun: 1,
    fetchImpl: stubFetch,
  });
  const checkpoints = [];
  const result = await provider.discover(business, {
    resumeFrom: partial,
    onChunkSucceeded: (p) => checkpoints.push(p),
  });

  assert.equal(stubFetch.starts.length, 1, "only the missing query should trigger a new actor run");
  assert.equal(stubFetch.starts[0].query, missingQuery);
  assert.equal(checkpoints.length, 1);
  // The checkpoint callback's own value already includes resumeFrom's 2
  // candidates plus the 1 newly-fetched one.
  assert.equal(checkpoints[0].candidates.length, 3);
  assert.equal(result.candidates.length, 3);
  assert.deepEqual(queriesOf(result), [...EXPECTED_QUERIES].sort());
});

test("if every remaining query fails, resumeFrom's own results are returned rather than throwing away real progress", async () => {
  const missingQuery = "google family link";
  const partial = {
    candidates: [harshmaurRecordAsCandidate(1, "android tv parental control app")],
    searchPlan: [
      { lane: "category_recommendation", query: "android tv parental control app", seed: "android tv parental control app" },
    ],
    sourceMode: "live",
    diagnostics: {
      queryCount: 1, fetchedCandidates: 1, normalizedCandidates: 1, verifiedRecentCandidates: 1,
      rejectedByReason: {
        invalid_record: 0, invalid_url: 0, query_mismatch: 0, bot_author: 0,
        deleted: 0, nsfw: 0, missing_timestamp: 0, outside_window: 0,
      },
      laneQueryCounts: { category_recommendation: 1 },
    },
  };

  const stubFetch = makeStub({ failQueries: new Set([missingQuery, "kids watching tv too long"]) });
  const provider = new HarshmaurRedditProvider({
    token: "test-token",
    queriesPerRun: 1,
    discoveryRetryAttempts: 1, // no retry delay -- keeps this test fast
    fetchImpl: stubFetch,
  });
  const onChunkSucceeded = () => {
    throw new Error("no chunk should succeed in this test");
  };
  const result = await provider.discover(business, { resumeFrom: partial, onChunkSucceeded });

  assert.equal(result, partial);
});

/** Minimal valid RedditDiscoveryCandidate shape for a hand-built checkpoint fixture. */
function harshmaurRecordAsCandidate(index, term) {
  return {
    provider: "apify-harshmaur",
    sourceMode: "live",
    externalId: `t3_h${index}`,
    kind: "post",
    subreddit: "r/AndroidTV",
    title: `Post about ${term} #${index}`,
    body: "Body text describing the relevant problem.",
    author: `user_${index}`,
    permalink: `https://www.reddit.com/r/AndroidTV/comments/h${index}/post`,
    createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    metrics: { score: 5, comments: 2 },
    matchedQueries: [term],
    discoveryLanes: ["pain"],
    provenance: {
      id: `source_${index}`,
      kind: "reddit",
      provider: "apify-harshmaur",
      providerExternalId: `t3_h${index}`,
      contentHash: `hash_${index}`,
      observedAt: new Date().toISOString(),
      isMock: false,
    },
  };
}
