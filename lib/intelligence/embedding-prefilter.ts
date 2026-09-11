/**
 * Embedding prefilter.
 *
 * Acquisition now retrieves 200-300 candidates, so sending every deterministic
 * survivor to LLM relevance classification is no longer affordable. Embeddings
 * were previously removed from this pipeline for a good reason: at 30-50
 * candidates they added cost without value, and using cosine similarity as a
 * relevance *decision* loses indirectly expressed pain, which is exactly the
 * demand worth finding.
 *
 * So this layer never decides relevance. It orders candidates and removes only
 * the obviously unrelated tail, deliberately preserving a generous pool for the
 * LLM to judge. Every threshold here is biased towards recall: when in doubt the
 * candidate is kept, and when embeddings are unavailable nothing is dropped.
 */

export interface PrefilterCandidateInput {
  externalId: string;
  /** Cosine similarity to the business profile, or null when unavailable. */
  similarity: number | null;
}

export interface PrefilterOptions {
  /** Maximum candidates forwarded to LLM classification. */
  budget: number;
  /**
   * Similarity at or below which a candidate is considered obviously
   * unrelated. Intentionally low - this is a junk filter, not a relevance bar.
   */
  floor: number;
  /**
   * Never shrink the pool below this many candidates, however poorly the
   * business profile embeds. Guards against a bad profile vector silently
   * emptying the funnel.
   */
  minimumPool: number;
}

export interface PrefilterOutcome {
  retained: string[];
  dropped: string[];
  diagnostics: {
    scored: number;
    unscored: number;
    droppedBelowFloor: number;
    droppedOverBudget: number;
    retained: number;
    /** Lowest similarity that survived, for tuning the floor from real runs. */
    retainedMinimumSimilarity: number | null;
  };
}

export const DEFAULT_PREFILTER_FLOOR = 0.12;

export function cosineSimilarity(left: readonly number[], right: readonly number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] * left[index];
    rightMagnitude += right[index] * right[index];
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

/**
 * Order candidates by similarity and trim only the tail.
 *
 * A candidate with no similarity score is always retained: a missing embedding
 * is a failure of this layer, never evidence about the conversation.
 */
export function prioritizeCandidates(
  candidates: readonly PrefilterCandidateInput[],
  options: PrefilterOptions,
): PrefilterOutcome {
  const budget = Math.max(1, Math.trunc(options.budget));
  const minimumPool = Math.max(1, Math.trunc(options.minimumPool));

  const unscored = candidates.filter((candidate) => candidate.similarity === null);
  const scored = candidates
    .filter((candidate) => candidate.similarity !== null)
    .sort((left, right) => (right.similarity ?? 0) - (left.similarity ?? 0));

  // Unscored candidates are never dropped, so they consume budget first.
  const remainingBudget = Math.max(0, budget - unscored.length);

  const aboveFloor = scored.filter((candidate) => (candidate.similarity ?? 0) > options.floor);
  const belowFloor = scored.filter((candidate) => (candidate.similarity ?? 0) <= options.floor);

  const keptScored = aboveFloor.slice(0, remainingBudget);
  const droppedOverBudget = aboveFloor.slice(remainingBudget);

  // Backfill from the sub-floor tail only if the pool would otherwise be too
  // small to be a credible sample of what was retrieved.
  const shortfall = Math.max(
    0,
    Math.min(minimumPool, budget) - (unscored.length + keptScored.length),
  );
  const backfilled = belowFloor.slice(0, shortfall);
  const droppedBelowFloor = belowFloor.slice(shortfall);

  const retainedEntries = [...unscored, ...keptScored, ...backfilled];
  const retainedSimilarities = retainedEntries
    .map((candidate) => candidate.similarity)
    .filter((value): value is number => value !== null);

  return {
    retained: retainedEntries.map((candidate) => candidate.externalId),
    dropped: [...droppedOverBudget, ...droppedBelowFloor].map((candidate) => candidate.externalId),
    diagnostics: {
      scored: scored.length,
      unscored: unscored.length,
      droppedBelowFloor: droppedBelowFloor.length,
      droppedOverBudget: droppedOverBudget.length,
      retained: retainedEntries.length,
      retainedMinimumSimilarity:
        retainedSimilarities.length > 0 ? Math.min(...retainedSimilarities) : null,
    },
  };
}
