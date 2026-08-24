import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

/**
 * crawlWebsite() used to fetch its up-to-maxPages pages strictly one at a
 * time: page 2's URL is only known after parsing page 1's links, but pages
 * 2+ have no ordering dependency on each other, so fetching them
 * sequentially was pure wasted wall-clock time (this crawl is used both
 * for a competitor's site in competitor-analysis.ts and for the primary
 * business's own site in scan-workflow.ts, both at maxPages: 4). These
 * tests exercise the real, compiled crawlWebsite -- not source-string
 * assertions -- against a fake multi-page site, using timestamps recorded
 * by a slow fetchImpl to prove pages 2+ genuinely overlap in time rather
 * than running back-to-back.
 */

const crawlerSource = await readFile(
  new URL("../lib/security/website-crawler.ts", import.meta.url),
  "utf8",
);
const crawlerJavaScript = ts.transpileModule(crawlerSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: "website-crawler.ts",
}).outputText;
const crawlerModuleUrl = `data:text/javascript;base64,${Buffer.from(crawlerJavaScript).toString("base64")}`;
const { crawlWebsite } = await import(crawlerModuleUrl);

const PUBLIC_V4 = { address: "93.184.216.34", family: 4 };

function pageHtml(title, links) {
  const anchors = links.map((href) => `<a href="${href}">${href}</a>`).join("");
  return `<html><title>${title}</title><body>This is a sufficiently long public business page with useful product, audience, and customer problem information for analysis about ${title}. ${anchors}</body></html>`;
}

/** A fetchImpl that resolves after a fixed delay and records the [start, end] window for each URL. */
function slowFetchImpl(pagesByPath, delayMs, windows) {
  return async (url) => {
    const path = new URL(url).pathname;
    const start = Date.now();
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    windows.push({ path, start, end: Date.now() });
    const html = pagesByPath[path];
    if (!html) return new Response(null, { status: 404 });
    return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
  };
}

function windowsOverlap(a, b) {
  return a.start < b.end && b.start < a.end;
}

test("pages discovered from the homepage are fetched concurrently, not one at a time", async () => {
  const pagesByPath = {
    "/": pageHtml("Home", ["/about", "/pricing", "/blog"]),
    "/about": pageHtml("About", []),
    "/pricing": pageHtml("Pricing", []),
    "/blog": pageHtml("Blog", []),
  };
  const windows = [];
  const result = await crawlWebsite("https://example.com", {
    maxPages: 4,
    resolver: async () => [PUBLIC_V4],
    fetchImpl: slowFetchImpl(pagesByPath, 50, windows),
  });

  assert.equal(result.pages.length, 4);
  const homeWindow = windows.find((w) => w.path === "/");
  const restWindows = windows.filter((w) => w.path !== "/");
  assert.equal(restWindows.length, 3);

  // Page 1 (the homepage) must complete before any other page starts --
  // the others are only discovered from its links.
  for (const w of restWindows) {
    assert.ok(w.start >= homeWindow.end, `${w.path} started before the homepage finished`);
  }

  // At least two of the remaining three pages must have been in flight at
  // the same time -- proof this is genuinely concurrent, not sequential
  // with a coincidental timestamp ordering.
  const anyOverlap = restWindows.some((a, i) =>
    restWindows.slice(i + 1).some((b) => windowsOverlap(a, b)),
  );
  assert.equal(anyOverlap, true, "expected at least two non-homepage pages to overlap in time");
});

test("total crawl time for a multi-page site is close to one page's fetch time, not the sum of all pages", async () => {
  const pagesByPath = {
    "/": pageHtml("Home", ["/a", "/b", "/c"]),
    "/a": pageHtml("A", []),
    "/b": pageHtml("B", []),
    "/c": pageHtml("C", []),
  };
  const delayMs = 40;
  const windows = [];
  const startedAt = Date.now();
  await crawlWebsite("https://example.com", {
    maxPages: 4,
    resolver: async () => [PUBLIC_V4],
    fetchImpl: slowFetchImpl(pagesByPath, delayMs, windows),
  });
  const elapsed = Date.now() - startedAt;

  // Strictly sequential would take ~4 * delayMs (homepage + 3 pages, one
  // after another). Concurrent fetching of pages 2-4 should land close to
  // ~2 * delayMs (homepage, then the other 3 together). Generous bound to
  // avoid flakiness on a loaded CI machine, but well under the fully
  // sequential total.
  assert.ok(elapsed < delayMs * 3.5, `expected well under ${delayMs * 4}ms for a sequential crawl, got ${elapsed}ms`);
});

test("the page-count budget (maxPages) is still enforced exactly, even with several fetches racing to add pages", async () => {
  const pagesByPath = {
    "/": pageHtml("Home", ["/a", "/b", "/c", "/d", "/e"]),
    "/a": pageHtml("A", []),
    "/b": pageHtml("B", []),
    "/c": pageHtml("C", []),
    "/d": pageHtml("D", []),
    "/e": pageHtml("E", []),
  };
  const windows = [];
  const result = await crawlWebsite("https://example.com", {
    maxPages: 3,
    resolver: async () => [PUBLIC_V4],
    fetchImpl: slowFetchImpl(pagesByPath, 20, windows),
  });

  assert.equal(result.pages.length, 3, "must never exceed maxPages even though 5 links were queued");
});

test("canonicalUrl always reflects the originally-submitted homepage, not whichever page finishes first", async () => {
  const pagesByPath = {
    "/": pageHtml("Home", ["/about"]),
    "/about": pageHtml("About", []),
  };
  const windows = [];
  const result = await crawlWebsite("https://example.com", {
    maxPages: 2,
    resolver: async () => [PUBLIC_V4],
    // The homepage is deliberately slower than the page it links to, so a
    // naive "whichever finishes first sets canonicalUrl" implementation
    // would get this wrong.
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      await new Promise((resolve) => setTimeout(resolve, path === "/" ? 60 : 5));
      windows.push(path);
      return new Response(pagesByPath[path], { status: 200, headers: { "content-type": "text/html" } });
    },
  });

  assert.equal(result.canonicalUrl, "https://example.com/");
  assert.equal(result.pages.length, 2);
});

test("a page that fails to fetch does not block or fail its siblings", async () => {
  const windows = [];
  const result = await crawlWebsite("https://example.com", {
    maxPages: 3,
    resolver: async () => [PUBLIC_V4],
    fetchImpl: async (url) => {
      const path = new URL(url).pathname;
      windows.push(path);
      if (path === "/") return new Response(pageHtml("Home", ["/broken", "/ok"]), { status: 200, headers: { "content-type": "text/html" } });
      if (path === "/broken") return new Response(null, { status: 500 });
      return new Response(pageHtml("OK", []), { status: 200, headers: { "content-type": "text/html" } });
    },
  });

  assert.equal(result.pages.length, 2);
  assert.equal(result.pages.some((p) => p.url === "https://example.com/ok"), true);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].url, /\/broken$/);
});
