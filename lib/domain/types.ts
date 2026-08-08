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
  features: CitedValue<ProductFeature[]>;
  competitors: CitedValue<CompetitorReference[]>;
  irrelevantTopics: CitedValue<string[]>;
  productTerms: CitedValue<string[]>;
  customerProblemLanguage: CitedValue<string[]>;
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

export interface RedditConversationMetrics {
  score: number;
  comments: number;
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
  /**
   * Selected surrounding thread text fetched from the same Reddit permalink.
   * This is source material for classification and reply drafting, not a
   * business claim and never replaces the conversation's own body.
   */
  threadContext?: string;
  author?: string;
  /** Absent for mock fixtures: mock records must never link to invented URLs. */
  permalink?: string;
  createdAt: IsoDateTime;
  metrics: RedditConversationMetrics;
  matchedQuery?: string;
  provenance: SourceProvenance;
}

export type RecommendedAction =
  | "reply_helpfully"
  | "monitor"
  | "learn"
  | "avoid";
export type CommunityRisk = "low" | "medium" | "high" | "unknown";

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
  classification: OpportunityClassification;
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
