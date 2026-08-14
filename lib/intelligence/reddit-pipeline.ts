import type {
  BusinessUnderstanding,
  ConversationTriage,
  DeepQualification,
  FitLevel,
  OpportunityClassification,
  RedditDiscoveryCandidate,
  RedditSearchLane,
  TriageIntent,
} from "@/lib/domain/types";
import type { PotentialCustomerIntent } from "@/lib/server/contracts";
import { contentFingerprint, normalizeSearchText } from "./opportunity-ranking";

export type DeterministicRejectionReason =
  | "invalid_author"
  | "deleted"
  | "jobs_recruitment"
  | "account_sales"
  | "spam"
  | "self_promotion"
  | "known_homonym"
  | "invalid_timestamp"
  | "outside_window"
  | "duplicate";

export type DeterministicRejectionCounts = Record<DeterministicRejectionReason, number>;

export interface DiscoveryCleaningResult {
  survivors: RedditDiscoveryCandidate[];
  rejectedByReason: DeterministicRejectionCounts;
  duplicateExternalIds: string[];
}

function emptyRejections(): DeterministicRejectionCounts {
  return {
    invalid_author: 0,
    deleted: 0,
    jobs_recruitment: 0,
    account_sales: 0,
    spam: 0,
    self_promotion: 0,
    known_homonym: 0,
    invalid_timestamp: 0,
    outside_window: 0,
    duplicate: 0,
  };
}

function normalizedAuthor(value: string | undefined): string | null {
  const normalized = value?.trim().replace(/^u\//i, "").toLocaleLowerCase("en-US") ?? "";
  if (
    !normalized ||
    normalized === "reddit user" ||
    normalized === "[deleted]" ||
    normalized === "automoderator" ||
    normalized === "reddit" ||
    normalized.length > 100 ||
    /(?:^|[-_])(bot|moderator)(?:$|[-_])/i.test(normalized) ||
    normalized.endsWith("bot")
  ) return null;
  return normalized;
}

function canonicalPermalink(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

function tokens(value: string): Set<string> {
  return new Set(
    normalizeSearchText(value)
      .split(" ")
      .filter((token) => token.length >= 3),
  );
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function phraseEvidence(text: string, phrases: readonly string[]): boolean {
  return phrases.some((value) => {
    const phrase = normalizeSearchText(value);
    if (!phrase || phrase.length < 4) return false;
    if (text.includes(phrase)) return true;
    const phraseTokens = phrase.split(" ").filter((token) => token.length >= 4);
    if (phraseTokens.length < 2) return false;
    const matched = phraseTokens.filter((token) => text.includes(token)).length;
    return matched >= Math.min(2, phraseTokens.length) && matched / phraseTokens.length >= 0.67;
  });
}

function candidateText(candidate: RedditDiscoveryCandidate): string {
  return `${candidate.title ?? ""}\n${candidate.body}`;
}

function deterministicReason(
  candidate: RedditDiscoveryCandidate,
  business: BusinessUnderstanding,
  sinceMs: number | null,
  nowMs: number,
): Exclude<DeterministicRejectionReason, "duplicate"> | null {
  if (!normalizedAuthor(candidate.author)) return "invalid_author";
  if (/^\[(?:deleted|removed)\]$/i.test(candidate.body.trim())) return "deleted";

  const createdAt = Date.parse(candidate.createdAt);
  if (!Number.isFinite(createdAt)) return "invalid_timestamp";
  if (sinceMs !== null && createdAt < sinceMs) return "outside_window";
  if (createdAt > nowMs + 5 * 60_000) return "invalid_timestamp";

  const rawText = candidateText(candidate);
  const text = normalizeSearchText(rawText);

  if (
    /\b(?:we(?:'| a)?re hiring|now hiring|job opening|job opportunity|apply now|salary range|send (?:your )?(?:cv|resume)|open role|hiring for)\b/i.test(rawText)
  ) return "jobs_recruitment";

  if (
    /\b(?:account for sale|selling (?:my|an?) account|buy (?:my|an?) account|fortnite account|steam account|discord account|aged reddit account)\b/i.test(rawText)
  ) return "account_sales";

  if (
    /\b(?:dm me on|message me on|telegram me|whatsapp me|limited time offer|discount code|promo code|use code [a-z0-9_-]+)\b/i.test(rawText)
  ) return "spam";

  if (
    /\b(?:i built this|i built a|i made a|check out my|launching my|my newsletter|subscribe to my|my new course|here is my product)\b/i.test(rawText)
  ) return "self_promotion";

  const ambiguity = [
    ...business.ambiguityRisks.value,
    ...business.irrelevantTopics.value,
  ];
  const hasAmbiguity = phraseEvidence(text, ambiguity);
  if (hasAmbiguity) {
    const verifiedBusinessPhrases = [
      business.productCategory.value,
      ...business.problemsSolved.value,
      ...business.customerProblemLanguage.value,
      ...business.features.value.filter((feature) => feature.verified).map((feature) => feature.name),
    ];
    if (!phraseEvidence(text, verifiedBusinessPhrases)) return "known_homonym";
  }

  return null;
}

/**
 * High-recall deterministic cleaning. This function deliberately does not
 * decide commercial relevance; every survivor is eligible for LLM triage.
 */
export function cleanDiscoveryCandidates(input: {
  candidates: readonly RedditDiscoveryCandidate[];
  business: BusinessUnderstanding;
  since?: string;
  now?: Date;
  nearDuplicateThreshold?: number;
}): DiscoveryCleaningResult {
  const rejectedByReason = emptyRejections();
  const sinceMs = input.since && Number.isFinite(Date.parse(input.since))
    ? Date.parse(input.since)
    : null;
  const nowMs = (input.now ?? new Date()).getTime();
  const threshold = Math.max(0.8, Math.min(input.nearDuplicateThreshold ?? 0.9, 1));
  const survivors: RedditDiscoveryCandidate[] = [];
  const duplicateExternalIds: string[] = [];
  const tokenCache = new Map<string, Set<string>>();

  for (const candidate of input.candidates) {
    const reason = deterministicReason(candidate, input.business, sinceMs, nowMs);
    if (reason) {
      rejectedByReason[reason] += 1;
      continue;
    }

    const text = candidateText(candidate);
    const hash = contentFingerprint(text);
    const permalink = canonicalPermalink(candidate.permalink);
    let duplicateIndex = -1;

    for (let index = 0; index < survivors.length; index += 1) {
      const current = survivors[index];
      if (
        (current.provider === candidate.provider && current.externalId === candidate.externalId) ||
        (permalink && canonicalPermalink(current.permalink) === permalink) ||
        contentFingerprint(candidateText(current)) === hash
      ) {
        duplicateIndex = index;
        break;
      }
      const currentTokens = tokenCache.get(current.externalId) ?? tokens(candidateText(current));
      const candidateTokens = tokenCache.get(candidate.externalId) ?? tokens(text);
      tokenCache.set(current.externalId, currentTokens);
      tokenCache.set(candidate.externalId, candidateTokens);
      if (jaccard(currentTokens, candidateTokens) >= threshold) {
        duplicateIndex = index;
        break;
      }
    }

    if (duplicateIndex < 0) {
      survivors.push(candidate);
      continue;
    }

    rejectedByReason.duplicate += 1;
    duplicateExternalIds.push(candidate.externalId);
    const current = survivors[duplicateIndex];
    const currentRichness = current.body.length + current.metrics.comments * 5 + current.metrics.score;
    const candidateRichness = candidate.body.length + candidate.metrics.comments * 5 + candidate.metrics.score;
    if (candidateRichness > currentRichness) survivors[duplicateIndex] = candidate;
  }

  return { survivors, rejectedByReason, duplicateExternalIds };
}

function fitSelectionWeight(value: FitLevel): number {
  if (value === "high") return 20;
  if (value === "medium") return 10;
  if (value === "low") return 0;
  return 4;
}

function intentSelectionWeight(value: TriageIntent): number {
  if (value === "actively_looking") return 60;
  if (value === "switching") return 55;
  if (value === "evaluating") return 50;
  if (value === "problem_aware") return 35;
  if (value === "informational") return 10;
  return 0;
}

/** Budget ordering only; it never changes the triage classification itself. */
export function selectCandidatesForEnrichment(input: {
  candidates: readonly RedditDiscoveryCandidate[];
  triageById: ReadonlyMap<string, ConversationTriage>;
  budget: number;
  /**
   * Lead-oriented triage can correctly return very few acquisition candidates
   * while the scan still contains useful pain, workaround, category or
   * competitor evidence. This bounded floor opens a small, lane-diverse set for
   * full-context intelligence review without changing any triage/lead label.
   */
  minimumReviewCount?: number;
}): RedditDiscoveryCandidate[] {
  const budget = Math.max(1, Math.min(Math.trunc(input.budget), 20));
  const rankedLeadCandidates = input.candidates
    .flatMap((candidate) => {
      const triage = input.triageById.get(candidate.externalId);
      if (!triage?.worthEnriching) return [];
      let priority = intentSelectionWeight(triage.intent);
      priority += fitSelectionWeight(triage.productFit);
      priority += fitSelectionWeight(triage.replyability) / 2;
      if (triage.demandSignal === "explicit_demand") priority += 25;
      if (triage.demandSignal === "switching") priority += 20;
      if (triage.demandSignal === "pain") priority += 15;
      if (triage.demandSignal === "workaround") priority += 10;
      if (triage.timing === "current") priority += 12;
      if (triage.timing === "near_term") priority += 8;
      return [{ candidate, priority }];
    })
    .sort((left, right) => right.priority - left.priority);
  const selected = rankedLeadCandidates
    .slice(0, budget)
    .map(({ candidate }) => candidate);

  const minimumReviewCount = Math.max(
    0,
    Math.min(Math.trunc(input.minimumReviewCount ?? 0), budget),
  );
  if (selected.length >= minimumReviewCount) return selected;

  const selectedIds = new Set(selected.map((candidate) => candidate.externalId));
  const laneOrder: RedditSearchLane[] = [
    "problem_pain",
    "competitor_switching",
    "brand_competitor_mentions",
    "category_recommendation",
    "workaround",
    "timing",
    "direct_buying_intent",
  ];
  const intelligenceCandidates = input.candidates
    .flatMap((candidate) => {
      if (selectedIds.has(candidate.externalId)) return [];
      const triage = input.triageById.get(candidate.externalId);
      if (!triage || triage.intent === "irrelevant" || triage.intent === "promotional") return [];
      const matchingLaneIndexes = candidate.discoveryLanes
        .map((lane) => laneOrder.indexOf(lane))
        .filter((index) => index >= 0);
      if (matchingLaneIndexes.length === 0) return [];
      const bestLaneIndex = Math.min(...matchingLaneIndexes);
      let priority = (laneOrder.length - bestLaneIndex) * 20;
      if (triage.relevant) priority += 20;
      if (triage.demandSignal !== "none") priority += 18;
      if (triage.timing === "current") priority += 10;
      if (triage.timing === "near_term") priority += 6;
      priority += fitSelectionWeight(triage.productFit);
      return [{ candidate, priority }];
    })
    .sort((left, right) => right.priority - left.priority);

  // First take one candidate per evidence lane so an acquisition-heavy query
  // cannot crowd out competitor/pain evidence, then fill any remaining floor by
  // priority. The floor is still capped by the existing enrichment budget.
  for (const lane of laneOrder) {
    if (selected.length >= minimumReviewCount) break;
    const row = intelligenceCandidates.find(({ candidate }) =>
      !selectedIds.has(candidate.externalId) && candidate.discoveryLanes.includes(lane),
    );
    if (!row) continue;
    selected.push(row.candidate);
    selectedIds.add(row.candidate.externalId);
  }
  for (const { candidate } of intelligenceCandidates) {
    if (selected.length >= minimumReviewCount) break;
    if (selectedIds.has(candidate.externalId)) continue;
    selected.push(candidate);
    selectedIds.add(candidate.externalId);
  }

  return selected;
}

function fitScore(value: FitLevel): number {
  if (value === "high") return 1;
  if (value === "medium") return 0.65;
  if (value === "low") return 0.2;
  return 0.4;
}

function intentScore(value: TriageIntent): number {
  if (value === "actively_looking") return 1;
  if (value === "switching") return 0.9;
  if (value === "evaluating") return 0.8;
  if (value === "problem_aware") return 0.55;
  if (value === "informational") return 0.2;
  return 0;
}

function timingScore(value: DeepQualification["timing"]): number {
  if (value === "current") return 1;
  if (value === "near_term") return 0.8;
  if (value === "hypothetical") return 0.3;
  if (value === "historical") return 0.1;
  return 0.5;
}

/** Ranking is intentionally downstream of categorical lead qualification. */
export function opportunityRankScore(qualification: DeepQualification): number {
  const score =
    fitScore(qualification.productFit) * 0.25 +
    intentScore(qualification.intent) * 0.2 +
    fitScore(qualification.painSeverity) * 0.15 +
    timingScore(qualification.timing) * 0.1 +
    fitScore(qualification.evidenceQuality) * 0.1 +
    fitScore(qualification.replyability) * 0.2;
  return Math.round(Math.max(0, Math.min(score, 1)) * 100);
}

export function potentialCustomerIntentFromQualification(
  qualification: DeepQualification,
): PotentialCustomerIntent | null {
  if (qualification.leadStatus !== "potential_customer") return null;
  if (qualification.intent === "actively_looking" || qualification.intent === "evaluating") {
    return "high_intent";
  }
  if (qualification.intent === "switching") return "competitor_switching";
  if (qualification.intent === "problem_aware") return "problem_aware";
  return null;
}

/** Compatibility projection for older insight/UI types; never used for qualification. */
export function legacyClassificationFromDeep(
  qualification: DeepQualification,
): OpportunityClassification {
  const buyerIntent = intentScore(qualification.intent);
  const competitorComplaint = qualification.competitorMentioned &&
    qualification.demandSignals.includes("switching")
    ? 0.85
    : 0;
  return {
    relevance: fitScore(qualification.productFit),
    buyerIntent,
    customerProblem: fitScore(qualification.painSeverity),
    competitorComplaint,
    semanticSimilarity: 0,
    recommendedAction: qualification.shouldReply
      ? "reply_helpfully"
      : qualification.leadStatus === "potential_customer"
        ? "monitor"
        : qualification.intelligenceTags.length > 0
          ? "learn"
          : "avoid",
    communityRisk: qualification.communityRisk,
    problemSummary: qualification.problemSummary,
    competitorMentioned: qualification.competitorMentioned,
    rationale: [qualification.whyItMatters],
  };
}
