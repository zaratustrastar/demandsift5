import type { RedditSearchLane } from "@/lib/domain/types";
import type { RedditSearchRequest } from "@/lib/providers/contracts";
import { normalizeSearchText } from "@/lib/intelligence/opportunity-ranking";
import { naturalSearchTerms } from "@/lib/providers/reddit-natural-queries";

/**
 * Reddit-native search-query expressions for Harshmaur's Direct URL
 * (`startUrls` + `fastMode:false`) discovery path.
 *
 * A manual side-by-side test against `searchTerms` found three things that
 * shape this file:
 *
 *  1. Reddit's own search genuinely supports the boolean operators AND, OR,
 *     NOT (case-sensitive) and parenthetical grouping -- confirmed on
 *     Reddit's own help documentation, not just observed behavior.
 *  2. A single broad natural phrase (e.g. "parental controls Android TV")
 *     has good recall (50 candidates in the test) but low precision --
 *     most hits only shared one or two words with the query. A precise
 *     boolean query ("parental controls" OR "screen time") AND ("Android
 *     TV" OR "Google TV") cut that to a handful, most of them relevant.
 *  3. Boolean search is still lexical, not semantic: it can still return a
 *     false positive that happens to contain the right words for the wrong
 *     reason (a phone post mentioning "Google TV" because a TV app was
 *     installed on it). AI triage downstream is still required either way.
 *
 * So this deliberately generates a MIX of broad and precise queries per
 * scan rather than picking one style: broad queries carry recall, precise
 * boolean queries carry precision, and duplicates across them collapse once
 * results come back (candidates already dedupe by Reddit id).
 *
 * An earlier version also appended a blanket `NOT (...)` clause built from
 * `queries.excludedTerms` to every single query. A real production run
 * showed this bloats every query with the same ~15 extra encoded words
 * regardless of relevance, for little practical benefit -- the excluded
 * platform names are unlikely to false-positive-match unrelated queries
 * anyway, and AI triage downstream already hard-rejects obvious noise. That
 * blanket exclusion was removed; `withKnownServiceExclusion` below is kept
 * because it targets one specific, narrow, confirmed collision rather than
 * applying to every query regardless of content.
 */

export interface RedditQueryFamily {
  lane: RedditSearchLane;
  query: string;
}

const DEFAULT_MAX_QUERIES = 12;
const MAX_QUERIES_CAP = 20;

/** Generic complaint/weakness vocabulary, not company-specific -- these are
 * the words people use when a competitor is failing them, regardless of
 * what the competitor or product category is. */
const WEAKNESS_WORDS = ["problem", "bypass", "limit", "alternative"];

const FILLER = new Set([
  "a", "an", "and", "any", "are", "app", "apps", "as", "at", "be", "best",
  "but", "can", "for", "from", "get", "has", "have", "how", "i", "in", "is",
  "it", "its", "looking", "me", "my", "need", "needs", "of", "on", "or",
  "our", "please", "recommend", "recommendation", "recommendations", "should",
  "software", "solution", "solutions", "some", "that", "the", "their", "there",
  "this", "to", "tool", "tools", "use", "using", "want", "was", "we", "what",
  "when", "which", "who", "why", "with", "without", "would", "you", "your",
  "no", "not", "too", "very", "just", "only", "still", "set", "make", "keep",
  "way", "help", "stop",
]);

function words(phrase: string): string[] {
  return normalizeSearchText(phrase)
    .split(" ")
    .filter((word) => word.length > 0 && !FILLER.has(word));
}

/** Condense a source sentence to a short, deduplicated phrase. */
function condense(phrase: string, maxWords: number): string {
  return [...new Set(words(phrase))].slice(0, maxWords).join(" ");
}

/** A gentler clean for phrases meant to be quoted verbatim as a customer's
 * own language (pain points, buying-intent phrases): drop only leading/
 * trailing filler, keep the rest in source order so it still reads like
 * something a person actually typed. */
function naturalPhrase(phrase: string, maxWords: number): string {
  const all = normalizeSearchText(phrase).split(" ").filter(Boolean);
  let start = 0;
  let end = all.length;
  while (start < end && FILLER.has(all[start])) start += 1;
  while (end > start && FILLER.has(all[end - 1])) end -= 1;
  return all.slice(start, Math.min(end, start + maxWords)).join(" ");
}

function quote(term: string): string {
  return term.includes(" ") ? `"${term}"` : term;
}

/** OR-group deduplicated, non-empty terms. A single term needs no
 * parentheses; Reddit's own examples don't wrap a lone quoted phrase. */
function orGroup(terms: readonly string[]): string {
  const unique = [...new Set(terms.map((term) => term.trim()).filter(Boolean))];
  if (unique.length === 0) return "";
  if (unique.length === 1) return quote(unique[0]);
  return `(${unique.map(quote).join(" OR ")})`;
}

function andGroup(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  return `${left} AND ${right}`;
}

/**
 * "youtube" plus the bare qualifier "tv" collides with the YouTube TV
 * streaming service. An earlier plain-phrase generator dropped this pairing
 * outright; boolean search lets the query keep the recall and exclude the
 * collision instead, which is strictly better as long as NOT is genuinely
 * supported -- confirmed above.
 */
function withKnownServiceExclusion(query: string, qualifier: string | undefined): string {
  if (qualifier !== "tv" || !/\byoutube\b/.test(query) || !/\btv\b/.test(query)) return query;
  return `${query} NOT "youtube tv"`;
}

/**
 * Build a bounded, deduplicated set of Reddit-native search-query
 * expressions from the Discovery Profile, mixing broad recall queries with
 * precise boolean ones across several distinct search intents.
 */
export function redditQueryFamilies(
  request: RedditSearchRequest,
  options: { maxQueries?: number } = {},
): RedditQueryFamily[] {
  const maxQueries = Math.max(1, Math.min(options.maxQueries ?? DEFAULT_MAX_QUERIES, MAX_QUERIES_CAP));
  const queries = request.queries;

  const categories = (queries.productCategories ?? []).filter(Boolean);
  const categoryWords = categories[0] ? condense(categories[0], 4).split(" ").filter(Boolean) : [];
  const qualifier = categoryWords.find((word) => word.length <= 3) ?? categoryWords[0];

  const problems = (queries.customerProblems ?? []).filter(Boolean);
  const problemCores = problems.map((problem) => condense(problem, 2)).filter(Boolean);
  const jobs = (queries.jobsToBeDone ?? []).filter(Boolean);
  const jobCores = jobs.map((job) => condense(job, 2)).filter(Boolean);
  const competitors = (queries.competitors ?? [])
    .map((competitor) => normalizeSearchText(competitor))
    .filter((competitor) => competitor.length >= 3);
  const families: RedditQueryFamily[] = [];
  const push = (lane: RedditSearchLane, query: string) => {
    const cleaned = withKnownServiceExclusion(query, qualifier);
    if (cleaned.trim()) families.push({ lane, query: cleaned });
  };

  // BROAD: recall-first natural phrases. Already tuned and tested elsewhere;
  // reused verbatim rather than re-derived here.
  for (const term of naturalSearchTerms(request, { maxTerms: 3 })) {
    push("category_recommendation", term);
  }

  // PRECISE CATEGORY: problem language AND the market, each as an OR-group
  // so near-synonyms in the profile widen the match without losing focus.
  if (problemCores.length > 0 && categories.length > 0) {
    const marketGroup = orGroup(categories.slice(0, 2).map((category) => condense(category, 4)));
    push("category_recommendation", andGroup(orGroup(problemCores.slice(0, 2)), marketGroup));
  }

  // PAIN: the customer's own words, quoted, not reduced to keywords.
  for (const problem of problems.slice(0, 2)) {
    const phrase = naturalPhrase(problem, 6);
    if (phrase.split(" ").length >= 2) push("pain", quote(phrase));
  }

  // FEATURE / JOB: the action people want AND the market it applies to.
  if (jobCores.length > 0 && qualifier) {
    const marketGroup = orGroup(categoryWords.filter((word) => word.length > 3).slice(0, 2)) || quote(qualifier);
    push("explicit_demand", andGroup(orGroup(jobCores.slice(0, 3)), marketGroup));
  }

  // BUYING / RECOMMENDATION INTENT: an explicit ask, plus the market as a
  // trailing bare word rather than AND'd -- this is how people actually
  // phrase a recommendation request ("best parental controls app" TV).
  if (qualifier) {
    for (const intent of (queries.buyerIntent ?? []).slice(0, 2)) {
      const phrase = naturalPhrase(intent, 4);
      if (phrase.split(" ").length >= 2) push("explicit_demand", `${quote(phrase)} ${qualifier}`);
    }
  }

  // COMPETITOR: named alternatives AND the market.
  if (competitors.length > 0) {
    const marketGroup = qualifier ? orGroup([qualifier, "television"]) : "";
    push("brand_competitor_mentions", andGroup(orGroup(competitors.slice(0, 3)), marketGroup));
  }

  // FAILURE / WEAKNESS: named alternatives AND generic complaint language.
  if (competitors.length > 0) {
    push("switching", andGroup(orGroup(competitors.slice(0, 2)), orGroup(WEAKNESS_WORDS)));
  }

  const deduped = new Map<string, RedditQueryFamily>();
  for (const family of families) {
    const key = dedupeKey(family.query);
    if (!deduped.has(key)) deduped.set(key, family);
  }
  return [...deduped.values()].slice(0, maxQueries);
}

/**
 * A boolean/quoted query's structure is load-bearing, so it is deduped by
 * exact text. A plain, operator-free phrase is deduped by its sorted word
 * set instead: `naturalSearchTerms` deliberately emits both word orders of
 * a core-plus-qualifier pairing (e.g. "kid watches tv" and "tv kid
 * watches") because both read naturally on their own, but when only a
 * handful of query slots exist per scan, two orderings of the same idea is
 * a wasted slot rather than added recall -- a real production run spent
 * two of its seven startUrls this way.
 */
function dedupeKey(query: string): string {
  if (/[()"]/.test(query) || /\b(AND|OR|NOT)\b/.test(query)) return query.toLowerCase();
  return query.toLowerCase().split(" ").filter(Boolean).sort().join(" ");
}
