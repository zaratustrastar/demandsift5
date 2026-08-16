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

test("actor input matches the real Harshmaur schema", () => {
  const input = harshmaur.buildHarshmaurInput(tvcp, { targetTotal: 250, now: NOW });
  assert.equal(input.searchPosts, true);
  assert.equal(input.searchComments, true);
  assert.equal(input.searchCommunities, false);
  // "relevance" re-ranks across all time and would smuggle in records from
  // outside the seven-day window we asked for.
  assert.equal(input.searchSort, "new");
  assert.equal(input.searchTime, "week");
  assert.equal(input.postedAfter, WINDOW.since);
  assert.equal(input.commentedAfter, WINDOW.since);
  assert.equal(input.crawlCommentsPerPost, false);
  assert.equal(input.includeNSFW, false);
  assert.equal(input.maxCommentsPerPost, 0);
  assert.equal(input.maxCommunitiesCount, 0);
  assert.ok(input.maxPostsCount > 0 && input.maxCommentsCount > 0);
  // maxItems is a platform-level guard, never an actor input field.
  assert.equal("maxItems" in input, false);
  assert.equal("startUrls" in input, false);
  for (const term of input.searchTerms) {
    assert.ok(term.split(" ").length <= 4, `not a short phrase: "${term}"`);
  }
});

test("per-term budgets keep total acquisition comparable to Trudax", () => {
  // The actor applies these caps per search term, so passing the full target
  // through would multiply spend by the number of terms.
  for (const [target, terms] of [[250, 12], [250, 4], [100, 10], [40, 1]]) {
    const { maxPostsCount, maxCommentsCount } = harshmaur.harshmaurPerTermBudget(target, terms);
    const projected = (maxPostsCount + maxCommentsCount) * terms;
    assert.ok(maxPostsCount >= 1 && maxCommentsCount >= 1);
    assert.ok(
      projected >= target && projected <= target * 2.5,
      `budget ${maxPostsCount}/${maxCommentsCount} x ${terms} = ${projected} for target ${target}`,
    );
  }
});

test("both posts and comments are budgeted so comment search is exercised", () => {
  const input = harshmaur.buildHarshmaurInput(tvcp, { targetTotal: 250, now: NOW });
  assert.ok(input.maxCommentsCount >= 1, "comment search must not be starved to zero");
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


/* ------------------------------------------------------------------ *
 * Fixtures using the actor's real documented output shapes.
 * These replaced hand-invented field names that silently disagreed with
 * production data: comments carry `commentCreatedAt`, posts carry
 * `commentsCount`, and both use `authorName`/`subredditName`.
 * ------------------------------------------------------------------ */

const recentIso = (daysAgo) =>
  new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();

const realComment = {
  dataType: "comment",
  id: "t1_real1",
  body: "We had the same problem, nothing on Google TV lets you cap it.",
  authorName: "parent_real",
  subredditName: "AndroidTV",
  postId: "t3_realpost",
  parentId: "t3_realpost",
  url: "https://www.reddit.com/r/AndroidTV/comments/realpost/x/real1/",
  score: 7,
  commentCreatedAt: recentIso(2),
  searchTerm: "screen time tv",
};

const realPost = {
  dataType: "post",
  id: "t3_realpost",
  title: "Any parental control that works on Android TV?",
  body: "The kids watch youtube on the tv all evening and I cannot limit it.",
  authorName: "parent_two",
  communityName: "r/AndroidTV",
  subredditName: "AndroidTV",
  score: 23,
  commentsCount: 14,
  postUrl: "https://www.reddit.com/r/AndroidTV/comments/realpost/any_parental_control/",
  createdAt: recentIso(3),
  searchTerm: "android tv parental control",
};

test("a real comment record parses and stays inside the 7-day window", () => {
  const { candidates, summary } = harshmaur.parseHarshmaurDataset([realComment], {
    since: WINDOW.since,
    until: WINDOW.until,
  });
  assert.equal(summary.droppedByReason.missing_timestamp, undefined,
    "commentCreatedAt must be recognised as the comment timestamp");
  assert.equal(candidates.length, 1, "the real comment shape must survive parsing");

  const [candidate] = candidates;
  assert.equal(candidate.kind, "comment");
  assert.equal(candidate.externalId, "t1_real1");
  assert.equal(candidate.author, "parent_real");
  assert.equal(candidate.subreddit, "AndroidTV");
  assert.equal(candidate.parentExternalId, "t3_realpost");
  assert.equal(candidate.metrics.score, 7);
  assert.deepEqual(candidate.matchedQueries, ["screen time tv"]);

  const created = Date.parse(candidate.createdAt);
  assert.ok(created >= Date.parse(WINDOW.since) && created <= Date.parse(WINDOW.until),
    "parsed timestamp must fall inside the seven-day window");
});

test("a real post record preserves engagement from commentsCount", () => {
  const { candidates } = harshmaur.parseHarshmaurDataset([realPost], {
    since: WINDOW.since,
    until: WINDOW.until,
  });
  assert.equal(candidates.length, 1);
  const [candidate] = candidates;
  assert.equal(candidate.kind, "post");
  assert.equal(candidate.title, "Any parental control that works on Android TV?");
  assert.equal(candidate.author, "parent_two");
  assert.equal(candidate.subreddit, "AndroidTV", "communityName carries an r/ prefix");
  assert.equal(candidate.metrics.score, 23);
  assert.equal(candidate.metrics.comments, 14, "commentsCount must not be lost");
  assert.match(candidate.permalink, /^https:\/\/www\.reddit\.com\//);
  assert.deepEqual(candidate.matchedQueries, ["android tv parental control"]);
});

test("a real mixed post+comment dataset yields both kinds", () => {
  const { candidates, summary } = harshmaur.parseHarshmaurDataset([realPost, realComment], {
    since: WINDOW.since,
    until: WINDOW.until,
  });
  assert.equal(candidates.length, 2);
  assert.equal(summary.posts, 1);
  assert.equal(summary.comments, 1);
  assert.deepEqual(Object.keys(summary.droppedByReason), [],
    "no real record may be dropped");
});

test("the actor id is normalized to Apify's tilde path form", () => {
  assert.equal(harshmaur.harshmaurActorId("harshmaur/reddit-scraper"), "harshmaur~reddit-scraper");
  assert.equal(harshmaur.harshmaurActorId("harshmaur~reddit-scraper"), "harshmaur~reddit-scraper");
  assert.throws(() => harshmaur.harshmaurActorId("not a valid id!"));
});
