import type { RedditSearchLane } from "@/lib/domain/types";
import type { RedditSearchRequest } from "@/lib/providers/contracts";

/**
 * Reddit-native search-query expressions for Harshmaur's Direct URL
 * (`startUrls` + `fastMode:false`) discovery path.
 *
 * Earlier versions of this file built precise boolean queries (`("a" OR "b")
 * AND ("c" OR "d")`) and quoted exact-phrase pain queries, on the theory that
 * boolean structure would trade some recall for real precision gains. In
 * practice that structure made queries brittle and hard to reason about, and
 * meant every phrase went through some form of word-count trimming before it
 * could be embedded in a group -- exactly the kind of mechanical shortening
 * that produced meaningless fragments in earlier production runs ("cant
 * lock", "limit long").
 *
 * This generates the simplest thing that works: the exact reviewed natural
 * phrase per query, run
 * through Reddit's default (non-boolean, non-quoted) search. No AND/OR, no
 * quotes, no market-qualifier pairing games, and no lowercasing, punctuation
 * stripping, single-word rejection, or ambiguity rewrite after the user has
 * approved the chips. AI triage downstream still does the real relevance
 * filtering; this file's only job is to search what the user reviewed.
 *
 * Bounded to three query families, each independently capped, so a sparse or
 * a rich profile both produce a small, deliberate set rather than however
 * many combinations the source data happens to allow:
 *   - product/category: up to 3 queries
 *   - pain/problem: up to 3 queries
 *   - competitor: up to 3 queries
 */

export interface RedditQueryFamily {
  lane: RedditSearchLane;
  query: string;
}

const MAX_PRODUCT_QUERIES = 3;
const MAX_PAIN_QUERIES = 3;
const MAX_COMPETITOR_QUERIES = 3;
const TOTAL_QUERY_CAP = MAX_PRODUCT_QUERIES + MAX_PAIN_QUERIES + MAX_COMPETITOR_QUERIES;

/**
 * Build a bounded, deduplicated set of plain, natural-language Reddit search
 * queries from the Discovery Profile.
 */
export function redditQueryFamilies(
  request: RedditSearchRequest,
  options: { maxQueries?: number } = {},
): RedditQueryFamily[] {
  const queries = request.queries;
  const families: RedditQueryFamily[] = [];
  const seen = new Set<string>();

  const push = (lane: RedditSearchLane, rawPhrase: string): boolean => {
    // The review API and UI already sanitize surrounding whitespace. Trim once
    // defensively, but otherwise preserve spelling, case, punctuation and word
    // choice exactly as approved. The comparison key is case-insensitive only
    // so a duplicated chip cannot trigger a second paid Actor run.
    const query = rawPhrase.trim();
    if (!query) return false;
    const key = query.toLocaleLowerCase("en-US");
    if (seen.has(key)) return false;
    seen.add(key);
    families.push({ lane, query });
    return true;
  };

  // PRODUCT / CATEGORY: what the business is, verbatim. Category
  // phrases come first since they read as a complete concept on their own;
  // shorter product terms fill any remaining slots.
  const productSources = [
    ...(queries.productCategories ?? []),
    ...(queries.productTerms ?? []),
  ].filter(Boolean);
  let productCount = 0;
  for (const source of productSources) {
    if (productCount >= MAX_PRODUCT_QUERIES) break;
    if (push("category_recommendation", source)) productCount += 1;
  }

  // PAIN / PROBLEM: the customer's own words, verbatim.
  const painSources = (queries.customerProblems ?? []).filter(Boolean);
  let painCount = 0;
  for (const source of painSources) {
    if (painCount >= MAX_PAIN_QUERIES) break;
    if (push("pain", source)) painCount += 1;
  }

  // COMPETITOR: named alternatives. Single-word phrases are valid in every
  // lane when the user approved them; competitor names commonly use one.
  const competitorSources = (queries.competitors ?? []).filter(Boolean);
  let competitorCount = 0;
  for (const source of competitorSources) {
    if (competitorCount >= MAX_COMPETITOR_QUERIES) break;
    if (push("brand_competitor_mentions", source)) competitorCount += 1;
  }

  const maxQueries = Math.max(1, Math.min(options.maxQueries ?? TOTAL_QUERY_CAP, TOTAL_QUERY_CAP));
  return families.slice(0, maxQueries);
}
