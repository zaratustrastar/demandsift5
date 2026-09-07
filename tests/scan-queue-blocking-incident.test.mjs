import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

/**
 * Real production incident: canva.com returns HTTP 403 to the crawler
 * (bot-blocking). Nothing distinguished that from an ordinary transient
 * failure, so the scan retried the entire crawl+analysis pipeline
 * repeatedly -- 2 attempts inside runFullWebsiteUnderstanding, times up
 * to 5 attempts at the job queue level, each with its own exponential
 * backoff -- keeping a worker slot (this environment runs
 * BACKGROUND_WORKER_CONCURRENCY=1, so there is only one) occupied for
 * ~30 minutes and blocking every other queued scan, including a real
 * user's, behind it.
 *
 * These tests pin the fix at the two layers that actually needed it:
 * the crawler now throws a distinguishable PermanentWebsiteFetchError
 * for a status retrying can never fix, and that classification survives
 * all the way through crawlWebsite's own final aggregation throw (which
 * previously collapsed every failure into one generic Error, silently
 * erasing the distinction). job-retry-classification.test.mjs covers
 * the queue-level disposition this feeds into.
 */

const crawlerSource = await readFile(new URL("../lib/security/website-crawler.ts", import.meta.url), "utf8");
const crawlerJavaScript = ts.transpileModule(crawlerSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: "website-crawler.ts",
}).outputText;
const crawlerModuleUrl = `data:text/javascript;base64,${Buffer.from(crawlerJavaScript).toString("base64")}`;
const { crawlWebsite, PermanentWebsiteFetchError } = await import(crawlerModuleUrl);

const PUBLIC_V4 = { address: "93.184.216.34", family: 4 };

test("a persistent 403 on the homepage throws PermanentWebsiteFetchError with the real status, not a generic Error", async () => {
  await assert.rejects(
    crawlWebsite("https://example.com", {
      maxPages: 4,
      resolver: async () => [PUBLIC_V4],
      fetchImpl: async () => new Response(null, { status: 403 }),
    }),
    (error) => {
      assert.equal(error.name, "PermanentWebsiteFetchError");
      assert.equal(error.status, 403);
      assert.equal(error.code, "website_permanently_unreachable");
      return true;
    },
  );
});

test("401, 404, 410, and 451 on the homepage all classify the same way as 403", async () => {
  for (const status of [401, 404, 410, 451]) {
    await assert.rejects(
      crawlWebsite("https://example.com", {
        maxPages: 4,
        resolver: async () => [PUBLIC_V4],
        fetchImpl: async () => new Response(null, { status }),
      }),
      (error) => {
        assert.equal(error.name, "PermanentWebsiteFetchError", `status ${status}`);
        assert.equal(error.status, status);
        return true;
      },
    );
  }
});

test("a repeated 500/502/503 on the homepage still throws a plain, retryable Error -- not PermanentWebsiteFetchError", async () => {
  for (const status of [500, 502, 503]) {
    await assert.rejects(
      crawlWebsite("https://example.com", {
        maxPages: 4,
        resolver: async () => [PUBLIC_V4],
        fetchImpl: async () => new Response(null, { status }),
      }),
      (error) => {
        assert.notEqual(error.name, "PermanentWebsiteFetchError", `status ${status}`);
        assert.equal(error instanceof PermanentWebsiteFetchError, false);
        return true;
      },
    );
  }
});

test("a 429 on the homepage also stays a plain, retryable Error", async () => {
  await assert.rejects(
    crawlWebsite("https://example.com", {
      maxPages: 4,
      resolver: async () => [PUBLIC_V4],
      fetchImpl: async () => new Response(null, { status: 429 }),
    }),
    (error) => {
      assert.equal(error instanceof PermanentWebsiteFetchError, false);
      return true;
    },
  );
});

test("a genuinely hanging/timing-out homepage fetch still throws a plain Error, never silently classified permanent", async () => {
  await assert.rejects(
    crawlWebsite("https://example.com", {
      maxPages: 4,
      resolver: async () => [PUBLIC_V4],
      // Simulates what a real fetch does once its own AbortSignal fires
      // after a slow, unresponsive server -- a timeout is a transport
      // failure, never grounds for PermanentWebsiteFetchError.
      fetchImpl: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        throw new Error("The operation was aborted due to timeout");
      },
    }),
    (error) => {
      assert.equal(error instanceof PermanentWebsiteFetchError, false);
      return true;
    },
  );
});

test("when the homepage succeeds but a later page returns 403, the crawl still succeeds with what it has (permanence only matters once every page has failed)", async () => {
  const result = await crawlWebsite("https://example.com", {
    maxPages: 3,
    resolver: async () => [PUBLIC_V4],
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      if (path === "/") {
        return new Response(
          `<html><head><title>Home</title></head><body>Home page with enough body text to clear the crawler's readable-content threshold. <a href="/other">Other page</a></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      return new Response(null, { status: 403 });
    },
  });
  assert.equal(result.pages.length, 1);
  assert.equal(result.failures.length >= 1, true);
  assert.equal(result.failures[0].permanent, true);
  assert.equal(result.failures[0].status, 403);
});
