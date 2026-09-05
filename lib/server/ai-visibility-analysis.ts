import type {
  AiVisibilityAiProvider,
  AiVisibilityAnswer,
  AiVisibilityCitation,
  AiVisibilityMetrics,
} from "@/lib/server/contracts";

/**
 * Deterministic matching for AI Visibility Tracking.
 *
 * Per the spec: brand names, competitor names and Reddit URLs are matched
 * deterministically wherever possible; AI is reserved for the one genuinely
 * semantic field (whether the brand is actually being *recommended* --
 * see analyzeVisibilityMentions in lib/providers/contracts.ts). Every
 * function here is a pure string/URL matcher with no AI call and no I/O, so
 * it is fully unit-testable and never varies run to run for the same input.
 */

const REDDIT_HOSTNAMES = new Set(["reddit.com", "old.reddit.com", "redd.it"]);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-boundary, case-insensitive match so "Ada" doesn't match "Adapt". */
function containsTerm(text: string, term: string): boolean {
  const trimmed = term.trim();
  if (!trimmed) return false;
  const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(trimmed)}(?:[^\\p{L}\\p{N}]|$)`, "iu");
  return pattern.test(` ${text} `);
}

function firstTermIndex(text: string, terms: readonly string[]): number {
  let earliest = -1;
  for (const term of terms) {
    const trimmed = term.trim();
    if (!trimmed) continue;
    const pattern = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(trimmed)}(?:[^\\p{L}\\p{N}]|$)`, "iu");
    const match = pattern.exec(` ${text} `);
    if (match && (earliest === -1 || match.index < earliest)) earliest = match.index;
  }
  return earliest;
}

export function brandMentioned(answerText: string, brandTerms: readonly string[]): boolean {
  return brandTerms.some((term) => containsTerm(answerText, term));
}

export function competitorsMentioned(
  answerText: string,
  competitorNames: readonly string[],
): string[] {
  const seen = new Set<string>();
  const matched: string[] = [];
  for (const name of competitorNames) {
    const trimmed = name.trim();
    if (!trimmed) continue;
    const key = trimmed.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    if (containsTerm(answerText, trimmed)) {
      seen.add(key);
      matched.push(trimmed);
    }
  }
  return matched;
}

/**
 * Deterministic, text-position-based bucket -- not an AI judgment. An
 * answer's earliest brand mention divided into thirds of the answer length
 * is a meaningful, reproducible proxy for prominence (a brand named in the
 * opening sentence reads very differently than one buried in a closing
 * aside), without requiring a model call for something string math already
 * answers exactly.
 */
export function mentionPosition(
  answerText: string,
  brandTerms: readonly string[],
): AiVisibilityAnswer["mentionPosition"] {
  const index = firstTermIndex(answerText, brandTerms);
  if (index === -1 || answerText.length === 0) return "not_mentioned";
  const fraction = index / answerText.length;
  if (fraction <= 1 / 3) return "early";
  if (fraction <= 2 / 3) return "mid";
  return "late";
}

export function isRedditCitation(citation: AiVisibilityCitation): boolean {
  return REDDIT_HOSTNAMES.has(citation.domain.toLowerCase());
}

export function redditCitations(citations: readonly AiVisibilityCitation[]): AiVisibilityCitation[] {
  return citations.filter(isRedditCitation);
}

/** Every cited domain other than reddit.com and the business's own domain, deduplicated. */
export function otherCitedDomains(
  citations: readonly AiVisibilityCitation[],
  ownDomain: string,
): string[] {
  const own = ownDomain.replace(/^www\./i, "").toLowerCase();
  const seen = new Set<string>();
  const domains: string[] = [];
  for (const citation of citations) {
    const domain = citation.domain.toLowerCase();
    if (!domain || domain === own || REDDIT_HOSTNAMES.has(domain) || seen.has(domain)) continue;
    seen.add(domain);
    domains.push(domain);
  }
  return domains;
}

function emptyProviderTotals(): AiVisibilityMetrics["byProvider"] {
  return {
    chatgpt: { mentioned: 0, recommended: 0, total: 0 },
    gemini: { mentioned: 0, recommended: 0, total: 0 },
    perplexity: { mentioned: 0, recommended: 0, total: 0 },
  };
}

/**
 * Simple, MVP-only visibility metrics computed from the 9 (3 questions x 3
 * providers) stored answers. Deliberately no weighting, decay, or GEO
 * scoring -- just the counts and rates the spec asks for.
 */
export function computeVisibilityMetrics(answers: readonly AiVisibilityAnswer[]): AiVisibilityMetrics {
  const byProvider = emptyProviderTotals();
  const competitorMentionCounts: Record<string, number> = {};
  const otherDomainCounts: Record<string, number> = {};
  let totalMentions = 0;
  let totalRecommendations = 0;
  let redditCitationCount = 0;

  for (const answer of answers) {
    const providerTotals = byProvider[answer.provider];
    providerTotals.total += 1;
    if (answer.brandMentioned) {
      totalMentions += 1;
      providerTotals.mentioned += 1;
    }
    if (answer.brandRecommended) {
      totalRecommendations += 1;
      providerTotals.recommended += 1;
    }
    for (const competitor of answer.competitorsMentioned) {
      const key = competitor.trim();
      if (!key) continue;
      competitorMentionCounts[key] = (competitorMentionCounts[key] ?? 0) + 1;
    }
    redditCitationCount += answer.redditCitations.length;
    for (const domain of answer.otherDomains) {
      otherDomainCounts[domain] = (otherDomainCounts[domain] ?? 0) + 1;
    }
  }

  const totalAnswers = answers.length;
  return {
    totalAnswers,
    totalMentions,
    mentionRate: totalAnswers > 0 ? totalMentions / totalAnswers : 0,
    totalRecommendations,
    recommendationRate: totalAnswers > 0 ? totalRecommendations / totalAnswers : 0,
    byProvider,
    competitorMentionCounts,
    redditCitationCount,
    otherDomainCounts,
  };
}

export function isVisibilityProvider(value: unknown): value is AiVisibilityAiProvider {
  return value === "chatgpt" || value === "gemini" || value === "perplexity";
}
