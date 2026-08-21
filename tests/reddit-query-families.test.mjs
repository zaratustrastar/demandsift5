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

let src = await readFile(here("../lib/providers/reddit-query-families.ts"), "utf8");
src = src
  .replaceAll('"@/lib/domain/types"', JSON.stringify(stub))
  .replaceAll('"@/lib/providers/contracts"', JSON.stringify(stub))
  .replaceAll('"@/lib/intelligence/opportunity-ranking"', JSON.stringify(ranking));
const { redditQueryFamilies } = await import(u(cc(src, "f.ts")));

const tvcp = {
  queries: {
    productTerms: ["TVCP"],
    productCategories: ["Android TV parental control app", "kids screen time app"],
    customerProblems: [
      "kids watching TV too long",
      "no parental controls on Android TV",
      "kids watching YouTube on the TV unsupervised",
      "cant figure out how to set a bedtime limit",
    ],
    jobsToBeDone: ["limit screen time on the television", "lock the tv menu"],
    buyerIntent: ["looking for a parental control app for TV", "best screen time app recommendations"],
    competitors: ["Google Family Link", "Bark", "Qustodio"],
    excludedTerms: ["youtube tv service", "hulu"],
  },
  limit: 100,
};

const containsBooleanOrQuoting = (q) =>
  /["()]/.test(q) || /\b(AND|OR|NOT|and|or|not)\b/.test(q);

test("generates plain, lowercase natural-language queries with no boolean operators or quoting", () => {
  const families = redditQueryFamilies(tvcp);
  assert.ok(families.length > 0);
  for (const family of families) {
    assert.equal(containsBooleanOrQuoting(family.query), false, `unexpected structure in: ${family.query}`);
    assert.equal(family.query, family.query.toLowerCase(), `expected lowercase: ${family.query}`);
  }
});

test("matches the exact example from the spec: profile phrase to plain query", () => {
  const families = redditQueryFamilies({
    queries: {
      productTerms: [],
      productCategories: ["Android TV parental control"],
      customerProblems: [],
      buyerIntent: [],
      competitors: [],
      excludedTerms: [],
    },
    limit: 100,
  });
  const category = families.find((f) => f.lane === "category_recommendation");
  assert.ok(category, `expected a category_recommendation query, got: ${JSON.stringify(families)}`);
  assert.equal(category.query, "android tv parental control");
});

test("uses the profile phrase close to verbatim rather than mechanically shortening it", () => {
  // normalizeSearchText only lowercases and strips punctuation/diacritics --
  // no word-count truncation, no filler-word removal, no reordering. A long
  // source phrase should survive with every word intact.
  const families = redditQueryFamilies({
    queries: {
      productTerms: [],
      productCategories: [],
      customerProblems: ["I can't figure out how to limit how long my kid watches TV every single day"],
      buyerIntent: [],
      competitors: [],
      excludedTerms: [],
    },
    limit: 100,
  });
  const pain = families.find((f) => f.lane === "pain");
  assert.ok(pain);
  assert.equal(pain.query, "i cant figure out how to limit how long my kid watches tv every single day");
});

test("enforces per-bucket caps: max 3 product/category, max 3 pain, max 3 competitor", () => {
  const families = redditQueryFamilies({
    queries: {
      productTerms: ["term one", "term two", "term three", "term four", "term five"],
      productCategories: ["category one", "category two", "category three", "category four"],
      customerProblems: ["pain one", "pain two", "pain three", "pain four", "pain five"],
      buyerIntent: [],
      competitors: ["Alpha Corp", "Beta Corp", "Gamma Corp", "Delta Corp"],
      excludedTerms: [],
    },
    limit: 100,
  });
  const byLane = (lane) => families.filter((f) => f.lane === lane);
  assert.ok(byLane("category_recommendation").length <= 3, `too many product/category queries: ${byLane("category_recommendation").length}`);
  assert.ok(byLane("pain").length <= 3, `too many pain queries: ${byLane("pain").length}`);
  assert.ok(byLane("brand_competitor_mentions").length <= 3, `too many competitor queries: ${byLane("brand_competitor_mentions").length}`);
  assert.ok(families.length <= 9, `expected at most 9 total queries, got ${families.length}`);
});

test("category phrases are prioritized over product terms when both compete for the product/category cap", () => {
  const families = redditQueryFamilies({
    queries: {
      productTerms: ["term alpha", "term beta"],
      productCategories: ["category one", "category two", "category three"],
      customerProblems: [],
      buyerIntent: [],
      competitors: [],
      excludedTerms: [],
    },
    limit: 100,
  });
  const productish = families.filter((f) => f.lane === "category_recommendation").map((f) => f.query);
  assert.deepEqual(productish, ["category one", "category two", "category three"]);
});

test("a lone brand name is a valid competitor query even though it is a single word", () => {
  const families = redditQueryFamilies({
    queries: {
      productTerms: [],
      productCategories: [],
      customerProblems: [],
      buyerIntent: [],
      competitors: ["Bark"],
      excludedTerms: [],
    },
    limit: 100,
  });
  const competitor = families.find((f) => f.lane === "brand_competitor_mentions");
  assert.ok(competitor);
  assert.equal(competitor.query, "bark");
});

test("a single-word product or pain phrase is dropped rather than emitted as a bare word", () => {
  const families = redditQueryFamilies({
    queries: {
      productTerms: ["tvcp"],
      productCategories: [],
      customerProblems: ["frustrated"],
      buyerIntent: [],
      competitors: [],
      excludedTerms: [],
    },
    limit: 100,
  });
  assert.equal(families.length, 0);
});

test("known-ambiguous youtube+tv pairing is dropped, never negated with NOT", () => {
  const families = redditQueryFamilies({
    queries: {
      productTerms: [],
      productCategories: ["android tv parental control"],
      customerProblems: ["youtube on the tv never stops autoplaying"],
      buyerIntent: [],
      competitors: [],
      excludedTerms: [],
    },
    limit: 100,
  });
  const collision = families.find((f) => /\byoutube\b/.test(f.query) && /\btv\b/.test(f.query));
  assert.equal(collision, undefined, `expected the youtube+tv collision to be dropped, got: ${JSON.stringify(families)}`);
  assert.equal(families.some((f) => /\bnot\b/.test(f.query)), false, "no query should ever contain a not clause");
});

test("deduplicates identical normalized queries across sources", () => {
  const families = redditQueryFamilies({
    queries: {
      productTerms: [],
      productCategories: ["Android TV Parental Control", "android tv parental control!"],
      customerProblems: [],
      buyerIntent: [],
      competitors: [],
      excludedTerms: [],
    },
    limit: 100,
  });
  assert.equal(families.length, 1);
});

test("contractions collapse into one word instead of leaving an orphan letter behind", () => {
  const families = redditQueryFamilies({
    queries: {
      productTerms: [],
      productCategories: [],
      customerProblems: ["can't lock the TV remotely when guests are over"],
      buyerIntent: [],
      competitors: [],
      excludedTerms: [],
    },
    limit: 100,
  });
  assert.equal(families.length, 1);
  const tokens = families[0].query.split(" ");
  assert.equal(tokens.includes("t"), false);
  assert.ok(tokens.includes("cant"));
});

test("maxQueries further bounds the natural per-bucket total", () => {
  const bounded = redditQueryFamilies(tvcp, { maxQueries: 3 });
  assert.ok(bounded.length <= 3);
  const queries = bounded.map((f) => f.query);
  assert.equal(new Set(queries).size, queries.length, "no duplicate queries");
});

test("an empty profile produces no queries rather than fabricating one", () => {
  const empty = redditQueryFamilies({
    queries: {
      productTerms: [],
      customerProblems: [],
      competitors: [],
      excludedTerms: [],
      buyerIntent: [],
    },
    limit: 100,
  });
  assert.deepEqual(empty, []);
});

test("excludedTerms have no effect on generated queries", () => {
  // The Discovery Profile's excludedTerms concept has no representation in
  // plain-text queries (there is no NOT to attach it to) -- this pins that
  // down explicitly so a future change doesn't silently start filtering or
  // appending based on it.
  const withExclusions = redditQueryFamilies(tvcp);
  const withoutExclusions = redditQueryFamilies({
    queries: { ...tvcp.queries, excludedTerms: [] },
    limit: 100,
  });
  assert.deepEqual(
    withExclusions.map((f) => f.query),
    withoutExclusions.map((f) => f.query),
  );
});
