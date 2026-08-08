import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
  varchar,
} from "drizzle-orm/pg-core";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { sql } from "drizzle-orm";

import type { OpportunityClassification } from "@/lib/domain/types";
import type {
  CheckoutRecord,
  ConversionRecord,
  EntitlementRecord,
  FunnelEventRecord,
  RedditConnectionRecord,
  RedditPublicationRecord,
  ReplyRecord,
  ScanRecord,
} from "@/lib/server/contracts";

const createdAt = timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = timestamp("updated_at", { withTimezone: true }).defaultNow().notNull();

export const workspaceRole = pgEnum("workspace_role", ["owner", "member"]);
export const runStatus = pgEnum("run_status", ["queued", "running", "succeeded", "failed"]);
export const sourceKind = pgEnum("source_kind", [
  "website", "reddit", "mock_reddit", "external_provider", "user_supplied",
]);
export const conversationKind = pgEnum("conversation_kind", ["post", "comment"]);
export const recommendedAction = pgEnum("recommended_action", [
  "reply_helpfully", "monitor", "learn", "avoid",
]);
export const communityRisk = pgEnum("community_risk", ["low", "medium", "high", "unknown"]);
export const opportunityStatus = pgEnum("opportunity_status", ["new", "saved", "dismissed", "replied"]);
export const insightKind = pgEnum("insight_kind", [
  "customer_demand", "customer_problem", "buyer_intent", "competitor_gap", "search_ai_visibility",
]);
export const replyStatus = pgEnum("reply_status", ["draft", "edited", "copied", "published"]);
export const accessProduct = pgEnum("access_product", ["market_scan", "seven_day_pass", "core"]);
export const accessStatus = pgEnum("access_status", ["active", "expired", "revoked"]);
export const billingStatus = pgEnum("billing_status", [
  "pending", "active", "past_due", "canceled", "expired", "refunded",
]);
export const jobStatus = pgEnum("job_status", ["queued", "running", "retrying", "succeeded", "failed"]);

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 320 }).notNull(),
  name: varchar("name", { length: 160 }),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  createdAt,
  updatedAt,
}, (table) => [uniqueIndex("users_email_uidx").on(table.email)]);

export const authAccounts = pgTable("auth_accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: varchar("provider", { length: 64 }).notNull(),
  providerSubject: varchar("provider_subject", { length: 255 }).notNull(),
  createdAt,
}, (table) => [
  uniqueIndex("auth_accounts_provider_subject_uidx").on(table.provider, table.providerSubject),
  index("auth_accounts_user_idx").on(table.userId),
]);

export const authSessions = pgTable("auth_sessions", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: varchar("token_hash", { length: 128 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow().notNull(),
  createdAt,
}, (table) => [uniqueIndex("auth_sessions_token_hash_uidx").on(table.tokenHash), index("auth_sessions_user_idx").on(table.userId)]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 160 }).notNull(),
  createdAt,
  updatedAt,
});

export const workspaceMembers = pgTable("workspace_members", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: workspaceRole("role").default("member").notNull(),
  createdAt,
}, (table) => [
  primaryKey({ columns: [table.workspaceId, table.userId] }),
  index("workspace_members_user_idx").on(table.userId),
]);

export const businesses = pgTable("businesses", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  websiteUrl: text("website_url").notNull(),
  canonicalDomain: varchar("canonical_domain", { length: 253 }).notNull(),
  displayName: varchar("display_name", { length: 200 }),
  active: boolean("active").default(true).notNull(),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("businesses_workspace_domain_uidx").on(table.workspaceId, table.canonicalDomain),
  index("businesses_workspace_idx").on(table.workspaceId),
]);

export const analysisRuns = pgTable("analysis_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  status: runStatus("status").default("queued").notNull(),
  stage: varchar("stage", { length: 80 }).default("queued").notNull(),
  progressPercent: integer("progress_percent").default(0).notNull(),
  errorCode: varchar("error_code", { length: 80 }),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt,
}, (table) => [index("analysis_runs_business_created_idx").on(table.businessId, table.createdAt)]);

export const sourceDocuments = pgTable("source_documents", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  kind: sourceKind("kind").notNull(),
  provider: varchar("provider", { length: 100 }).notNull(),
  providerExternalId: varchar("provider_external_id", { length: 255 }),
  canonicalUrl: text("canonical_url"),
  title: text("title"),
  excerpt: text("excerpt"),
  contentHash: varchar("content_hash", { length: 128 }).notNull(),
  isMock: boolean("is_mock").default(false).notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt,
}, (table) => [
  uniqueIndex("source_documents_provider_external_uidx").on(table.provider, table.providerExternalId),
  index("source_documents_business_kind_idx").on(table.businessId, table.kind),
  index("source_documents_content_hash_idx").on(table.businessId, table.contentHash),
]);

export const websitePages = pgTable("website_pages", {
  id: uuid("id").defaultRandom().primaryKey(),
  sourceDocumentId: uuid("source_document_id").notNull().references(() => sourceDocuments.id, { onDelete: "cascade" }),
  finalUrl: text("final_url").notNull(),
  title: text("title").notNull(),
  description: text("description"),
  extractedText: text("extracted_text").notNull(),
  bytes: integer("bytes").notNull(),
  retrievedAt: timestamp("retrieved_at", { withTimezone: true }).notNull(),
  createdAt,
}, (table) => [uniqueIndex("website_pages_source_uidx").on(table.sourceDocumentId)]);

export const profileFacts = pgTable("profile_facts", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  runId: uuid("run_id").references(() => analysisRuns.id, { onDelete: "set null" }),
  category: varchar("category", { length: 80 }).notNull(),
  label: varchar("label", { length: 200 }).notNull(),
  value: jsonb("value").$type<unknown>().notNull(),
  confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
  version: integer("version").default(1).notNull(),
  createdAt,
}, (table) => [index("profile_facts_business_category_idx").on(table.businessId, table.category)]);

export const profileFactSources = pgTable("profile_fact_sources", {
  profileFactId: uuid("profile_fact_id").notNull().references(() => profileFacts.id, { onDelete: "cascade" }),
  sourceDocumentId: uuid("source_document_id").notNull().references(() => sourceDocuments.id, { onDelete: "restrict" }),
}, (table) => [primaryKey({ columns: [table.profileFactId, table.sourceDocumentId] })]);

export const redditConversations = pgTable("reddit_conversations", {
  id: uuid("id").defaultRandom().primaryKey(),
  sourceDocumentId: uuid("source_document_id").notNull().references(() => sourceDocuments.id, { onDelete: "restrict" }),
  provider: varchar("provider", { length: 100 }).notNull(),
  externalId: varchar("external_id", { length: 255 }).notNull(),
  kind: conversationKind("kind").notNull(),
  parentExternalId: varchar("parent_external_id", { length: 255 }),
  subreddit: varchar("subreddit", { length: 100 }).notNull(),
  title: text("title"),
  body: text("body").notNull(),
  author: varchar("author", { length: 100 }),
  permalink: text("permalink"),
  redditScore: integer("reddit_score").default(0).notNull(),
  commentCount: integer("comment_count").default(0).notNull(),
  postedAt: timestamp("posted_at", { withTimezone: true }).notNull(),
  createdAt,
}, (table) => [
  uniqueIndex("reddit_conversations_provider_external_uidx").on(table.provider, table.externalId),
  uniqueIndex("reddit_conversations_source_uidx").on(table.sourceDocumentId),
]);

export const opportunities = pgTable("opportunities", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => redditConversations.id, { onDelete: "restrict" }),
  runId: uuid("run_id").references(() => analysisRuns.id, { onDelete: "set null" }),
  rankScore: numeric("rank_score", { precision: 6, scale: 5 }).notNull(),
  relevance: numeric("relevance", { precision: 5, scale: 4 }).notNull(),
  buyerIntent: numeric("buyer_intent", { precision: 5, scale: 4 }).notNull(),
  customerProblem: numeric("customer_problem", { precision: 5, scale: 4 }).notNull(),
  competitorComplaint: numeric("competitor_complaint", { precision: 5, scale: 4 }).notNull(),
  semanticSimilarity: numeric("semantic_similarity", { precision: 5, scale: 4 }).notNull(),
  recommendedAction: recommendedAction("recommended_action").notNull(),
  communityRisk: communityRisk("community_risk").notNull(),
  classification: jsonb("classification").$type<OpportunityClassification>().notNull(),
  status: opportunityStatus("status").default("new").notNull(),
  discoveredAt: timestamp("discovered_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt,
}, (table) => [
  uniqueIndex("opportunities_business_conversation_uidx").on(table.businessId, table.conversationId),
  index("opportunities_business_rank_idx").on(table.businessId, table.rankScore),
]);

export const opportunitySources = pgTable("opportunity_sources", {
  opportunityId: uuid("opportunity_id").notNull().references(() => opportunities.id, { onDelete: "cascade" }),
  sourceDocumentId: uuid("source_document_id").notNull().references(() => sourceDocuments.id, { onDelete: "restrict" }),
}, (table) => [primaryKey({ columns: [table.opportunityId, table.sourceDocumentId] })]);

export const insights = pgTable("insights", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  runId: uuid("run_id").references(() => analysisRuns.id, { onDelete: "set null" }),
  kind: insightKind("kind").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  implication: text("implication").notNull(),
  confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
  createdAt,
}, (table) => [index("insights_business_created_idx").on(table.businessId, table.createdAt)]);

export const insightSources = pgTable("insight_sources", {
  insightId: uuid("insight_id").notNull().references(() => insights.id, { onDelete: "cascade" }),
  sourceDocumentId: uuid("source_document_id").notNull().references(() => sourceDocuments.id, { onDelete: "restrict" }),
}, (table) => [primaryKey({ columns: [table.insightId, table.sourceDocumentId] })]);

export const competitorSignals = pgTable("competitor_signals", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  runId: uuid("run_id").references(() => analysisRuns.id, { onDelete: "set null" }),
  competitorName: varchar("competitor_name", { length: 200 }).notNull(),
  signal: text("signal").notNull(),
  customerImpact: text("customer_impact").notNull(),
  confidence: numeric("confidence", { precision: 5, scale: 4 }).notNull(),
  createdAt,
}, (table) => [index("competitor_signals_business_idx").on(table.businessId)]);

export const competitorSignalSources = pgTable("competitor_signal_sources", {
  competitorSignalId: uuid("competitor_signal_id").notNull().references(() => competitorSignals.id, { onDelete: "cascade" }),
  sourceDocumentId: uuid("source_document_id").notNull().references(() => sourceDocuments.id, { onDelete: "restrict" }),
}, (table) => [primaryKey({ columns: [table.competitorSignalId, table.sourceDocumentId] })]);

export const suggestedReplies = pgTable("suggested_replies", {
  id: uuid("id").defaultRandom().primaryKey(),
  opportunityId: uuid("opportunity_id").notNull().references(() => opportunities.id, { onDelete: "cascade" }),
  version: integer("version").default(1).notNull(),
  body: text("body").notNull(),
  status: replyStatus("status").default("draft").notNull(),
  disclosedConnection: boolean("disclosed_connection").default(false).notNull(),
  generatedByRunId: uuid("generated_by_run_id").references(() => analysisRuns.id, { onDelete: "set null" }),
  editedAt: timestamp("edited_at", { withTimezone: true }),
  copiedAt: timestamp("copied_at", { withTimezone: true }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  publishedUrl: text("published_url"),
  createdAt,
  updatedAt,
}, (table) => [uniqueIndex("suggested_replies_opportunity_version_uidx").on(table.opportunityId, table.version)]);

export const replySources = pgTable("reply_sources", {
  replyId: uuid("reply_id").notNull().references(() => suggestedReplies.id, { onDelete: "cascade" }),
  sourceDocumentId: uuid("source_document_id").notNull().references(() => sourceDocuments.id, { onDelete: "restrict" }),
}, (table) => [primaryKey({ columns: [table.replyId, table.sourceDocumentId] })]);

export const semanticEmbeddings = pgTable("semantic_embeddings", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  sourceDocumentId: uuid("source_document_id").references(() => sourceDocuments.id, { onDelete: "cascade" }),
  purpose: varchar("purpose", { length: 80 }).notNull(),
  model: varchar("model", { length: 120 }).notNull(),
  contentHash: varchar("content_hash", { length: 128 }).notNull(),
  embedding: vector("embedding", { dimensions: 1536 }).notNull(),
  createdAt,
}, (table) => [
  uniqueIndex("semantic_embeddings_model_hash_uidx").on(table.businessId, table.purpose, table.model, table.contentHash),
]);

export const aiUsage = pgTable("ai_usage", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").references(() => businesses.id, { onDelete: "set null" }),
  runId: uuid("run_id").references(() => analysisRuns.id, { onDelete: "set null" }),
  provider: varchar("provider", { length: 80 }).notNull(),
  model: varchar("model", { length: 120 }).notNull(),
  operation: varchar("operation", { length: 80 }).notNull(),
  inputTokens: integer("input_tokens").default(0).notNull(),
  outputTokens: integer("output_tokens").default(0).notNull(),
  cachedInputTokens: integer("cached_input_tokens").default(0).notNull(),
  cacheWriteInputTokens: integer("cache_write_input_tokens").default(0).notNull(),
  estimatedCostUsd: numeric("estimated_cost_usd", { precision: 14, scale: 8 }).default("0").notNull(),
  providerRequestId: varchar("provider_request_id", { length: 255 }),
  createdAt,
}, (table) => [index("ai_usage_workspace_created_idx").on(table.workspaceId, table.createdAt)]);

export const backgroundJobs = pgTable("background_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").references(() => businesses.id, { onDelete: "cascade" }),
  type: varchar("type", { length: 100 }).notNull(),
  status: jobStatus("status").default("queued").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
  dedupeKey: varchar("dedupe_key", { length: 255 }),
  attempts: integer("attempts").default(0).notNull(),
  maxAttempts: integer("max_attempts").default(5).notNull(),
  runAt: timestamp("run_at", { withTimezone: true }).defaultNow().notNull(),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lockedBy: varchar("locked_by", { length: 160 }),
  lastError: text("last_error"),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("background_jobs_dedupe_uidx").on(table.dedupeKey).where(sql`${table.dedupeKey} is not null`),
  index("background_jobs_poll_idx").on(table.status, table.runAt),
]);

export const stripeCustomers = pgTable("stripe_customers", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  stripeCustomerId: varchar("stripe_customer_id", { length: 255 }).notNull(),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("stripe_customers_workspace_uidx").on(table.workspaceId),
  uniqueIndex("stripe_customers_customer_uidx").on(table.stripeCustomerId),
]);

export const billingPurchases = pgTable("billing_purchases", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  product: accessProduct("product").notNull(),
  status: billingStatus("status").default("pending").notNull(),
  stripeCheckoutSessionId: varchar("stripe_checkout_session_id", { length: 255 }),
  stripePaymentIntentId: varchar("stripe_payment_intent_id", { length: 255 }),
  stripeSubscriptionId: varchar("stripe_subscription_id", { length: 255 }),
  amountSubtotal: integer("amount_subtotal"),
  amountTax: integer("amount_tax"),
  amountTotal: integer("amount_total"),
  currency: varchar("currency", { length: 3 }),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  createdAt,
  updatedAt,
}, (table) => [
  uniqueIndex("billing_purchases_checkout_uidx").on(table.stripeCheckoutSessionId),
  uniqueIndex("billing_purchases_subscription_uidx").on(table.stripeSubscriptionId),
  index("billing_purchases_business_idx").on(table.businessId),
]);

export const stripeEvents = pgTable("stripe_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  stripeEventId: varchar("stripe_event_id", { length: 255 }).notNull(),
  type: varchar("type", { length: 120 }).notNull(),
  livemode: boolean("livemode").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  signatureVerified: boolean("signature_verified").default(false).notNull(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  processingError: text("processing_error"),
  createdAt,
}, (table) => [uniqueIndex("stripe_events_event_uidx").on(table.stripeEventId)]);

export const accessGrants = pgTable("access_grants", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  purchaseId: uuid("purchase_id").references(() => billingPurchases.id, { onDelete: "set null" }),
  product: accessProduct("product").notNull(),
  status: accessStatus("status").default("active").notNull(),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  verifiedStripeEventId: uuid("verified_stripe_event_id").references(() => stripeEvents.id, { onDelete: "restrict" }),
  createdAt,
  updatedAt,
}, (table) => [index("access_grants_business_status_idx").on(table.businessId, table.status, table.endsAt)]);

export const trackedLinks = pgTable("tracked_links", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  replyId: uuid("reply_id").references(() => suggestedReplies.id, { onDelete: "set null" }),
  slug: varchar("slug", { length: 80 }).notNull(),
  destinationUrl: text("destination_url").notNull(),
  clickCount: integer("click_count").default(0).notNull(),
  createdAt,
}, (table) => [uniqueIndex("tracked_links_slug_uidx").on(table.slug), index("tracked_links_business_idx").on(table.businessId)]);

export const conversions = pgTable("conversions", {
  id: uuid("id").defaultRandom().primaryKey(),
  businessId: uuid("business_id").notNull().references(() => businesses.id, { onDelete: "cascade" }),
  trackedLinkId: uuid("tracked_link_id").references(() => trackedLinks.id, { onDelete: "set null" }),
  replyId: uuid("reply_id").references(() => suggestedReplies.id, { onDelete: "set null" }),
  kind: varchar("kind", { length: 80 }).notNull(),
  externalReference: varchar("external_reference", { length: 255 }),
  valueCents: integer("value_cents"),
  currency: varchar("currency", { length: 3 }),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt,
}, (table) => [index("conversions_business_occurred_idx").on(table.businessId, table.occurredAt)]);

/**
 * Durable aggregate state for the anonymous market-scan acquisition flow.
 * These snapshots bridge the demo-shaped API to the normalized domain tables
 * above; authenticated workspace migration can happen without changing the
 * route contract.
 */
export const runtimeWorkspaces = pgTable("runtime_workspaces", {
  id: varchar("id", { length: 96 }).primaryKey(),
  tokenHash: varchar("token_hash", { length: 64 }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt,
  updatedAt,
}, (table) => [index("runtime_workspaces_expires_idx").on(table.expiresAt)]);

export const runtimeScans = pgTable("runtime_scans", {
  id: varchar("id", { length: 96 }).primaryKey(),
  workspaceId: varchar("workspace_id", { length: 96 }).notNull().references(() => runtimeWorkspaces.id, { onDelete: "cascade" }),
  websiteUrl: text("website_url").notNull(),
  status: varchar("status", { length: 24 }).notNull(),
  record: jsonb("record").$type<ScanRecord>().notNull(),
  createdAt,
  updatedAt,
}, (table) => [
  index("runtime_scans_workspace_created_idx").on(table.workspaceId, table.createdAt),
  index("runtime_scans_status_updated_idx").on(table.status, table.updatedAt),
]);

export const runtimeReplies = pgTable("runtime_replies", {
  id: varchar("id", { length: 96 }).primaryKey(),
  workspaceId: varchar("workspace_id", { length: 96 }).notNull().references(() => runtimeWorkspaces.id, { onDelete: "cascade" }),
  scanId: varchar("scan_id", { length: 96 }).notNull().references(() => runtimeScans.id, { onDelete: "cascade" }),
  status: varchar("status", { length: 24 }).notNull(),
  record: jsonb("record").$type<ReplyRecord>().notNull(),
  createdAt,
  updatedAt,
}, (table) => [
  index("runtime_replies_scan_idx").on(table.scanId),
  index("runtime_replies_workspace_status_idx").on(table.workspaceId, table.status),
]);

export const runtimeEntitlements = pgTable("runtime_entitlements", {
  workspaceId: varchar("workspace_id", { length: 96 }).primaryKey().references(() => runtimeWorkspaces.id, { onDelete: "cascade" }),
  plan: varchar("plan", { length: 24 }).notNull(),
  status: varchar("status", { length: 24 }).notNull(),
  record: jsonb("record").$type<EntitlementRecord>().notNull(),
  createdAt,
  updatedAt,
}, (table) => [index("runtime_entitlements_status_idx").on(table.status, table.updatedAt)]);

export const runtimeCheckouts = pgTable("runtime_checkouts", {
  id: varchar("id", { length: 255 }).primaryKey(),
  workspaceId: varchar("workspace_id", { length: 96 }).notNull().references(() => runtimeWorkspaces.id, { onDelete: "cascade" }),
  plan: varchar("plan", { length: 24 }).notNull(),
  status: varchar("status", { length: 24 }).notNull(),
  record: jsonb("record").$type<CheckoutRecord>().notNull(),
  createdAt,
  updatedAt,
}, (table) => [index("runtime_checkouts_workspace_status_idx").on(table.workspaceId, table.status)]);

export const runtimeMonitoringSchedules = pgTable("runtime_monitoring_schedules", {
  workspaceId: varchar("workspace_id", { length: 96 }).primaryKey().references(() => runtimeWorkspaces.id, { onDelete: "cascade" }),
  seedScanId: varchar("seed_scan_id", { length: 96 }).notNull().references(() => runtimeScans.id, { onDelete: "restrict" }),
  websiteUrl: text("website_url").notNull(),
  plan: varchar("plan", { length: 24 }).notNull(),
  cadenceSeconds: integer("cadence_seconds").notNull(),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
  lastScanId: varchar("last_scan_id", { length: 96 }).references(() => runtimeScans.id, { onDelete: "set null" }),
  enabled: boolean("enabled").default(true).notNull(),
  createdAt,
  updatedAt,
}, (table) => [
  check("runtime_monitoring_schedules_plan_check", sql`${table.plan} in ('pass', 'core')`),
  check("runtime_monitoring_schedules_cadence_check", sql`${table.cadenceSeconds} > 0`),
  check("runtime_monitoring_schedules_website_check", sql`length(trim(${table.websiteUrl})) > 0`),
  index("runtime_monitoring_schedules_due_idx").on(table.enabled, table.nextRunAt),
]);

export const runtimeConversions = pgTable("runtime_conversions", {
  id: varchar("id", { length: 96 }).primaryKey(),
  workspaceId: varchar("workspace_id", { length: 96 }).notNull().references(() => runtimeWorkspaces.id, { onDelete: "cascade" }),
  scanId: varchar("scan_id", { length: 96 }).notNull().references(() => runtimeScans.id, { onDelete: "cascade" }),
  kind: varchar("kind", { length: 24 }).notNull(),
  record: jsonb("record").$type<ConversionRecord>().notNull(),
  createdAt,
}, (table) => [
  index("runtime_conversions_workspace_created_idx").on(table.workspaceId, table.createdAt),
  index("runtime_conversions_scan_created_idx").on(table.scanId, table.createdAt),
]);

export const runtimeFunnelEvents = pgTable("runtime_funnel_events", {
  id: varchar("id", { length: 96 }).primaryKey(),
  workspaceId: varchar("workspace_id", { length: 96 }).notNull().references(() => runtimeWorkspaces.id, { onDelete: "cascade" }),
  scanId: varchar("scan_id", { length: 96 }).notNull().references(() => runtimeScans.id, { onDelete: "cascade" }),
  name: varchar("name", { length: 64 }).notNull(),
  potentialCustomerCount: integer("potential_customer_count"),
  record: jsonb("record").$type<FunnelEventRecord>().notNull(),
  createdAt,
}, (table) => [
  check("runtime_funnel_events_count_check", sql`${table.potentialCustomerCount} is null or ${table.potentialCustomerCount} >= 0`),
  index("runtime_funnel_events_workspace_created_idx").on(table.workspaceId, table.createdAt),
  index("runtime_funnel_events_scan_name_idx").on(table.scanId, table.name, table.createdAt),
]);

export const runtimeRedditConnections = pgTable("runtime_reddit_connections", {
  workspaceId: varchar("workspace_id", { length: 96 }).primaryKey().references(() => runtimeWorkspaces.id, { onDelete: "cascade" }),
  redditUserId: varchar("reddit_user_id", { length: 96 }).notNull(),
  username: varchar("username", { length: 100 }).notNull(),
  record: jsonb("record").$type<RedditConnectionRecord>().notNull(),
  createdAt,
  updatedAt,
}, (table) => [
  index("runtime_reddit_connections_user_idx").on(table.redditUserId),
]);

export const runtimeRedditPublications = pgTable("runtime_reddit_publications", {
  replyId: varchar("reply_id", { length: 96 }).primaryKey().references(() => runtimeReplies.id, { onDelete: "cascade" }),
  workspaceId: varchar("workspace_id", { length: 96 }).notNull().references(() => runtimeWorkspaces.id, { onDelete: "cascade" }),
  status: varchar("status", { length: 24 }).notNull(),
  record: jsonb("record").$type<RedditPublicationRecord>().notNull(),
  createdAt,
  updatedAt,
}, (table) => [
  check("runtime_reddit_publications_status_check", sql`${table.status} in ('pending', 'succeeded', 'failed', 'unknown')`),
  index("runtime_reddit_publications_workspace_idx").on(table.workspaceId, table.updatedAt),
]);

export type UserRow = InferSelectModel<typeof users>;
export type NewUserRow = InferInsertModel<typeof users>;
export type BusinessRow = InferSelectModel<typeof businesses>;
export type NewBusinessRow = InferInsertModel<typeof businesses>;
export type OpportunityRow = InferSelectModel<typeof opportunities>;
export type NewOpportunityRow = InferInsertModel<typeof opportunities>;
export type SuggestedReplyRow = InferSelectModel<typeof suggestedReplies>;
export type BackgroundJobRow = InferSelectModel<typeof backgroundJobs>;
