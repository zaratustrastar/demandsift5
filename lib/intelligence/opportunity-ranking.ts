import type {
  BusinessUnderstanding,
  RedditConversation,
} from "@/lib/domain/types";

const BUYER_PHRASES = [
  "any recommendations",
  "what are people using",
  "looking for",
  "need a tool",
  "which tool",
  "best software",
  "alternative to",
  "comparing",
  "ready to buy",
  "pricing",
] as const;

const GENERIC_BUSINESS_TERMS = new Set([
  "about", "api", "app", "apps", "avoid", "business", "businesses", "buy", "enable",
  "feature", "features", "help", "home", "login", "marketplace", "model", "models",
  "platform", "price", "pricing", "product", "products", "reduce", "review", "reviews",
  "save", "sell", "service", "services", "software", "tool", "tools", "website", "without",
]);

export function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US")
    .replace(/https?:\/\/\S+/g, " ")
    // Apostrophes are dropped, not replaced with a space, so a contraction
    // collapses into one word ("can't" -> "cant", "child's" -> "childs")
    // instead of splitting into a real word plus an orphaned single-letter
    // fragment ("can t", "child s"). Downstream code that condenses text
    // down to its first few surviving words has no way to recognize "t" or
    // "s" as junk -- they read as content words and end up in generated
    // search queries, e.g. a real production query was "t lock the tv
    // remotely" from "can't lock the TV remotely".
    .replace(/['\u2019]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Rejects navigation labels and broad one-word terms before discovery/ranking. */
export function isUsefulSearchPhrase(value: string): boolean {
  const normalized = normalizeSearchText(value);
  if (normalized.length < 4) return false;
  const phraseTokens = normalized.split(" ").filter(Boolean);
  if (phraseTokens.length === 0 || phraseTokens.length > 10) return false;
  if (phraseTokens.every((token) => GENERIC_BUSINESS_TERMS.has(token))) return false;
  return !new Set(["get started", "learn more", "sign in", "sign up"]).has(normalized);
}

/** Deterministic non-cryptographic fingerprint for duplicate detection. */
export function contentFingerprint(value: string): string {
  const normalized = normalizeSearchText(value);
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
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
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
}

function conversationText(conversation: RedditConversation): string {
  return `${conversation.title ?? ""}\n${conversation.body}\n${conversation.threadContext ?? ""}`;
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

function preferredConversation(
  left: RedditConversation,
  right: RedditConversation,
): RedditConversation {
  const leftValue = left.body.length + left.metrics.score * 2 + left.metrics.comments * 3;
  const rightValue = right.body.length + right.metrics.score * 2 + right.metrics.comments * 3;
  return rightValue > leftValue ? right : left;
}

export interface DuplicateGroup {
  keptExternalId: string;
  removedExternalIds: string[];
  reason: "provider_id" | "permalink" | "content" | "near_duplicate";
}

export interface DeduplicationResult {
  unique: RedditConversation[];
  duplicateGroups: DuplicateGroup[];
}

export interface DeduplicationOptions {
  nearDuplicateThreshold?: number;
}

/** Removes provider duplicates and cross-query near duplicates before AI calls. */
export function deduplicateConversations(
  conversations: readonly RedditConversation[],
  options: DeduplicationOptions = {},
): DeduplicationResult {
  const threshold = Math.max(0.7, Math.min(options.nearDuplicateThreshold ?? 0.88, 1));
  const unique: RedditConversation[] = [];
  const tokenCache = new Map<string, Set<string>>();
  const duplicateGroups: DuplicateGroup[] = [];

  for (const candidate of conversations) {
    const candidateText = conversationText(candidate);
    const candidateHash = contentFingerprint(candidateText);
    const candidatePermalink = canonicalPermalink(candidate.permalink);
    let duplicateIndex = -1;
    let reason: DuplicateGroup["reason"] | undefined;

    for (let index = 0; index < unique.length; index += 1) {
      const current = unique[index];
      if (current.provider === candidate.provider && current.externalId === candidate.externalId) {
        duplicateIndex = index;
        reason = "provider_id";
        break;
      }
      const currentPermalink = canonicalPermalink(current.permalink);
      if (candidatePermalink && currentPermalink === candidatePermalink) {
        duplicateIndex = index;
        reason = "permalink";
        break;
      }
      const currentText = conversationText(current);
      if (contentFingerprint(currentText) === candidateHash) {
        duplicateIndex = index;
        reason = "content";
        break;
      }

      const currentTokens = tokenCache.get(current.externalId) ?? tokens(currentText);
      tokenCache.set(current.externalId, currentTokens);
      const candidateTokens = tokenCache.get(candidate.externalId) ?? tokens(candidateText);
      tokenCache.set(candidate.externalId, candidateTokens);
      if (jaccard(currentTokens, candidateTokens) >= threshold) {
        duplicateIndex = index;
        reason = "near_duplicate";
        break;
      }
    }

    if (duplicateIndex < 0 || !reason) {
      unique.push(candidate);
      continue;
    }

    const previous = unique[duplicateIndex];
    const kept = preferredConversation(previous, candidate);
    const removed = kept === previous ? candidate : previous;
    unique[duplicateIndex] = kept;
    duplicateGroups.push({
      keptExternalId: kept.externalId,
      removedExternalIds: [removed.externalId],
      reason,
    });
  }

  return { unique, duplicateGroups };
}

function bounded(value: number): number {
  return Math.max(0, Math.min(value, 1));
}

function phraseCoverage(text: string, phrases: readonly string[]): number {
  const usable = phrases.map(normalizeSearchText).filter((phrase) => phrase.length >= 3);
  if (usable.length === 0) return 0;
  const matches = usable.filter((phrase) => text.includes(phrase)).length;
  return bounded(matches / Math.min(usable.length, 4));
}

export interface RankingComponents {
  productTerm: number;
  problemLanguage: number;
  buyerIntent: number;
  competitorSignal: number;
  /** Real embedding cosine distance, distinct from the LLM `solutionFit`. */
  embeddingSimilarity: number;
  quality: number;
  recency: number;
  irrelevantPenalty: number;
}

export interface RankedConversation {
  conversation: RedditConversation;
  score: number;
  components: RankingComponents;
  reasons: string[];
}

export interface RankingOptions {
  semanticSimilarities?: Readonly<Record<string, number>>;
  now?: Date;
  minimumScore?: number;
  requireBusinessEvidence?: boolean;
}

/**
 * Cheap deterministic pre-ranking. The capable/economy model can classify only
 * these candidates, which lowers token usage without exposing raw scores in UI.
 */
export function rankConversations(
  conversations: readonly RedditConversation[],
  business: BusinessUnderstanding,
  options: RankingOptions = {},
): RankedConversation[] {
  const now = options.now ?? new Date();
  const productTerms = business.productTerms.value.filter(isUsefulSearchPhrase);
  const problems = [
    ...business.customerProblemLanguage.value,
    ...business.problemsSolved.value,
  ].filter(isUsefulSearchPhrase);
  const competitors = business.competitors.value
    .map((competitor) => competitor.name)
    .filter(isUsefulSearchPhrase);
  const irrelevant = business.irrelevantTopics.value;

  return conversations
    .map((conversation): RankedConversation => {
      const text = normalizeSearchText(conversationText(conversation));
      const productTerm = phraseCoverage(text, productTerms);
      const problemLanguage = phraseCoverage(text, problems);
      const buyerIntent = phraseCoverage(text, BUYER_PHRASES);
      const competitorSignal = phraseCoverage(text, competitors);
      const embeddingSimilarity = bounded(
        options.semanticSimilarities?.[conversation.externalId] ?? 0,
      );
      const engagement =
        Math.log1p(Math.max(0, conversation.metrics.score)) +
        Math.log1p(Math.max(0, conversation.metrics.comments));
      const quality = bounded((Math.min(conversation.body.length, 500) / 500 + engagement / 10) / 2);
      const ageDays = Math.max(
        0,
        (now.getTime() - new Date(conversation.createdAt).getTime()) / 86_400_000,
      );
      const recency = Number.isFinite(ageDays) ? Math.exp(-ageDays / 30) : 0;
      const irrelevantPenalty = phraseCoverage(text, irrelevant);

      const score = bounded(
        productTerm * 0.22 +
          problemLanguage * 0.23 +
          buyerIntent * 0.2 +
          competitorSignal * 0.1 +
          embeddingSimilarity * 0.18 +
          quality * 0.04 +
          recency * 0.03 -
          irrelevantPenalty * 0.45,
      );

      const reasons: string[] = [];
      if (buyerIntent >= 0.25) reasons.push("Requests a recommendation or buying guidance");
      if (problemLanguage >= 0.25) reasons.push("Describes a customer problem the business addresses");
      if (competitorSignal >= 0.25) reasons.push("Mentions a relevant competitor or alternative");
      if (embeddingSimilarity >= 0.6) reasons.push("Semantically close to the business use case");
      if (irrelevantPenalty > 0) reasons.push("Contains an excluded or irrelevant topic");

      return {
        conversation,
        score: Math.round(score * 10_000) / 10_000,
        components: {
          productTerm,
          problemLanguage,
          buyerIntent,
          competitorSignal,
          embeddingSimilarity,
          quality,
          recency,
          irrelevantPenalty,
        },
        reasons,
      };
    })
    .filter((result) => {
      const evidence = result.components;
      const hasBusinessEvidence =
        evidence.productTerm >= 0.2 ||
        evidence.problemLanguage >= 0.2 ||
        evidence.competitorSignal >= 0.2 ||
        evidence.embeddingSimilarity >= 0.6;
      return (
        (options.requireBusinessEvidence === false || hasBusinessEvidence) &&
        evidence.irrelevantPenalty < 0.5 &&
        result.score >= (options.minimumScore ?? 0)
      );
    })
    .sort((left, right) => right.score - left.score);
}
