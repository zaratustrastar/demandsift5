import type {
  ConversationTriage,
  DeepQualification,
  DemandSignal,
  IntelligenceTag,
  LeadStatus,
  RedditSearchLane,
} from "@/lib/domain/types";

export type AccessPlan = "free" | "pass" | "core";

export type PotentialCustomerIntent =
  | "high_intent"
  | "competitor_switching"
  | "problem_aware";

export type ScanStageId =
  | "website"
  | "understanding"
  | "discovery"
  | "triage"
  | "enrichment"
  | "qualification"
  | "replies";

export type ScanStage = {
  id: ScanStageId;
  label: string;
  status: "pending" | "active" | "complete" | "failed";
  detail: string;
};

export type Provenance = {
  id: string;
  kind: "website" | "reddit";
  url: string;
  title: string;
  excerpt: string;
  capturedAt: string;
  synthetic: boolean;
  provider?: string;
  sourceMode?: "live" | "mock" | "apify-test";
};

/**
 * A competitor's own homepage understood through the same fast, cheap
 * first-pass pipeline as the primary business's fast profile (see
 * lib/server/competitor-analysis.ts) -- deliberately a separate model from
 * ScanBusinessProfile/BusinessUnderstanding. A competitor's site describes
 * itself, not the user's business, so its claims must never be folded into
 * discoveryProfile or treated as facts about the business being scanned.
 * Only its name and phrases are ever read downstream, and only to extend
 * (never replace) the primary business's own Reddit query terms -- see
 * runScan's discovery query-building step.
 */
export type CompetitorProfile = {
  url: string;
  domain: string;
  name: string;
  summary: string;
  productCategory: string;
  keyphrases: string[];
  painPhrases: string[];
  status: "ready" | "failed";
  error?: string;
  analyzedAt: string;
};

export type ScanBusinessProfile = {
  name: string;
  websiteUrl: string;
  summary: string;
  productCategory?: string;
  targetAudience: string[];
  problemsSolved: string[];
  jobsToBeDone?: string[];
  likelyWorkarounds?: string[];
  triggerEvents?: string[];
  /** Website-grounded search hypotheses, not observed customer quotations. */
  customerProblemLanguage?: string[];
  features: string[];
  competitors: string[];
  irrelevantTopics: string[];
  brandTerms?: string[];
  ambiguityRisks?: string[];
  sourceIds: string[];
};

export type DemandInsightRecord = {
  id: string;
  title: string;
  summary: string;
  evidence: string;
  signal: "rising" | "steady" | "emerging";
  opportunityIds: string[];
  sourceIds: string[];
  /** A single conversation is a directional signal, never a recurring pattern. */
  evidenceScope: "single-conversation" | "recurring-pattern";
  sourceCount: number;
};

export type MarketIntelligenceRecord = {
  id: string;
  sourceId: string;
  externalId: string;
  title: string;
  summary: string;
  subreddit: string;
  author: string | null;
  tags: IntelligenceTag[];
  demandSignals: DemandSignal[];
  competitor: string | null;
  sourceCreatedAt: string;
  sourceIds: string[];
  /** Ranks the competitor-intelligence view; zero when no competitor is named. */
  competitorScore: number;
  /** Ranks research value and drives theme aggregation. */
  researchScore: number;
  /** Ranks discussions worth joining, independent of lead value. */
  replyScore: number;
  /**
   * Present only when this relevant (non-lead) conversation was reply-eligible
   * and a grounded reply was drafted for it. Never implies leadStatus or
   * potentialCustomer classification -- it only means a helpful, disclosed
   * reply is available to review, matched via ReplyRecord.opportunityId.
   */
  replyId?: string;
};

export type CompetitorWeaknessRecord = {
  id: string;
  verified: boolean;
  competitor: string | null;
  title: string;
  summary: string;
  opportunityIds: string[];
  sourceIds: string[];
};

export type OpportunityRecord = {
  id: string;
  sourceId: string;
  title: string;
  excerpt: string;
  /** Selected Reddit thread context used to ground the suggested reply. */
  conversationContext?: string;
  subreddit: string;
  author: string;
  permalink: string;
  postedAt: string;
  /**
   * @deprecated Equal to `leadScore`; retained for stored reports and older
   * consumers. New code should read the purpose-specific score it means.
   */
  score: number;
  /**
   * Purpose-specific scores. A conversation is useful in several independent
   * ways, so each output ranks by its own measure rather than competing for a
   * single blended "opportunity" number.
   */
  leadScore: number;
  replyScore: number;
  competitorScore: number;
  researchScore: number;
  commentCount: number;
  whyItMatters: string;
  intent: "actively-looking" | "evaluating" | "problem-aware";
  recommendedAction: "reply" | "monitor" | "learn";
  communityRisk: "low" | "medium" | "high";
  competitorSignal: string | null;
  competitorComplaint: boolean;
  customerProblem: string;
  replyId: string;
  synthetic: boolean;
  sourceMode?: "live" | "mock" | "apify-test";
  conversationType: "post" | "comment";
  /** Normalized public Reddit author identifier; absent authors never count as people. */
  authorIdentifier: string | null;
  potentialCustomerIntent: PotentialCustomerIntent | null;
  /** Compatibility ranking alias; no longer a qualification threshold. */
  qualificationScore: number;
  firstSeenAt: string;
  scanId: string;
  sourceCreatedAt: string;
  supportingSourceIds: string[];
  supportingSignalCount: number;
  appearedInPreviousDemandDrop: boolean;
  /** Reddit fullname (`t3_…` post or `t1_…` comment) used for direct replies. */
  redditThingId?: string | null;
  discoveryLanes?: RedditSearchLane[];
  leadStatus?: LeadStatus;
  demandSignals?: DemandSignal[];
  intelligenceTags?: IntelligenceTag[];
  productFit?: DeepQualification["productFit"];
  painSeverity?: DeepQualification["painSeverity"];
  timing?: DeepQualification["timing"];
  evidenceQuality?: DeepQualification["evidenceQuality"];
  replyability?: DeepQualification["replyability"];
  shouldReply?: boolean;
  autoReplyAllowed?: boolean;
  requiresHumanReview?: boolean;
  replyAngle?: string | null;
  mentionProduct?: boolean;
  disclosureRequired?: boolean;
};

export type PotentialCustomerSummary = {
  total: number;
  conversationCount: number;
  windowDays: number;
  windowStartedAt: string;
  windowEndedAt: string;
  breakdown: {
    highIntent: number;
    competitorSwitching: number;
    problemAware: number;
  };
  newSincePreviousDemandDrop: number;
};

export type ReplyRecord = {
  id: string;
  opportunityId: string;
  workspaceId: string;
  scanId: string;
  /** Empty means not generated yet; paid results may generate lazily. */
  content: string;
  status: "draft" | "published";
  generation: number;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  publishedUrl: string | null;
  publishedVia?: "manual" | "reddit" | null;
  redditCommentId?: string | null;
};

/** OAuth tokens are always stored as versioned AES-GCM ciphertext. */
export type RedditConnectionRecord = {
  workspaceId: string;
  redditUserId: string;
  username: string;
  accessTokenCiphertext: string;
  refreshTokenCiphertext: string;
  scopes: string[];
  tokenExpiresAt: string;
  connectedAt: string;
  updatedAt: string;
};

export type RedditPublicationRecord = {
  replyId: string;
  workspaceId: string;
  redditThingId: string;
  contentHash: string;
  status: "pending" | "succeeded" | "failed" | "unknown";
  attempts: number;
  redditCommentId: string | null;
  publishedUrl: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
};

export type UsageRecord = {
  provider: "openai" | "local";
  purpose:
    | "website-analysis"
    | "website-analysis-fast"
    | "triage"
    | "deep-qualification"
    | "insight-generation"
    | "reply-generation"
    | "classification"
    | "embedding";
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
};

export type ProcessedRedditState = {
  provider: string;
  externalId: string;
  conversationId: string;
  title: string | null;
  excerpt: string;
  subreddit: string;
  author: string | null;
  canonicalPermalink: string | null;
  sourceCreatedAt: string;
  matchedQueries: string[];
  discoveryLanes: RedditSearchLane[];
  contentHash: string;
  contextHash: string | null;
  /** True only when the provider returned enough thread data to verify context. */
  threadContextVerified?: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  lastAnalyzedAt: string;
  commentCount: number;
  triage: ConversationTriage;
  deepQualification: DeepQualification | null;
  replyStatus: "not_applicable" | "eligible" | "generated" | "published";
  lastReplyAt: string | null;
};

export type ScanDiagnostics = {
  provider: string;
  retrieved: number;
  normalized: number;
  providerRejectedByReason: Record<string, number>;
  deterministicRejectedByReason: Record<string, number>;
  deterministicSurvivors: number;
  /** Embedding prefilter: how the pool was narrowed before LLM classification. */
  embeddingScored: number;
  embeddingDroppedBelowFloor: number;
  embeddingDroppedOverBudget: number;
  classifiedCandidates: number;
  reusedUnchanged: number;
  reusedTriageOnly: number;
  submittedForTriage: number;
  triageReturned: number;
  triageMissing: number;
  triageDuplicateIds: number;
  triageUnknownIds: number;
  worthEnriching: number;
  zeroResultAuditEscalated: number;
  intelligenceCoverageReviews: number;
  requestedForEnrichment: number;
  enrichedSuccessfully: number;
  enrichmentFailures: number;
  enrichmentFailureReason?: string;
  requiredFullContextReviews: number;
  coverageLimited: boolean;
  enrichmentReplacementAttempts: number;
  enrichmentReplacementSuccesses: number;
  unverifiedPotentialCustomerSignals: number;
  submittedForDeepQualification: number;
  deepQualificationsReturned: number;
  deepQualificationMissing: number;
  potentialCustomerConversations: number;
  notCustomerConversations: number;
  uncertainConversations: number;
  marketIntelligenceSignals: number;
  uniquePotentialCustomers: number;
  replyEligible: number;
  repliesGenerated: number;
};

/**
 * A recurring theme across the relevant corpus, always carrying the sources
 * that support it so the report can show evidence under every aggregation.
 */
export type ConversationThemeRecord = {
  id: string;
  label: string;
  kind: "struggle" | "request";
  conversationCount: number;
  sourceIds: string[];
};

export type ScanResult = {
  profile: ScanBusinessProfile;
  insights: DemandInsightRecord[];
  /** Aggregated pains and requests derived from the relevant corpus. */
  conversationThemes: ConversationThemeRecord[];
  marketIntelligence: MarketIntelligenceRecord[];
  competitorWeakness: CompetitorWeaknessRecord;
  opportunities: OpportunityRecord[];
  potentialCustomers: PotentialCustomerSummary;
  replies: ReplyRecord[];
  sources: Provenance[];
  usage: UsageRecord[];
  analysisMode: "openai" | "local-fallback";
  dataMode: "live" | "mock" | "apify-test";
  dataNotice: string;
  processedRedditState: ProcessedRedditState[];
  diagnostics: ScanDiagnostics;
  /** Legacy provider counters retained for existing admin/debug consumers. */
  retrievalDiagnostics?: {
    provider: string;
    queryCount: number;
    searchPlan: Array<{
      lane: RedditSearchLane;
      query: string;
      seed?: string;
    }>;
    queryCountsByLane: Partial<Record<RedditSearchLane, number>>;
    matchedCandidatesByLane: Partial<Record<RedditSearchLane, number>>;
    worthEnrichingByLane: Partial<Record<RedditSearchLane, number>>;
    matchedCandidatesByQuery: Record<string, number>;
    worthEnrichingByQuery: Record<string, number>;
    fetchedCandidates: number;
    normalizedCandidates: number;
    locallyMatchedCandidates: number;
    enrichmentAttempts: number;
    intelligenceCoverageReviews: number;
    enrichedConversations: number;
    verifiedRecentConversations: number;
    missingVerifiedTimestamps: number;
    rejectedCandidates: number;
    enrichmentFallbacks: number;
    qualifiedOpportunities: number;
  };
};

export type FunnelEventName =
  | "scan_started"
  | "scan_completed"
  | "potential_customer_count_revealed"
  | "opportunity_preview_viewed"
  | "suggested_reply_viewed"
  | "locked_results_viewed"
  | "unlock_cta_clicked"
  | "pass_checkout_started"
  | "pass_purchased";

export type FunnelEventRecord = {
  id: string;
  workspaceId: string;
  scanId: string;
  name: FunnelEventName;
  potentialCustomerCount: number | null;
  createdAt: string;
};

import type { BusinessUnderstanding } from "@/lib/domain/types";
import type { DiscoveryTermOverrides } from "@/lib/intelligence/discovery-overrides";
import type { RedditDiscoveryResponse } from "@/lib/providers/contracts";

export type ScanRecord = {
  id: string;
  workspaceId: string;
  websiteUrl: string;
  /**
   * "retrying" means the pipeline threw but a background job attempt is
   * still scheduled to try again -- it is NOT terminal, and must never be
   * treated the same as "failed" by a poller. Only `runScan`'s own catch
   * block (lib/server/scan-workflow.ts) ever assigns it, and only when it
   * was given the current job's attempt count and confirmed more attempts
   * remain. Absent that information (e.g. a synchronous, non-worker scan
   * request) a failure always lands on "failed" as before.
   */
  status: "queued" | "running" | "retrying" | "complete" | "failed";
  progress: ScanStage[];
  createdAt: string;
  updatedAt: string;
  error: string | null;
  /**
   * Structured classification of `error`, set alongside it. Lets consumers
   * (the background job executor, the frontend) branch on a stable code
   * instead of pattern-matching `error`'s free-text message.
   */
  errorCode?: string | null;
  result: ScanResult | null;
  /**
   * User edits to the discovery terms, applied before query planning. Stored
   * on the scan record, which is persisted as jsonb, so no schema change is
   * required.
   */
  discoveryOverrides?: DiscoveryTermOverrides | null;
  /**
   * Website analysis result, persisted as soon as the crawl completes and
   * before any Reddit retrieval.
   *
   * The discovery profile has to outlive the analysis step: the user reviews
   * and edits these terms *between* understanding the business and searching
   * Reddit. Reading them from `result.profile` was a lifecycle contradiction,
   * because a result only exists once the scan it was meant to configure has
   * already run.
   */
  discoveryProfile?: {
    profile: ScanBusinessProfile;
    business: BusinessUnderstanding;
    analysisMode: ScanResult["analysisMode"];
    analyzedAt: string;
    /**
     * "fast" is a homepage-only preview built to render the editable setup
     * screen in seconds; it is never sufficient input for Reddit query
     * planning. Absent (older records) or "full" both mean a complete,
     * multi-page analysis -- see lib/server/scan-workflow.ts's
     * `runFastUnderstanding` / `refineDiscoveryProfile` / the
     * `canReusePersistedAnalysis` check in `runScan`.
     */
    profileStage?: "fast" | "full";
  } | null;
  /**
   * Checkpoint of a successful Reddit discovery call, persisted the same way
   * `discoveryProfile` is: as soon as discovery clears the zero-candidates
   * guard, before any later stage (enrichment, AI qualification) has a
   * chance to fail.
   *
   * The background job retries a failed scan up to its configured max
   * attempts, and every retry re-runs `runScan()` from the top. Without this
   * checkpoint, a downstream failure on attempt 2 would silently re-trigger
   * a brand new (paid) Reddit discovery call, even though attempt 1 already
   * paid for and obtained good results -- a real production incident showed
   * a single 6-query scan spawn roughly 10 Apify actor runs this way, one
   * full discovery re-run per job attempt. `discoveryProfile` and
   * `discoveryOverrides` are both fixed once a scan starts, so discovery's
   * inputs are deterministic across attempts of the same scan: reusing this
   * checkpoint is always safe, never stale.
   */
  redditDiscovery?: RedditDiscoveryResponse | null;
  /**
   * Optional, user-supplied competitor URLs and what DemandSift understood
   * from each of their homepages. Fixed by the user before the Reddit scan
   * starts, same lifecycle as discoveryProfile/discoveryOverrides -- edited
   * on the review screen, then read (never re-analyzed) once the scan runs.
   */
  competitorProfiles?: CompetitorProfile[] | null;
};

export type EntitlementRecord = {
  workspaceId: string;
  plan: AccessPlan;
  status: "active" | "expired" | "canceled";
  accessUntil: string | null;
  seedScanId: string | null;
  websiteUrl: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  verifiedByEventId: string | null;
  updatedAt: string;
};

export type CheckoutRecord = {
  id: string;
  workspaceId: string;
  scanId: string;
  plan: Exclude<AccessPlan, "free">;
  status: "pending" | "completed";
  createdAt: string;
};

export type ConversionRecord = {
  id: string;
  workspaceId: string;
  scanId: string;
  replyId: string | null;
  kind: "click" | "conversion";
  label: string;
  valueCents: number | null;
  createdAt: string;
};

export type BackgroundJobRecord = {
  id: string;
  type: "scan.run";
  status: "queued" | "running" | "retrying" | "succeeded" | "failed";
  payload: { scanId: string; workspaceId: string };
  dedupeKey: string;
  attempts: number;
  maxAttempts: number;
  runAt: string;
  lockedAt: string | null;
  lockedBy: string | null;
  lastError: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type MonitoringScheduleRecord = {
  workspaceId: string;
  websiteUrl: string;
  seedScanId: string;
  plan: Exclude<AccessPlan, "free">;
  nextRunAt: string;
  lastRunAt: string | null;
  enabled: boolean;
  updatedAt: string;
};
