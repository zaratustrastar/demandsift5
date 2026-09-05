import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Pins the analyzeBusiness prompt's instructions for customerProblemLanguage
 * to the search-concept architecture: the AI must decide, per problem,
 * whether the wording alone identifies the market or needs the smallest
 * natural market discriminator added -- semantically, not by mechanically
 * gluing productCategory onto a shortened complaint -- and must hand back
 * the exact phrase to search, since downstream code (redditQueryFamilies)
 * only normalizes whitespace/case and URL-encodes verbatim. It does no
 * truncation, stopword removal or semantic rewriting of its own. A
 * regression here (reverting to "just describe the lived problem naturally"
 * with no anchoring guidance, a fixed quota that invites padding, or
 * mechanical category-concatenation) would silently reintroduce ambiguous,
 * redundant, or padded Reddit searches.
 */

const source = await readFile(
  new URL("../lib/providers/openai.server.ts", import.meta.url),
  "utf8",
);

test("customerProblemLanguage prompt asks for search-ready concepts, not raw complaint sentences", () => {
  assert.match(source, /search-ready problem concepts/);
  assert.match(source, /not raw customer complaint sentences/);
});

test("the prompt tells the AI it owns the anchoring decision, not later code", () => {
  assert.match(
    source,
    /Downstream code only lowercases, strips punctuation and URL-encodes these verbatim/,
  );
  assert.match(
    source,
    /it does no stopword removal, truncation or semantic rewriting/,
  );
});

test("the prompt caps at up to 5 concepts and explicitly forbids padding with filler or near-duplicates", () => {
  assert.match(source, /up to 5 distinct search-ready problem concepts/);
  assert.match(
    source,
    /Never invent filler or near-duplicate variants of the same problem just to reach 5/,
  );
});

test("the prompt requires semantic composition, not mechanically concatenating productCategory onto the complaint", () => {
  assert.match(
    source,
    /decide first whether the problem wording alone already identifies the market/,
  );
  assert.match(
    source,
    /think semantically \(problem core \+ the minimum market discriminator that removes the ambiguity\), never mechanically/,
  );
  assert.match(
    source,
    /never repeat a word across the concept/,
  );
});

test("the prompt forbids boolean operators, quoting and generic filler as a stand-in for the real problem", () => {
  assert.match(source, /Never output Boolean operators, quotes/);
});
