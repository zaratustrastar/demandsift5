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

test("known-ambiguous youtube+tv pairing is dropped, never negated with NOT", () => {
  // A problem phrase engineered so its core is literally "youtube", so a
  // family pairing it with the bare "tv" market qualifier is guaranteed.
  // The Discovery Profile no longer surfaces an exclusions concept, so this
  // file must never emit a NOT clause -- the colliding pairing is simply
  // dropped instead of negated.
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
  const collision = families.find((f) => /\byoutube\b/i.test(f.query) && /\btv\b/i.test(f.query));
  assert.equal(
    collision,
    undefined,
    `expected the youtube+tv collision to be dropped, got: ${JSON.stringify(families)}`,
  );
  assert.equal(
    families.some((f) => /\bNOT\b/.test(f.query)),
    false,
    "no query should ever contain a NOT clause",
  );
});

test("excludedTerms do not get compiled into a blanket NOT clause on every query", () => {
  // An earlier version appended the same NOT (...) block built from
  // excludedTerms to every single family. A real production run showed
  // this bloats every query with ~15 extra encoded words regardless of
  // relevance, for little practical benefit -- AI triage downstream
  // already hard-rejects obvious noise, so this was removed. excludedTerms
  // simply has no effect on the generated queries now; the known-ambiguous
  // youtube+tv exclusion above is a separate, narrowly targeted mechanism
  // that is unaffected by this.
  const withExclusions = redditQueryFamilies(tvcp);
  const withoutExclusions = redditQueryFamilies({
    queries: { ...tvcp.queries, excludedTerms: [] },
    limit: 100,
  });
  assert.deepEqual(
    withExclusions.map((f) => f.query),
    withoutExclusions.map((f) => f.query),
  );
  assert.equal(withExclusions.some((f) => /\bNOT\b.*hulu|hulu.*\bNOT\b/i.test(f.query)), false);
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

test("word-order permutations of the same broad phrase collapse into a single query", () => {
  // naturalSearchTerms deliberately emits both "core qualifier" and
  // "qualifier core" for a pairing (real behavior: "kid watches tv" and
  // "tv kid watches" for this fixture) because both read naturally on
  // their own. That is fine when there is room for many terms, but when
  // only a handful of query slots exist per scan, two orderings of the
  // same idea burns a slot without adding recall -- a real production run
  // spent two of its seven startUrls this way.
  const fixture = {
    queries: {
      productCategories: ["Android TV parental control app"],
      customerProblems: ["kid watches shows constantly"],
      jobsToBeDone: [],
      buyerIntent: [],
      competitors: [],
      excludedTerms: [],
    },
    limit: 100,
  };
  const families = redditQueryFamilies(fixture);
  const plainQueries = families
    .map((f) => f.query)
    .filter((q) => !/[()"]/.test(q) && !/\b(AND|OR|NOT)\b/.test(q));
  const signatures = plainQueries.map((q) => q.toLowerCase().split(" ").sort().join(" "));
  assert.equal(
    new Set(signatures).size,
    signatures.length,
    `expected no word-order duplicates among: ${JSON.stringify(plainQueries)}`,
  );
  assert.ok(plainQueries.length > 0, "expected at least one plain broad query to survive dedup");
});

test("contractions collapse into one word instead of leaving an orphan letter behind", () => {
  // A real production run generated queries like "t lock the tv remotely"
  // and "child s" -- normalizeSearchText was turning "can't" into "can t"
  // and "child's" into "child s", and nothing downstream recognized the
  // stray "t"/"s" as junk once "can" (a real filler word) was stripped.
  const fixture = {
    queries: {
      productCategories: ["Android TV parental control app"],
      customerProblems: ["can't lock the TV remotely when guests are over"],
      jobsToBeDone: ["prevent my child's access to certain apps"],
      buyerIntent: [],
      competitors: [],
      excludedTerms: [],
    },
    limit: 100,
  };
  const families = redditQueryFamilies(fixture);
  for (const family of families) {
    const tokens = family.query.toLowerCase().replace(/[()"]/g, " ").split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      assert.notEqual(token, "t", `orphaned contraction fragment in: ${family.query}`);
      assert.notEqual(token, "s", `orphaned contraction fragment in: ${family.query}`);
    }
  }
  assert.ok(
    families.some((f) => /\bcant\b/.test(f.query.toLowerCase())),
    `expected "can't" to collapse to "cant" somewhere, got: ${JSON.stringify(families)}`,
  );
  assert.ok(
    families.some((f) => /\bchilds\b/.test(f.query.toLowerCase())),
    `expected "child's" to collapse to "childs" somewhere, got: ${JSON.stringify(families)}`,
  );
});


test("quoted problem/job phrases are full natural excerpts, never bare two-word fragments", () => {
  // A real production run generated meaningless *quoted, standalone* boolean
  // terms like "cant lock" (from "can't lock the TV remotely...") and
  // "limit long" (from "limit how long my kid watches..."), because the old
  // condense() picked the first two filler-filtered words regardless of
  // where they fell in the sentence, then quoted that pair as an exact
  // phrase. Quoted cores must now be a longer contiguous slice from the
  // sentence's own start, so a quoted term reads as an actual excerpt of
  // what was written rather than an arbitrary two-word pick. This is
  // specifically about *quoted* terms: an unquoted, unpunctuated broad
  // phrase (a different lane, a different purpose -- compressed retrieval
  // keywords, not an exact-phrase claim) is out of scope here.
  const fixture = {
    queries: {
      productCategories: ["Android TV parental control app"],
      customerProblems: [
        "can't lock the TV remotely when guests are over",
        "limit how long my kid watches TV every day",
      ],
      jobsToBeDone: [],
      buyerIntent: [],
      competitors: [],
      excludedTerms: [],
    },
    limit: 100,
  };
  const families = redditQueryFamilies(fixture);
  const quotedTerms = families
    .flatMap((f) => [...f.query.matchAll(/"([^"]+)"/g)].map((m) => m[1].toLowerCase()));
  for (const bareFragment of ["cant lock", "limit long"]) {
    assert.equal(
      quotedTerms.includes(bareFragment),
      false,
      `expected no bare quoted fragment "${bareFragment}" among quoted terms: ${JSON.stringify(quotedTerms)}`,
    );
  }
  assert.ok(
    quotedTerms.some((term) => term.startsWith("cant lock the tv remotely")),
    `expected a genuine quoted excerpt of the sentence to survive, got: ${JSON.stringify(quotedTerms)}`,
  );
});
