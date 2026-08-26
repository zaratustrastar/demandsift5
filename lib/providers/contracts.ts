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

/**
 * Input for building a `BusinessUnderstanding` from a user's own freeform
 * description instead of crawled website pages -- the "Describe your market
 * / idea" onboarding path. `sourceId` is the id of the `user_supplied`
 * Provenance record the caller (scan-workflow.ts) already created for this
 * text, so every cited field can point back to it exactly like a crawled
 * page's sourceId would.
 */
export interface AnalyzeBusinessFromContextRequest {
  workspaceId: EntityId;
  businessId: EntityId;
  contextText: string;
  sourceId: EntityId;
  models: ModelConfiguration;
}

/**
 * A much smaller, uncited business summary produced from homepage-only
 * evidence by a fast/cheap model. It exists purely to let the editable
 * setup screen render in a few seconds; it is never treated as good enough
 * to plan Reddit discovery queries from -- the full `analyzeBusiness` pass
 * always runs before retrieval, either in the background while the user
 * reviews this, or synchronously if they start the scan before that
 * finishes. See lib/server/scan-workflow.ts's `profileStage` handling.
 */
export interface FastBusinessProfile {
  name: string;
  summary: string;
  productCategory: string;
  productTerms: string[];
  customerProblemLanguage: string[];
  competitors: string[];
}

export interface TriageConversationsRequest {
  business: BusinessUnderstanding;
  candidates: RedditDiscoveryCandidate[];
  models: ModelConfiguration;
  coverageRetries?: number;
  /**
   * Triage results already obtained for a subset of `candidates` during an
   * earlier, interrupted attempt of this same scan (see the doc comment on
   * ScanRecord.triageCheckpoint). Any candidate present here is returned
   * directly and never resubmitted to OpenAI.
   */
  resumeFrom?: ReadonlyMap<string, ConversationTriage>;
  /**
   * Fired once a batch (or bisected sub-batch, see processBatch) reaches a
   * final verdict for every one of its own candidates -- either a real
   * OpenAI judgment, or (only when tolerateUnrecoverableBatches is set) a
   * synthetic worthEnriching=false verdict for a batch OpenAI could never
   * usably respond to. Never fired for a batch that is still going to be
   * retried. A caller can persist these as they arrive so a scan
   * interrupted mid-triage (e.g. one concurrent batch's OpenAI request
   * timing out after exhausting its own retries) resumes from here instead
   * of resubmitting every candidate again.
   */
  onBatchSucceeded?: (items: readonly TriagedConversation[]) => void | Promise<void>;
  /**
   * Real production finding: raising triageCandidateBudget's default
   * (120 -> 300, see scan-workflow.ts) means a single scan now fans out to
   * roughly 2.5x more batches, so a batch whose OpenAI response is not
   * usable JSON even after every retry and model fallback this provider
   * offers (previously a rare event) became common enough to fail whole
   * scans outright -- one real scan lost 150 already-checkpointed, good
   * triage judgments this way. These errors are content-specific to one
   * batch, not systemic (OpenAI's own status is always absent from them,
   * unlike a real network/auth/rate-limit failure), so when this is set,
   * such a batch's candidates are marked worthEnriching=false and skipped
   * instead of failing the whole call -- they are simply never shown,
   * enriched, or promoted as leads, exactly like any other negative
   * verdict. Off by default so every other caller (and existing tests)
   * keeps the original all-or-throw coverage guarantee.
   */
  tolerateUnrecoverableBatches?: boolean;
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

/**
 * Input for generating the 3 fixed buyer-intent questions AI Visibility
 * Tracking asks every engine. Deliberately narrow -- only the handful of
 * BusinessUnderstanding fields and competitor names actually needed to
 * write natural buyer questions, not the whole business/competitor record.
 */
export interface GenerateVisibilityQuestionsRequest {
  productCategory: string;
  brandName: string;
  customerProblemLanguage: string[];
  competitorNames: string[];
  workspaceId: EntityId;
  businessId: EntityId;
  models: ModelConfiguration;
}

export interface GeneratedVisibilityQuestions {
  /** Always exactly 3: category/use-case, alternatives, and problem-solving. */
  questions: string[];
}

/** One raw AI-search answer to classify for AnalyzeVisibilityMentionsRequest. */
export interface VisibilityAnswerToAnalyze {
  index: number;
  question: string;
  answerText: string;
}

export interface AnalyzeVisibilityMentionsRequest {
  brandName: string;
  answers: VisibilityAnswerToAnalyze[];
  models: ModelConfiguration;
  workspaceId: EntityId;
  businessId: EntityId;
}

/**
 * The one genuinely semantic field AI Visibility Tracking needs: whether
 * the brand is actually being recommended as a solution, as opposed to
 * merely named, mentioned neutrally, or mentioned negatively. Everything
 * else about an answer (whether the brand/competitors/Reddit are mentioned
 * at all) is deterministic string/URL matching -- see
 * lib/server/ai-visibility-analysis.ts.
 */
export interface VisibilityMentionAnalysis {
  index: number;
  brandRecommended: boolean;
  reasoning: string;
}

export interface AiProvider {
  readonly name: string;
  analyzeBusiness(
    request: AnalyzeBusinessRequest,
  ): Promise<AiProviderResult<BusinessUnderstanding>>;
  /** Fast first-pass analysis from homepage-only evidence. See `FastBusinessProfile`. */
  analyzeBusinessFast(
    request: AnalyzeBusinessRequest,
  ): Promise<AiProviderResult<FastBusinessProfile>>;
  /**
   * The context-mode counterpart to `analyzeBusiness`: builds the same
   * `BusinessUnderstanding` shape from a user's freeform description rather
   * than crawled pages. There is no "fast" tier for this path -- a single
   * short text has no multi-page latency to hide behind, so this is always
   * the complete analysis. Competitors the user explicitly names are tagged
   * `verification: "user_claim"`; other plausible competitors the model
   * suggests, only when reasonably confident, are tagged
   * `"unverified_hypothesis"` -- see lib/domain/types.ts's CompetitorReference.
   */
  analyzeBusinessFromContext(
    request: AnalyzeBusinessFromContextRequest,
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
  /** AI Visibility Tracking: generate the 3 fixed buyer-intent questions. */
  generateVisibilityQuestions(
    request: GenerateVisibilityQuestionsRequest,
  ): Promise<AiProviderResult<GeneratedVisibilityQuestions>>;
  /** AI Visibility Tracking: batched semantic recommendation classification. */
  analyzeVisibilityMentions(
    request: AnalyzeVisibilityMentionsRequest,
  ): Promise<AiProviderResult<VisibilityMentionAnalysis[]>>;
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
  /**
   * A prior, possibly-incomplete discovery attempt for this same scan (see
   * the discovery-checkpointing comment in scan-workflow.ts). When
   * supplied, discover() skips re-querying any search-plan query already
   * present in `resumeFrom.searchPlan` and merges its own new results into
   * it before returning -- so a scan resumed after an interruption only
   * pays for and waits on whatever never actually completed, instead of
   * re-running every query from scratch.
   */
  resumeFrom?: RedditDiscoveryResponse;
  /**
   * Fired after each independently-run query chunk succeeds (never on
   * failure -- a failed chunk has nothing new worth checkpointing). The
   * value is the full running result so far (resumeFrom plus every chunk
   * that has succeeded up to and including this one). A caller can persist
   * this so a scan interrupted mid-discovery resumes from here on its next
   * attempt rather than re-querying everything already covered.
   */
  onChunkSucceeded?: (partial: RedditDiscoveryResponse) => void | Promise<void>;
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
