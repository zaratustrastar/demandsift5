import type { AiOperation, TokenUsage } from "@/lib/ai/usage";
import type {
  BusinessUnderstanding,
  CompetitorSignal,
  ConversationTriage,
  DeepQualification,
  DemandInsight,
  EnrichedRedditConversation,
  EntityId,
  ModelConfiguration,
  OpportunityClassification,
  QualifiedOpportunity,
  RedditConversation,
  RedditDiscoveryCandidate,
  RedditSearchLane,
} from "@/lib/domain/types";

export interface WebsiteEvidencePage {
  sourceId?: EntityId;
  url: string;
  title: string;
  description?: string;
  text: string;
  contentHash: string;
  retrievedAt: string;
}

export interface AiProviderResult<T> {
  value: T;
  model: string;
  operation: AiOperation;
  usage: TokenUsage;
  estimatedCostUsd: number;
  providerRequestId?: string;
}

export interface AnalyzeBusinessRequest {
  workspaceId: EntityId;
  businessId: EntityId;
  websiteUrl: string;
  canonicalDomain: string;
  pages: WebsiteEvidencePage[];
  models: ModelConfiguration;
}

export interface TriageConversationsRequest {
  business: BusinessUnderstanding;
  candidates: RedditDiscoveryCandidate[];
  models: ModelConfiguration;
  coverageRetries?: number;
}

export interface TriagedConversation {
  externalId: string;
  triage: ConversationTriage;
}

export interface QualifyConversationsRequest {
  business: BusinessUnderstanding;
  conversations: EnrichedRedditConversation[];
  models: ModelConfiguration;
  coverageRetries?: number;
}

export interface DeepQualifiedConversation {
  externalId: string;
  conversation: EnrichedRedditConversation;
  qualification: DeepQualification;
}

/** Legacy request retained for older callers; the active scan uses triage/qualify. */
export interface ClassifyConversationsRequest {
  business: BusinessUnderstanding;
  conversations: RedditConversation[];
  models: ModelConfiguration;
}

export interface ClassifiedConversation {
  externalId: string;
  classification: OpportunityClassification;
}

export interface GenerateInsightsRequest {
  business: BusinessUnderstanding;
  opportunities: QualifiedOpportunity[];
  evidenceConversations?: DeepQualifiedConversation[];
  models: ModelConfiguration;
}

export interface GeneratedInsightSet {
  demandInsights: Omit<DemandInsight, "id" | "createdAt">[];
  competitorSignals: Omit<CompetitorSignal, "id" | "createdAt">[];
}

export interface GenerateReplyRequest {
  business: BusinessUnderstanding;
  opportunity: QualifiedOpportunity;
  models: ModelConfiguration;
  instructions?: string;
}

export interface GeneratedReplyDraft {
  body: string;
  disclosedConnection: boolean;
  websiteFactProvenanceIds: EntityId[];
}

export interface EmbeddingRequest {
  texts: string[];
  models: ModelConfiguration;
  workspaceId?: EntityId;
  businessId?: EntityId;
}

export interface AiProvider {
  readonly name: string;
  analyzeBusiness(
    request: AnalyzeBusinessRequest,
  ): Promise<AiProviderResult<BusinessUnderstanding>>;
  triageConversations(
    request: TriageConversationsRequest,
  ): Promise<AiProviderResult<TriagedConversation[]>>;
  qualifyConversations(
    request: QualifyConversationsRequest,
  ): Promise<AiProviderResult<DeepQualifiedConversation[]>>;
  /** Deprecated compatibility method. */
  classifyConversations(
    request: ClassifyConversationsRequest,
  ): Promise<AiProviderResult<ClassifiedConversation[]>>;
  generateInsights(
    request: GenerateInsightsRequest,
  ): Promise<AiProviderResult<GeneratedInsightSet>>;
  generateReply(
    request: GenerateReplyRequest,
  ): Promise<AiProviderResult<GeneratedReplyDraft>>;
  /** Available for future high-volume retrieval, not used by the MVP scan. */
  embed(request: EmbeddingRequest): Promise<AiProviderResult<number[][]>>;
}

export interface RedditSearchQueries {
  productTerms: string[];
  brandTerms?: string[];
  /** Short generic categories buyers use, such as "project management software". */
  productCategories?: string[];
  customerProblems: string[];
  /** Source-grounded functional jobs that can seed demand-language searches. */
  jobsToBeDone?: string[];
  /** Source-grounded workaround hypotheses such as email, spreadsheets or manual steps. */
  workarounds?: string[];
  /** Source-grounded events that may create present-tense buying urgency. */
  triggerEvents?: string[];
  buyerIntent: string[];
  competitors: string[];
  excludedTerms: string[];
  ambiguityRisks?: string[];
}

export interface RedditSearchRequest {
  queries: RedditSearchQueries;
  subreddits?: string[];
  cursor?: string;
  limit: number;
  since?: string;
}

/**
 * Concept evidence a candidate must show for a plan entry to match.
 *
 * Token counting cannot distinguish a market from its neighbour: "android tv
 * parental control app" overlaps an Android *phone* thread on most of its
 * tokens, and the one token that separates the two markets carries no more
 * weight than the rest. Concepts express the requirement directly - market
 * evidence AND problem evidence - and each concept accepts synonyms, so a
 * thread saying "television" or "screen time" still matches.
 */
export interface RedditSearchConcepts {
  /** Market/category variants. At least one must appear in the candidate. */
  market: string[];
  /** Problem or use-case variants. At least one must appear. */
  problem: string[];
  /** Buying-intent variants. Never required; contributes to score only. */
  intent?: string[];
}

export interface RedditSearchPlanEntry {
  lane: RedditSearchLane;
  query: string;
  seed?: string;
  concepts?: RedditSearchConcepts;
}

export type ProviderRejectionReason =
  | "invalid_record"
  | "invalid_url"
  | "query_mismatch"
  | "bot_author"
  | "deleted"
  | "nsfw"
  | "missing_timestamp"
  | "outside_window";

export interface RedditDiscoveryDiagnostics {
  queryCount: number;
  fetchedCandidates: number;
  normalizedCandidates: number;
  verifiedRecentCandidates: number;
  rejectedByReason: Record<ProviderRejectionReason, number>;
  laneQueryCounts: Partial<Record<RedditSearchLane, number>>;
  /**
   * True when discovery lost coverage it could not recover even after
   * retries -- e.g. one or more query batches exhausted every retry, or a
   * timed-out run retained zero usable records. `candidates` may still be
   * non-empty (other batches can succeed); this flag is what lets a caller
   * distinguish "genuinely searched and found nothing" from "the search
   * itself was incomplete", which a bare empty `candidates` array cannot.
   */
  degraded?: boolean;
  /** How many of the planned queries never returned usable results, after retries. */
  queriesFailed?: number;
  /** How many of the planned queries succeeded (possibly after a retry). */
  queriesSucceeded?: number;
  /** Total retry attempts spent across all query batches. */
  retryAttempts?: number;
}

export interface RedditDiscoveryResponse {
  candidates: RedditDiscoveryCandidate[];
  searchPlan: RedditSearchPlanEntry[];
  nextCursor?: string;
  sourceMode: RedditConversation["sourceMode"];
  diagnostics: RedditDiscoveryDiagnostics;
}

export interface RedditEnrichmentRequest {
  candidates: RedditDiscoveryCandidate[];
  maxComments?: number;
}

export interface RedditEnrichmentResponse {
  conversations: EnrichedRedditConversation[];
  sourceMode: RedditConversation["sourceMode"];
  diagnostics: {
    requested: number;
    enriched: number;
    failed: number;
    fallbackUsed: number;
    /** Sanitized provider/mapping reason; never contains credentials or raw Reddit content. */
    failureReason?: string;
  };
}

/** Legacy response retained for compatibility with older provider callers. */
export interface RedditSearchResponse {
  conversations: RedditConversation[];
  nextCursor?: string;
  sourceMode: RedditConversation["sourceMode"];
  diagnostics?: {
    queryCount: number;
    fetchedCandidates: number;
    normalizedCandidates: number;
    locallyMatchedCandidates: number;
    enrichmentAttempts: number;
    enrichedConversations: number;
    verifiedRecentConversations: number;
    missingVerifiedTimestamps: number;
    rejectedCandidates: number;
    enrichmentFallbacks: number;
  };
}

/**
 * Production implementations must use an approved API. The `apify-test` mode
 * is an explicitly guarded MVP test adapter and is never treated as approved.
 */
/** Reported once per retry attempt so a caller can surface live progress. */
export interface RedditDiscoveryRetryNotice {
  reason: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
}

export interface RedditDiscoverOptions {
  onRetry?: (notice: RedditDiscoveryRetryNotice) => void | Promise<void>;
}

export interface RedditProvider {
  readonly name: string;
  readonly sourceMode: RedditConversation["sourceMode"];
  discover(request: RedditSearchRequest, options?: RedditDiscoverOptions): Promise<RedditDiscoveryResponse>;
  enrich(request: RedditEnrichmentRequest): Promise<RedditEnrichmentResponse>;
  /** Deprecated compatibility path. The active scan never calls it. */
  search?(request: RedditSearchRequest): Promise<RedditSearchResponse>;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  idempotencyKey: string;
}

export interface EmailProvider {
  readonly name: string;
  send(message: EmailMessage): Promise<{ providerMessageId: string }>;
}

export interface StoredObject {
  key: string;
  etag?: string;
  size: number;
  contentType: string;
}

export interface StorageProvider {
  readonly name: string;
  put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    contentType: string,
  ): Promise<StoredObject>;
  get(key: string): Promise<ReadableStream<Uint8Array> | null>;
  delete(key: string): Promise<void>;
}

export type AnalyticsValue = string | number | boolean | null;

export interface AnalyticsEvent {
  name: string;
  workspaceId: EntityId;
  businessId?: EntityId;
  actorId?: EntityId;
  occurredAt: string;
  properties?: Record<string, AnalyticsValue>;
}

export interface AnalyticsProvider {
  readonly name: string;
  capture(event: AnalyticsEvent): Promise<void>;
}
