import assert from "node:assert/strict";
import test from "node:test";

import {
  publicStatsConfiguration,
  publicStatsSchedulerEnabled,
  refreshPublicLandingStats,
} from "../scripts/background-worker.mjs";

const NOW = new Date("2026-09-04T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Minimal fake of a postgres.js tagged-template client: reconstructs the
 * query text from the strings array (ignoring interpolated values, like
 * the existing fakes in tests/background-worker-monitoring.test.mjs do)
 * to pick a canned response, and records every call plus its interpolated
 * values so assertions can check what refreshPublicLandingStats actually
 * tried to write.
 */
function createFakeSql({ existingNextRunAt, aggregate }) {
  const calls = [];
  const sql = async (strings, ...values) => {
    const query = strings.join("?").replace(/\s+/gu, " ").trim();
    calls.push({ query, values });
    if (query.startsWith("SELECT next_run_at FROM runtime_public_stats")) {
      return existingNextRunAt ? [{ next_run_at: existingNextRunAt }] : [];
    }
    if (query.startsWith("SELECT COUNT(*)::int AS scans_analyzed")) {
      return [aggregate];
    }
    if (query.startsWith("INSERT INTO runtime_public_stats")) {
      return [];
    }
    throw new Error(`Unexpected fake query: ${query}`);
  };
  return { calls, sql };
}

test("does not refresh (or query the aggregate at all) before a day has passed", async () => {
  const fake = createFakeSql({
    existingNextRunAt: new Date(NOW.getTime() + 60_000),
    aggregate: { scans_analyzed: 999, reddit_posts_analyzed: 999 },
  });
  const refreshed = await refreshPublicLandingStats(fake.sql, { now: NOW });
  assert.equal(refreshed, false);
  // Only the due-check ran -- the expensive aggregate and the write must
  // never fire when nothing is actually due yet.
  assert.equal(fake.calls.length, 1);
  assert.match(fake.calls[0].query, /^SELECT next_run_at FROM runtime_public_stats/);
});

test("refreshes and writes the real aggregate when due, and advances next_run_at by exactly one day", async () => {
  const fake = createFakeSql({
    existingNextRunAt: new Date(NOW.getTime() - 60_000),
    aggregate: { scans_analyzed: 37, reddit_posts_analyzed: 4_213 },
  });
  const refreshed = await refreshPublicLandingStats(fake.sql, { now: NOW });
  assert.equal(refreshed, true);
  assert.equal(fake.calls.length, 3);

  const [dueCheck, aggregateQuery, upsert] = fake.calls;
  assert.match(dueCheck.query, /^SELECT next_run_at FROM runtime_public_stats/);

  // The aggregate must only ever count real, live, finished scans -- this
  // is the whole reason a real counter is honest where a fabricated one
  // wasn't: counting mock/apify-test scans would just be a differently
  // shaped version of the same problem.
  assert.match(aggregateQuery.query, /FROM runtime_scans/);
  assert.match(aggregateQuery.query, /WHERE status = 'complete'/);
  assert.match(aggregateQuery.query, /record -> 'result' ->> 'dataMode' = 'live'/);
  assert.match(aggregateQuery.query, /record -> 'result' -> 'diagnostics' ->> 'normalized'/);

  assert.match(upsert.query, /^INSERT INTO runtime_public_stats/);
  assert.match(upsert.query, /ON CONFLICT \(id\) DO UPDATE SET/);
  // scansAnalyzed and redditPostsAnalyzed are each interpolated twice
  // (once for INSERT, once for the ON CONFLICT UPDATE branch); nextRunAt
  // is interpolated three times (also once for created_at's fallback).
  assert.ok(upsert.values.includes(37));
  assert.ok(upsert.values.includes(4_213));
  assert.ok(upsert.values.some((value) => value instanceof Date && value.getTime() === NOW.getTime() + DAY_MS));
});

test("refreshes on the very first run, when no row exists yet", async () => {
  const fake = createFakeSql({
    existingNextRunAt: null,
    aggregate: { scans_analyzed: 0, reddit_posts_analyzed: 0 },
  });
  const refreshed = await refreshPublicLandingStats(fake.sql, { now: NOW });
  assert.equal(refreshed, true);
});

test("the scheduler is enabled by default and independently configurable", () => {
  assert.equal(publicStatsSchedulerEnabled({}), true);
  assert.equal(publicStatsSchedulerEnabled({ PUBLIC_STATS_SCHEDULER_ENABLED: "false" }), false);
  // Defaults to a coarse poll -- the underlying refresh is due at most
  // once a day regardless, so there is nothing to gain from polling as
  // tightly as the other, genuinely time-sensitive schedulers.
  assert.equal(publicStatsConfiguration({}).schedulerPollMs, 3_600_000);
});

import { readFile } from "node:fs/promises";

const landingSource = await readFile(
  new URL("../components/ThreadlineExperience.tsx", import.meta.url),
  "utf8",
);

test("the landing page fetches the real stats endpoint and never renders a hardcoded scan count", () => {
  assert.match(landingSource, /fetch\("\/api\/public\/landing-stats"\)/);
  // The two numbers this feature replaced (a fabricated hero counter and a
  // fabricated stat-grid card) must not come back as literal strings.
  assert.equal(landingSource.includes('"520"'), false);
  assert.equal(landingSource.includes('"1,412"'), false);
  assert.equal(landingSource.includes('"1408"'), false);
  // The hero's own "N scans run so far" line was deliberately removed (a
  // small real number reads as weak social proof) -- the fetch and state
  // stay, since the stat-grid card still shows real redditPostsAnalyzed,
  // but nothing should render publicStats.scansAnalyzed in the hero.
  assert.equal(landingSource.includes("scansAnalyzed.toLocaleString()"), false);
  assert.match(landingSource, /publicStats\?\.redditPostsAnalyzed/);
});
