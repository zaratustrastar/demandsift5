import type {
  BusinessUnderstanding,
  ConversationTriage,
  DeepQualifiedConversation,
  DeepQualification,
  EnrichedRedditConversation,
  QualifiedOpportunity,
  RedditDiscoveryCandidate,
  RedditSearchLane,
} from "@/lib/domain/types";
import { identifyVerifiedCompetitorSignal } from "@/lib/intelligence/competitor-signal";
import {
  cleanDiscoveryCandidates,
  dedupeMarketIntelligenceRecords,
  isQualifiedPotentialCustomer,
  isRelevantMarketConversation,
  legacyClassificationFromDeep,
  competitorScore,
  leadScore,
  opportunityRankScore,
  replyScore,
  researchScore,
  potentialCustomerIntentFromQualification,
  selectCandidatesForEnrichment,
  selectCandidatesForIntelligenceReview,
  selectZeroResultAuditCandidates,
} from "@/lib/intelligence/reddit-pipeline";
import { contentFingerprint, isUsefulSearchPhrase } from "@/lib/intelligence/opportunity-ranking";
import { applyDiscoveryOverrides } from "@/lib/intelligence/discovery-overrides";
import { clusterThemes } from "@/lib/intelligence/theme-clustering";
import {
  DEFAULT_PREFILTER_FLOOR,
  cosineSimilarity,
  prioritizeCandidates,
} from "@/lib/intelligence/embedding-prefilter";
import { aggregatePotentialCustomers, normalizedRedditAuthor } from "@/lib/intelligence/potential-customers";
import { createRedditProviderFromEnv } from "@/lib/providers/reddit.server";
import { createOpenAiProviderFromEnv, openAiModelsFromEnv } from "@/lib/providers/openai.server";
import type { FastBusinessProfile } from "@/lib/providers/contracts";
import { ensureAiVisibilityTrackingStarted } from "@/lib/server/ai-visibility-workflow";
import { crawlWebsite, UnsafeWebsiteUrlError } from "@/lib/security/website-crawler";
import type { WebsiteCrawlResult } from "@/lib/security/website-crawler";
import type {
  CompetitorProfile,
  CompetitorWeaknessRecord,
  DemandInsightRecord,
  MarketIntelligenceRecord,
  OpportunityRecord,
  ProcessedRedditState,
  Provenance,
  ReplyRecord,
  ScanBusinessProfile,
  ConversationThemeRecord,
  ScanDiagnostics,
  ScanRecord,
  ScanResult,
  ScanStage,
  UsageRecord,
} from "./contracts";
import { captureFunnelEvent } from "./funnel";
import { ApiError } from "./http";
import { createId } from "./ids";
import { jobWillRetryScanFailure } from "./job-retry-classification";
import { getStateRepository } from "./repository";

const STAGES: ScanStage[] = [
  {
    id: "website",
    label: "Understanding your business",
    status: "pending",
    detail: "Reading safe public pages on the submitted domain.",
  },
  {
    id: "understanding",
    label: "Mapping the problems you solve",
    status: "pending",
    detail: "Building a source-backed company context pack.",
  },
  {
    id: "discovery",
    label: "Searching recent Reddit conversations",
    status: "pending",
    detail: "Searching explicit demand, pain, workaround, switching and timing signals.",
  },
  {
    id: "triage",
    label: "Reading every credible candidate",
    status: "pending",
    detail: "Using high-recall AI triage before spending on full thread context.",
  },
  {
    id: "enrichment",
    label: "Opening the strongest conversations",
    status: "pending",
    detail: "Fetching useful thread context only for candidates worth deeper review.",
  },
  {
    id: "qualification",
    label: "Identifying potential customers",
    status: "pending",
    detail: "Qualifying first, then ranking and deduplicating people by Reddit author.",
  },
  {
    id: "replies",
    label: "Preparing the best next move",
    status: "pending",
    detail: "Generating one grounded reply only when the conversation is appropriate to join.",
  },
];

function countCandidatesByLane(
  candidates: readonly RedditDiscoveryCandidate[],
): Partial<Record<RedditSearchLane, number>> {
  const counts: Partial<Record<RedditSearchLane, number>> = {};

  for (const candidate of candidates) {
    for (const lane of new Set(candidate.discoveryLanes)) {
      counts[lane] = (counts[lane] ?? 0) + 1;
    }
  }

  return counts;
}

function countCandidatesByQuery(
  candidates: readonly RedditDiscoveryCandidate[],
): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const candidate of candidates) {
    for (const query of new Set(candidate.matchedQueries)) {
      counts[query] = (counts[query] ?? 0) + 1;
    }
  }

  return counts;
}

function cloneStages(): ScanStage[] {
  return STAGES.map((stage) => ({ ...stage }));
}

async function setStage(
  scan: ScanRecord,
  stageId: ScanStage["id"],
  status: ScanStage["status"],
  detail?: string,
) {
  scan.progress = scan.progress.map((stage) =>
    stage.id === stageId ? { ...stage, status, detail: detail ?? stage.detail } : stage,
  );
  scan.updatedAt = new Date().toISOString();
  await getStateRepository().saveScan(scan);
}

function firstUsefulSentence(text: string): string | null {
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 35 && sentence.length <= 260);
  return sentences.find((sentence) => !/cookie|privacy|copyright|terms of use/i.test(sentence)) ?? null;
}

function cleanTitle(title: string): string {
  return title.split(/\s+[|—–-]\s+/)[0]?.trim() || title.trim();
}

function usefulFallbackSentence(value: string): string | null {
  const sentence = value.replace(/\s+/g, " ").trim();
  const words = sentence.split(" ").filter(Boolean);
  if (sentence.length < 25 || sentence.length > 220 || words.length > 38) return null;
  if (/cookie|privacy|copyright|terms of use|sign in|sign up|buy credits|marketplace/i.test(sentence)) {
    return null;
  }
  return sentence;
}

function redditThingId(
  conversation: {
    kind: "post" | "comment";
    externalId: string;
    permalink?: string;
    sourceMode: string;
  },
): string | null {
  if (conversation.sourceMode === "mock" || !conversation.permalink) return null;
  try {
    const url = new URL(conversation.permalink);
    const host = url.hostname.toLowerCase();
    const segments = url.pathname.split("/").filter(Boolean);
    let permalinkId = "";
    if (host === "redd.it") {
      if (conversation.kind !== "post") return null;
      permalinkId = segments[0] ?? "";
    } else if (host === "reddit.com" || host.endsWith(".reddit.com")) {
      const commentsIndex = segments.findIndex((segment) => segment.toLowerCase() === "comments");
      if (commentsIndex < 0) return null;
      permalinkId = conversation.kind === "comment"
        ? segments[commentsIndex + 3] ?? ""
        : segments[commentsIndex + 1] ?? "";
    }
    if (!/^[a-z0-9]+$/i.test(permalinkId)) return null;
    const providerId = conversation.externalId.trim().replace(/^t[13]_/i, "");
    if (/^[a-z0-9]+$/i.test(providerId) && providerId.toLowerCase() !== permalinkId.toLowerCase()) {
      return null;
    }
    return `${conversation.kind === "comment" ? "t1" : "t3"}_${permalinkId}`;
  } catch {
    return null;
  }
}

function conservativeProfile(
  canonicalUrl: string,
  pages: Array<{ url: string; title: string; description?: string; text: string; sourceId: string }>,
): ScanBusinessProfile {
  const homepage = pages[0];
  const hostname = new URL(canonicalUrl).hostname.replace(/^www\./, "");
  const name = cleanTitle(homepage?.title ?? "") || hostname.split(".")[0] || hostname;
  const summary =
    homepage?.description?.trim() ||
    firstUsefulSentence(homepage?.text ?? "") ||
    `${name} is described on its public website at ${hostname}.`;
  const pageTitles = pages
    .slice(1)
    .map((page) => cleanTitle(page.title))
    .filter((title) =>
      title.length >= 3 &&
      title.length <= 80 &&
      !/home|about|contact|privacy|terms|login|sign in/i.test(title),
    );
  const problemSentences = pages
    .flatMap((page) =>
      page.text
        .replace(/\s+/g, " ")
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => /\b(help|solve|simplif|save|avoid|reduce|enable|without)\w*\b/i.test(sentence)),
    )
    .map(usefulFallbackSentence)
    .filter((sentence): sentence is string => Boolean(sentence))
    .slice(0, 4);
  return {
    name,
    websiteUrl: canonicalUrl,
    summary,
    productCategory: pageTitles[0] ?? name,
    targetAudience: [],
    problemsSolved: problemSentences,
    jobsToBeDone: [],
    likelyWorkarounds: [],
    triggerEvents: [],
    customerProblemLanguage: problemSentences,
    features: [...new Set(pageTitles)].slice(0, 6),
    competitors: [],
    irrelevantTopics: [],
    brandTerms: [name],
    ambiguityRisks: [],
    sourceIds: pages.map((page) => page.sourceId),
  };
}

function toBusinessUnderstanding(input: {
  profile: ScanBusinessProfile;
  workspaceId: string;
  businessId: string;
  canonicalDomain: string;
}): BusinessUnderstanding {
  const { profile } = input;
  const cited = <T,>(value: T) => ({ value, confidence: 0.8, provenanceIds: profile.sourceIds });
  const productTerms = [profile.name, profile.productCategory ?? "", ...profile.features.slice(0, 3)]
    .filter(isUsefulSearchPhrase);
  return {
    businessId: input.businessId,
    workspaceId: input.workspaceId,
    websiteUrl: profile.websiteUrl,
    canonicalDomain: input.canonicalDomain,
    name: cited(profile.name),
    summary: cited(profile.summary),
    productCategory: cited(profile.productCategory ?? profile.features[0] ?? profile.name),
    targetAudiences: cited(
      profile.targetAudience.map((audience) => ({ name: audience, description: audience, pains: [] })),
    ),
    problemsSolved: cited(profile.problemsSolved),
    jobsToBeDone: cited(profile.jobsToBeDone ?? []),
    likelyWorkarounds: cited(profile.likelyWorkarounds ?? []),
    triggerEvents: cited(profile.triggerEvents ?? []),
    features: cited(profile.features.map((feature) => ({ name: feature, description: feature, verified: true }))),
    competitors: cited(profile.competitors.map((competitor) => ({
      name: competitor,
      relationship: "unknown" as const,
      verification: "website_claim" as const,
    }))),
    irrelevantTopics: cited(profile.irrelevantTopics),
    productTerms: cited(productTerms),
    brandTerms: cited(profile.brandTerms?.length ? profile.brandTerms : [profile.name]),
    customerProblemLanguage: cited(
      profile.customerProblemLanguage?.length
        ? profile.customerProblemLanguage
        : profile.problemsSolved,
    ),
    ambiguityRisks: cited(profile.ambiguityRisks ?? []),
    version: 3,
    generatedAt: new Date().toISOString(),
  };
}

function profileFromBusiness(business: BusinessUnderstanding): ScanBusinessProfile {
  return {
    name: business.name.value,
    websiteUrl: business.websiteUrl,
    summary: business.summary.value,
    productCategory: business.productCategory.value,
    targetAudience: business.targetAudiences.value.map((audience) => audience.name),
    problemsSolved: business.problemsSolved.value,
    jobsToBeDone: business.jobsToBeDone?.value ?? [],
    likelyWorkarounds: business.likelyWorkarounds?.value ?? [],
    triggerEvents: business.triggerEvents?.value ?? [],
    customerProblemLanguage: business.customerProblemLanguage.value,
    features: business.features.value.filter((feature) => feature.verified).map((feature) => feature.name),
    competitors: business.competitors.value
      .filter((competitor) => competitor.verification !== "unverified_hypothesis")
      .map((competitor) => competitor.name),
    irrelevantTopics: business.irrelevantTopics.value,
    brandTerms: business.brandTerms.value,
    ambiguityRisks: business.ambiguityRisks.value,
    sourceIds: [...new Set([
      ...business.name.provenanceIds,
      ...business.summary.provenanceIds,
      ...business.productCategory.provenanceIds,
      ...business.targetAudiences.provenanceIds,
      ...business.problemsSolved.provenanceIds,
      ...(business.jobsToBeDone?.provenanceIds ?? []),
      ...(business.likelyWorkarounds?.provenanceIds ?? []),
      ...(business.triggerEvents?.provenanceIds ?? []),
      ...business.features.provenanceIds,
      ...business.competitors.provenanceIds,
      ...business.productTerms.provenanceIds,
      ...business.brandTerms.provenanceIds,
      ...business.customerProblemLanguage.provenanceIds,
      ...business.ambiguityRisks.provenanceIds,
    ])],
  };
}

/** Builds the same review-screen profile shape as `profileFromBusiness`, but
 * from a fast, homepage-only, uncited analysis. Fields the fast pass never
 * asks for (audiences, jobs, workarounds, triggers, features, exclusions,
 * ambiguity risks) are left empty rather than guessed; the background
 * refinement (see `refineDiscoveryProfile`) fills them in from the full
 * multi-page analysis. */
function scanProfileFromFastAnalysis(
  fast: FastBusinessProfile,
  canonicalUrl: string,
  sourceIds: string[],
): ScanBusinessProfile {
  return {
    name: fast.name,
    websiteUrl: canonicalUrl,
    summary: fast.summary,
    productCategory: fast.productCategory,
    targetAudience: [],
    problemsSolved: fast.customerProblemLanguage,
    jobsToBeDone: [],
    likelyWorkarounds: [],
    triggerEvents: [],
    customerProblemLanguage: fast.customerProblemLanguage,
    features: [],
    competitors: fast.competitors,
    irrelevantTopics: [],
    brandTerms: [fast.name],
    ambiguityRisks: [],
    sourceIds,
  };
}

/** The `BusinessUnderstanding` counterpart to `scanProfileFromFastAnalysis`,
 * built directly (rather than via `toBusinessUnderstanding`) so productTerms
 * can cite the fast pass's own productTerms instead of the derived
 * name/productCategory/features formula that pass never fills in. Confidence
 * is intentionally lower than a full analysis's 0.8: this is a one-page,
 * quick-read hypothesis, not a verified multi-page finding. */
function businessUnderstandingFromFastAnalysis(
  fast: FastBusinessProfile,
  input: { workspaceId: string; businessId: string; websiteUrl: string; canonicalDomain: string; sourceIds: string[] },
): BusinessUnderstanding {
  const cited = <T,>(value: T) => ({ value, confidence: 0.55, provenanceIds: input.sourceIds });
  const productTerms = [fast.productCategory, ...fast.productTerms].filter(isUsefulSearchPhrase);
  return {
    businessId: input.businessId,
    workspaceId: input.workspaceId,
    websiteUrl: input.websiteUrl,
    canonicalDomain: input.canonicalDomain,
    name: cited(fast.name),
    summary: cited(fast.summary),
    productCategory: cited(fast.productCategory),
    targetAudiences: cited([]),
    problemsSolved: cited(fast.customerProblemLanguage),
    jobsToBeDone: cited([]),
    likelyWorkarounds: cited([]),
    triggerEvents: cited([]),
    features: cited([]),
    competitors: cited(
      fast.competitors.map((name) => ({
        name,
        relationship: "unknown" as const,
        verification: "website_claim" as const,
      })),
    ),
    irrelevantTopics: cited([]),
    productTerms: cited(productTerms),
    brandTerms: cited([fast.name]),
    customerProblemLanguage: cited(fast.customerProblemLanguage),
    ambiguityRisks: cited([]),
    version: 3,
    generatedAt: new Date().toISOString(),
  };
}

/** Provenance records + sourceId-tagged pages for a crawl result. Shared by
 * the fast pass, the full pass inside `runScan`, and the background
 * `refineDiscoveryProfile` continuation, so all three attribute evidence the
 * same way. */
function pagesFromCrawl(crawl: WebsiteCrawlResult): {
  websiteSources: Provenance[];
  pages: Array<WebsiteCrawlResult["pages"][number] & { sourceId: string }>;
} {
  const websiteSources: Provenance[] = crawl.pages.map((page) => ({
    id: `web_${page.contentHash.slice(0, 20)}`,
    kind: "website",
    url: page.url,
    title: page.title,
    excerpt: (page.description ?? page.text).slice(0, 280),
    capturedAt: page.retrievedAt,
    synthetic: false,
    provider: "same-domain-crawler",
    sourceMode: "live",
  }));
  const pages = crawl.pages.map((page, index) => ({ ...page, sourceId: websiteSources[index].id }));
  return { websiteSources, pages };
}

/** Fast first-pass understanding: a homepage-only crawl plus, when AI is
 * configured, a small/cheap-model analysis -- built to finish in a couple of
 * seconds so the editable setup screen doesn't wait on the full 4-page,
 * `analysisModel` pipeline. Falls back to the same local heuristic parser
 * the full pipeline uses when no AI provider is configured. */
async function runFastUnderstanding(scan: ScanRecord): Promise<{
  business: BusinessUnderstanding;
  profile: ScanBusinessProfile;
  analysisMode: ScanResult["analysisMode"];
}> {
  const crawl = await crawlWebsite(scan.websiteUrl, { maxPages: 1, timeoutMs: 6_000 });
  const { pages } = pagesFromCrawl(crawl);
  const homepage = pages[0];
  const businessId = createId("biz");
  const aiProvider = process.env.OPENAI_API_KEY?.trim() ? createOpenAiProviderFromEnv() : null;

  if (aiProvider) {
    const models = openAiModelsFromEnv();
    const analyzed = await aiProvider.analyzeBusinessFast({
      workspaceId: scan.workspaceId,
      businessId,
      websiteUrl: crawl.canonicalUrl,
      canonicalDomain: crawl.canonicalDomain,
      pages: [homepage],
      models,
    });
    const profile = scanProfileFromFastAnalysis(analyzed.value, crawl.canonicalUrl, [homepage.sourceId]);
    const business = businessUnderstandingFromFastAnalysis(analyzed.value, {
      workspaceId: scan.workspaceId,
      businessId,
      websiteUrl: crawl.canonicalUrl,
      canonicalDomain: crawl.canonicalDomain,
      sourceIds: [homepage.sourceId],
    });
    return { business, profile, analysisMode: "openai" };
  }

  const profile = conservativeProfile(crawl.canonicalUrl, pages);
  const business = toBusinessUnderstanding({
    profile,
    workspaceId: scan.workspaceId,
    businessId,
    canonicalDomain: crawl.canonicalDomain,
  });
  return { business, profile, analysisMode: "local-fallback" };
}

/** Best-effort continuation of the fast pass: re-crawls the full 4 pages and
 * runs the real `analysisModel` analysis, then upgrades `discoveryProfile`
 * from "fast" to "full" in place. Runs detached from any HTTP request on
 * this same long-running server process (see the `void` call site in
 * `runScan`) -- if it throws, is slow, or the process restarts before it
 * finishes, nothing is lost: `runScan`'s full pipeline path only ever
 * trusts a "full" `discoveryProfile`, so it simply redoes this
 * synchronously the next time the scan is started. Re-reads the scan
 * immediately before writing so it never clobbers a scan that has since
 * moved on (started, or already refined by another run). */
async function refineDiscoveryProfile(scanId: string): Promise<void> {
  const repository = getStateRepository();
  const scan = await repository.getScan(scanId);
  if (!scan || scan.status !== "queued" || scan.discoveryProfile?.profileStage !== "fast") return;

  const aiProvider = process.env.OPENAI_API_KEY?.trim() ? createOpenAiProviderFromEnv() : null;
  if (!aiProvider) return;

  const crawl = await crawlWebsite(scan.websiteUrl, { maxPages: 4 });
  const { pages } = pagesFromCrawl(crawl);
  const models = openAiModelsFromEnv();
  const businessId = scan.discoveryProfile.business.businessId;
  const analyzed = await aiProvider.analyzeBusiness({
    workspaceId: scan.workspaceId,
    businessId,
    websiteUrl: crawl.canonicalUrl,
    canonicalDomain: crawl.canonicalDomain,
    pages,
    models,
  });
  const business = analyzed.value;
  const profile = profileFromBusiness(business);

  const latest = await repository.getScan(scanId);
  if (!latest || latest.status !== "queued" || latest.discoveryProfile?.profileStage !== "fast") return;
  latest.discoveryProfile = {
    profile,
    business,
    analysisMode: "openai",
    analyzedAt: new Date().toISOString(),
    profileStage: "full",
  };
  latest.updatedAt = new Date().toISOString();
  await repository.saveScan(latest);
}

/**
 * Turns analyzed competitor profiles into extra Reddit query material,
 * kept structurally separate from the primary business's own
 * BusinessUnderstanding the whole way through (see CompetitorProfile's doc
 * comment in contracts.ts) -- these are never merged into `business`, only
 * appended to the query arrays built from it, and only for competitors that
 * analyzed successfully. Skipped competitors (no URLs submitted, or every
 * submission failed) simply contribute nothing, which is exactly today's
 * behavior with no competitorProfiles.
 */
function competitorDiscoverySignals(
  competitorProfiles: readonly CompetitorProfile[] | null | undefined,
): { names: string[]; painPhrases: string[] } {
  const ready = (competitorProfiles ?? []).filter((competitor) => competitor.status === "ready");
  const names = ready
    .flatMap((competitor) => [competitor.name, `${competitor.name} alternative`])
    .filter(isUsefulSearchPhrase);
  // A couple of phrases per competitor, not every one they found: this is a
  // supplementary signal filling any budget the primary business's own pain
  // phrases left, not a second full query family of its own.
  const painPhrases = ready.flatMap((competitor) => competitor.painPhrases.slice(0, 2));
  return { names, painPhrases };
}

function usageRecord(
  result: { model: string; usage: { inputTokens: number; outputTokens: number }; estimatedCostUsd: number },
  purpose: UsageRecord["purpose"],
): UsageRecord {
  return {
    provider: "openai",
    purpose,
    model: result.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    estimatedCostUsd: result.estimatedCostUsd,
  };
}

function localMockTriage(candidate: RedditDiscoveryCandidate): ConversationTriage {
  const text = `${candidate.title ?? ""}\n${candidate.body}`.toLocaleLowerCase("en-US");
  if (/not buying right now|documenting how teams|weekly general discussion|hiring updates/.test(text)) {
    return {
      externalId: candidate.externalId,
      relevant: false,
      intent: /launch|hiring/.test(text) ? "promotional" : "informational",
      demandSignal: "none",
      problem: undefined,
      productFit: "unknown",
      timing: "unknown",
      replyability: "low",
      worthEnriching: false,
      reason: "Labeled mock fixture is informational/promotional rather than current demand.",
    };
  }
  const switching = /alternative|tried .* but|current .* breaking/.test(text);
  const explicit = /looking for|need something|recommend|what has worked|which/.test(text);
  const pain = /manual|outgrown|breaking down|loses .* hours|difficult to justify/.test(text);
  return {
    externalId: candidate.externalId,
    relevant: true,
    intent: switching ? "switching" : explicit ? "actively_looking" : "problem_aware",
    demandSignal: switching ? "switching" : explicit ? "explicit_demand" : pain ? "pain" : "none",
    problem: candidate.body,
    productFit: "high",
    timing: "current",
    replyability: "high",
    worthEnriching: true,
    reason: "Labeled mock fixture contains a current demand/problem signal.",
  };
}

function localMockDeep(
  conversation: EnrichedRedditConversation,
  triage: ConversationTriage,
): DeepQualification {
  const switching = triage.intent === "switching";
  return {
    externalId: conversation.externalId,
    leadStatus: triage.relevant ? "potential_customer" : "not_customer",
    demandSignals: triage.demandSignal === "none" ? [] : [triage.demandSignal],
    intelligenceTags: triage.relevant
      ? switching
        ? ["problem_signal", "competitor_intelligence"]
        : ["problem_signal"]
      : ["market_insight"],
    productFit: triage.productFit,
    painSeverity: triage.relevant ? "high" : "low",
    intent: triage.intent,
    timing: triage.timing,
    evidenceQuality: triage.relevant ? "high" : "medium",
    replyability: triage.replyability,
    communityRisk: "low",
    problemSummary: triage.problem,
    competitorMentioned: switching ? "the market leader" : undefined,
    whyItMatters: triage.reason,
    shouldReply: triage.relevant && triage.replyability === "high",
    autoReplyAllowed: false,
    requiresHumanReview: true,
    replyAngle: triage.relevant ? "Help with a practical evaluation framework before mentioning the product." : undefined,
    mentionProduct: false,
    disclosureRequired: false,
  };
}

function structuredContextHash(conversation: EnrichedRedditConversation): string {
  return contentFingerprint(JSON.stringify(conversation.structuredContext));
}

function canonicalPermalink(value?: string): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function sameWebsite(left: string, right: string): boolean {
  try {
    return new URL(left).hostname.toLowerCase().replace(/^www\./, "") ===
      new URL(right).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
}

function normalizedCompetitorName(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function intentForQualification(qualification: DeepQualification): OpportunityRecord["intent"] {
  if (qualification.intent === "actively_looking") return "actively-looking";
  if (qualification.intent === "evaluating" || qualification.intent === "switching") return "evaluating";
  return "problem-aware";
}

function communityRiskForUi(risk: DeepQualification["communityRisk"]): OpportunityRecord["communityRisk"] {
  return risk === "unknown" ? "medium" : risk;
}

function fallbackReply(profile: ScanBusinessProfile): string {
  const fact = profile.features[0] ?? profile.problemsSolved[0] ?? profile.summary;
  return `A practical way to narrow this down is to start with the workflow that is causing the most friction, then compare options against setup effort, day-to-day maintenance, and the specific handoffs your team needs to keep visible.\n\nFull disclosure: I work with ${profile.name}. Our public site describes ${fact}. If that directly matches what you are trying to fix, it may be worth including in the same comparison, but I would test it against those workflow criteria rather than choosing on feature count alone.`;
}

function buildFallbackInsights(
  opportunities: OpportunityRecord[],
): { insights: DemandInsightRecord[]; weakness: CompetitorWeaknessRecord } {
  const recommendationRequests = opportunities.filter(
    (opportunity) => opportunity.intent === "actively-looking" || opportunity.intent === "evaluating",
  );
  const problemAware = opportunities.filter((opportunity) =>
    opportunity.demandSignals?.includes("pain") || opportunity.potentialCustomerIntent === "problem_aware",
  );
  const competitorOpportunities = opportunities.filter(
    (opportunity) => opportunity.competitorComplaint && opportunity.competitorSignal,
  );
  const inputs = [
    {
      title: "Buyers are asking for practical recommendations",
      summary: "The strongest stored conversations contain active evaluation or recommendation intent.",
      evidence: `${recommendationRequests.length} qualified conversation(s) contain recommendation/evaluation intent.`,
      signal: "rising" as const,
      rows: recommendationRequests,
    },
    {
      title: "Current workflow pain is creating demand",
      summary: "Qualified authors describe concrete problems before they necessarily name a product category.",
      evidence: `${problemAware.length} qualified conversation(s) contain a current problem signal.`,
      signal: "steady" as const,
      rows: problemAware,
    },
  ];
  const insights = inputs.filter((input) => input.rows.length > 0).map((input) => {
    const sourceIds = [...new Set(input.rows.map((row) => row.sourceId))];
    return {
      id: createId("ins"),
      title: input.title,
      summary: input.summary,
      evidence: input.evidence,
      signal: input.signal,
      opportunityIds: input.rows.map((row) => row.id),
      sourceIds,
      evidenceScope: sourceIds.length >= 2 ? "recurring-pattern" as const : "single-conversation" as const,
      sourceCount: sourceIds.length,
    };
  });
  const weakness: CompetitorWeaknessRecord = competitorOpportunities.length > 0
    ? {
        id: createId("comp"),
        verified: true,
        competitor: competitorOpportunities[0].competitorSignal,
        title: "A source-backed competitor complaint reveals an opening",
        summary: "This is one qualified conversation signal, not a market-wide claim.",
        opportunityIds: competitorOpportunities.map((row) => row.id),
        sourceIds: competitorOpportunities.map((row) => row.sourceId),
      }
    : {
        id: createId("comp"),
        verified: false,
        competitor: null,
        title: "No verified competitor weakness in this scan",
        summary: "No deeply qualified conversation contained a source-backed competitor complaint or comparison.",
        opportunityIds: [],
        sourceIds: [],
      };
  return { insights, weakness };
}

/**
 * Candidate volume for the acquisition scan. Segmentation happens after
 * relevance qualification, so retrieval optimises for useful business-relevant
 * conversations rather than leads alone.
 */
/**
 * Maximum candidates forwarded to LLM relevance classification. The embedding
 * prefilter keeps this bounded while acquisition volume grows.
 */
function triageCandidateBudget(): number {
  const value = Number(process.env.REDDIT_TRIAGE_BUDGET ?? 120);
  return Number.isFinite(value) ? Math.max(20, Math.min(Math.trunc(value), 400)) : 120;
}

function embeddingPrefilterFloor(): number {
  const value = Number(process.env.REDDIT_EMBEDDING_PREFILTER_FLOOR);
  return Number.isFinite(value) ? Math.max(0, Math.min(value, 0.5)) : DEFAULT_PREFILTER_FLOOR;
}

/** What the business is about, embedded once and compared to each candidate. */
function businessEmbeddingQuery(business: BusinessUnderstanding): string {
  const parts = [
    business.productCategory.value,
    ...business.productTerms.value,
    ...business.customerProblemLanguage.value,
    ...business.problemsSolved.value,
    ...(business.jobsToBeDone?.value ?? []),
  ].filter((value) => typeof value === "string" && value.trim().length > 0);
  return [...new Set(parts)].join("\n").slice(0, 6_000);
}

function candidateEmbeddingText(candidate: RedditDiscoveryCandidate): string {
  return `${candidate.title ?? ""}\n${candidate.body ?? ""}`.trim().slice(0, 4_000);
}

function acquisitionCandidateTarget(): number {
  const value = Number(process.env.REDDIT_ACQUISITION_CANDIDATES ?? 250);
  return Number.isFinite(value) ? Math.max(25, Math.min(Math.trunc(value), 400)) : 250;
}

function enrichmentBudget(): number {
  const value = Number(process.env.REDDIT_ENRICHMENT_BUDGET ?? process.env.APIFY_REDDIT_ENRICHMENT_LIMIT ?? 8);
  return Number.isFinite(value) ? Math.max(1, Math.min(Math.trunc(value), 20)) : 8;
}

/**
 * How many conversations must be read with full thread context before the scan
 * is allowed to publish - in particular before it may publish a definitive
 * zero. Deliberately independent of the lookback window: shortening the window
 * to 7 days must not silently halve verification quality.
 */
function minimumFullContextReviews(): number {
  const configured = Number(process.env.REDDIT_MINIMUM_FULL_CONTEXT_REVIEWS);
  if (Number.isFinite(configured)) return Math.max(0, Math.min(Math.trunc(configured), enrichmentBudget()));
  return 4;
}

/**
 * Enrichment is probabilistic: threads get deleted, subreddits go private and
 * the scraper is occasionally rate limited. Selecting exactly the minimum meant
 * `required === selected`, so a single miss failed the entire scan after all
 * upstream work had already been paid for. Select with headroom instead.
 */
function enrichmentSelectionTarget(required: number): number {
  const headroom = Math.max(2, Math.ceil(required * 0.5));
  return Math.min(enrichmentBudget(), required + headroom);
}

export async function createScan(workspaceId: string, websiteUrl: string): Promise<ScanRecord> {
  const now = new Date().toISOString();
  const scan: ScanRecord = {
    id: createId("scan"),
    workspaceId,
    websiteUrl,
    status: "queued",
    progress: cloneStages(),
    createdAt: now,
    updatedAt: now,
    error: null,
    result: null,
  };
  await getStateRepository().saveScan(scan);
  await captureFunnelEvent(scan, "scan_started");
  return scan;
}

export async function enqueueScanRun(scan: ScanRecord) {
  return getStateRepository().enqueueScan(scan.id, scan.workspaceId);
}

export async function runScan(
  scanId: string,
  options: {
    resumeRunning?: boolean;
    stopAfterUnderstanding?: boolean;
    /**
     * The current background job attempt number and its configured ceiling,
     * when this run is driven by the job queue. Used only to decide whether
     * a thrown error should leave the scan at a terminal "failed" or at
     * "retrying" -- a status the frontend keeps polling through instead of
     * showing an error screen. Omitted (e.g. a synchronous, non-worker scan
     * request) always falls back to "failed", matching prior behavior.
     */
    jobAttempts?: number;
    jobMaxAttempts?: number;
  } = {},
): Promise<ScanRecord> {
  const repository = getStateRepository();
  const claim = await repository.beginScanRun(scanId);
  if (claim.state === "missing" || !claim.scan) {
    throw new ApiError("Scan was not found.", 404, "scan_not_found");
  }
  if (claim.state === "complete") return claim.scan;
  if (claim.state === "running" && !options.resumeRunning) return claim.scan;
  const scan = claim.scan;

  try {
    await setStage(scan, "website", "active");

    if (options.stopAfterUnderstanding) {
      // `/analyze` only ever calls runScan with stopAfterUnderstanding when
      // scan.discoveryProfile doesn't exist yet (it returns early itself
      // otherwise), so there is nothing here to reuse: always take the fast
      // path. The full crawl + full analysis still happen -- right away in
      // the background, or synchronously the next time runScan() runs the
      // real pipeline -- before Reddit retrieval ever sees this profile.
      const fast = await runFastUnderstanding(scan);
      await setStage(scan, "website", "complete", "1 public page read from the submitted domain.");
      scan.discoveryProfile = {
        profile: fast.profile,
        business: fast.business,
        analysisMode: fast.analysisMode,
        analyzedAt: new Date().toISOString(),
        profileStage: "fast",
      };
      await setStage(
        scan,
        "understanding",
        "complete",
        `Fast first look at ${fast.profile.name}. Refining in the background -- review what we should look for, then start the Reddit scan.`,
      );
      scan.status = "queued";
      scan.updatedAt = new Date().toISOString();
      await getStateRepository().saveScan(scan);

      // Best-effort background upgrade to a full analysis; see
      // refineDiscoveryProfile's doc comment for why a lost/failed run here
      // is never a correctness problem.
      void refineDiscoveryProfile(scan.id).catch((error) => {
        console.error("scan-workflow: background profile refinement failed", error);
      });

      return scan;
    }

    const crawl = await crawlWebsite(scan.websiteUrl, { maxPages: 4 });
    const { websiteSources, pages } = pagesFromCrawl(crawl);
    await setStage(
      scan,
      "website",
      "complete",
      `${pages.length} public page${pages.length === 1 ? "" : "s"} read from the submitted domain.`,
    );

    const redditProvider = createRedditProviderFromEnv({
      ...process.env,
      REDDIT_PROVIDER: process.env.REDDIT_PROVIDER?.trim() || "mock",
    });
    const requiresAi = redditProvider.sourceMode !== "mock";
    const usage: UsageRecord[] = [];
    const businessId = createId("biz");
    const models = openAiModelsFromEnv();
    const aiProvider = process.env.OPENAI_API_KEY?.trim()
      ? createOpenAiProviderFromEnv()
      : null;
    if (requiresAi && !aiProvider) {
      throw new Error("AI is required to analyze and qualify real Reddit records.");
    }

    await setStage(scan, "understanding", "active");
    let business: BusinessUnderstanding;
    let profile: ScanBusinessProfile;
    let analysisMode: ScanResult["analysisMode"];
    // A previously analyzed profile is reused verbatim. Re-analyzing would
    // burn tokens and, worse, could produce different terms from the ones the
    // user just reviewed and approved. A "fast" (homepage-only) profile is
    // never reused here: it exists only to render the review screen quickly,
    // and query planning below needs the full multi-page analysis, so this
    // redoes it just like the no-persisted-analysis case.
    const persistedAnalysis = scan.discoveryProfile;
    const canReusePersistedAnalysis =
      Boolean(persistedAnalysis) && persistedAnalysis?.profileStage !== "fast";
    if (canReusePersistedAnalysis && persistedAnalysis) {
      business = persistedAnalysis.business;
      profile = persistedAnalysis.profile;
      analysisMode = persistedAnalysis.analysisMode;
    } else if (aiProvider) {
      const analyzed = await aiProvider.analyzeBusiness({
        workspaceId: scan.workspaceId,
        businessId,
        websiteUrl: crawl.canonicalUrl,
        canonicalDomain: crawl.canonicalDomain,
        pages,
        models,
      });
      business = analyzed.value;
      profile = profileFromBusiness(business);
      usage.push(usageRecord(analyzed, "website-analysis"));
      analysisMode = "openai";
    } else {
      profile = conservativeProfile(crawl.canonicalUrl, pages);
      business = toBusinessUnderstanding({
        profile,
        workspaceId: scan.workspaceId,
        businessId,
        canonicalDomain: crawl.canonicalDomain,
      });
      usage.push({
        provider: "local",
        purpose: "website-analysis",
        model: "conservative-parser",
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
      });
      analysisMode = "local-fallback";
    }
    if (!canReusePersistedAnalysis) {
      // Persisted before Reddit retrieval so the user can review and edit the
      // discovery terms while the scan waits. This also upgrades a "fast"
      // profile left by the earlier review step to "full".
      scan.discoveryProfile = {
        profile,
        business,
        analysisMode,
        analyzedAt: new Date().toISOString(),
        profileStage: "full",
      };
      scan.updatedAt = new Date().toISOString();
      await getStateRepository().saveScan(scan);
    }

    // Note: options.stopAfterUnderstanding is handled entirely by the fast
    // path near the top of this function, which always returns before
    // reaching here -- see the comment there for why.

    // User edits are applied after crawling and before query planning: the
    // user decides what to look for, DemandSift still compiles the searches.
    const overrideResult = applyDiscoveryOverrides(business, scan.discoveryOverrides);
    business = overrideResult.business;
    const understandingDetail = overrideResult.overriddenFields.length > 0
      ? `Built a source-backed context pack for ${profile.name}; ${overrideResult.overriddenFields.length} discovery field${overrideResult.overriddenFields.length === 1 ? "" : "s"} edited by you.`
      : `Built a source-backed context pack for ${profile.name}.`;
    await setStage(scan, "understanding", "complete", understandingDetail);

    const previousScan = await repository.getLatestScan(scan.workspaceId);
    const previousResult = previousScan?.result && sameWebsite(previousScan.websiteUrl, scan.websiteUrl)
      ? previousScan.result
      : null;
    // A 7-day window gave Reddit's own search a thin pool to rank within for
    // any but the highest-volume terms -- for niche/low-traffic topics,
    // "most relevant this week" was often picking from a handful of posts.
    // A manual comparison against Reddit's own "All time" search for the
    // same query found dramatically more relevant matches once the window
    // was widened. Review depth is chosen independently of this window (see
    // minimumFullContextReviews), so widening it cannot quietly lower
    // verification quality -- it only changes how far back a candidate is
    // allowed to have been posted, not how thoroughly each one is reviewed.
    const lookbackDays = 365;
    const since = new Date(Date.parse(scan.createdAt) - lookbackDays * 86_400_000).toISOString();
    await setStage(scan, "discovery", "active");
    // A checkpoint from a prior job attempt of this same scan is always safe
    // to reuse: discoveryProfile and discoveryOverrides are both fixed once
    // a scan starts, so discovery's inputs cannot have changed between
    // attempts. Reusing it skips a real, paid Apify call entirely instead of
    // re-running discovery from scratch on every retry.
    const persistedDiscovery = scan.redditDiscovery;
    // Competitor-derived signals (see lib/server/competitor-analysis.ts) are
    // appended after, never in place of, the primary business's own terms
    // below. redditQueryFamilies() caps each lane at 3 queries and fills it
    // in array order, so the user's own product/pain/competitor terms
    // always get first claim on that budget; a competitor's own name or
    // pain phrases only occupy a slot the primary business left empty.
    const competitorSignals = competitorDiscoverySignals(scan.competitorProfiles);
    const discovery = persistedDiscovery ?? await redditProvider.discover(
      {
        queries: {
          productTerms: business.productTerms.value,
          brandTerms: business.brandTerms.value,
          productCategories: [business.productCategory.value],
          customerProblems: [
            ...(business.customerProblemLanguage.value.length > 0
              ? business.customerProblemLanguage.value
              : business.problemsSolved.value),
            ...competitorSignals.painPhrases,
          ],
          jobsToBeDone: business.jobsToBeDone?.value ?? [],
          workarounds: business.likelyWorkarounds?.value ?? [],
          triggerEvents: business.triggerEvents?.value ?? [],
          buyerIntent: ["recommendations", "alternative", "comparing tools", "need a tool"],
          competitors: [
            ...business.competitors.value
              .filter(
                (competitor) =>
                  competitor.verification !== "unverified_hypothesis" &&
                  (competitor.relationship === "direct" || competitor.relationship === "alternative"),
              )
              .map((competitor) => competitor.name),
            ...competitorSignals.names,
          ],
          excludedTerms: business.irrelevantTopics.value,
          ambiguityRisks: business.ambiguityRisks.value,
        },
        limit: acquisitionCandidateTarget(),
        since,
      },
      {
        // Surfaced live so a slow/retrying search isn't silent: the frontend
        // already renders this stage's `detail` text on every poll tick.
        onRetry: async (notice) => {
          await setStage(
            scan,
            "discovery",
            "active",
            `Reddit search is taking longer than expected, retrying automatically ` +
              `(attempt ${Math.min(notice.attempt + 1, notice.maxAttempts)} of ${notice.maxAttempts})…`,
          );
        },
      },
    ).catch((error) => {
      const message = error instanceof Error ? error.message : "Unknown Reddit discovery failure.";
      throw new ApiError(
        `Reddit discovery failed: ${message}`,
        502,
        "reddit_discovery_failed",
      );
    });
    if (discovery.candidates.length === 0 && discovery.diagnostics.degraded) {
      // Zero results here would otherwise be indistinguishable from a real
      // "searched and found nothing" outcome. A degraded run means coverage
      // was lost to retries being exhausted, not that the search completed
      // cleanly with nothing to show -- that must never be reported as a
      // successful empty scan. Never checkpointed either, so the next job
      // attempt correctly retries discovery instead of reusing this failure.
      throw new ApiError(
        "Reddit discovery timed out and returned no usable results after retrying.",
        503,
        "reddit_discovery_failed",
      );
    }
    if (!persistedDiscovery) {
      scan.redditDiscovery = discovery;
      scan.updatedAt = new Date().toISOString();
      await repository.saveScan(scan);
    }
    /**
     * `now` here is the sanity-check ceiling deterministicReason() uses to
     * reject impossible future-dated records (bad actor output, clock skew).
     * It must be the actual wall-clock time at discovery, not scan.createdAt.
     * Discovery runs after website crawl + AI business-profile generation,
     * which can take several minutes; Reddit's "new"-sorted results legally
     * include posts published after the scan was queued but before this
     * call executes. Pinning `now` to scan.createdAt made every such post
     * look future-dated and silently discarded it as invalid_timestamp.
     * Production evidence (2026-08-17, cursor.com scan) showed 19 of 40
     * discovered candidates rejected this way -- the single largest
     * rejection bucket, and one that disproportionately removes the
     * freshest, most relevant candidates right before AI triage even runs.
     * `since` intentionally stays anchored to scan.createdAt: it defines a
     * stable "past 7 days" window that must not drift while a scan runs.
     */
    const cleaned = cleanDiscoveryCandidates({
      candidates: discovery.candidates,
      business,
      since,
      now: new Date(),
    });
    await setStage(
      scan,
      "discovery",
      "complete",
      `${discovery.diagnostics.fetchedCandidates} public candidates retrieved; ${cleaned.survivors.length} credible recent records remained after deterministic cleaning.`,
    );

    const previousStates = new Map(
      (previousResult?.processedRedditState ?? []).map((state) => [`${state.provider}:${state.externalId}`, state]),
    );
    const previousBySource = new Map(
      (previousResult?.opportunities ?? []).map((opportunity) => [opportunity.sourceId, opportunity]),
    );
    const previousReplies = new Map(
      (previousResult?.replies ?? []).map((reply) => [reply.opportunityId, reply]),
    );

    await setStage(scan, "triage", "active");

    /**
     * Embedding prefilter. This orders candidates and removes only the
     * obviously unrelated tail; it never decides business relevance, because
     * cosine similarity systematically undervalues indirectly expressed pain.
     * The LLM still makes every relevance decision, just on a bounded pool.
     * Any failure here is non-fatal and keeps the full pool.
     */
    const embeddingSimilarityById = new Map<string, number>();
    let prefilterDiagnostics: ReturnType<typeof prioritizeCandidates>["diagnostics"] | null = null;
    let prefilteredSurvivors = cleaned.survivors;

    if (aiProvider && cleaned.survivors.length > triageCandidateBudget()) {
      try {
        const embedded = await aiProvider.embed({
          texts: [
            businessEmbeddingQuery(business),
            ...cleaned.survivors.map(candidateEmbeddingText),
          ],
          models,
          workspaceId: scan.workspaceId,
        });
        usage.push(usageRecord(embedded, "embedding"));
        const [profileVector, ...candidateVectors] = embedded.value;
        if (profileVector && candidateVectors.length === cleaned.survivors.length) {
          cleaned.survivors.forEach((candidate, index) => {
            embeddingSimilarityById.set(
              candidate.externalId,
              cosineSimilarity(profileVector, candidateVectors[index]),
            );
          });
        }
      } catch (error) {
        console.error("Embedding prefilter unavailable; classifying the full pool", error);
      }

      if (embeddingSimilarityById.size > 0) {
        const outcome = prioritizeCandidates(
          cleaned.survivors.map((candidate) => ({
            externalId: candidate.externalId,
            similarity: embeddingSimilarityById.get(candidate.externalId) ?? null,
          })),
          {
            budget: triageCandidateBudget(),
            floor: embeddingPrefilterFloor(),
            minimumPool: Math.min(cleaned.survivors.length, 40),
          },
        );
        prefilterDiagnostics = outcome.diagnostics;
        const retained = new Set(outcome.retained);
        prefilteredSurvivors = cleaned.survivors.filter((candidate) =>
          retained.has(candidate.externalId),
        );
      }
    }

    const triageById = new Map<string, ConversationTriage>();
    let reusedUnchanged = 0;
    let reusedTriageOnly = 0;
    const needsTriage: RedditDiscoveryCandidate[] = [];

    for (const candidate of prefilteredSurvivors) {
      const previous = previousStates.get(`${candidate.provider}:${candidate.externalId}`);
      if (
        previous &&
        previous.contentHash === candidate.provenance.contentHash &&
        previous.triage.worthEnriching === true
      ) {
        // Positive triage may be reused because it still flows into enrichment/deep
        // qualification. Negative triage is intentionally re-run on repeat scans: a
        // stale cheap false-negative must never become a permanent blind spot.
        triageById.set(candidate.externalId, previous.triage);
        reusedTriageOnly += 1;
        continue;
      }
      needsTriage.push(candidate);
    }

    let triageReturned = 0;
    if (needsTriage.length > 0) {
      if (aiProvider) {
        const triaged = await aiProvider.triageConversations({
          business,
          candidates: needsTriage,
          models,
          coverageRetries: 2,
        });
        usage.push(usageRecord(triaged, "triage"));
        triageReturned = triaged.value.length;
        for (const item of triaged.value) triageById.set(item.externalId, item.triage);
      } else {
        const triaged = needsTriage.map((candidate) => localMockTriage(candidate));
        triageReturned = triaged.length;
        for (const item of triaged) triageById.set(item.externalId, item);
      }
    }

    if (prefilteredSurvivors.some((candidate) => !triageById.has(candidate.externalId))) {
      throw new Error("Triage coverage is incomplete. The scan will not report a valid zero-result outcome.");
    }
    const worthEnriching = prefilteredSurvivors.filter(
      (candidate) => triageById.get(candidate.externalId)?.worthEnriching,
    );
    const zeroResultAuditCandidates = worthEnriching.length === 0
      ? selectZeroResultAuditCandidates({
          candidates: cleaned.survivors,
          triageById,
          // Acquisition gets a three-candidate audit. Incremental scans get one
          // independent deep check so a cached/cheap triage false-negative cannot
          // silently turn real demand into a valid-looking zero.
          budget: Math.min(previousResult ? 2 : 3, enrichmentBudget()),
        })
      : [];
    const triageDetail = zeroResultAuditCandidates.length > 0
      ? `${prefilteredSurvivors.length} of ${cleaned.survivors.length} credible candidates were read in full; lightweight triage selected none, so ${zeroResultAuditCandidates.length} high-signal candidate${zeroResultAuditCandidates.length === 1 ? " was" : "s were"} escalated for an independent full-context audit.`
      : `${prefilteredSurvivors.length} of ${cleaned.survivors.length} credible candidates were read in full; ${worthEnriching.length} warranted full-context review.`;
    await setStage(scan, "triage", "complete", triageDetail);

    await setStage(scan, "enrichment", "active");
    const primaryEnrichmentCandidates = zeroResultAuditCandidates.length > 0
      ? zeroResultAuditCandidates
      : selectCandidatesForEnrichment({
          candidates: worthEnriching,
          triageById,
          budget: enrichmentBudget(),
        });
    const primaryIds = new Set(primaryEnrichmentCandidates.map((candidate) => candidate.externalId));
    const requiredReviews = minimumFullContextReviews();
    const intelligenceReviewBudget = Math.max(
      0,
      Math.min(
        enrichmentSelectionTarget(requiredReviews) - primaryEnrichmentCandidates.length,
        enrichmentBudget() - primaryEnrichmentCandidates.length,
      ),
    );
    const intelligenceReviewCandidates = selectCandidatesForIntelligenceReview({
      candidates: cleaned.survivors.filter((candidate) => !primaryIds.has(candidate.externalId)),
      triageById,
      budget: intelligenceReviewBudget,
    });
    const selectedForEnrichment = [
      ...primaryEnrichmentCandidates,
      ...intelligenceReviewCandidates,
    ];
    let intelligenceCoverageReviews = intelligenceReviewCandidates.length;
    // Review depth is chosen independently of the lookback window, so
    // narrowing the scan to 7 days cannot quietly halve verification quality.
    const requiredFullContextReviews = Math.min(
      requiredReviews,
      cleaned.survivors.length,
      enrichmentBudget(),
    );
    // Verified thread context means the PROVIDER actually fetched full thread
    // context for this specific conversation (provenance.metadata.enriched),
    // not merely that the source is some live provider. Trusting sourceMode
    // alone let a live discovery-only pass-through (no comments/replies ever
    // fetched) masquerade as verified -- exempting only mock, whose fixtures
    // are synthetic full context by construction.
    //
    // Thread enrichment (the extra actor run that fetches each shortlisted
    const hasVerifiedThreadContext = (conversation: EnrichedRedditConversation): boolean =>
      conversation.sourceMode === "mock" || conversation.provenance.metadata?.enriched === true;

    // Thread enrichment (the extra actor run that fetches each shortlisted
    // candidate's real comments) is disabled by default -- see
    // HarshmaurRedditProvider.enrich()'s doc comment for the reasoning and
    // trade-off. hasVerifiedThreadContext above stays honest everywhere --
    // the scan trace and the "N full threads verified" diagnostic must keep
    // truthfully reporting that nothing was actually fetched, not claim
    // verification that never happened. This second, relaxed check exists
    // only for the public-surfacing gates below (isQualifiedPotentialCustomer
    // / isRelevantMarketConversation call sites): when enrichment is off,
    // every conversation is discovery-only by construction, so gating public
    // leads/signals on real verification would zero out every scan's
    // results rather than just being honest about reduced confidence.
    const enrichmentDisabled = Number(process.env.APIFY_REDDIT_ENRICHMENT_LIMIT ?? 0) === 0;
    const meetsPublishingContextBar = (conversation: EnrichedRedditConversation): boolean =>
      hasVerifiedThreadContext(conversation) || enrichmentDisabled;

    // Enrichment is useful context, not an all-or-nothing website-analysis gate.
    // If one selected Reddit URL cannot be expanded, try the next-best candidate
    // within the existing bounded budget. This protects zero-result confidence
    // without throwing away the website profile, discovery, and triage already done.
    const initialEnrichment = await redditProvider.enrich({
      candidates: selectedForEnrichment,
      maxComments: Number(process.env.APIFY_REDDIT_ENRICHMENT_COMMENTS ?? 6),
    });
    const enrichmentById = new Map<string, EnrichedRedditConversation>();
    let enrichmentRequested = 0;
    const enrichmentFailureReasons: string[] = [];
    const absorbEnrichment = (batch: typeof initialEnrichment) => {
      enrichmentRequested += batch.diagnostics.requested;
      if (batch.diagnostics.failureReason) enrichmentFailureReasons.push(batch.diagnostics.failureReason);
      for (const conversation of batch.conversations) {
        const current = enrichmentById.get(conversation.externalId);
        if (!current || (!hasVerifiedThreadContext(current) && hasVerifiedThreadContext(conversation))) {
          enrichmentById.set(conversation.externalId, conversation);
        }
      }
    };
    absorbEnrichment(initialEnrichment);

    const selectedIds = new Set(selectedForEnrichment.map((candidate) => candidate.externalId));
    const verifiedContextCount = () =>
      [...enrichmentById.values()].filter(hasVerifiedThreadContext).length;
    let enrichmentReplacementAttempts = 0;
    let enrichmentReplacementSuccesses = 0;

    while (
      verifiedContextCount() < requiredFullContextReviews &&
      selectedForEnrichment.length < Math.min(enrichmentBudget(), cleaned.survivors.length)
    ) {
      const remaining = cleaned.survivors.filter((candidate) => !selectedIds.has(candidate.externalId));
      if (remaining.length === 0) break;
      const remainingWorthEnriching = remaining.filter(
        (candidate) => triageById.get(candidate.externalId)?.worthEnriching === true,
      );
      const replacementCandidate = (
        worthEnriching.length === 0
          ? selectZeroResultAuditCandidates({ candidates: remaining, triageById, budget: 1 })[0]
          : selectCandidatesForEnrichment({
              candidates: remainingWorthEnriching,
              triageById,
              budget: 1,
            })[0]
      ) ?? selectCandidatesForIntelligenceReview({
        candidates: remaining,
        triageById,
        budget: 1,
      })[0];
      if (!replacementCandidate) break;

      selectedForEnrichment.push(replacementCandidate);
      selectedIds.add(replacementCandidate.externalId);
      if (triageById.get(replacementCandidate.externalId)?.worthEnriching !== true) {
        intelligenceCoverageReviews += 1;
      }
      enrichmentReplacementAttempts += 1;
      const before = verifiedContextCount();
      const replacementEnrichment = await redditProvider.enrich({
        candidates: [replacementCandidate],
        maxComments: Number(process.env.APIFY_REDDIT_ENRICHMENT_COMMENTS ?? 6),
      });
      absorbEnrichment(replacementEnrichment);
      if (verifiedContextCount() > before) enrichmentReplacementSuccesses += 1;
    }

    const enrichmentConversations = selectedForEnrichment.flatMap((candidate) => {
      const conversation = enrichmentById.get(candidate.externalId);
      return conversation ? [conversation] : [];
    });
    const enrichedSuccessfully = enrichmentConversations.filter(hasVerifiedThreadContext).length;
    const enrichmentFailures = Math.max(0, selectedForEnrichment.length - enrichedSuccessfully);
    const coverageLimited = enrichedSuccessfully < requiredFullContextReviews;
    const enrichment = {
      conversations: enrichmentConversations,
      sourceMode: discovery.sourceMode,
      diagnostics: {
        requested: enrichmentRequested,
        enriched: enrichedSuccessfully,
        failed: enrichmentFailures,
        fallbackUsed: enrichmentFailures,
        ...(enrichmentFailureReasons.length > 0
          ? { failureReason: enrichmentFailureReasons.join(" | ").slice(0, 1_500) }
          : {}),
      },
    };

    await setStage(
      scan,
      "enrichment",
      "complete",
      coverageLimited
        ? `${enrichedSuccessfully} conversation${enrichedSuccessfully === 1 ? "" : "s"} received verified thread context; the ${requiredFullContextReviews}-conversation confidence target was not fully reached after ${enrichmentReplacementAttempts} replacement attempt${enrichmentReplacementAttempts === 1 ? "" : "s"}. The scan will continue and will not present a definitive zero.`
        : `${enrichedSuccessfully} conversation${enrichedSuccessfully === 1 ? "" : "s"} received verified thread context; ${enrichmentFailures} selected conversation${enrichmentFailures === 1 ? "" : "s"} remained discovery-only after bounded recovery.`,
    );

    await setStage(scan, "qualification", "active");
    const selectedById = new Map(selectedForEnrichment.map((candidate) => [candidate.externalId, candidate]));
    const reusedDeepById = new Map<string, DeepQualification>();
    const deepById = new Map<string, DeepQualifiedConversation>();
    const conversationsNeedingDeep: EnrichedRedditConversation[] = [];

    for (const conversation of enrichment.conversations) {
      const candidate = selectedById.get(conversation.externalId);
      const previous = previousStates.get(`${conversation.provider}:${conversation.externalId}`) ??
        previousStates.get(`${conversation.sourceMode === "apify-test" ? "apify-test" : conversation.provider}:${conversation.externalId}`);
      const currentContextHash = structuredContextHash(conversation);
      const sourceUnchanged = Boolean(
        candidate &&
        previous &&
        previous.contentHash === candidate.provenance.contentHash,
      );
      const contextUnchanged = Boolean(
        previous?.contextHash && previous.contextHash === currentContextHash,
      );

      if (
        sourceUnchanged && contextUnchanged && previous?.deepQualification &&
        previous.deepQualification.leadStatus !== "not_customer"
      ) {
        reusedDeepById.set(conversation.externalId, previous.deepQualification);
        deepById.set(conversation.externalId, {
          externalId: conversation.externalId,
          conversation,
          qualification: previous.deepQualification,
        });
        reusedUnchanged += 1;
        reusedTriageOnly = Math.max(0, reusedTriageOnly - 1);
      } else {
        conversationsNeedingDeep.push(conversation);
      }
    }

    let deepReturned = 0;
    if (conversationsNeedingDeep.length > 0) {
      if (aiProvider) {
        const qualified = await aiProvider.qualifyConversations({
          business,
          conversations: conversationsNeedingDeep,
          models,
          coverageRetries: 2,
        });
        usage.push(usageRecord(qualified, "deep-qualification"));
        deepReturned = qualified.value.length;
        for (const item of qualified.value) deepById.set(item.externalId, item);
      } else {
        for (const conversation of conversationsNeedingDeep) {
          const triage = triageById.get(conversation.externalId);
          if (!triage) continue;
          const qualification = localMockDeep(conversation, triage);
          deepById.set(conversation.externalId, {
            externalId: conversation.externalId,
            conversation,
            qualification,
          });
          deepReturned += 1;
        }
      }
    }

    if (enrichment.conversations.some((conversation) => !deepById.has(conversation.externalId))) {
      throw new Error("Deep qualification coverage is incomplete. The scan will not convert model failure into zero customers.");
    }

    const deepRows = [...deepById.values()];
    // A discovery-only fallback may still look promising to deep AI. Keep that
    // provisional judgment in the transparent scan trace, but never promote it
    // to a public lead or market-intelligence claim without meeting the
    // publishing context bar (real verification, or enrichment deliberately
    // off -- see meetsPublishingContextBar above).
    const unverifiedQualifiedCandidates = deepRows.filter((row) =>
      isQualifiedPotentialCustomer(row.qualification) && !meetsPublishingContextBar(row.conversation),
    );
    const relevantCompetitorByExternalId = new Map<string, string | null>();
    const relevantDeepRows = deepRows.filter((row) => {
      if (!meetsPublishingContextBar(row.conversation)) return false;
      const qualification = row.qualification;
      const competitorEvidence = identifyVerifiedCompetitorSignal({
        conversationText: `${row.conversation.title ?? ""}\n${row.conversation.body}`,
        sourceMode: row.conversation.sourceMode,
        externalId: row.conversation.externalId,
        businessCompetitors: business.competitors.value.map((competitor) => competitor.name),
        deterministicCompetitorScore: qualification.demandSignals.includes("switching") ? 1 : 0,
        classifiedComplaintScore: qualification.intelligenceTags.includes("competitor_intelligence") ? 1 : 0,
        classifiedCompetitor: qualification.competitorMentioned,
      });
      const relevant = isRelevantMarketConversation({
        qualification,
        verifiedCompetitorSignal: competitorEvidence.verified,
      });
      if (relevant) {
        relevantCompetitorByExternalId.set(
          row.externalId,
          competitorEvidence.verified ? competitorEvidence.competitor : null,
        );
      }
      return relevant;
    });
    const marketIntelligence: MarketIntelligenceRecord[] = dedupeMarketIntelligenceRecords(relevantDeepRows.map((row) => {
      const qualification = row.qualification;
      return {
        id: createId("intel"),
        sourceId: row.conversation.provenance.id,
        externalId: row.externalId,
        title: row.conversation.title ?? "Reddit conversation signal",
        summary: qualification.whyItMatters,
        subreddit: row.conversation.subreddit,
        author: row.conversation.author ?? null,
        tags: qualification.intelligenceTags,
        demandSignals: qualification.demandSignals.filter((signal) => signal !== "none"),
        competitor: relevantCompetitorByExternalId.get(row.externalId) ?? null,
        sourceCreatedAt: row.conversation.createdAt,
        sourceIds: [row.conversation.provenance.id],
        competitorScore: competitorScore(qualification),
        researchScore: researchScore(qualification),
        replyScore: replyScore(qualification),
        // A relevant conversation is not a lead, but qualification.shouldReply
        // is decided independently of leadStatus. Reserve a stable id now so a
        // reply drafted for it later can be linked without becoming an
        // opportunity/lead record.
        replyId: qualification.shouldReply === true ? createId("reply") : undefined,
      };
    }));

    /**
     * Recurring themes are aggregated from the whole relevant corpus rather
     * than from qualified leads, so a pain reported by people who will never
     * buy still shapes the research view. A conversation contributes to the
     * struggle set, the request set, or both, matching how it was labelled.
     */
    const themeWeight = (qualification: DeepQualification): number =>
      researchScore(qualification);
    const themeInputs = relevantDeepRows.flatMap((row) => {
      const qualification = row.qualification;
      const text = [
        qualification.problemSummary,
        row.conversation.title,
        row.conversation.body,
      ]
        .filter((value): value is string => Boolean(value && value.trim()))
        .join(" ")
        .slice(0, 2_000);
      const sourceId = row.conversation.provenance.id;
      const weight = themeWeight(qualification);

      const isStruggle =
        qualification.intelligenceTags.includes("problem_signal") ||
        qualification.intelligenceTags.includes("workaround") ||
        qualification.demandSignals.includes("pain");
      const isRequest =
        qualification.intelligenceTags.includes("product_feedback") ||
        qualification.demandSignals.includes("explicit_demand");

      return [
        ...(isStruggle ? [{ sourceId, text, kind: "struggle" as const, weight }] : []),
        ...(isRequest ? [{ sourceId, text, kind: "request" as const, weight }] : []),
      ];
    });

    const conversationThemes: ConversationThemeRecord[] = [
      ...clusterThemes(themeInputs, "struggle", { maxThemes: 5, minimumConversations: 2 }),
      ...clusterThemes(themeInputs, "request", { maxThemes: 4, minimumConversations: 2 }),
    ].map((theme) => ({ id: createId("theme"), ...theme }));

    const rawOpportunities: OpportunityRecord[] = deepRows.flatMap((row) => {
      const { conversation, qualification } = row;
      // A public acquisition opportunity must be both a plausible customer and
      // appropriate to answer. Non-replyable demand still contributes to the
      // source-backed intelligence layer, but it must not become a lead card
      // without the grounded reply promised by the product. Apify discovery-only
      // fallbacks are never promoted as reply-ready leads.
      if (!isQualifiedPotentialCustomer(qualification) || !meetsPublishingContextBar(conversation)) return [];
      const score = opportunityRankScore(qualification);
      const competitorEvidence = identifyVerifiedCompetitorSignal({
        conversationText: `${conversation.title ?? ""}\n${conversation.body}`,
        sourceMode: conversation.sourceMode,
        externalId: conversation.externalId,
        businessCompetitors: business.competitors.value.map((competitor) => competitor.name),
        deterministicCompetitorScore: qualification.demandSignals.includes("switching") ? 1 : 0,
        classifiedComplaintScore: qualification.demandSignals.includes("switching") ? 1 : 0,
        classifiedCompetitor: qualification.competitorMentioned,
      });
      const replyId = createId("reply");
      const priorState = previousStates.get(`${conversation.provider}:${conversation.externalId}`) ??
        previousStates.get(`${conversation.sourceMode === "apify-test" ? "apify-test" : conversation.provider}:${conversation.externalId}`);
      return [{
        id: createId("opp"),
        sourceId: conversation.provenance.id,
        title: conversation.title ?? "Relevant Reddit conversation",
        excerpt: conversation.body,
        conversationContext: conversation.threadContext,
        subreddit: conversation.subreddit,
        author: conversation.author ?? "Reddit user",
        permalink: conversation.permalink ?? "",
        postedAt: conversation.createdAt,
        score,
        leadScore: leadScore(qualification),
        replyScore: replyScore(qualification),
        competitorScore: competitorScore(qualification),
        researchScore: researchScore(qualification),
        commentCount: conversation.metrics.comments,
        whyItMatters: qualification.whyItMatters,
        intent: intentForQualification(qualification),
        recommendedAction: "reply",
        communityRisk: communityRiskForUi(qualification.communityRisk),
        competitorSignal: competitorEvidence.competitor,
        competitorComplaint: competitorEvidence.verified,
        customerProblem: qualification.problemSummary ?? "Current problem matched to the verified business context",
        replyId,
        synthetic: conversation.sourceMode === "mock",
        sourceMode: conversation.sourceMode,
        conversationType: conversation.kind,
        authorIdentifier: normalizedRedditAuthor(conversation.author),
        potentialCustomerIntent: potentialCustomerIntentFromQualification(qualification),
        qualificationScore: score,
        firstSeenAt: priorState?.firstSeenAt ?? scan.createdAt,
        scanId: scan.id,
        sourceCreatedAt: conversation.createdAt,
        supportingSourceIds: [conversation.provenance.id],
        supportingSignalCount: 1,
        appearedInPreviousDemandDrop: Boolean(priorState),
        redditThingId: redditThingId(conversation),
        discoveryLanes: conversation.discoveryLanes,
        leadStatus: qualification.leadStatus,
        demandSignals: qualification.demandSignals,
        intelligenceTags: qualification.intelligenceTags,
        productFit: qualification.productFit,
        painSeverity: qualification.painSeverity,
        timing: qualification.timing,
        evidenceQuality: qualification.evidenceQuality,
        replyability: qualification.replyability,
        shouldReply: qualification.shouldReply,
        autoReplyAllowed: qualification.autoReplyAllowed,
        requiresHumanReview: qualification.requiresHumanReview,
        replyAngle: qualification.replyAngle ?? null,
        mentionProduct: qualification.mentionProduct,
        disclosureRequired: qualification.disclosureRequired,
      }];
    });

    const aggregated = aggregatePotentialCustomers({
      opportunities: rawOpportunities,
      previousOpportunities: previousResult?.opportunities ?? [],
      scanId: scan.id,
      windowEndedAt: scan.createdAt,
      windowDays: lookbackDays,
    });
    const opportunities = discovery.sourceMode === "mock" ? rawOpportunities : aggregated.opportunities;
    const deepBySourceId = new Map(deepRows.map((row) => [row.conversation.provenance.id, row]));
    const qualifiedOpportunities: Array<QualifiedOpportunity & {
      conversation: EnrichedRedditConversation;
    }> = opportunities.flatMap((opportunity) => {
      const row = deepBySourceId.get(opportunity.sourceId);
      if (!row) return [];
      return [{
        id: opportunity.id,
        workspaceId: scan.workspaceId,
        businessId,
        conversation: row.conversation,
        qualification: row.qualification,
        classification: legacyClassificationFromDeep(row.qualification),
        rankScore: Math.max(0, Math.min(1, opportunity.score / 100)),
        status: "new",
        provenanceIds: [opportunity.sourceId],
        discoveredAt: opportunity.postedAt,
      }];
    });

    await setStage(
      scan,
      "qualification",
      "complete",
      coverageLimited && aggregated.summary.total === 0
        ? `No verified potential customer was promoted from ${enrichedSuccessfully} full-context review${enrichedSuccessfully === 1 ? "" : "s"}. The confidence target was ${requiredFullContextReviews}, so this is a limited-coverage result rather than a definitive zero.${unverifiedQualifiedCandidates.length > 0 ? ` ${unverifiedQualifiedCandidates.length} provisional signal${unverifiedQualifiedCandidates.length === 1 ? "" : "s"} lacked full thread verification.` : ""}`
        : `${aggregated.summary.total} unique potential customer${aggregated.summary.total === 1 ? "" : "s"} identified from ${rawOpportunities.length} qualified conversation${rawOpportunities.length === 1 ? "" : "s"}; ranking was applied only after qualification.${unverifiedQualifiedCandidates.length > 0 ? ` ${unverifiedQualifiedCandidates.length} provisional signal${unverifiedQualifiedCandidates.length === 1 ? "" : "s"} lacked full thread verification and was not promoted.` : ""}`,
    );

    const fallbackInsightSet = buildFallbackInsights(opportunities);
    let insightSet = fallbackInsightSet;
    if (aiProvider && relevantDeepRows.length > 0) {
      try {
        const generated = await aiProvider.generateInsights({
          business,
          opportunities: qualifiedOpportunities,
          evidenceConversations: relevantDeepRows,
          models,
        });
        usage.push(usageRecord(generated, "insight-generation"));
        const reviewedRedditSourceIds = new Set(
          relevantDeepRows.map((row) => row.conversation.provenance.id),
        );
        const seenEvidenceSets = new Set<string>();
        const generatedInsights: DemandInsightRecord[] = generated.value.demandInsights.flatMap((insight) => {
          const sourceIds = [...new Set(insight.provenanceIds)]
            .filter((sourceId) => reviewedRedditSourceIds.has(sourceId))
            .sort();
          if (sourceIds.length === 0) return [];
          const evidenceKey = sourceIds.join("|");
          if (seenEvidenceSets.has(evidenceKey)) return [];
          seenEvidenceSets.add(evidenceKey);
          return [{
            id: createId("ins"),
            title: insight.title,
            summary: insight.summary,
            evidence: insight.implication,
            signal: insight.confidence >= 0.75 ? "rising" : insight.confidence >= 0.5 ? "steady" : "emerging",
            opportunityIds: opportunities
              .filter((opportunity) => sourceIds.includes(opportunity.sourceId))
              .map((opportunity) => opportunity.id),
            sourceIds,
            evidenceScope: sourceIds.length >= 2 ? "recurring-pattern" as const : "single-conversation" as const,
            sourceCount: sourceIds.length,
          }];
        });
        const combinedInsights = [
          ...generatedInsights,
          ...fallbackInsightSet.insights.filter((fallback) =>
            !generatedInsights.some((generatedInsight) => generatedInsight.title === fallback.title),
          ),
          // The report shows 3-5 market findings; the cap was 3, which discarded
          // grounded insights the model had already evidenced.
        ].slice(0, 5);

        const generatedCompetitor = generated.value.competitorSignals.find((signal) =>
          relevantDeepRows.some((row) => {
            if (!signal.provenanceIds.includes(row.conversation.provenance.id)) return false;
            const verified = identifyVerifiedCompetitorSignal({
              conversationText: (row.conversation.title ?? "") + "\n" + row.conversation.body,
              sourceMode: row.conversation.sourceMode,
              externalId: row.conversation.externalId,
              businessCompetitors: business.competitors.value.map((competitor) => competitor.name),
              deterministicCompetitorScore: 1,
              classifiedComplaintScore: row.qualification.intelligenceTags.includes("competitor_intelligence") ? 1 : 0,
              classifiedCompetitor: row.qualification.competitorMentioned ?? undefined,
            });
            return verified.verified &&
              normalizedCompetitorName(verified.competitor) === normalizedCompetitorName(signal.competitorName);
          }),
        );
        const matchingOpportunities = generatedCompetitor
          ? opportunities.filter((opportunity) => generatedCompetitor.provenanceIds.includes(opportunity.sourceId))
          : [];
        const weakness = generatedCompetitor
          ? {
              id: createId("comp"),
              verified: true,
              competitor: generatedCompetitor.competitorName,
              title: generatedCompetitor.signal,
              summary: generatedCompetitor.customerImpact,
              opportunityIds: matchingOpportunities.map((opportunity) => opportunity.id),
              sourceIds: [...new Set(generatedCompetitor.provenanceIds)].filter((sourceId) =>
                relevantDeepRows.some((row) => row.conversation.provenance.id === sourceId),
              ),
            }
          : fallbackInsightSet.weakness;
        insightSet = { insights: combinedInsights, weakness };
      } catch (error) {
        console.error("OpenAI insight generation failed; using deterministic sourced insights", error);
      }
    }

    await setStage(scan, "replies", "active");
    const now = new Date().toISOString();
    const replies: ReplyRecord[] = [];
    // Reply generation is bounded, so ordering decides which conversations get
    // a drafted reply. That has to be reply value, not lead value: the best
    // thread to answer is often not the strongest buyer.
    const replyEligible = [...opportunities]
      .filter((opportunity) => opportunity.shouldReply === true)
      .sort((left, right) => right.replyScore - left.replyScore);
    for (const opportunity of replyEligible) {
      const row = qualifiedOpportunities.find((qualified) => qualified.id === opportunity.id);
      let content = "";
      const previousOpportunity = previousBySource.get(opportunity.sourceId);
      const previousReply = previousOpportunity ? previousReplies.get(previousOpportunity.id) : undefined;
      const state = previousStates.get(`${row?.conversation.sourceMode === "apify-test" ? "apify-test" : row?.conversation.provider}:${row?.conversation.externalId}`);
      const currentContextHash = row ? structuredContextHash(row.conversation) : null;
      if (
        previousReply?.content.trim() &&
        state &&
        row &&
        state.contentHash === row.conversation.provenance.contentHash &&
        state.contextHash !== null &&
        state.contextHash === currentContextHash
      ) {
        content = previousReply.content;
      } else if (row && aiProvider) {
        const generated = await aiProvider.generateReply({
          business,
          opportunity: row,
          models,
          instructions: row.qualification.replyAngle,
        });
        usage.push(usageRecord(generated, "reply-generation"));
        content = generated.value.body.trim();
      } else if (row && discovery.sourceMode === "mock") {
        content = fallbackReply(profile);
      }
      if (!content) {
        throw new Error("A reply-eligible opportunity did not produce a grounded reply.");
      }
      replies.push({
        id: opportunity.replyId,
        opportunityId: opportunity.id,
        workspaceId: scan.workspaceId,
        scanId: scan.id,
        content,
        status: "draft",
        generation: 1,
        createdAt: now,
        updatedAt: now,
        publishedAt: null,
        publishedUrl: null,
        publishedVia: null,
        redditCommentId: null,
      });
    }
    // Relevant (non-lead) conversations classify shouldReply independently of
    // leadStatus: a conversation can be genuinely useful market signal -- and
    // deserve a helpful, disclosed reply -- without being a potential
    // customer. Generate replies for those too, but keep them out of the
    // opportunities/lead set entirely; they are linked only through
    // marketIntelligence[].replyId and surfaced as relevant conversations.
    const leadSourceIds = new Set(opportunities.map((opportunity) => opportunity.sourceId));
    const relevantReplyEligible = marketIntelligence.filter(
      (intelligence) => intelligence.replyId && !leadSourceIds.has(intelligence.sourceId),
    );
    for (const intelligence of relevantReplyEligible) {
      const row = relevantDeepRows.find(
        (candidate) => candidate.conversation.provenance.id === intelligence.sourceId,
      );
      if (!row) continue;
      let content = "";
      if (aiProvider) {
        const qualifiedRow = {
          id: intelligence.id,
          workspaceId: scan.workspaceId,
          businessId,
          conversation: row.conversation,
          qualification: row.qualification,
          classification: legacyClassificationFromDeep(row.qualification),
          rankScore: Math.max(0, Math.min(1, (intelligence.replyScore ?? 0) / 100)),
          status: "new" as const,
          provenanceIds: [intelligence.sourceId],
          discoveredAt: row.conversation.createdAt,
        };
        try {
          const generated = await aiProvider.generateReply({
            business,
            opportunity: qualifiedRow,
            models,
            instructions: row.qualification.replyAngle,
          });
          usage.push(usageRecord(generated, "reply-generation"));
          content = generated.value.body.trim();
        } catch (error) {
          // A relevant conversation's reply is best-effort, not the strict
          // per-lead invariant: it is still fully useful as research evidence
          // without a drafted reply, so a generation failure here must not
          // fail the scan.
          console.error("Relevant-conversation reply generation failed", error);
        }
      } else if (discovery.sourceMode === "mock") {
        content = fallbackReply(profile);
      }
      if (!content) continue;
      replies.push({
        id: intelligence.replyId!,
        opportunityId: intelligence.id,
        workspaceId: scan.workspaceId,
        scanId: scan.id,
        content,
        status: "draft",
        generation: 1,
        createdAt: now,
        updatedAt: now,
        publishedAt: null,
        publishedUrl: null,
        publishedVia: null,
        redditCommentId: null,
      });
    }
    await Promise.all(replies.map((reply) => repository.saveReply(reply)));
    await setStage(
      scan,
      "replies",
      "complete",
      replies.length > 0
        ? `${replies.length} complete grounded repl${replies.length === 1 ? "y" : "ies"} prepared for ${replies.length === 1 ? "the qualified opportunity" : "all qualified opportunities"}.`
        : "No conversation was appropriate for reply generation in this scan.",
    );

    const generatedReplyIds = new Set(replies.filter((reply) => reply.content.trim()).map((reply) => reply.opportunityId));
    const processedRedditState: ProcessedRedditState[] = prefilteredSurvivors.map((candidate) => {
      const previous = previousStates.get(`${candidate.provider}:${candidate.externalId}`);
      const deep = deepById.get(candidate.externalId);
      const contextHash = deep ? structuredContextHash(deep.conversation) : null;
      const opportunity = opportunities.find((row) => row.sourceId === candidate.provenance.id);
      return {
        provider: candidate.provider,
        externalId: candidate.externalId,
        conversationId: candidate.externalId,
        title: candidate.title ?? null,
        excerpt: candidate.body.slice(0, 500),
        subreddit: candidate.subreddit,
        author: normalizedRedditAuthor(candidate.author),
        canonicalPermalink: canonicalPermalink(candidate.permalink),
        sourceCreatedAt: candidate.createdAt,
        matchedQueries: candidate.matchedQueries,
        discoveryLanes: candidate.discoveryLanes,
        contentHash: candidate.provenance.contentHash,
        contextHash,
        threadContextVerified: deep ? hasVerifiedThreadContext(deep.conversation) : false,
        firstSeenAt: previous?.firstSeenAt ?? scan.createdAt,
        lastSeenAt: scan.createdAt,
        lastAnalyzedAt:
          previous && reusedDeepById.has(candidate.externalId)
            ? previous.lastAnalyzedAt
            : deep
              ? scan.createdAt
              : previous?.lastAnalyzedAt ?? scan.createdAt,
        commentCount: candidate.metrics.comments,
        triage: triageById.get(candidate.externalId)!,
        deepQualification: deep?.qualification ?? null,
        replyStatus: opportunity && generatedReplyIds.has(opportunity.id)
          ? "generated"
          : opportunity?.shouldReply
            ? "eligible"
            : "not_applicable",
        lastReplyAt: opportunity && generatedReplyIds.has(opportunity.id)
          ? scan.createdAt
          : previous?.lastReplyAt ?? null,
      };
    });

    const redditSources: Provenance[] = deepRows.map(({ conversation }) => ({
      id: conversation.provenance.id,
      kind: "reddit",
      url: conversation.permalink ?? "",
      title: conversation.title ?? "Reddit conversation",
      excerpt: conversation.body.slice(0, 280),
      capturedAt: conversation.provenance.observedAt,
      synthetic: conversation.sourceMode === "mock",
      provider: conversation.provider,
      sourceMode: conversation.sourceMode,
    }));

    const providerRejectedCount = Object.values(discovery.diagnostics.rejectedByReason)
      .reduce((sum, count) => sum + count, 0);
    const matchedCandidatesByLane = countCandidatesByLane(cleaned.survivors);
    const worthEnrichingByLane = countCandidatesByLane(worthEnriching);
    const matchedCandidatesByQuery = countCandidatesByQuery(cleaned.survivors);
    const worthEnrichingByQuery = countCandidatesByQuery(worthEnriching);
    const diagnostics: ScanDiagnostics = {
      provider: redditProvider.name,
      retrieved: discovery.diagnostics.fetchedCandidates,
      normalized: discovery.diagnostics.normalizedCandidates,
      providerRejectedByReason: discovery.diagnostics.rejectedByReason,
      deterministicRejectedByReason: cleaned.rejectedByReason,
      deterministicSurvivors: cleaned.survivors.length,
      embeddingScored: prefilterDiagnostics?.scored ?? 0,
      embeddingDroppedBelowFloor: prefilterDiagnostics?.droppedBelowFloor ?? 0,
      embeddingDroppedOverBudget: prefilterDiagnostics?.droppedOverBudget ?? 0,
      classifiedCandidates: prefilteredSurvivors.length,
      reusedUnchanged,
      reusedTriageOnly,
      submittedForTriage: needsTriage.length,
      triageReturned,
      triageMissing: 0,
      triageDuplicateIds: 0,
      triageUnknownIds: 0,
      worthEnriching: worthEnriching.length,
      zeroResultAuditEscalated: zeroResultAuditCandidates.length,
      intelligenceCoverageReviews,
      requestedForEnrichment: enrichment.diagnostics.requested,
      enrichedSuccessfully: enrichment.diagnostics.enriched,
      enrichmentFailures: enrichment.diagnostics.failed,
      ...(enrichment.diagnostics.failureReason
        ? { enrichmentFailureReason: enrichment.diagnostics.failureReason }
        : {}),
      requiredFullContextReviews,
      coverageLimited,
      enrichmentReplacementAttempts,
      enrichmentReplacementSuccesses,
      unverifiedPotentialCustomerSignals: unverifiedQualifiedCandidates.length,
      submittedForDeepQualification: conversationsNeedingDeep.length,
      deepQualificationsReturned: deepReturned,
      deepQualificationMissing: 0,
      potentialCustomerConversations: rawOpportunities.length,
      notCustomerConversations: deepRows.filter((row) => row.qualification.leadStatus === "not_customer").length,
      uncertainConversations: deepRows.filter((row) => row.qualification.leadStatus === "uncertain").length,
      marketIntelligenceSignals: marketIntelligence.length,
      uniquePotentialCustomers: aggregated.summary.total,
      replyEligible: replyEligible.length,
      repliesGenerated: replies.filter((reply) => reply.content.trim()).length,
    };

    scan.result = {
      profile,
      insights: insightSet.insights,
      conversationThemes,
      marketIntelligence,
      competitorWeakness: insightSet.weakness,
      opportunities,
      potentialCustomers: aggregated.summary,
      replies,
      sources: [...websiteSources, ...redditSources],
      usage,
      analysisMode,
      dataMode: discovery.sourceMode,
      dataNotice:
        discovery.sourceMode === "mock"
          ? "Website evidence was fetched from the submitted domain. Reddit conversations are synthetic mock-provider records, clearly labeled and never represented as live Reddit activity."
          : discovery.sourceMode === "apify-test"
            ? "Website evidence came from the submitted domain. Reddit records are real public records retrieved by an Apify web-scraping actor for internal MVP testing. This is not an approved production Reddit API integration."
            : "Website evidence and Reddit records came from their identified approved live providers.",
      processedRedditState,
      diagnostics,
      retrievalDiagnostics: {
        provider: redditProvider.name,
        queryCount: discovery.diagnostics.queryCount,
        searchPlan: discovery.searchPlan,
        queryCountsByLane: discovery.diagnostics.laneQueryCounts,
        matchedCandidatesByLane,
        worthEnrichingByLane,
        matchedCandidatesByQuery,
        worthEnrichingByQuery,
        fetchedCandidates: discovery.diagnostics.fetchedCandidates,
        normalizedCandidates: discovery.diagnostics.normalizedCandidates,
        locallyMatchedCandidates: cleaned.survivors.length,
        enrichmentAttempts: enrichment.diagnostics.requested,
        intelligenceCoverageReviews,
        enrichedConversations: enrichment.diagnostics.enriched,
        verifiedRecentConversations: discovery.diagnostics.verifiedRecentCandidates,
        missingVerifiedTimestamps: discovery.diagnostics.rejectedByReason.missing_timestamp,
        rejectedCandidates: providerRejectedCount + Object.values(cleaned.rejectedByReason).reduce((sum, count) => sum + count, 0),
        enrichmentFallbacks: enrichment.diagnostics.fallbackUsed,
        qualifiedOpportunities: opportunities.length,
      },
    };
    scan.status = "complete";
    scan.updatedAt = new Date().toISOString();
    await repository.saveScan(scan);
    await captureFunnelEvent(scan, "scan_completed");
    if (scan.scanKind !== "monitoring") {
      // AI Visibility Tracking is a sidecar (see ai-visibility-workflow.ts):
      // best-effort only. Nothing about it may ever fail, delay, or retry
      // the primary scan this business-setup completion belongs to.
      void ensureAiVisibilityTrackingStarted(scan).catch((error) => {
        console.error("Could not start AI visibility tracking.", error);
      });
    }
    return scan;
  } catch (error) {
    const message =
      error instanceof UnsafeWebsiteUrlError
        ? error.message
        : error instanceof Error
          ? error.message
          : "The scan failed unexpectedly.";
    const code = error instanceof ApiError ? error.code : undefined;
    // A thrown error here does not necessarily mean the scan is done: if a
    // background job attempt is in progress and attempts remain, the job
    // queue (scripts/background-worker.mjs) is about to retry the whole
    // scan on its own schedule. Landing on "failed" in that window is
    // exactly what stopped the frontend from polling while a retry was
    // already coming -- so only do that once retries are truly exhausted or
    // the error is one retrying cannot fix.
    const jobWillRetry = jobWillRetryScanFailure({ code, jobAttempts: options.jobAttempts, jobMaxAttempts: options.jobMaxAttempts });
    scan.status = jobWillRetry ? "retrying" : "failed";
    scan.error = message;
    scan.errorCode = code ?? null;
    scan.progress = scan.progress.map((stage) => {
      if (stage.status !== "active") return stage;
      if (jobWillRetry) {
        // Keep the stage looking "active", not "failed" -- this is what the
        // frontend already renders live per poll tick, so no new UI plumbing
        // is needed to show retry progress.
        return { ...stage, detail: `${message} Retrying automatically…` };
      }
      return { ...stage, status: "failed" as const, detail: message };
    });
    scan.updatedAt = new Date().toISOString();
    await repository.saveScan(scan);
    throw error;
  }
}

export function getConfiguredModelRolesForDiagnostics() {
  return openAiModelsFromEnv();
}
