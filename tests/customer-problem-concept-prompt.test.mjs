import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * Pins the analyzeBusiness prompt's instructions for customerProblemLanguage
 * to the search-concept architecture: the AI must decide, per problem,
 * whether the wording alone identifies the market or needs the smallest
 * useful category anchor attached -- and must hand back the exact phrase to
 * search, since downstream code (redditQueryFamilies) only normalizes
 * whitespace/case and URL-encodes verbatim. It does no truncation, stopword
 * removal or semantic rewriting of its own. A regression here (reverting to
 * "just describe the lived problem naturally" with no anchoring guidance)
 * would silently reintroduce ambiguous, decontextualized Reddit searches.
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

test("the prompt gives the explicit self-identifying-vs-ambiguous anchoring rule", () => {
  assert.match(
    source,
    /decide first whether the problem wording alone already identifies the market/,
  );
  assert.match(
    source,
    /attach the smallest useful market\/category anchor/,
  );
});

test("the prompt forbids boolean operators, quoting and generic filler as a stand-in for the real problem", () => {
  assert.match(source, /Never output Boolean operators, quotes/);
});
