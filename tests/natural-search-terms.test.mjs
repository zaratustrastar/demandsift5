import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

/**
 * Reddit search matches what people actually type. The Trudax planner emits
 * intent-shaped sentences like "looking for android tv parental control app",
 * which no title contains, so recall collapses. These terms must stay short,
 * natural and market-anchored; classification happens afterwards.
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
let src = await readFile(new URL("../lib/providers/reddit-natural-queries.ts", import.meta.url), "utf8");
src = src.replaceAll('"@/lib/providers/contracts"', JSON.stringify(stub))
         .replaceAll('"@/lib/intelligence/opportunity-ranking"', JSON.stringify(ranking));
const { naturalSearchTerms } = await import(u(cc(src, "n.ts")));

const tvcp = {
  queries: {
    productCategories: ["Android TV parental control app"],
    customerProblems: [
      "kids watching TV too long",
      "no parental controls on Android TV",
      "kids watching YouTube on the TV unsupervised",
      "block youtube on the tv",
    ],
    jobsToBeDone: ["limit screen time on the television"],
    competitors: ["Google Family Link"],
    productTerms: ["TVCP"],
  },
};

test("terms are short natural phrases, never intent sentences", () => {
  for (const term of naturalSearchTerms(tvcp)) {
    const words = term.split(" ");
    assert.ok(words.length >= 2 && words.length <= 4, `not short: "${term}"`);
    for (const banned of ["looking", "recommendations", "need", "should", "please"]) {
      assert.ok(!words.includes(banned), `intent-shaped word "${banned}" in "${term}"`);
    }
  }
});

test("the market qualifier survives and is paired with problem concepts", () => {
  const terms = naturalSearchTerms(tvcp);
  assert.ok(terms.some((t) => /\btv\b/.test(t)), "no term carries the market qualifier");
  // The parental-controls concept must reach the market qualifier in some
  // short form. The exact wording depends on how much of the source
  // sentence's own contiguous phrasing survives condensing -- "parental
  // controls tv" and "parental controls android tv" are both good retrieval
  // phrases, so the assertion checks the concept, not one exact string.
  assert.ok(
    terms.some((t) => /\btv\b/.test(t) && /parental control/.test(t)),
    `no parental-controls term paired with the market: ${terms.join(" | ")}`,
  );
  // The screen-time concept must reach the market qualifier in some short
  // form; "limit screen tv" and "screen time tv" are both good retrieval
  // phrases, so the assertion checks the concept, not one exact wording.
  assert.ok(
    terms.some((t) => /\btv\b/.test(t) && /(screen|time|limit)/.test(t)),
    `no screen-time term paired with the market: ${terms.join(" | ")}`,
  );
});

test("competitor names become their own terms, including single words", () => {
  assert.ok(naturalSearchTerms(tvcp).includes("google family link"));
  const single = naturalSearchTerms({
    queries: { productCategories: ["HR onboarding software"], customerProblems: ["hr paperwork takes weeks"], competitors: ["BambooHR"] },
  });
  assert.ok(single.includes("bamboohr"), "a one-word brand is still a valid search term");
});

test("terms are deduplicated and bounded", () => {
  const terms = naturalSearchTerms(tvcp, { maxTerms: 6 });
  assert.ok(terms.length <= 6);
  assert.equal(new Set(terms).size, terms.length);
});

test("an empty profile yields no terms rather than junk", () => {
  assert.deepEqual(naturalSearchTerms({ queries: {} }), []);
});
