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

test("generates plain reviewed phrases with no added boolean operators or quoting", () => {
  const families = redditQueryFamilies(tvcp);
  assert.ok(families.length > 0);
  for (const family of families) {
    assert.equal(containsBooleanOrQuoting(family.query), false, `unexpected structure in: ${family.query}`);
  }
});

test("preserves the exact reviewed phrase, including capitalization", () => {
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
  assert.equal(category.query, "Android TV parental control");
});

test("uses the profile phrase verbatim rather than mechanically rewriting it", () => {
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
  assert.equal(pain.query, "I can't figure out how to limit how long my kid watches TV every single day");
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
  assert.equal(competitor.query, "Bark");
});

test("single-word product and pain phrases are searched when the user approved them", () => {
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
  assert.deepEqual(families.map((family) => family.query), ["tvcp", "frustrated"]);
});

test("an approved ambiguous phrase is preserved and left to downstream relevance filtering", () => {
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
  assert.equal(collision?.query, "youtube on the tv never stops autoplaying");
  assert.equal(families.some((f) => /\bnot\b/.test(f.query)), false, "no query should ever contain a not clause");
});

test("deduplicates case-insensitively without rewriting the first approved phrase", () => {
  const families = redditQueryFamilies({
    queries: {
      productTerms: [],
      productCategories: ["Android TV Parental Control", "android tv parental control"],
      customerProblems: [],
      buyerIntent: [],
      competitors: [],
      excludedTerms: [],
    },
    limit: 100,
  });
  assert.equal(families.length, 1);
  assert.equal(families[0].query, "Android TV Parental Control");
});

test("contractions and punctuation remain exactly as reviewed", () => {
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
  assert.equal(families[0].query, "can't lock the TV remotely when guests are over");
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
