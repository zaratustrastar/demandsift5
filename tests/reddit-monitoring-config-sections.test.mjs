import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Small UI/information-hierarchy improvement to the existing Reddit
 * monitoring config screen only. RedditWatchTerm's persisted kind field
 * (brand/competitor/keyword) already existed and already drove the
 * daily search query -- this just splits the one flat textarea that
 * edited all three into three labeled sections, one per existing kind.
 * No new database fields, no override objects, no backend changes.
 */

const dashboard = await readFile(new URL("../components/demand-intelligence/ProductDashboard.tsx", import.meta.url), "utf8");

function fnBody(source, name, endMarker) {
  const start = source.indexOf(name);
  assert.ok(start > -1, `${name} not found`);
  const end = source.indexOf(endMarker, start + name.length);
  return source.slice(start, end);
}

const panel = () => fnBody(dashboard, "function RedditMonitoringPanel", "function ");

test("the flat single textarea is gone -- three separate, labeled sections exist instead: Brand terms, Competitors, Topics & phrases", () => {
  const body = panel();
  assert.equal(body.includes("Brand, competitor and keyword watch terms"), false);
  assert.match(body, /<span>Brand terms<\/span>/);
  assert.match(body, /<span>Competitors<\/span>/);
  assert.match(body, /<span>Topics &amp; phrases<\/span>/);
  // Three separate textareas, one per section.
  assert.equal((body.match(/<textarea/g) ?? []).length, 3);
});

test("each section seeds directly from the existing persisted kind, with no attempt to distinguish where a keyword originally came from", () => {
  const body = panel();
  assert.match(body, /termsByKind\("brand"\)/);
  assert.match(body, /termsByKind\("competitor"\)/);
  assert.match(body, /termsByKind\("keyword"\)/);
  // No productTerms/customerProblemLanguage distinction reconstructed --
  // that split isn't in the persisted watch-term model.
  assert.equal(body.includes("productTerms"), false);
  assert.equal(body.includes("customerProblemLanguage"), false);
});

test("the existing active-only seeding behavior is preserved exactly -- only active terms of each kind populate their box", () => {
  const body = panel();
  const termsByKindFn = body.slice(body.indexOf("const termsByKind"), body.indexOf("const [brandTerms"));
  assert.match(termsByKindFn, /term\.active && term\.kind === kind/);
});

test("kind is now assigned directly by which box a term came from -- no more guessing kind by looking up an existing term with the same value", () => {
  const body = panel();
  const parsedTermsFn = body.slice(body.indexOf("const parsedTerms"), body.indexOf("const save ="));
  assert.match(parsedTermsFn, /kind: "brand" as const/);
  assert.match(parsedTermsFn, /kind: "competitor" as const/);
  assert.match(parsedTermsFn, /kind: "keyword" as const/);
  // The old guess-by-lookup logic is gone.
  assert.equal(parsedTermsFn.includes("existing?.kind"), false);
  assert.equal(parsedTermsFn.includes(".find("), false);
});

test("the combine-dedupe-cap behavior (REDDIT_MONITOR_LIMITS.maxWatchTerms) is preserved, just applied across all three boxes combined instead of one", () => {
  const body = panel();
  const parsedTermsFn = body.slice(body.indexOf("const parsedTerms"), body.indexOf("const save ="));
  assert.match(parsedTermsFn, /\.slice\(0, REDDIT_MONITOR_LIMITS\.maxWatchTerms\)/);
  // Case-insensitive dedupe across the combined list, same as before.
  assert.match(parsedTermsFn, /toLocaleLowerCase\("en-US"\)/);
});

test("save/onUpdate is called exactly the same way as before -- the existing persistence path is reused unchanged", () => {
  const body = panel();
  assert.match(body, /await onUpdate\(enabled, parsedTerms\(\)\);/);
});

test("everything unrelated to term editing is untouched: the monitoring toggle, last-check footer, and Recent runs list", () => {
  const body = panel();
  assert.match(body, /Monitoring on/);
  assert.match(body, /Monitoring off/);
  assert.match(body, /Last successful check/);
  assert.match(body, /No daily check has completed yet\./);
  assert.match(body, /Recent runs/);
  assert.match(body, /Save watch terms/);
});
