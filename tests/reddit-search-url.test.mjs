import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const u = (c) => `data:text/javascript;base64,${Buffer.from(c).toString("base64")}`;
const cc = (s, f) => ts.transpileModule(s, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: f,
}).outputText;

const src = await readFile(new URL("../lib/providers/reddit-search-url.ts", import.meta.url), "utf8");
const { redditSearchUrl } = await import(u(cc(src, "url.ts")));

test("produces exactly the tested-working URL shape, nothing else", () => {
  const href = redditSearchUrl("parental controls Android TV");
  const url = new URL(href);
  assert.equal(url.origin, "https://www.reddit.com");
  assert.equal(url.pathname, "/search/");
  assert.equal(url.searchParams.get("q"), "parental controls Android TV");
  assert.equal(url.searchParams.get("t"), "week");
  // Only q and t -- a browser-copied URL's type/cId/acId/iId params are what
  // got a real query rejected outright by this actor build.
  assert.deepEqual([...url.searchParams.keys()].sort(), ["q", "t"]);
});

test("never emits type, cId, acId, or iId even if a caller tried to sneak them into the query text", () => {
  // The query text itself can't inject extra params -- URLSearchParams
  // percent-encodes the value, it never becomes a second query pair.
  const href = redditSearchUrl("tv&type=link&cId=x");
  const url = new URL(href);
  assert.deepEqual([...url.searchParams.keys()].sort(), ["q", "t"]);
  assert.equal(url.searchParams.get("q"), "tv&type=link&cId=x");
});

test("boolean/quoted queries round-trip through URL encoding intact", () => {
  const query = '("parental controls" OR "screen time") AND ("Android TV" OR "Google TV")';
  const href = redditSearchUrl(query);
  const url = new URL(href);
  assert.equal(url.searchParams.get("q"), query);
});

test("time window defaults to week and can be overridden", () => {
  assert.equal(new URL(redditSearchUrl("tv")).searchParams.get("t"), "week");
  assert.equal(new URL(redditSearchUrl("tv", { time: "month" })).searchParams.get("t"), "month");
});

test("rejects an empty query rather than building a URL with nothing to search", () => {
  assert.throws(() => redditSearchUrl(""));
  assert.throws(() => redditSearchUrl("   "));
});
