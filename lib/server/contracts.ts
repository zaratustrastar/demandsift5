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
  /** Post-qualification ranking score. It must never decide leadStatus. */
  score: number;
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
  author: string | null;
  canonicalPermalink: string | null;
  contentHash: string;
  contextHash: string | null;
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
  reusedUnchanged: number;
  reusedTriageOnly: number;
  submittedForTriage: number;
  triageReturned: number;
  triageMissing: number;
  triageDuplicateIds: number;
  triageUnknownIds: number;
  worthEnriching: number;
  requestedForEnrichment: number;
  enrichedSuccessfully: number;
  enrichmentFailures: number;
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

export type ScanResult = {
  profile: ScanBusinessProfile;
  insights: DemandInsightRecord[];
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
    fetchedCandidates: number;
    normalizedCandidates: number;
    locallyMatchedCandidates: number;
    enrichmentAttempts: number;
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

export type ScanRecord = {
  id: string;
  workspaceId: string;
  websiteUrl: string;
  status: "queued" | "running" | "complete" | "failed";
  progress: ScanStage[];
  createdAt: string;
  updatedAt: string;
  error: string | null;
  result: ScanResult | null;
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
