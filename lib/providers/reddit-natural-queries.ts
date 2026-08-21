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
 *
 * A first version condensed each raw `customerProblems`/`jobsToBeDone`
 * sentence on its own by just keeping its first few non-filler words in
 * source order. Those sentences are LLM-authored prose ("control how much tv
 * my child watches without me having to constantly open the app"), and the
 * first few surviving words of a long sentence are rarely its most natural
 * short phrase -- real production runs produced queries like
 * "control tv child open" and "limit long child watches", which nobody
 * would type into Reddit and which mostly return noise. Every problem/job/
 * workaround phrase is now condensed down to a tight two-word "core" concept
 * and paired explicitly with the market qualifier, in both orders, which is
 * the same short-phrase-plus-market pattern real Reddit titles use.
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
/** How many words survive when reducing a problem/job/workaround sentence
 * to its "core" phrase before pairing it with the market qualifier. Wide
 * enough that the excerpt still reads as a genuine slice of what was
 * written (see naturalCore() below), narrow enough that pairing it with the
 * qualifier doesn't produce an unwieldy string. */
const MAX_CORE_WORDS = 5;

function condense(phrase: string, maxWords = MAX_WORDS): string {
  const words = normalizeSearchText(phrase)
    .split(" ")
    .filter((word) => word.length > 0 && !FILLER.has(word));
  // Two-letter qualifiers such as "tv" are the market and must survive.
  return [...new Set(words)].slice(0, maxWords).join(" ");
}

/** A gentler extraction for problem/job/workaround "core" phrases: drop only
 * leading/trailing filler and keep the rest as a contiguous, source-order
 * slice, rather than condense()'s filler-filtered word *set* (which can
 * start anywhere in the sentence). Real production runs paired with the
 * market qualifier produced fragments like "cant lock tv" (from "can't lock
 * the TV remotely...") and "limit long tv" (from "limit how long my kid
 * watches...") -- neither reads as something a person would type. Keeping a
 * contiguous run from the sentence's own start instead yields "cant lock the
 * tv remotely" and "limit how long my kid": genuine excerpts, not scattered
 * word picks. */
function naturalCore(phrase: string, maxWords: number): string {
  const all = normalizeSearchText(phrase).split(" ").filter(Boolean);
  let start = 0;
  let end = all.length;
  while (start < end && FILLER.has(all[start])) start += 1;
  while (end > start && FILLER.has(all[end - 1])) end -= 1;
  return all.slice(start, Math.min(end, start + maxWords)).join(" ");
}

/**
 * A small number of concept + generic-qualifier pairings read as an
 * unrelated named service rather than the customer's actual market. The
 * only one seen in production so far is "youtube" plus the bare qualifier
 * "tv", which collides with the YouTube TV streaming service -- the same
 * concept paired with a more specific qualifier (e.g. "android tv") is
 * fine and is left alone.
 */
function collidesWithKnownService(core: string, qualifier: string): boolean {
  return qualifier === "tv" && core.split(" ").includes("youtube");
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
 * Category phrases are used close to verbatim, since they already tend to
 * read as short noun phrases. Every problem, job, and workaround is reduced
 * to a short, contiguous "core" excerpt (see naturalCore() below) and paired
 * with the market qualifier -- never emitted as a standalone condensed
 * sentence -- so every query stays both natural and market-anchored.
 */
export function naturalSearchTerms(
  request: RedditSearchRequest,
  options: { maxTerms?: number } = {},
): string[] {
  const maxTerms = Math.max(1, Math.min(options.maxTerms ?? 8, 25));
  const queries = request.queries;
  const terms = new Map<string, string>();

  const categories = (queries.productCategories ?? []).filter(Boolean);
  for (const category of categories.slice(0, 3)) add(terms, category);

  // Pair the market qualifier with each problem concept so short, high-recall
  // combinations exist even when the profile never phrases them together.
  const categoryWords = categories[0] ? condense(categories[0], 3).split(" ") : [];
  const qualifier = categoryWords.find((word) => word.length <= 3) ?? categoryWords[0];
  if (qualifier) {
    // Jobs-to-be-done describe the same use cases as problems and are just as
    // likely to appear in a title, so both feed the pairing, along with
    // workarounds people already describe using.
    const pairable = [
      ...(queries.customerProblems ?? []).slice(0, 6),
      ...(queries.jobsToBeDone ?? []).slice(0, 4),
      ...(queries.workarounds ?? []).slice(0, 3),
    ];
    for (const source of pairable) {
      const core = naturalCore(source, MAX_CORE_WORDS);
      if (!core) continue;
      if (collidesWithKnownService(core, qualifier)) continue;
      // A wider, contiguous core (see naturalCore() above) often already
      // mentions the qualifier itself -- e.g. "no parental controls on
      // Android TV" naturally contains "tv" near the end. Discarding that
      // signal entirely would silently drop otherwise-good phrasing just
      // because the sentence already said the quiet part out loud; keep the
      // core as its own term instead of pairing it with a redundant repeat.
      if (core.split(" ").includes(qualifier)) {
        add(terms, core);
        continue;
      }
      // Both orders show up in real Reddit titles: "parental controls tv"
      // reads like a complaint, "tv parental controls" reads like a search.
      add(terms, `${core} ${qualifier}`);
      add(terms, `${qualifier} ${core}`);
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
