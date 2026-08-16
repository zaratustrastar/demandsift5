import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

/**
 * Harshmaur is a separate provider because its schema differs from Trudax in
 * kind: plain searchTerms in, its own field names out, with post and comment
 * records interleaved. These tests pin the boundary that makes two providers
 * safe to run side by side — both must emit the same normalized candidate, and
 * neither may let the actor's own filtering stand in for ours.
 */

const u = (c) => `data:text/javascript;base64,${Buffer.from(c).toString("base64")}`;
const cc = (s, f) => ts.transpileModule(s, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: f,
}).outputText;

const stub = u("export {};");
const ranking = u(cc(
  (await readFile(new URL("../lib/intelligence/opportunity-ranking.ts", import.meta.url), "utf8"))
    .replaceAll('"@/lib/domain/types"', JSON.stringify(stub)), "r.ts"));
const natural = u(cc(
  (await readFile(new URL("../lib/providers/reddit-natural-queries.ts", import.meta.url), "utf8"))
    .replaceAll('"@/lib/providers/contracts"', JSON.stringify(stub))
    .replaceAll('"@/lib/intelligence/opportunity-ranking"', JSON.stringify(ranking)), "n.ts"));

let src = await readFile(new URL("../lib/providers/reddit-harshmaur.server.ts", import.meta.url), "utf8");
src = src
  .replaceAll('"@/lib/domain/types"', JSON.stringify(stub))
  .replaceAll('"@/lib/providers/contracts"', JSON.stringify(stub))
  .replaceAll('"@/lib/intelligence/opportunity-ranking"', JSON.stringify(ranking))
  .replaceAll('"@/lib/providers/reddit-natural-queries"', JSON.stringify(natural));
const harshmaur = await import(u(cc(src, "h.ts")));

const NOW = new Date("2026-08-16T12:00:00.000Z");
const WINDOW = harshmaur.sevenDayWindow(NOW);

const tvcp = {
  queries: {
    productCategories: ["Android TV parental control app"],
    customerProblems: ["kids watching TV too long", "block youtube on the tv"],
    jobsToBeDone: ["limit screen time on the television"],
    competitors: ["Google Family Link"],
    productTerms: ["TVCP"],
  },
};

test("actor input matches the required discovery configuration", () => {
  const input = harshmaur.buildHarshmaurInput(tvcp, { maxItems: 250, now: NOW });
  assert.equal(input.searchPosts, true);
  assert.equal(input.searchComments, true);
  assert.equal(input.searchCommunities, false);
  // "relevance" re-ranks across all time and would smuggle in records from
  // outside the seven-day window we asked for.
  assert.equal(input.searchSort, "new");
  assert.equal(input.maxItems, 250);
  assert.equal(input.postedAfter, WINDOW.since);
  assert.equal(input.commentedAfter, WINDOW.since);
  assert.ok(input.searchTerms.length > 0);
  // No intent-shaped sentences and no unrelated startUrls.
  assert.equal("startUrls" in input, false);
  for (const term of input.searchTerms) {
    assert.ok(term.split(" ").length <= 4, `not a short phrase: "${term}"`);
  }
});

test("the seven-day window is exact", () => {
  const span = Date.parse(WINDOW.until) - Date.parse(WINDOW.since);
  assert.equal(span, 7 * 86_400_000);
});

const post = {
  id: "t3_aaa",
  type: "post",
  title: "Parental controls on Android TV?",
  body: "My kids watch youtube on the tv for hours.",
  subreddit: "r/AndroidTV",
  author: "parent_one",
  url: "/r/AndroidTV/comments/aaa/parental_controls",
  createdAt: "2026-08-14T10:00:00.000Z",
  score: 12,
  numberOfComments: 4,
  searchTerm: "android tv parental control",
};

const comment = {
  id: "t1_bbb",
  type: "comment",
  postId: "t3_aaa",
  body: "Same here, nothing works on Google TV.",
  subreddit: "AndroidTV",
  author: "parent_two",
  url: "https://www.reddit.com/r/AndroidTV/comments/aaa/x/bbb",
  createdUtc: 1786000000,
  score: 3,
  searchTerm: "screen time tv",
};

test("posts and comments both normalize to the shared contract", () => {
  const { candidates, summary } = harshmaur.parseHarshmaurDataset([post, comment], {
    since: "2026-08-01T00:00:00.000Z",
  });
  assert.equal(candidates.length, 2);
  assert.equal(summary.posts, 1);
  assert.equal(summary.comments, 1);

  const [p, c] = candidates;
  assert.equal(p.kind, "post");
  assert.equal(p.subreddit, "AndroidTV", "the r/ prefix must be stripped");
  assert.equal(p.provider, "apify-harshmaur-reddit");
  assert.match(p.permalink, /^https:\/\/www\.reddit\.com\//, "relative urls must be absolute");
  assert.equal(c.kind, "comment");
  assert.equal(c.parentExternalId, "t3_aaa");
  // Epoch seconds are a Harshmaur-specific quirk.
  assert.match(c.createdAt, /^20\d\d-/);
});

test("searchTerm attribution is preserved verbatim, never inferred", () => {
  const { candidates } = harshmaur.parseHarshmaurDataset([post, comment], {
    since: "2026-08-01T00:00:00.000Z",
  });
  assert.deepEqual(candidates[0].matchedQueries, ["android tv parental control"]);
  assert.deepEqual(candidates[1].matchedQueries, ["screen time tv"]);
});

test("a record found by several terms keeps every attribution once", () => {
  const { candidates, summary } = harshmaur.parseHarshmaurDataset(
    [post, { ...post, searchTerm: "kids watching tv" }],
    { since: "2026-08-01T00:00:00.000Z" },
  );
  assert.equal(candidates.length, 1, "duplicates must collapse by external id");
  assert.deepEqual(candidates[0].matchedQueries.sort(), [
    "android tv parental control",
    "kids watching tv",
  ]);
  assert.equal(summary.rawRecords, 2);
});

test("our own timestamp check overrides the actor's filtering", () => {
  const stale = { ...post, id: "t3_old", createdAt: "2026-07-01T00:00:00.000Z" };
  const { candidates, summary } = harshmaur.parseHarshmaurDataset([stale], {
    since: WINDOW.since,
    until: WINDOW.until,
  });
  assert.deepEqual(candidates, []);
  assert.equal(summary.droppedByReason.outside_window, 1);
});

test("malformed records are dropped with a reason rather than crashing", () => {
  const junk = [
    null,
    "not an object",
    { id: "t3_x" },
    { id: "t3_y", body: "hi", subreddit: "AndroidTV" },
    { id: "t3_z", body: "hi", subreddit: "AndroidTV", createdAt: "2026-08-14T10:00:00.000Z" },
    { ...post, id: "t3_bot", author: "AutoModerator" },
  ];
  const { candidates, summary } = harshmaur.parseHarshmaurDataset(junk, {
    since: "2026-08-01T00:00:00.000Z",
  });
  assert.equal(candidates.length, 0);
  assert.ok(summary.droppedByReason.invalid_record >= 1);
  assert.equal(summary.droppedByReason.missing_timestamp, 1);
  assert.equal(summary.droppedByReason.invalid_url, 1);
  assert.equal(summary.droppedByReason.bot_author, 1);
});

test("per-term raw yield is reported for the A/B comparison", () => {
  const { summary } = harshmaur.parseHarshmaurDataset([post, comment, comment], {
    since: "2026-08-01T00:00:00.000Z",
  });
  assert.equal(summary.rawByTerm["android tv parental control"], 1);
  assert.equal(summary.rawByTerm["screen time tv"], 2);
});
