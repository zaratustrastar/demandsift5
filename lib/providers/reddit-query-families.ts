import type { RedditSearchLane } from "@/lib/domain/types";
import type { RedditSearchRequest } from "@/lib/providers/contracts";
import { normalizeSearchText } from "@/lib/intelligence/opportunity-ranking";

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
 * This generates the simplest thing that works: a plain, lowercase, natural
 * phrase per query, close to verbatim from the Discovery Profile, run
 * through Reddit's default (non-boolean, non-quoted) search. No AND/OR, no
 * quotes, no market-qualifier pairing games -- just what a person would
 * actually type. AI triage downstream still does the real relevance
 * filtering; this file's only job is retrieval.
 *
 * Bounded to three query families, each independently capped, so a sparse or
 * a rich profile both produce a small, deliberate set rather than however
 * many combinations the source data happens to allow:
 *   - product/category: up to 3 queries
 *   - pain/problem: up to 3 queries
 *   - competitor: up to 2 queries
 */

export interface RedditQueryFamily {
  lane: RedditSearchLane;
  query: string;
}

const MAX_PRODUCT_QUERIES = 3;
const MAX_PAIN_QUERIES = 3;
const MAX_COMPETITOR_QUERIES = 2;
const TOTAL_QUERY_CAP = MAX_PRODUCT_QUERIES + MAX_PAIN_QUERIES + MAX_COMPETITOR_QUERIES;

/**
 * "youtube" plus the bare word "tv" collides with the YouTube TV streaming
 * service -- the same concept paired with a more specific qualifier (e.g.
 * "android tv") is fine and is left alone. The Discovery Profile has no
 * exclusions concept, so a colliding query is simply dropped rather than
 * negated with a boolean NOT.
 */
function collidesWithKnownService(query: string): boolean {
  const words = query.split(" ");
  return words.includes("youtube") && words.includes("tv");
}

/**
 * Lowercase and strip punctuation/diacritics only -- no word-count
 * truncation, no filler-word removal, no reordering. The Discovery Profile's
 * product/category, pain and competitor phrases are already short, natural
 * text; this generator's job is to use them close to verbatim, not to
 * mechanically re-shorten them.
 */
function normalizedQuery(phrase: string): string {
  return normalizeSearchText(phrase).trim();
}

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

  const push = (lane: RedditSearchLane, rawPhrase: string, minWords: number): boolean => {
    const query = normalizedQuery(rawPhrase);
    if (!query) return false;
    if (query.split(" ").length < minWords) return false;
    if (collidesWithKnownService(query)) return false;
    if (seen.has(query)) return false;
    seen.add(query);
    families.push({ lane, query });
    return true;
  };

  // PRODUCT / CATEGORY: what the business is, close to verbatim. Category
  // phrases come first since they read as a complete concept on their own;
  // shorter product terms fill any remaining slots.
  const productSources = [
    ...(queries.productCategories ?? []),
    ...(queries.productTerms ?? []),
  ].filter(Boolean);
  let productCount = 0;
  for (const source of productSources) {
    if (productCount >= MAX_PRODUCT_QUERIES) break;
    if (push("category_recommendation", source, 2)) productCount += 1;
  }

  // PAIN / PROBLEM: the customer's own words, close to verbatim.
  const painSources = (queries.customerProblems ?? []).filter(Boolean);
  let painCount = 0;
  for (const source of painSources) {
    if (painCount >= MAX_PAIN_QUERIES) break;
    if (push("pain", source, 2)) painCount += 1;
  }

  // COMPETITOR: named alternatives. A brand name is a valid query on its
  // own, so (unlike the other two lanes) a single word is allowed here.
  const competitorSources = (queries.competitors ?? []).filter(Boolean);
  let competitorCount = 0;
  for (const source of competitorSources) {
    if (competitorCount >= MAX_COMPETITOR_QUERIES) break;
    if (push("brand_competitor_mentions", source, 1)) competitorCount += 1;
  }

  const maxQueries = Math.max(1, Math.min(options.maxQueries ?? TOTAL_QUERY_CAP, TOTAL_QUERY_CAP));
  return families.slice(0, maxQueries);
}
