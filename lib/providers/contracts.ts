import type { AiOperation, TokenUsage } from "@/lib/ai/usage";
import type {
  BusinessUnderstanding,
  CompetitorSignal,
  DemandInsight,
  EntityId,
  ModelConfiguration,
  OpportunityClassification,
  QualifiedOpportunity,
  RedditConversation,
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
  classifyConversations(
    request: ClassifyConversationsRequest,
  ): Promise<AiProviderResult<ClassifiedConversation[]>>;
  generateInsights(
    request: GenerateInsightsRequest,
  ): Promise<AiProviderResult<GeneratedInsightSet>>;
  generateReply(
    request: GenerateReplyRequest,
  ): Promise<AiProviderResult<GeneratedReplyDraft>>;
  embed(request: EmbeddingRequest): Promise<AiProviderResult<number[][]>>;
}

export interface RedditSearchQueries {
  productTerms: string[];
  /** Short generic categories buyers use, such as "project management software". */
  productCategories?: string[];
  customerProblems: string[];
  buyerIntent: string[];
  competitors: string[];
  excludedTerms: string[];
}

export interface RedditSearchRequest {
  queries: RedditSearchQueries;
  subreddits?: string[];
  cursor?: string;
  limit: number;
  since?: string;
}

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
export interface RedditProvider {
  readonly name: string;
  readonly sourceMode: RedditConversation["sourceMode"];
  search(request: RedditSearchRequest): Promise<RedditSearchResponse>;
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
