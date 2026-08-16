import type { RedditSearchRequest } from "@/lib/providers/contracts";
import { normalizeSearchText } from "@/lib/intelligence/opportunity-ranking";

/**
 * Short, natural retrieval phrases for search backends that match on plain
 * text rather than boolean expressions.
 *
 * The Trudax planner emits intent-shaped sentences ("looking for android tv
 * parental control app", "weekday weekend viewing rules need android tv").
 * Nobody writes titles like that, so recall collapses and what does come back
 * is incidental. Reddit search should retrieve broadly on the concepts people
 * actually type; DemandSift's AI classifies afterwards.
 *
 * Target shape for TVCP:
 *   parental control tv, android tv parental control, kids tv control,
 *   screen time tv, limit kids tv, block youtube kids
 */

/** Words that add no retrieval value inside a short search phrase. */
const FILLER = new Set([
  "a", "an", "and", "any", "are", "app", "apps", "as", "at", "be", "best",
  "but", "can", "for", "from", "get", "has", "have", "how", "i", "in", "is",
  "it", "its", "looking", "me", "my", "need", "needs", "of", "on", "or",
  "our", "please", "recommend", "recommendation", "recommendations", "should",
  "software", "solution", "solutions", "some", "that", "the", "their", "there",
  "this", "to", "tool", "tools", "use", "using", "want", "was", "we", "what",
  "when", "which", "who", "why", "with", "without", "would", "you", "your",
  // Negations and vague verbs read as noise in a short search phrase and
  // produce terms like "no parental tv" that match nothing.
  "no", "not", "too", "very", "just", "only", "still", "set", "make", "keep",
  "way", "help", "stop",
]);

const MAX_WORDS = 4;
const MIN_WORDS = 2;

function condense(phrase: string, maxWords = MAX_WORDS): string {
  const words = normalizeSearchText(phrase)
    .split(" ")
    .filter((word) => word.length > 0 && !FILLER.has(word));
  // Two-letter qualifiers such as "tv" are the market and must survive.
  return [...new Set(words)].slice(0, maxWords).join(" ");
}

function add(into: Map<string, string>, phrase: string): void {
  const term = condense(phrase);
  const wordCount = term ? term.split(" ").length : 0;
  if (wordCount < MIN_WORDS || wordCount > MAX_WORDS) return;
  if (!into.has(term)) into.set(term, term);
}

/**
 * Build bounded, deduplicated search terms from the Discovery Profile.
 *
 * Category and problem language lead, because those are the phrases that
 * actually appear in titles. Competitor names are included as their own terms
 * so switching conversations are reachable without contaminating the market
 * phrases.
 */
export function naturalSearchTerms(
  request: RedditSearchRequest,
  options: { maxTerms?: number } = {},
): string[] {
  const maxTerms = Math.max(1, Math.min(options.maxTerms ?? 12, 25));
  const queries = request.queries;
  const terms = new Map<string, string>();

  const categories = (queries.productCategories ?? []).filter(Boolean);
  for (const category of categories.slice(0, 3)) add(terms, category);

  // The category's distinctive core, e.g. "android tv parental control app"
  // also yields "parental control tv" style pairings via its problem phrases.
  for (const problem of (queries.customerProblems ?? []).slice(0, 8)) {
    add(terms, problem);
  }
  for (const job of (queries.jobsToBeDone ?? []).slice(0, 4)) add(terms, job);
  for (const workaround of (queries.workarounds ?? []).slice(0, 3)) {
    add(terms, workaround);
  }

  // Pair the market qualifier with each problem concept so short, high-recall
  // combinations exist even when the profile never phrases them together.
  const categoryWords = categories[0] ? condense(categories[0], 3).split(" ") : [];
  const qualifier = categoryWords.find((word) => word.length <= 3) ?? categoryWords[0];
  if (qualifier) {
    // Jobs-to-be-done describe the same use cases as problems and are just as
    // likely to appear in a title, so both feed the pairing.
    const pairable = [
      ...(queries.customerProblems ?? []).slice(0, 5),
      ...(queries.jobsToBeDone ?? []).slice(0, 3),
    ];
    for (const problem of pairable) {
      const core = condense(problem, 2);
      if (core && !core.split(" ").includes(qualifier)) {
        add(terms, `${core} ${qualifier}`);
      }
    }
  }

  for (const competitor of (queries.competitors ?? []).slice(0, 3)) {
    // A brand is a valid search term on its own, so single words are kept
    // here even though generic phrases need two.
    const name = normalizeSearchText(competitor);
    if (name.length >= 4) terms.set(name, name);
  }

  return [...terms.values()].slice(0, maxTerms);
}
