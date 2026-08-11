/**
 * Shared, serializable domain objects. These types deliberately contain no
 * database or framework primitives so API routes, jobs, and providers can all
 * use the same contracts.
 */

export type EntityId = string;
export type IsoDateTime = string;
export type Confidence = number;

export type SourceKind =
  | "website"
  | "reddit"
  | "mock_reddit"
  | "external_provider"
  | "user_supplied";

export interface SourceProvenance {
  id: EntityId;
  kind: SourceKind;
  provider: string;
  providerExternalId?: string;
  url?: string;
  title?: string;
  excerpt?: string;
  contentHash: string;
  observedAt: IsoDateTime;
  /** Mock records must remain visibly distinguishable from live Reddit data. */
  isMock: boolean;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface CitedValue<T> {
  value: T;
  confidence: Confidence;
  provenanceIds: EntityId[];
}

export interface AudienceSegment {
  name: string;
  description: string;
  pains: string[];
}

export interface ProductFeature {
  name: string;
  description: string;
  /** A feature is verified only when a crawled page supports it. */
  verified: boolean;
}

export interface CompetitorReference {
  name: string;
  relationship: "direct" | "alternative" | "category" | "unknown";
  /** Never present a competitor as fact unless its supporting sources are set. */
  verification: "website_claim" | "external_provider" | "unverified_hypothesis";
}

/** Source-backed company context used by both retrieval and AI interpretation. */
export interface BusinessUnderstanding {
  businessId: EntityId;
  workspaceId: EntityId;
  websiteUrl: string;
  canonicalDomain: string;
  name: CitedValue<string>;
  summary: CitedValue<string>;
  productCategory: CitedValue<string>;
  targetAudiences: CitedValue<AudienceSegment[]>;
  problemsSolved: CitedValue<string[]>;
  /**
   * Functional JTBD hypotheses inferred from verified website evidence.
   * These are retrieval/interpretation hypotheses, not verbatim customer claims.
   */
  jobsToBeDone?: CitedValue<string[]>;
  /**
   * Likely current alternatives or manual workarounds suggested by website evidence.
   * Empty when the website does not support a responsible inference.
   */
  likelyWorkarounds?: CitedValue<string[]>;
  /**
   * Events or transitions that could make the verified job urgent now.
   * Empty when the website does not support a responsible inference.
   */
  triggerEvents?: CitedValue<string[]>;
  features: CitedValue<ProductFeature[]>;
  competitors: CitedValue<CompetitorReference[]>;
  irrelevantTopics: CitedValue<string[]>;
  /** Product/category search seeds retained for backward compatibility. */
  productTerms: CitedValue<string[]>;
  /** Brand/product names that can be used in brand-monitoring search lanes. */
  brandTerms: CitedValue<string[]>;
  customerProblemLanguage: CitedValue<string[]>;
  /** Known ambiguity/homonym concepts such as travel meanings of "basecamp". */
  ambiguityRisks: CitedValue<string[]>;
  version: number;
  generatedAt: IsoDateTime;
}

export type RedditConversationKind = "post" | "comment";
/**
 * `apify-test` is real public Reddit data obtained through an explicitly
 * enabled web-scraping actor. It must never be presented as an approved live
 * Reddit API integration.
 */
export type RedditSourceMode = "live" | "mock" | "apify-test";

export type RedditSearchLane =
  | "explicit_demand"
  | "pain"
  | "workaround"
  | "switching"
  | "timing"
  // Legacy lane names remain accepted for previously stored scan records.
  | "direct_buying_intent"
  | "problem_pain"
  | "competitor_switching"
  | "category_recommendation"
  | "brand_competitor_mentions";

export interface RedditConversationMetrics {
  score: number;
  comments: number;
}

export interface RedditContextMessage {
  externalId: string;
  kind: RedditConversationKind;
  author?: string;
  body: string;
  parentExternalId?: string;
  createdAt?: IsoDateTime;
}

/**
 * Structured thread context keeps the matched author's words separate from
 * parent/reply/surrounding text so deep qualification cannot confuse speakers.
 */
export interface RedditStructuredContext {
  originalPost?: RedditContextMessage;
  matched: RedditContextMessage;
  parentChain: RedditContextMessage[];
  replies: RedditContextMessage[];
  surroundingComments: RedditContextMessage[];
}

/** Lightweight, timestamp-verified record returned by discovery before enrichment. */
export interface RedditDiscoveryCandidate {
  provider: string;
  sourceMode: RedditSourceMode;
  externalId: string;
  kind: RedditConversationKind;
  parentExternalId?: string;
  subreddit: string;
  title?: string;
  body: string;
  author?: string;
  permalink?: string;
  createdAt: IsoDateTime;
  metrics: RedditConversationMetrics;
  matchedQuery?: string;
  matchedQueries: string[];
  discoveryLanes: RedditSearchLane[];
  provenance: SourceProvenance;
}

/** Normalized record returned by a configured Reddit data provider. */
export interface RedditConversation {
  provider: string;
  sourceMode: RedditSourceMode;
  externalId: string;
  kind: RedditConversationKind;
  parentExternalId?: string;
  subreddit: string;
  title?: string;
  body: string;
  /** Legacy flattened context retained for UI/reply compatibility. */
  threadContext?: string;
  structuredContext?: RedditStructuredContext;
  author?: string;
  /** Absent for mock fixtures: mock records must never link to invented URLs. */
  permalink?: string;
  createdAt: IsoDateTime;
  metrics: RedditConversationMetrics;
  matchedQuery?: string;
  matchedQueries?: string[];
  discoveryLanes?: RedditSearchLane[];
  provenance: SourceProvenance;
}

export interface EnrichedRedditConversation extends RedditConversation {
  structuredContext: RedditStructuredContext;
}

export type TriageIntent =
  | "actively_looking"
  | "evaluating"
  | "switching"
  | "problem_aware"
  | "informational"
  | "promotional"
  | "irrelevant";

export type DemandSignal =
  | "explicit_demand"
  | "pain"
  | "workaround"
  | "switching"
  | "timing"
  | "none";

export type FitLevel = "low" | "medium" | "high" | "unknown";
export type TimingSignal = "current" | "near_term" | "historical" | "hypothetical" | "unknown";

export interface ConversationTriage {
  externalId: string;
  relevant: boolean;
  intent: TriageIntent;
  demandSignal: DemandSignal;
  problem?: string;
  productFit: FitLevel;
  timing: TimingSignal;
  replyability: FitLevel;
  worthEnriching: boolean;
  reason: string;
}

export type LeadStatus = "potential_customer" | "not_customer" | "uncertain";

export type IntelligenceTag =
  | "problem_signal"
  | "product_feedback"
  | "competitor_intelligence"
  | "market_insight"
  | "objection"
  | "workaround";

export type CommunityRisk = "low" | "medium" | "high" | "unknown";

export interface DeepQualification {
  externalId: string;
  leadStatus: LeadStatus;
  demandSignals: DemandSignal[];
  intelligenceTags: IntelligenceTag[];
  productFit: FitLevel;
  painSeverity: FitLevel;
  intent: TriageIntent;
  timing: TimingSignal;
  evidenceQuality: FitLevel;
  replyability: FitLevel;
  communityRisk: CommunityRisk;
  problemSummary?: string;
  competitorMentioned?: string;
  whyItMatters: string;
  shouldReply: boolean;
  autoReplyAllowed: boolean;
  requiresHumanReview: boolean;
  replyAngle?: string;
  mentionProduct: boolean;
  disclosureRequired: boolean;
}

export interface DeepQualifiedConversation {
  externalId: string;
  conversation: EnrichedRedditConversation;
  qualification: DeepQualification;
}

/** Legacy classification retained for compatibility with older stored reports. */
export type RecommendedAction =
  | "reply_helpfully"
  | "monitor"
  | "learn"
  | "avoid";

export interface OpportunityClassification {
  relevance: number;
  buyerIntent: number;
  customerProblem: number;
  competitorComplaint: number;
  semanticSimilarity: number;
  recommendedAction: RecommendedAction;
  communityRisk: CommunityRisk;
  problemSummary?: string;
  competitorMentioned?: string;
  rationale: string[];
}

export interface QualifiedOpportunity {
  id: EntityId;
  workspaceId: EntityId;
  businessId: EntityId;
  conversation: RedditConversation;
  /** New categorical qualification used by the active MVP pipeline. */
  qualification: DeepQualification;
  /** Compatibility projection only; never used to decide lead status. */
  classification: OpportunityClassification;
  /** Ranking only. Qualification is determined by `qualification.leadStatus`. */
  rankScore: number;
  status: "new" | "saved" | "dismissed" | "replied";
  provenanceIds: EntityId[];
  discoveredAt: IsoDateTime;
}

export type InsightKind =
  | "customer_demand"
  | "customer_problem"
  | "buyer_intent"
  | "competitor_gap"
  | "search_ai_visibility";

export interface DemandInsight {
  id: EntityId;
  businessId: EntityId;
  kind: InsightKind;
  title: string;
  summary: string;
  implication: string;
  confidence: Confidence;
  provenanceIds: EntityId[];
  createdAt: IsoDateTime;
}

export interface CompetitorSignal {
  id: EntityId;
  businessId: EntityId;
  competitorName: string;
  signal: string;
  customerImpact: string;
  confidence: Confidence;
  provenanceIds: EntityId[];
  createdAt: IsoDateTime;
}

export type ReplyStatus = "draft" | "edited" | "copied" | "published";

export interface SuggestedReply {
  id: EntityId;
  opportunityId: EntityId;
  version: number;
  body: string;
  status: ReplyStatus;
  disclosedConnection: boolean;
  websiteFactProvenanceIds: EntityId[];
  conversationProvenanceId: EntityId;
  generatedAt: IsoDateTime;
  editedAt?: IsoDateTime;
  publishedAt?: IsoDateTime;
  publishedUrl?: string;
}

export interface StoredResultCounts {
  opportunities: number;
  insights: number;
  competitorSignals: number;
  replies: number;
}

/** The report stores exact counts; presentation decides which records to blur. */
export interface PersonalizedReport {
  business: BusinessUnderstanding;
  demandInsights: DemandInsight[];
  competitorSignals: CompetitorSignal[];
  opportunities: QualifiedOpportunity[];
  suggestedReplies: SuggestedReply[];
  storedCounts: StoredResultCounts;
  generatedAt: IsoDateTime;
  dataMode: "live" | "includes_mock_reddit";
}

export type AccessProduct = "market_scan" | "seven_day_pass" | "core";

export interface AccessGrant {
  product: AccessProduct;
  status: "active" | "expired" | "revoked";
  startsAt: IsoDateTime;
  endsAt?: IsoDateTime;
  /** Access is created only after a verified provider event. */
  verifiedEventId?: string;
}

export interface ModelConfiguration {
  analysisModel: string;
  economyModel: string;
  embeddingModel: string;
}
