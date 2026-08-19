import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

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

let src = await readFile(here("../lib/providers/reddit-query-families.ts"), "utf8");
src = src
  .replaceAll('"@/lib/domain/types"', JSON.stringify(stub))
  .replaceAll('"@/lib/providers/contracts"', JSON.stringify(stub))
  .replaceAll('"@/lib/intelligence/opportunity-ranking"', JSON.stringify(ranking))
  .replaceAll('"@/lib/providers/reddit-natural-queries"', JSON.stringify(natural));
const { redditQueryFamilies } = await import(u(cc(src, "f.ts")));

const tvcp = {
  queries: {
    productTerms: ["TVCP"],
    productCategories: ["Android TV parental control app"],
    customerProblems: [
      "kids watching TV too long",
      "no parental controls on Android TV",
      "kids watching YouTube on the TV unsupervised",
    ],
    jobsToBeDone: ["limit screen time on the television", "lock the tv menu"],
    buyerIntent: ["looking for a parental control app for TV", "best screen time app recommendations"],
    competitors: ["Google Family Link", "Bark"],
    excludedTerms: ["youtube tv service", "hulu"],
  },
  limit: 100,
};

test("produces a mix of lanes, not just one query style", () => {
  const families = redditQueryFamilies(tvcp);
  const lanes = new Set(families.map((f) => f.lane));
  assert.ok(lanes.size >= 3, `expected several distinct lanes, got: ${[...lanes]}`);
  assert.ok(families.length >= 5, `expected several queries, got ${families.length}`);
});

test("includes at least one broad plain-phrase query and one precise boolean query", () => {
  const families = redditQueryFamilies(tvcp);
  // Exclusions (NOT ...) are a legitimate overlay on every family, including
  // broad ones, so "plain" here means the query has no AND/OR structure of
  // its own before that overlay -- strip it before judging shape.
  const withoutExclusion = (q) => q.replace(/\s+NOT\s+\(.*\)\s*$/, "").replace(/\s+NOT\s+"[^"]*"\s*$/, "");
  const queries = families.map((f) => withoutExclusion(f.query));
  assert.ok(queries.some((q) => !/[()]/.test(q) && !/\bAND\b|\bOR\b/.test(q)), "no broad plain query found");
  assert.ok(queries.some((q) => /\bAND\b/.test(q) && q.includes("(")), "no precise boolean query found");
});

test("pain queries quote the customer's own phrase rather than reducing it to keywords", () => {
  const families = redditQueryFamilies(tvcp);
  const pain = families.filter((f) => f.lane === "pain");
  assert.ok(pain.length > 0);
  for (const family of pain) {
    assert.match(family.query, /^"[^"]+"/, `pain query must open with a quoted phrase: ${family.query}`);
  }
});

test("competitor families only appear when the profile actually names competitors", () => {
  const withCompetitors = redditQueryFamilies(tvcp);
  assert.ok(withCompetitors.some((f) => f.lane === "brand_competitor_mentions"));
  assert.ok(withCompetitors.some((f) => f.lane === "switching"));

  const noCompetitors = redditQueryFamilies({
    queries: { ...tvcp.queries, competitors: [] },
    limit: 100,
  });
  assert.equal(noCompetitors.some((f) => f.lane === "brand_competitor_mentions"), false);
  assert.equal(noCompetitors.some((f) => f.lane === "switching"), false);
});

test("failure/weakness queries combine competitors with generic complaint language", () => {
  const families = redditQueryFamilies(tvcp);
  const weakness = families.find((f) => f.lane === "switching");
  assert.ok(weakness);
  assert.match(weakness.query, /\b(problem|bypass|limit|alternative)\b/);
  assert.match(weakness.query, /Family Link|Bark/i);
});

test("known-ambiguous youtube+tv pairing is excluded rather than dropped outright", () => {
  // A problem phrase engineered so its condensed core is literally "youtube",
  // so a family pairing it with the bare "tv" market qualifier is guaranteed.
  const fixture = {
    queries: {
      productCategories: ["Android TV parental control app"],
      customerProblems: ["youtube autoplay never stops"],
      jobsToBeDone: [],
      buyerIntent: [],
      competitors: [],
      excludedTerms: [],
    },
    limit: 100,
  };
  const families = redditQueryFamilies(fixture);
  const hit = families.find((f) => /\byoutube\b/i.test(f.query) && /\btv\b/i.test(f.query));
  assert.ok(hit, `expected a youtube+tv query to be generated, got: ${JSON.stringify(families)}`);
  assert.match(hit.query, /NOT "youtube tv"/);
});

test("excludedTerms become a NOT clause instead of being silently ignored", () => {
  const families = redditQueryFamilies(tvcp);
  assert.ok(
    families.some((f) => /\bNOT\b/.test(f.query) && /hulu|youtube tv service/i.test(f.query)),
    "expected at least one query to exclude the profile's excludedTerms",
  );

  const noExclusions = redditQueryFamilies({
    queries: { ...tvcp.queries, excludedTerms: [] },
    limit: 100,
  });
  assert.equal(noExclusions.some((f) => /\bhulu\b/i.test(f.query)), false);
});

test("bounded and deduplicated by maxQueries", () => {
  const bounded = redditQueryFamilies(tvcp, { maxQueries: 3 });
  assert.ok(bounded.length <= 3);
  const queries = bounded.map((f) => f.query.toLowerCase());
  assert.equal(new Set(queries).size, queries.length, "no duplicate queries");
});

test("an empty profile produces no queries rather than fabricating one", () => {
  const empty = redditQueryFamilies({
    queries: {
      productTerms: [], customerProblems: [], competitors: [], excludedTerms: [],
      buyerIntent: [],
    },
    limit: 100,
  });
  assert.deepEqual(empty, []);
});

test("query strings only ever use uppercase AND/OR/NOT, matching Reddit's case-sensitive operator syntax", () => {
  const families = redditQueryFamilies(tvcp);
  for (const family of families) {
    assert.equal(/\b(and|or|not)\b/.test(family.query), false, `lowercase operator leaked: ${family.query}`);
  }
});
