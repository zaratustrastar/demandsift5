export type AccessPlan = "free" | "pass" | "core";

export type PotentialCustomerIntent =
  | "high_intent"
  | "competitor_switching"
  | "problem_aware";

export type ScanStageId =
  | "website"
  | "understanding"
  | "discovery"
  | "reading"
  | "ranking"
  | "competitors"
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
  targetAudience: string[];
  problemsSolved: string[];
  features: string[];
  competitors: string[];
  irrelevantTopics: string[];
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
  qualificationScore: number;
  firstSeenAt: string;
  scanId: string;
  sourceCreatedAt: string;
  supportingSourceIds: string[];
  supportingSignalCount: number;
  appearedInPreviousDemandDrop: boolean;
  /** Reddit fullname (`t3_…` post or `t1_…` comment) used for direct replies. */
  redditThingId?: string | null;
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
    | "insight-generation"
    | "reply-generation"
    | "classification"
    | "embedding";
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
};

export type ScanResult = {
  profile: ScanBusinessProfile;
  insights: DemandInsightRecord[];
  competitorWeakness: CompetitorWeaknessRecord;
  opportunities: OpportunityRecord[];
  potentialCustomers: PotentialCustomerSummary;
  replies: ReplyRecord[];
  sources: Provenance[];
  usage: UsageRecord[];
  analysisMode: "openai" | "local-fallback";
  dataMode: "live" | "mock" | "apify-test";
  dataNotice: string;
  /** Internal provider health counters; intentionally omitted from ordinary UI. */
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
