export type NavigationSectionId =
  | "dashboard"
  | "opportunities"
  | "insights"
  | "competitors"
  | "visibility"
  | "replies"
  | "results"
  | "billing"
  | "settings";

export type ProvenanceKind =
  | "website-page"
  | "reddit-conversation"
  | "derived-analysis"
  | "user-action";

export type ConfidenceLevel = "high" | "medium" | "low";

export type CommunityRisk = "low" | "medium" | "high";

export type IntentLevel = "high" | "medium" | "low";

export type PotentialCustomerIntent =
  | "high_intent"
  | "competitor_switching"
  | "problem_aware";

export interface NavigationSection {
  id: NavigationSectionId;
  label: string;
  shortLabel?: string;
  badge?: number;
}

export interface ProvenanceSource {
  id: string;
  kind: ProvenanceKind;
  title: string;
  provider: string;
  url: string | null;
  retrievedAt: string;
  excerpt: string;
  isMock: boolean;
  verifiedWithinDemoFixture: boolean;
}

export interface ProfileFact {
  id: string;
  label: string;
  value: string;
  provenanceIds: string[];
}

export interface BusinessProfile {
  name: string;
  url: string;
  hostname: string;
  isFictionalDemoBusiness: boolean;
  oneLineSummary: string;
  productCategory: string;
  targetAudience: string[];
  problemsSolved: string[];
  features: string[];
  competitors: string[];
  irrelevantTopics: string[];
  facts: ProfileFact[];
  analyzedPageCount: number;
  analyzedAt: string;
}

export interface InsightEvidence {
  quote: string;
  sourceLabel: string;
  provenanceId: string;
  sourceUrl?: string | null;
}

export interface DemandInsight {
  id: string;
  eyebrow: string;
  title: string;
  summary: string;
  evidence: InsightEvidence[];
  whyItMatters: string;
  recommendedAction: string;
  signalStrength: ConfidenceLevel;
  opportunityIds: string[];
  provenanceIds: string[];
  evidenceScope?: "single-conversation" | "recurring-pattern";
  sourceCount?: number;
}

export interface RelevantConversation {
  id: string;
  provider: string;
  isMock: boolean;
  title: string;
  summary: string;
  subreddit: string;
  authorLabel: string;
  capturedAt: string;
  permalink: string | null;
  tags: string[];
  demandSignals: string[];
  competitorName: string | null;
  provenanceIds: string[];
}

export interface CompetitorWeakness {
  id: string;
  verified: boolean;
  competitorName: string | null;
  competitorIsFictionalDemo: boolean;
  headline: string;
  summary: string;
  evidence: InsightEvidence[];
  recommendedAction: string;
  signalStrength: ConfidenceLevel;
  opportunityIds: string[];
  provenanceIds: string[];
}

export interface OpportunityClassification {
  relevanceScore: number;
  buyerIntent: IntentLevel;
  customerProblem: string;
  competitorComplaint: boolean;
  recommendedAction: string;
  communityRisk: CommunityRisk;
}

export interface SuggestedReply {
  id: string;
  opportunityId: string;
  status: "draft" | "published";
  draft: string;
  alternateDrafts: string[];
  disclosure: string;
  verifiedClaims: string[];
  sourceFactIds: string[];
  provenanceIds: string[];
  publishedVia?: "manual" | "reddit" | null;
  publishedUrl?: string | null;
}

export interface RedditOpportunity {
  id: string;
  provider: string;
  isMock: boolean;
  conversationType: "post" | "comment";
  subreddit: string;
  authorLabel: string;
  title: string;
  excerpt: string;
  capturedAt: string;
  permalink: string | null;
  canReplyOnReddit?: boolean;
  potentialCustomerIntent?: PotentialCustomerIntent | null;
  qualificationScore?: number;
  firstSeenAt?: string;
  sourceCreatedAt?: string;
  supportingSignalCount?: number;
  supportingSourceIds?: string[];
  appearedInPreviousDemandDrop?: boolean;
  mentionProduct?: boolean;
  disclosureRequired?: boolean;
  matchReasons: string[];
  classification: OpportunityClassification;
  reply: SuggestedReply;
  provenanceIds: string[];
}

export type LockedResultKind =
  | "opportunity"
  | "insight"
  | "competitor"
  | "visibility";

export interface LockedStoredResult {
  id: string;
  kind: LockedResultKind;
  headline: string;
  sourceLabel: string;
  capturedAt: string;
  provider: string;
  isMock: boolean;
  buyerIntent?: IntentLevel;
  hasSuggestedReply?: boolean;
  potentialCustomerIntent?: PotentialCustomerIntent | null;
  subreddit?: string;
  conversationType?: "post" | "comment";
  supportingSignalCount?: number;
}

export interface PotentialCustomerSummary {
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
}

export interface LockedResultCounts {
  opportunities: number;
  relevantConversations?: number;
  insights: number;
  competitorSignals: number;
  visibilityOpportunities: number;
  readyReplies: number;
}

export interface DashboardMetrics {
  qualifiedOpportunities: number;
  highIntentOpportunities: number;
  readyReplies: number;
  competitorSignals: number;
  publishedReplies: number;
  trackedClicks: number;
  trackedConversions: number;
}

export interface AnalysisProgressStage {
  id: string;
  label: string;
  detail: string;
}

export interface PricingPlan {
  id: "market-scan" | "full-access-pass" | "core";
  name: string;
  priceInCents: number;
  cadence: "free" | "one-time" | "monthly";
  durationDays?: number;
  description: string;
  features: string[];
  checkoutNote: string;
  requiresVerifiedWebhook: boolean;
}

export interface SearchVisibilityOpportunity {
  id: string;
  title: string;
  summary: string;
  recommendedAction: string;
  verificationNote: string;
  provenanceIds: string[];
}

export interface ScanEvidenceCandidate {
  externalId: string;
  title: string | null;
  excerpt: string;
  subreddit: string;
  author: string | null;
  permalink: string | null;
  sourceCreatedAt: string;
  matchedQueries: string[];
  discoveryLanes: string[];
  fullContextVerified: boolean;
  triage: {
    relevant: boolean;
    intent: string;
    demandSignal: string;
    productFit: string;
    timing: string;
    replyability: string;
    worthEnriching: boolean;
    reason: string;
  };
  deepQualification: null | {
    leadStatus: string;
    demandSignals: string[];
    intelligenceTags: string[];
    productFit: string;
    painSeverity: string;
    intent: string;
    timing: string;
    evidenceQuality: string;
    replyability: string;
    whyItMatters: string;
    shouldReply: boolean;
  };
}

export interface ScanEvidence {
  searchPlan: Array<{ lane: string; query: string; seed?: string }>;
  diagnostics: {
    retrieved: number;
    normalized: number;
    deterministicSurvivors: number;
    providerRejectedByReason: Record<string, number>;
    deterministicRejectedByReason: Record<string, number>;
    submittedForTriage: number;
    triageReturned: number;
    worthEnriching: number;
    requestedForEnrichment: number;
    enrichedSuccessfully: number;
    enrichmentFailures: number;
    requiredFullContextReviews?: number;
    coverageLimited?: boolean;
    enrichmentReplacementAttempts?: number;
    enrichmentReplacementSuccesses?: number;
    unverifiedPotentialCustomerSignals?: number;
    submittedForDeepQualification: number;
    deepQualificationsReturned: number;
    potentialCustomerConversations: number;
    uniquePotentialCustomers: number;
  };
  candidates: ScanEvidenceCandidate[];
}

export interface RedditDemandDemoData {
  fixtureLabel: string;
  fixtureDisclosure: string;
  generatedAt: string;
  business: BusinessProfile;
  provenance: ProvenanceSource[];
  insights: DemandInsight[];
  relevantConversations?: RelevantConversation[];
  competitorWeaknesses: CompetitorWeakness[];
  opportunities: RedditOpportunity[];
  potentialCustomers?: PotentialCustomerSummary;
  qualificationCoverage?: {
    credibleCandidates: number;
    fullContextReviewed: number;
    requiredFullContextReviews?: number;
    limited?: boolean;
  };
  scanEvidence?: ScanEvidence;
  lockedResults: LockedStoredResult[];
  lockedCounts: LockedResultCounts;
  metrics: DashboardMetrics;
  navigation: NavigationSection[];
  analysisProgress: AnalysisProgressStage[];
  visibilityOpportunities: SearchVisibilityOpportunity[];
  pricing: PricingPlan[];
}
