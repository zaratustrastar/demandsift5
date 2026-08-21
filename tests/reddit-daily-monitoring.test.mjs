import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

import {
  redditMonitorConfiguration,
  redditMonitorDedupeKey,
  redditMonitorSchedulerEnabled,
  scheduleRedditMonitorScans,
} from "../scripts/background-worker.mjs";

function moduleUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
}

async function compileMonitorProvider() {
  const rawSource = await readFile(
    new URL("../lib/providers/reddit-monitor.server.ts", import.meta.url),
    "utf8",
  );
  assert.match(rawSource, /harshmaurCandidate/u,
    "monitoring must reuse the existing Harshmaur normalizer");
  // The production import uses the app's @/* alias, which a standalone data:
  // module cannot resolve. The discovery parser itself has its own regression
  // suite; this small injected equivalent keeps this test focused on one-run
  // orchestration and matched-term unioning.
  let source = rawSource.replace(
    /import \{ harshmaurCandidate \} from "@\/lib\/providers\/reddit-harshmaur\.server";/u,
    `const harshmaurCandidate = (value, options) => ({ candidate: {
      provider: "apify-harshmaur-reddit", sourceMode: "live",
      externalId: value.id, kind: value.dataType === "comment" ? "comment" : "post",
      subreddit: String(value.subredditName || "").replace(/^r\\//, ""),
      title: value.title, body: value.body, author: value.authorName,
      permalink: value.url, createdAt: value.createdAt,
      metrics: { score: 0, comments: 0 }, matchedQuery: value.searchTerm,
      matchedQueries: value.searchTerm ? [value.searchTerm] : [],
      discoveryLanes: options.lanes,
      provenance: { id: "source_" + value.id, kind: "reddit",
        provider: "apify-harshmaur-reddit", providerExternalId: value.id,
        url: value.url, excerpt: value.body, contentHash: value.id,
        observedAt: new Date().toISOString(), isMock: false,
        metadata: { searchTerm: value.searchTerm } }
    } });`,
  );
  source = source.replace(
    /import \{ REDDIT_MONITOR_LIMITS \} from "@\\/lib\\/intelligence\\/reddit-monitor-limits";/u,
    "const REDDIT_MONITOR_LIMITS = { maxWatchTerms: 5, maxResultsPerRun: 50, maxPostsPerTerm: 5, maxCommentsPerTerm: 5 };",
  );
  const javascript = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: "reddit-monitor.server.ts",
  }).outputText;
  return import(moduleUrl(javascript));
}

const monitorProvider = await compileMonitorProvider();
const FROM = new Date("2026-08-20T09:15:30.000Z");
const TO = new Date("2026-08-21T09:15:30.000Z");

test("monitoring sends all active terms in one exact-window Actor input", () => {
  const input = monitorProvider.buildRedditMonitorActorInput({
    watchTerms: [
      "DemandSift", "GummySearch", "buyer intent", "DemandSift",
      "Reddit monitoring", "competitor complaint", "sixth term",
    ],
    from: FROM,
    to: TO,
    environment: {},
  });
  assert.deepEqual(input.searchTerms, [
    "DemandSift", "GummySearch", "buyer intent", "Reddit monitoring", "competitor complaint",
  ]);
  assert.equal(input.searchPosts, true);
  assert.equal(input.searchComments, true);
  assert.equal(input.searchCommunities, false);
  assert.equal(input.searchSort, "new");
  assert.equal(input.searchTime, "all");
  assert.equal(input.postedAfter, FROM.toISOString());
  assert.equal(input.postedBefore, TO.toISOString());
  assert.equal(input.commentedAfter, FROM.toISOString());
  assert.equal(input.commentedBefore, TO.toISOString());
  assert.equal(input.sentimentAnalysis, false);
  assert.equal(input.crawlCommentsPerPost, false);
  assert.equal(input.maxPostsCount, 5);
  assert.equal(input.maxCommentsCount, 5);
  assert.ok(
    input.searchTerms.length * (input.maxPostsCount + input.maxCommentsCount) <= 50,
    "one Actor run must be capped at 50 raw results",
  );
});

test("one monitoring fetch starts one Actor run and preserves every matching term", async () => {
  const calls = [];
  const fakeFetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (init.method === "POST") {
      return new Response(JSON.stringify({ data: {
        id: "actor_run_one",
        status: "SUCCEEDED",
        defaultDatasetId: "dataset_one",
      } }), { status: 201 });
    }
    return new Response(JSON.stringify([
      {
        id: "t3_watch123",
        dataType: "post",
        searchTerm: "DemandSift",
        title: "Looking for Reddit demand intelligence",
        body: "Which tool separates buyer intent from noisy mentions?",
        authorName: "buyer_one",
        subredditName: "r/SaaS",
        url: "https://www.reddit.com/r/SaaS/comments/watch123/tool_recommendation/",
        createdAt: "2026-08-21T08:00:00.000Z",
      },
      {
        id: "t3_watch123",
        dataType: "post",
        searchTerm: "buyer intent",
        title: "Looking for Reddit demand intelligence",
        body: "Which tool separates buyer intent from noisy mentions?",
        authorName: "buyer_one",
        subredditName: "r/SaaS",
        url: "https://www.reddit.com/r/SaaS/comments/watch123/tool_recommendation/",
        createdAt: "2026-08-21T08:00:00.000Z",
      },
    ]), { status: 200 });
  };

  const result = await monitorProvider.fetchRedditMonitorCandidates({
    watchTerms: ["DemandSift", "buyer intent"],
    from: FROM,
    to: TO,
    environment: { APIFY_TOKEN: "test-token" },
    fetchImpl: fakeFetch,
  });

  assert.equal(calls.filter((call) => call.init.method === "POST").length, 1);
  const actorInput = JSON.parse(calls.find((call) => call.init.method === "POST").init.body);
  assert.deepEqual(actorInput.searchTerms, ["DemandSift", "buyer intent"]);
  assert.equal(actorInput.maxPostsCount, 5);
  assert.equal(actorInput.maxCommentsCount, 5);
  const datasetCall = calls.find((call) => call.init.method !== "POST");
  assert.equal(new URL(datasetCall.url).searchParams.get("limit"), "50");
  assert.equal(result.actorRunId, "actor_run_one");
  assert.equal(result.fetched, 2);
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0].matchedQueries, ["DemandSift", "buyer intent"]);
});

function fakeSchedulerSql(monitors, insertedJobs = [[{ id: "job_one" }]]) {
  const calls = [];
  let jobIndex = 0;
  const transactionSql = async (strings, ...values) => {
    const query = strings.join("?").replace(/\s+/gu, " ").trim();
    calls.push({ query, values });
    if (query.startsWith("SELECT monitor.workspace_id")) return monitors;
    if (query.startsWith("INSERT INTO background_jobs")) return insertedJobs[jobIndex++] ?? [];
    if (query.startsWith("INSERT INTO runtime_reddit_monitor_runs")) return [];
    throw new Error(`Unexpected fake query: ${query}`);
  };
  transactionSql.json = (value) => value;
  return {
    calls,
    sql: { begin: (callback) => callback(transactionSql) },
  };
}

test("scheduler creates one daily job and one run containing every active term", async () => {
  const fake = fakeSchedulerSql([{
    workspace_id: "ws_one",
    seed_scan_id: "scan_seed",
    last_successful_monitor_at: "2026-08-20T09:15:30.000Z",
    watch_terms: [
      { value: "DemandSift", kind: "brand", active: true },
      { value: "GummySearch", kind: "competitor", active: true },
      { value: "third", kind: "keyword", active: true },
      { value: "fourth", kind: "keyword", active: true },
      { value: "fifth", kind: "keyword", active: true },
      { value: "sixth", kind: "keyword", active: true },
      { value: "disabled term", kind: "keyword", active: false },
    ],
  }]);
  const result = await scheduleRedditMonitorScans(fake.sql, {
    now: TO,
    configuration: redditMonitorConfiguration({}),
    createRunId: () => "monrun_one",
  });

  assert.equal(result.scheduled.length, 1);
  assert.equal(result.scheduled[0].watchTermCount, 5);
  assert.equal(fake.calls.filter((call) => call.query.startsWith("INSERT INTO background_jobs")).length, 1);
  assert.equal(fake.calls.filter((call) => call.query.startsWith("INSERT INTO runtime_reddit_monitor_runs")).length, 1);
  const runRecord = fake.calls
    .find((call) => call.query.startsWith("INSERT INTO runtime_reddit_monitor_runs"))
    .values.find((value) => value?.id === "monrun_one");
  assert.deepEqual(runRecord.watchTerms, ["DemandSift", "GummySearch", "third", "fourth", "fifth"]);
  assert.equal(runRecord.windowStartedAt, "2026-08-20T09:15:30.000Z");
  assert.equal(runRecord.windowEndedAt, TO.toISOString());
  assert.equal(
    fake.calls.some((call) => /UPDATE runtime_reddit_monitors/u.test(call.query)),
    false,
    "the scheduler must not advance the successful watermark",
  );
});

test("daily monitor is independently enabled and deduped per business and UTC day", () => {
  assert.equal(redditMonitorSchedulerEnabled({}), true);
  assert.equal(redditMonitorSchedulerEnabled({ REDDIT_MONITOR_SCHEDULER_ENABLED: "false" }), false);
  assert.equal(redditMonitorDedupeKey("ws_one", "2026-08-21T01:00:00Z"),
    redditMonitorDedupeKey("ws_one", "2026-08-21T23:59:59Z"));
  assert.notEqual(redditMonitorDedupeKey("ws_one", "2026-08-21T23:59:59Z"),
    redditMonitorDedupeKey("ws_one", "2026-08-22T00:00:00Z"));
});

test("monitor storage enforces cross-run dedupe and advances watermark only on success", async () => {
  const repository = await readFile(
    new URL("../lib/server/reddit-monitor-repository.ts", import.meta.url),
    "utf8",
  );
  const migration = await readFile(
    new URL("../db/migrations/0006_daily_reddit_monitoring.sql", import.meta.url),
    "utf8",
  );
  const workflow = await readFile(
    new URL("../lib/server/reddit-monitor-workflow.ts", import.meta.url),
    "utf8",
  );
  const discovery = await readFile(
    new URL("../lib/server/scan-workflow.ts", import.meta.url),
    "utf8",
  );

  assert.match(migration, /PRIMARY KEY \(workspace_id, provider, external_id\)/u);
  assert.match(repository, /\.onConflictDoNothing\(\)/u);
  assert.match(repository, /if \(inserted\) \{\s*unseen\.push\(candidate\)/u);
  assert.match(repository, /existing\?\.outcome === "unreviewed"/u);
  assert.match(repository, /eq\(runtimeRedditMonitorMatches\.lastRunId, input\.runId\)/u);
  assert.match(repository, /if \(!reviewedIds\.has\(row\.externalId\)\) continue/u,
    "a recovery run must update reprocessed unseen matches without overwriting old duplicates");
  assert.match(repository, /lastSuccessfulMonitorAt: completed\.windowEndedAt/u);
  assert.match(repository, /getDb\(\)\.transaction/u,
    "successful run state and the monitoring watermark must commit atomically");
  assert.match(repository, /last_successful_monitor_at|lastSuccessfulMonitorAt/u);
  const failureFunction = repository.slice(repository.indexOf("export async function failRedditMonitorRun"));
  assert.equal(failureFunction.slice(0, failureFunction.indexOf("export async function latestRedditMonitorRun"))
    .includes("lastSuccessfulMonitorAt"), false);
  assert.match(workflow, /checkpointFromCandidates\(unseen/u);
  assert.match(workflow, /runScan\(scan\.id/u);
  assert.equal(discovery.includes("reddit-monitor.server"), false,
    "daily monitoring must not be spliced into the existing discovery implementation");
});
