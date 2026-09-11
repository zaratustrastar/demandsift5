import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

/**
 * The embedding prefilter exists to cut LLM cost on a 200-300 candidate corpus,
 * not to decide relevance. Embeddings overvalue topical similarity and miss
 * indirectly expressed pain, so every property tested here is a recall
 * guarantee: unscored candidates survive, the pool never collapses, and only
 * the obviously unrelated tail is removed.
 */

const source = await readFile(
  new URL("../lib/intelligence/embedding-prefilter.ts", import.meta.url),
  "utf8",
);
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  fileName: "embedding-prefilter.ts",
}).outputText;
const { cosineSimilarity, prioritizeCandidates, DEFAULT_PREFILTER_FLOOR } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

const options = (overrides = {}) => ({
  budget: 120,
  floor: DEFAULT_PREFILTER_FLOOR,
  minimumPool: 40,
  ...overrides,
});

function candidates(similarities) {
  return similarities.map((similarity, index) => ({
    externalId: `c${index}`,
    similarity,
  }));
}

test("cosine similarity is correct for known vectors", () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.ok(Math.abs(cosineSimilarity([1, 1], [1, 0]) - Math.SQRT1_2) < 1e-9);
  // Degenerate input must not produce NaN and poison the ranking.
  assert.equal(cosineSimilarity([], []), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 1]), 0);
  assert.equal(cosineSimilarity([1, 2, 3], [1, 2]), 0);
});

test("a candidate without a similarity score is never dropped", () => {
  // A missing embedding is a failure of this layer, not evidence about the post.
  const outcome = prioritizeCandidates(
    candidates([null, 0.9, null, 0.01]),
    options({ budget: 2, minimumPool: 1 }),
  );
  assert.ok(outcome.retained.includes("c0"));
  assert.ok(outcome.retained.includes("c2"));
  assert.equal(outcome.diagnostics.unscored, 2);
});

test("everything is retained when the pool fits the budget", () => {
  const outcome = prioritizeCandidates(
    candidates([0.4, 0.3, 0.2]),
    options({ budget: 10 }),
  );
  assert.equal(outcome.retained.length, 3);
  assert.deepEqual(outcome.dropped, []);
});

test("only the obviously unrelated tail is dropped", () => {
  const outcome = prioritizeCandidates(
    candidates([0.62, 0.44, 0.31, 0.02, 0.01]),
    options({ budget: 10, minimumPool: 1 }),
  );
  assert.deepEqual(outcome.retained, ["c0", "c1", "c2"]);
  assert.equal(outcome.diagnostics.droppedBelowFloor, 2);
  assert.equal(outcome.diagnostics.droppedOverBudget, 0);
});

test("a weakly matching corpus still yields a workable pool", () => {
  // If the business profile embeds poorly, every similarity can sit under the
  // floor. Emptying the funnel would turn a tuning artefact into a false zero,
  // so the minimum pool is backfilled from the best of a bad set.
  const outcome = prioritizeCandidates(
    candidates(Array.from({ length: 60 }, (_, index) => 0.1 - index * 0.001)),
    options({ budget: 120, minimumPool: 40 }),
  );
  assert.equal(outcome.retained.length, 40);
  // Backfill takes the strongest available, not an arbitrary slice.
  assert.equal(outcome.retained[0], "c0");
  assert.ok(outcome.diagnostics.retainedMinimumSimilarity !== null);
});

test("the budget caps the pool and keeps the strongest candidates", () => {
  const outcome = prioritizeCandidates(
    candidates(Array.from({ length: 300 }, (_, index) => 1 - index / 400)),
    options({ budget: 120 }),
  );
  assert.equal(outcome.retained.length, 120);
  assert.equal(outcome.retained[0], "c0");
  assert.equal(outcome.diagnostics.droppedOverBudget, 180);
  assert.equal(outcome.diagnostics.retained + outcome.dropped.length, 300);
});

test("unscored candidates consume budget before scored ones", () => {
  const input = [
    ...candidates([null, null, null]),
    { externalId: "scored-high", similarity: 0.9 },
    { externalId: "scored-low", similarity: 0.5 },
  ];
  const outcome = prioritizeCandidates(input, options({ budget: 4, minimumPool: 1 }));
  assert.equal(outcome.retained.length, 4);
  assert.ok(outcome.retained.includes("scored-high"));
  assert.ok(!outcome.retained.includes("scored-low"));
});

test("no candidate is silently lost or duplicated", () => {
  const outcome = prioritizeCandidates(
    candidates([0.8, null, 0.05, 0.42, 0.01, null, 0.19]),
    options({ budget: 3, minimumPool: 1 }),
  );
  const seen = [...outcome.retained, ...outcome.dropped];
  assert.equal(seen.length, 7, "retained + dropped must account for every candidate");
  assert.equal(new Set(seen).size, 7, "a candidate must not appear twice");
});

test("an empty corpus is handled without throwing", () => {
  const outcome = prioritizeCandidates([], options());
  assert.deepEqual(outcome.retained, []);
  assert.equal(outcome.diagnostics.retainedMinimumSimilarity, null);
});
