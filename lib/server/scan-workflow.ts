import { randomUUID } from "node:crypto";
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
import { createOpenAiProviderFromEnv, openAiModelsFromEnv, isUsableTriageJudgment } from "@/lib/providers/openai.server";
import type { TriageProcessingOutcome } from "@/lib/providers/contracts";
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
import { jobWillRetryScanFailure, scanPipelineErrorCode } from "./job-retry-classification";
import { getStateRepository } from "./repository";
import { environmentForScan, resolveScanConfiguration, upgradeScanDepthConfiguration } from "./scan-configuration";
import { deepQualificationBudget, discoveryOnlyReview } from "./scan-depth";
import { createScanTrace, traceProvider, type ScanTrace } from "./scan-observability";
import { createWebsiteSnapshot, reusableWebsiteSnapshot, legacyProfileMatchesSnapshot, websitePageSourceId, businessWebsiteSourceIds } from "./website-snapshot";
import { maintainScanExecution, ScanOwnershipLostError, type ScanExecutionOwner } from "./scan-execution";
import { assertReviewedVersion } from "./scan-lifecycle";
import { runtimeProgress, refreshRuntimeProgress, recordScanWork } from "./scan-progress";
import { createDiscoveryTriageCoordinator, newDiscoveryTriageCheckpoint } from "./discovery-triage-coordinator";
import { aiCapacityFromEnv } from "../ai/capacity";
import { triageInputVersion } from "../ai/triage-dispatcher";
import { AiRecoveryBudget } from "../ai/recovery-budget";
import { replyInputVersion } from "../ai/reply-checkpoint";
import { ApifyRunRecovery } from "../providers/apify-run-recovery";
import { publishPartialReply, removePartialRepliesExcept, replaceCandidatePreviews, replaceQualifiedPartialResults, stableScanOutputId } from "./partial-results";
import { globallyBoundedAiRequestGate, sharedProviderCapacity } from "./provider-capacity";

const scanTraces = new WeakMap<ScanRecord, { trace: ScanTrace; stages: Map<string, ReturnType<ScanTrace["start"]>> }>();
const scanExecutions = new WeakMap<ScanRecord, { owner: ScanExecutionOwner; guard: ReturnType<typeof maintainScanExecution> }>();

async function persistScan(scan: ScanRecord) {
  refreshRuntimeProgress(scan);
  const trace = scanTraces.get(scan)?.trace;
  const execution = scanExecutions.get(scan);
  execution?.guard.signal.throwIfAborted();
  const write = async () => {
    try { await getStateRepository().saveScan(scan, execution?.owner); }
    catch (error) { if (error instanceof ScanOwnershipLostError) execution?.guard.lose(); throw error; }
  };
  return trace ? trace.measure("checkpoint.save", write) : write();
}

function scanAiProvider(scan: ScanRecord, env: NodeJS.ProcessEnv) {
  if (!env.OPENAI_API_KEY?.trim()) return null;
  const trace = scanTraces.get(scan)?.trace;
  const fetchImpl = scanExecutions.get(scan)?.guard.wrapFetch();
  const signal = scanExecutions.get(scan)?.guard.signal;
  const aiCapacity = aiCapacityFromEnv(env);
  const requestGate = globallyBoundedAiRequestGate({ environment: env, workspaceId: scan.workspaceId,
    localLimit: aiCapacity.requestConcurrency, holderPrefix: `scan:${scan.id}` });
  const recovery = env.SCAN_COORDINATED_RETRIES === "1" ? new AiRecoveryBudget({
    ledger: scan.aiRecoveryLedger ??= {}, maxRequests: Number(env.AI_RECOVERY_MAX_REQUESTS ?? 20),
    deadlineMs: Number(env.AI_RECOVERY_DEADLINE_MS ?? 900_000), onChange: () => persistScan(scan),
  }) : undefined;
  if (scan.runConfiguration?.effective?.ai) Object.assign(scan.runConfiguration.effective.ai, {
    coordinatedRetries: Boolean(recovery), recoveryMaxRequests: recovery?.maxRequests, recoveryDeadlineMs: recovery?.deadlineMs,
  });
  if (!trace) return createOpenAiProviderFromEnv(env, { fetchImpl, signal, recovery, requestGate });
  const requests = new Map<string, ReturnType<ScanTrace["start"]>>();
  return traceProvider(createOpenAiProviderFromEnv(env, {
    fetchImpl, signal, recovery, requestGate,
    onRequest: event => {
      const key = `${event.route}:${event.requestIndex}`;
      const data = { provider: event.endpointKind, route: event.route, operation: event.operation, model: event.model,
        attempt: event.attempt, category: event.category, statusCode: event.statusCode };
      if (event.phase === "start") requests.set(key, trace.start("ai.request", data));
      else { requests.get(key)?.(event.category === "http_success" ? "succeeded" : "failed", data); requests.delete(key); }
    },
    onUsage: event => trace.milestone("ai.usage", { provider: event.provider, model: event.model,
      operation: event.operation, inputTokens: event.usage.inputTokens, outputTokens: event.usage.outputTokens,
      cachedInputTokens: event.usage.cachedInputTokens }),
    onDiagnostic: event => trace.milestone("ai.diagnostic", { category: event.kind, operation: event.operation, model: event.model,
      unresolved: "unresolved" in event ? event.unresolved : undefined }),
  }), trace, ["analyzeBusiness", "analyzeBusinessFromContext", "embed", "triageConversations", "qualifyConversations", "generateInsights", "generateReply"]);
}

async function observedCrawl(scan: ScanRecord): Promise<WebsiteCrawlResult> {
  const boundSnapshotId = scan.discoveryProfile?.websiteSnapshotId;
  const snapshot = scan.websiteSnapshot;
  if (snapshot && reusableWebsiteSnapshot(snapshot, scan.id, scan.websiteUrl)) {
    if (boundSnapshotId && boundSnapshotId !== snapshot.id) {
      throw new ApiError("The approved profile does not match its saved website evidence. Start a new scan and review its website analysis.", 409, "website_snapshot_mismatch");
    }
    scanTraces.get(scan)?.trace.milestone("website.snapshot_reused", { pages: snapshot.crawl.pages.length });
    // Also retries a previous ambiguous/failed snapshot save before paid AI.
    await persistScan(scan);
    return structuredClone(snapshot.crawl);
  }
  if (boundSnapshotId) {
    throw new ApiError("The approved website evidence is missing or changed. Start a new scan and review its website analysis.", 409, "website_snapshot_mismatch");
  }
  const work = async () => {
    const execution = scanExecutions.get(scan);
    await execution?.guard.check();
    return crawlWebsite(scan.websiteUrl, { maxPages: 4, signal: execution?.guard.signal });
  };
  const crawl = await (scanTraces.get(scan)?.trace.measure("website.crawl", work) ?? work());
  scan.websiteSnapshot = createWebsiteSnapshot(scan.id, scan.websiteUrl, crawl);
  // Persist successful crawling before AI analysis: a model retry reuses it.
  await persistScan(scan);
  return structuredClone(scan.websiteSnapshot.crawl);
}

function assertWebsiteProfileEvidence(scan: ScanRecord, business: BusinessUnderstanding) {
  if (!scan.websiteSnapshot || !legacyProfileMatchesSnapshot(businessWebsiteSourceIds(business), scan.websiteSnapshot)) {
    throw new ApiError("The business profile references unavailable website evidence. Retry the website analysis.", 502, "website_snapshot_mismatch");
  }
}

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
    detail: "Working out what you sell and who it's for.",
  },
  {
    id: "discovery",
    label: "Searching the last year of Reddit",
    status: "pending",
    detail: "Searching the user's approved phrases for demand, pain, workarounds, switching and timing signals.",
  },
  {
    id: "triage",
    label: "Reading every credible candidate",
    status: "pending",
    detail: "Filtering for genuine buying intent before reading full conversations.",
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
    label: "Drafting a reply",
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

function redditProvenance(conversation: EnrichedRedditConversation): Provenance {
  return { id: conversation.provenance.id, kind: "reddit", url: conversation.permalink ?? "",
    title: conversation.title ?? "Reddit conversation", excerpt: conversation.body.slice(0, 280),
    capturedAt: conversation.provenance.observedAt, synthetic: conversation.sourceMode === "mock",
    provider: conversation.provider, sourceMode: conversation.sourceMode };
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
  if (scan.progress.find(stage => stage.id === stageId)?.status !== status) recordScanWork(scan);
  scan.progress = scan.progress.map((stage) =>
    stage.id === stageId ? { ...stage, status, detail: detail ?? stage.detail } : stage,
  );
  scan.updatedAt = new Date().toISOString();
  const observation = scanTraces.get(scan);
  if (status === "active" && !observation?.stages.has(stageId)) {
    const end = observation?.trace.start("scan.stage", { stage: stageId });
    if (end) observation?.stages.set(stageId, end);
  } else if (status === "complete" || status === "failed") {
    observation?.stages.get(stageId)?.(status === "complete" ? "succeeded" : "failed");
    observation?.stages.delete(stageId);
  }
  await persistScan(scan);
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

/** The context-mode counterpart to `conservativeProfile`: the same
 * no-AI-configured heuristic fallback, over the user's own freeform text
 * instead of crawled pages. Used only when OPENAI_API_KEY is unset. */
function conservativeProfileFromContext(contextText: string, sourceId: string): ScanBusinessProfile {
  const cleaned = contextText.replace(/\s+/g, " ").trim();
  const summary = firstUsefulSentence(cleaned) || cleaned.slice(0, 200) || "Described in the context you provided.";
  const problemSentences = cleaned
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => /\b(help|solve|simplif|save|avoid|reduce|enable|without)\w*\b/i.test(sentence))
    .map(usefulFallbackSentence)
    .filter((sentence): sentence is string => Boolean(sentence))
    .slice(0, 4);
  return {
    name: "Your business",
    websiteUrl: "",
    summary,
    productCategory: "Your business",
    targetAudience: [],
    problemsSolved: problemSentences,
    jobsToBeDone: [],
    likelyWorkarounds: [],
    triggerEvents: [],
    customerProblemLanguage: problemSentences,
    features: [],
    competitors: [],
    irrelevantTopics: [],
    brandTerms: [],
    ambiguityRisks: [],
    sourceIds: [sourceId],
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

/** Provenance records + sourceId-tagged pages for a crawl result. Shared by
 * runFullWebsiteUnderstanding and the full pass inside `runScan`, so both
 * attribute evidence the same way. */
function pagesFromCrawl(crawl: WebsiteCrawlResult): {
  websiteSources: Provenance[];
  pages: Array<WebsiteCrawlResult["pages"][number] & { sourceId: string }>;
} {
  const websiteSources: Provenance[] = crawl.pages.map((page) => ({
    id: page.sourceId ?? websitePageSourceId(page.contentHash),
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

/** The context-mode counterpart to `pagesFromCrawl`: wraps the user's
 * freeform text in the same Provenance shape a crawled page would get, so
 * citation plumbing downstream (CitedValue.provenanceIds, the sources list
 * in the final scan result) treats both sources identically. There is
 * exactly one "page" -- the user's own text -- so this returns a single
 * source rather than an array-shaped crawl result.
 *
 * The id is derived from the scan id, not randomly generated, for the same
 * reason `pagesFromCrawl` derives website source ids from each page's
 * contentHash rather than a random id: `runScan`'s full pipeline rebuilds
 * this source on every run (even when it reuses a persisted business
 * understanding -- see the `canReusePersistedAnalysis` branch), and that
 * reuse only stays citation-valid if the id it already cited is
 * reproducible from the same input every time.
 */
function contextSource(scanId: string, contextText: string): { source: Provenance; sourceId: string } {
  const source: Provenance = {
    id: `ctx_${scanId}`,
    kind: "user_supplied",
    url: "",
    title: "Business & market context you described",
    excerpt: contextText.slice(0, 280),
    capturedAt: new Date().toISOString(),
    synthetic: false,
  };
  return { source, sourceId: source.id };
}

/** Full understanding for website scans: the real, multi-page crawl plus the
 * full `analysisModel` analysis, run synchronously before ever showing the
 * review screen. By explicit request, this replaces the former
 * homepage-only "fast" preview + best-effort background refinement
 * (`runFastUnderstanding` / `refineDiscoveryProfile`, both removed): that
 * two-tier design let a user review and edit terms from a quick, cheap-model
 * pass, then had runScan's own canReusePersistedAnalysis rule (a "fast"
 * stage is never reused) silently discard everything not explicitly
 * overridden and regenerate it from a second, independent AI call once the
 * real scan started -- producing different keyphrases than the ones just
 * reviewed and approved. Always doing the full analysis up front removes
 * that failure mode entirely: the terms a user reviews are guaranteed to be
 * the terms actually searched, at the cost of the review screen taking as
 * long as the full analysis instead of a couple of seconds. Matches the
 * same call already made for competitor analysis -- see
 * competitor-analysis.ts's doc comment. One retry for a transient crawl/AI
 * hiccup, same reasoning `refineDiscoveryProfile` used to have: a single
 * network blip should not turn into a hard failure on the very first step
 * of the funnel. */
async function runFullWebsiteUnderstanding(scan: ScanRecord): Promise<{
  business: BusinessUnderstanding;
  profile: ScanBusinessProfile;
  analysisMode: ScanResult["analysisMode"];
}> {
  const businessId = createId("biz");
  const env = scan.runConfiguration ? environmentForScan(scan.runConfiguration) : process.env;
  const aiProvider = scanAiProvider(scan, env);

  if (aiProvider) {
    const models = openAiModelsFromEnv(env);
    const UNDERSTANDING_ATTEMPTS = 2;
    let business: BusinessUnderstanding | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < UNDERSTANDING_ATTEMPTS; attempt += 1) {
      try {
        const crawl = await observedCrawl(scan);
        const { pages } = pagesFromCrawl(crawl);
        const analyzed = await aiProvider.analyzeBusiness({
          workspaceId: scan.workspaceId,
          businessId,
          websiteUrl: crawl.canonicalUrl,
          canonicalDomain: crawl.canonicalDomain,
          pages,
          models,
        });
        assertWebsiteProfileEvidence(scan, analyzed.value);
        business = analyzed.value;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < UNDERSTANDING_ATTEMPTS - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1_500));
        }
      }
    }
    if (!business) throw lastError ?? new Error("Website understanding failed.");
    const profile = profileFromBusiness(business);
    return { business, profile, analysisMode: "openai" };
  }

  const crawl = await observedCrawl(scan);
  const { pages } = pagesFromCrawl(crawl);
  const profile = conservativeProfile(crawl.canonicalUrl, pages);
  const business = toBusinessUnderstanding({
    profile,
    workspaceId: scan.workspaceId,
    businessId,
    canonicalDomain: crawl.canonicalDomain,
  });
  return { business, profile, analysisMode: "local-fallback" };
}

/** The context-mode counterpart to `runFullWebsiteUnderstanding`. There is no
 * crawl to hide latency behind and no cheaper/fuller tier to split across --
 * a single short text is already the complete input -- so this both builds
 * and finalizes the profile in one call, and the caller in `runScan` marks
 * the result `profileStage: "full"` immediately rather than kicking off a
 * background refinement the way the website path does. */
async function runContextUnderstanding(scan: ScanRecord): Promise<{
  business: BusinessUnderstanding;
  profile: ScanBusinessProfile;
  analysisMode: ScanResult["analysisMode"];
  contextSource: Provenance;
}> {
  const text = (scan.contextText ?? "").trim();
  const { source, sourceId } = contextSource(scan.id, text);
  const businessId = createId("biz");
  const env = scan.runConfiguration ? environmentForScan(scan.runConfiguration) : process.env;
  const aiProvider = scanAiProvider(scan, env);

  if (aiProvider) {
    const models = openAiModelsFromEnv(env);
    const analyzed = await aiProvider.analyzeBusinessFromContext({
      workspaceId: scan.workspaceId,
      businessId,
      contextText: text,
      sourceId,
      models,
    });
    const business = analyzed.value;
    const profile = profileFromBusiness(business);
    return { business, profile, analysisMode: "openai", contextSource: source };
  }

  const profile = conservativeProfileFromContext(text, sourceId);
  const business = toBusinessUnderstanding({
    profile,
    workspaceId: scan.workspaceId,
    businessId,
    canonicalDomain: "",
  });
  return { business, profile, analysisMode: "local-fallback", contextSource: source };
}

/**
 * Real production bug: this scan's actual Reddit search queries did not
 * match what the user reviewed and approved on the "What we'll look for"
 * screen (DiscoveryProfile.tsx), for three separate reasons, all fixed
 * together here:
 *
 *  1. business.productCategory.value (a single AI-generated descriptor,
 *     never shown as a chip anywhere) used to be injected as the *first*
 *     product-lane query ahead of the reviewed terms, silently bumping one
 *     of the three reviewed product chips out of redditQueryFamilies' cap.
 *  2. business.productTerms.value and business.customerProblemLanguage.value
 *     can legitimately hold more entries than the review screen displays
 *     (it caps display at REVIEW_TERM_CAP, same as DiscoveryProfile.tsx's
 *     MAX_TERMS) -- when a displayed/reviewed term got filtered out
 *     downstream (e.g. redditQueryFamilies' youtube+tv collision guard),
 *     the query builder used to fall through to one of these hidden,
 *     never-shown extra entries instead of simply running one fewer query
 *     for that lane.
 *  3. The competitor lane never read what the user reviewed at all: it
 *     read business.competitors.value filtered down to only "verified"
 *     entries (routinely empty) plus an always-auto-generated
 *     "<name> alternative" pair per analyzed competitor -- so editing or
 *     removing a chip on the "Competitors & alternatives" card had zero
 *     effect on what actually got searched.
 *
 * reviewCompetitorTerms below (used together with the REVIEW_TERM_CAP
 * slices at the discover() call site) reproduces exactly what
 * DiscoveryProfile.tsx shows and lets the user edit -- same cap, same
 * named-competitors-then-competitor-language-pool merge, see that file's
 * MAX_TERMS and competitorLanguagePool -- so query planning can never use a
 * term the user never had a chance to see or remove.
 */
const REVIEW_TERM_CAP = 3;

/** Case-insensitive de-duplication, first-seen order, capped -- mirrors
 * DiscoveryProfile.tsx's dedupedPhrases() exactly, so the server computes
 * the identical default the review screen shows when there is no saved
 * override yet. */
function dedupedTerms(values: readonly string[], max: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(trimmed);
    if (result.length >= max) break;
  }
  return result;
}

/**
 * The same "competitors" seed DiscoveryProfile.tsx shows and lets the user
 * edit: named competitors first, then keyphrases/pain phrases from every
 * successfully analyzed competitor page, deduplicated and capped. Query
 * planning uses this directly -- not a verification/relationship-filtered
 * subset of business.competitors.value -- because that filter exists to
 * gate what DemandSift *claims* about a business, not what is safe to type
 * into a Reddit search; a user-approved or user-typed competitor term is a
 * search hint either way.
 */
function reviewCompetitorTerms(
  business: BusinessUnderstanding,
  competitorProfiles: readonly CompetitorProfile[] | null | undefined,
): string[] {
  const named = business.competitors.value.map((competitor) => competitor.name);
  const languagePool = (competitorProfiles ?? [])
    .filter((competitor) => competitor.status === "ready")
    .flatMap((competitor) => [...competitor.keyphrases, ...competitor.painPhrases]);
  return dedupedTerms([...named, ...languagePool], REVIEW_TERM_CAP);
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

// How many reply-generation AI calls run at once (see the "replies" stage
// below). Each opportunity/conversation's reply is fully independent of
// every other's, so drafting them one at a time in a loop was pure wasted
// wall-clock time -- the same problem TRIAGE_CONCURRENCY (openai.server.ts)
// fixed for triage batches. Bounded, not unlimited, for the same
// rate-limit-contention reason as that constant's doc comment.
const REPLY_GENERATION_CONCURRENCY = 4;

/**
 * Runs `fn` over every item in `items`, at most `concurrency` at a time,
 * preserving each result at its original index. Workers are allowed to
 * drain independent work before the first error is rethrown, so successful
 * sibling items can be checkpointed for a retry. Callers that want per-item
 * failure isolation must catch inside `fn`; required items may rethrow after
 * persisting their explicit failed state.
 */
async function mapConcurrently<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  };
  const workers = await Promise.allSettled(
    Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, () => worker()),
  );
  const failure = workers.find(result => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return results;
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
/**
 * Real production finding: discovery can retrieve up to 450 raw candidates
 * (9 query families x 50 posts each, see postsPerQuery's default in
 * reddit-harshmaur.server.ts), which regularly cleans down to 250-320
 * credible survivors. Against the old default of 120, a real scan showed
 * 285 credible candidates with only 2 dropped for genuinely low embedding
 * similarity -- the other 163 were cut purely because the budget ran out,
 * not because they were judged irrelevant. Raising the default to 300
 * was meant to cover that realistic worst case without hitting the 400
 * ceiling.
 *
 * Further finding (same business, two separate scans, both producing 353
 * credible survivors): the "250-320 typical, 300 covers it" assumption
 * above was already too tight in practice -- 353 sat above the assumed
 * range and above the 300 default, so ~53 embedding-ranked-lowest
 * candidates would have been excluded from full AI triage purely on
 * volume again, the exact failure mode this budget exists to prevent.
 * Raising the default to match the 400 hard ceiling removes that gap
 * entirely for any scan up to the ceiling (the only volume this budget was
 * ever meant to bound), at the cost of one more triage batch round-trip
 * on larger scans (TRIAGE_CONCURRENCY still bounds how many run at once).
 * REDDIT_TRIAGE_BUDGET can still be set lower via env if cost/latency ever
 * needs to be traded back against coverage.
 */
function triageCandidateBudget(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.REDDIT_TRIAGE_BUDGET ?? 400);
  return Number.isFinite(value) ? Math.max(20, Math.min(Math.trunc(value), 400)) : 400;
}

function embeddingPrefilterFloor(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.REDDIT_EMBEDDING_PREFILTER_FLOOR);
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

function acquisitionCandidateTarget(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.REDDIT_ACQUISITION_CANDIDATES ?? 250);
  return Number.isFinite(value) ? Math.max(25, Math.min(Math.trunc(value), 400)) : 250;
}

function enrichmentBudget(env: NodeJS.ProcessEnv = process.env): number {
  return deepQualificationBudget(env);
}

/**
 * How many conversations must be read with full thread context before the scan
 * is allowed to publish - in particular before it may publish a definitive
 * zero. Deliberately independent of the lookback window: shortening the window
 * to 7 days must not silently halve verification quality.
 */
function minimumFullContextReviews(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.REDDIT_MINIMUM_FULL_CONTEXT_REVIEWS);
  if (Number.isFinite(configured)) return Math.max(0, Math.min(Math.trunc(configured), enrichmentBudget(env)));
  return 4;
}

/**
 * Enrichment is probabilistic: threads get deleted, subreddits go private and
 * the scraper is occasionally rate limited. Selecting exactly the minimum meant
 * `required === selected`, so a single miss failed the entire scan after all
 * upstream work had already been paid for. Select with headroom instead.
 */
function enrichmentSelectionTarget(required: number, env: NodeJS.ProcessEnv = process.env): number {
  const headroom = Math.max(2, Math.ceil(required * 0.5));
  return Math.min(enrichmentBudget(env), required + headroom);
}

const MAX_CONTEXT_TEXT_LENGTH = 4_000;

export type CreateScanInput =
  | { websiteUrl: string }
  | { contextText: string };

/**
 * Creates the scan record for either onboarding path.
 *
 * Website and "describe your market" are just two different sources for the
 * same downstream pipeline -- see runScan's inputMode branching. A context
 * scan's websiteUrl is always "", never a fabricated domain; every existing
 * consumer of ScanRecord.websiteUrl already treats a falsy/unparsable value
 * as "no identity" rather than throwing (normalizedBusinessHostname,
 * sameWebsite), so this needs no schema change.
 */
export async function createScan(workspaceId: string, input: CreateScanInput, options: { reviewRequired?: true } = {}): Promise<ScanRecord> {
  const now = new Date().toISOString();
  const isContext = "contextText" in input;
  const scan: ScanRecord = {
    id: createId("scan"),
    workspaceId,
    websiteUrl: isContext ? "" : input.websiteUrl,
    inputMode: isContext ? "context" : "website",
    contextText: isContext ? input.contextText.slice(0, MAX_CONTEXT_TEXT_LENGTH) : null,
    status: "queued",
    ...(options.reviewRequired ? { reviewRequired: true as const, phase: "created" as const } : {}),
    progress: cloneStages(),
    createdAt: now,
    updatedAt: now,
    error: null,
    result: null,
  };
  await persistScan(scan);
  await captureFunnelEvent(scan, "scan_started");
  return scan;
}

export async function enqueueScanRun(scan: ScanRecord, reviewVersion?: string) {
  return getStateRepository().acceptScanJob(scan.id, scan.workspaceId, "scan.run", reviewVersion);
}

export async function enqueueScanAnalysis(scan: ScanRecord) {
  return getStateRepository().acceptScanJob(scan.id, scan.workspaceId, "scan.analyze");
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
    jobId?: string;
    jobWorkerId?: string;
  } = {},
): Promise<ScanRecord> {
  const repository = getStateRepository();
  if (options.jobId && (!options.jobWorkerId || !options.jobAttempts)) throw new ScanOwnershipLostError();
  const owner: ScanExecutionOwner = { token: randomUUID(), ...(options.jobId
    ? { jobId: options.jobId, workerId: options.jobWorkerId, attempt: options.jobAttempts } : {}) };
  const claim = await repository.beginScanRun(scanId, owner);
  if (claim.state === "missing" || !claim.scan) {
    throw new ApiError("Scan was not found.", 404, "scan_not_found");
  }
  if (claim.state === "complete") return claim.scan;
  // The DB lease, not a local promise or a caller's resume flag, owns recovery.
  if (claim.state === "running") return claim.scan;
  const scan = claim.scan;
  const guard = maintainScanExecution(() => repository.refreshScanExecution(scanId, owner));
  scanExecutions.set(scan, { owner, guard });
  const trace = createScanTrace({ scanId, jobId: options.jobId, jobAttempt: options.jobAttempts });
  const finishExecution = trace.start(options.stopAfterUnderstanding ? "scan.analysis" : "scan.run");
  scanTraces.set(scan, { trace, stages: new Map() });
  let discoveryTriage: ReturnType<typeof createDiscoveryTriageCoordinator> | undefined;

  try {
    if (scan.reviewRequired && !options.stopAfterUnderstanding) assertReviewedVersion(scan, scan.approval?.version);
    scan.phase = options.stopAfterUnderstanding ? "analyzing" : "scanning";
    scan.runConfiguration = upgradeScanDepthConfiguration(scan.runConfiguration ?? resolveScanConfiguration(process.env, { workspaceId: scan.workspaceId }));
    const env = environmentForScan(scan.runConfiguration);
    scan.runConfiguration.effective ??= {
      workflow: { triageCandidateBudget: triageCandidateBudget(env), enrichmentBudget: enrichmentBudget(env),
        acquisitionCandidateTarget: acquisitionCandidateTarget(env), embeddingPrefilterFloor: embeddingPrefilterFloor(env),
        minimumFullContextReviews: minimumFullContextReviews(env), websiteMaxPages: 4, replyConcurrency: REPLY_GENERATION_CONCURRENCY },
      models: openAiModelsFromEnv(env),
      ai: env.OPENAI_API_KEY?.trim() ? createOpenAiProviderFromEnv(env).configurationForDiagnostics() : undefined,
    };
    const startedAt = new Date().toISOString();
    const liveProgress = runtimeProgress(scan);
    if (options.stopAfterUnderstanding) liveProgress.analysisStartedAt ??= startedAt;
    else liveProgress.runStartedAt ??= startedAt;
    recordScanWork(scan, startedAt);
    scan.timing = { ...scan.timing, acceptedAt: scan.timing?.acceptedAt ?? scan.createdAt,
      firstStartedAt: scan.timing?.firstStartedAt ?? startedAt, lastStartedAt: startedAt, executionId: trace.executionId };
    trace.milestone("scan.config", { configId: scan.runConfiguration.id, revision: scan.runConfiguration.defaultsVersion });
    const effective = scan.runConfiguration.effective;
    trace.milestone("scan.budgets", { triageBudget: effective.workflow.triageCandidateBudget,
      reviewBudget: effective.workflow.enrichmentBudget, acquisitionTarget: effective.workflow.acquisitionCandidateTarget,
      embeddingFloor: effective.workflow.embeddingPrefilterFloor, requiredFullContext: effective.workflow.minimumFullContextReviews,
      websitePageBudget: effective.workflow.websiteMaxPages, replyConcurrency: effective.workflow.replyConcurrency,
      providerTimeoutMs: effective.ai?.timeoutMs, triageConcurrency: effective.ai?.triageConcurrency, triageBatchSize: effective.ai?.triageBatchSize });
    for (const [operation, model] of Object.entries(effective.models)) trace.milestone("scan.model", { operation, model });
    await persistScan(scan);
    await setStage(scan, "website", "active");

    if (options.stopAfterUnderstanding) {
      if (scan.discoveryProfile && scan.discoveryProfile.profileStage !== "fast") {
        scan.status = "queued";
        scan.phase = "awaiting_review";
        scan.analysisCompletedAt = new Date().toISOString();
        await persistScan(scan);
        return scan;
      }
      // `/analyze` only ever calls runScan with stopAfterUnderstanding when
      // scan.discoveryProfile doesn't exist yet (it returns early itself
      // otherwise), so there is nothing here to reuse: this always runs the
      // full crawl + full analysis synchronously, right here, before
      // returning -- the terms the review screen shows are guaranteed to be
      // the same ones the real pipeline searches with later.
      if (scan.inputMode === "context") {
        // No crawl to hide behind and no cheaper tier below the full
        // analysis (see runContextUnderstanding's doc comment), so this
        // goes straight to a "full" profile -- no background refinement to
        // kick off, unlike the website path below.
        const built = await runContextUnderstanding(scan);
        await setStage(scan, "website", "complete", "Business context saved from your description.");
        scan.discoveryProfile = {
          profile: built.profile,
          business: built.business,
          analysisMode: built.analysisMode,
          analyzedAt: new Date().toISOString(),
          profileStage: "full",
        };
        await setStage(
          scan,
          "understanding",
          "complete",
          `Built a context pack for ${built.profile.name} from your description.`,
        );
        scan.status = "queued";
        scan.phase = "awaiting_review";
        scan.analysisCompletedAt = new Date().toISOString();
        scan.updatedAt = new Date().toISOString();
        await persistScan(scan);
        return scan;
      }

      const full = await runFullWebsiteUnderstanding(scan);
      const pageCount = scan.websiteSnapshot?.crawl.pages.length ?? 0;
      await setStage(scan, "website", "complete", `${pageCount} public page${pageCount === 1 ? "" : "s"} read from the submitted domain.`);
      scan.discoveryProfile = {
        websiteSnapshotId: scan.websiteSnapshot?.id,
        profile: full.profile,
        business: full.business,
        analysisMode: full.analysisMode,
        analyzedAt: new Date().toISOString(),
        profileStage: "full",
      };
      await setStage(
        scan,
        "understanding",
        "complete",
        `Built a source-backed context pack for ${full.profile.name}.`,
      );
      scan.status = "queued";
      scan.phase = "awaiting_review";
      scan.analysisCompletedAt = new Date().toISOString();
      scan.updatedAt = new Date().toISOString();
      await persistScan(scan);

      return scan;
    }

    const isContextScan = scan.inputMode === "context";
    let websiteSources: Provenance[] = [];
    let pages: Array<WebsiteCrawlResult["pages"][number] & { sourceId: string }> = [];
    let contextText = "";
    let crawl: WebsiteCrawlResult | null = null;
    if (isContextScan) {
      contextText = (scan.contextText ?? "").trim();
      const { source } = contextSource(scan.id, contextText);
      websiteSources = [source];
      await setStage(scan, "website", "complete", "Business context saved from your description.");
    } else {
      crawl = await observedCrawl(scan);
      ({ websiteSources, pages } = pagesFromCrawl(crawl));
      await setStage(
        scan,
        "website",
        "complete",
        `${pages.length} public page${pages.length === 1 ? "" : "s"} read from the submitted domain.`,
      );
    }

    const actorSpans = new Map<number, ReturnType<ScanTrace["start"]>>();
    const providerCapacity = sharedProviderCapacity(env);
    const redditProvider = traceProvider(createRedditProviderFromEnv(env, {}, {
      fetchImpl: guard.wrapFetch(),
      signal: guard.signal,
      runRecovery: new ApifyRunRecovery({ ledger: scan.externalActorLedger ??= {},
        previousRuns: Object.values(scan.externalActorRuns ?? {}), onChange: () => persistScan(scan),
        actorCapacity: providerCapacity?.capacity,
        actorCapacityLimit: providerCapacity?.configuration.apifyActorLimit,
        workspaceId: scan.workspaceId,
        holderPrefix: `scan:${scan.id}` }),
      onActorStarted: async checkpoint => {
        scan.externalActorRuns ??= {};
        scan.externalActorRuns[checkpoint.actorRunId] = checkpoint;
        await persistScan(scan);
      },
      onActorRun: event => {
        if (event.phase === "start") actorSpans.set(event.requestIndex, trace.start("apify.actor", { queries: event.queries }));
        else { actorSpans.get(event.requestIndex)?.(event.outcome ?? "failed", { actorRunId: event.actorRunId, candidates: event.candidates }); actorSpans.delete(event.requestIndex); }
      },
    }), trace, ["discover", "enrich"]);
    scan.runConfiguration.effective.reddit ??= redditProvider.configurationForDiagnostics?.() ?? { provider: redditProvider.name };
    const redditSettings = scan.runConfiguration.effective.reddit;
    trace.milestone("scan.reddit_config", { provider: redditProvider.name,
      actorConcurrency: Number(redditSettings.maxConcurrentDiscoveryRuns), postsPerQuery: Number(redditSettings.postsPerQuery),
      providerTimeoutMs: Number(redditSettings.timeoutMs) });
    const requiresAi = redditProvider.sourceMode !== "mock";
    const usage: UsageRecord[] = [];
    const businessId = createId("biz");
    const models = openAiModelsFromEnv(env);
    const aiProvider = scanAiProvider(scan, env);
    if (requiresAi && !aiProvider) {
      throw new Error("AI is required to analyze and qualify real Reddit records.");
    }

    await setStage(scan, "understanding", "active");
    let business: BusinessUnderstanding;
    let profile: ScanBusinessProfile;
    let analysisMode: ScanResult["analysisMode"];
    // A previously analyzed profile is reused verbatim. Re-analyzing would
    // burn tokens and, worse, could produce different terms from the ones the
    // user just reviewed and approved. The understanding step above always
    // persists a complete analysis now (the old homepage-only "fast" preview
    // tier that this used to have to guard against is gone -- see
    // runFullWebsiteUnderstanding's doc comment), so any persisted profile is
    // safe to reuse as-is.
    const persistedAnalysis = scan.discoveryProfile;
    if (!isContextScan && persistedAnalysis && !persistedAnalysis.websiteSnapshotId && scan.websiteSnapshot) {
      // Legacy records have no crawl snapshot. Recrawl through the protected
      // path, but never silently bind old claims to changed page content.
      if (!legacyProfileMatchesSnapshot([...(persistedAnalysis.profile.sourceIds ?? []), ...businessWebsiteSourceIds(persistedAnalysis.business)], scan.websiteSnapshot)) {
        throw new ApiError("The website evidence no longer matches the approved profile. Start a new scan and review its terms before scanning.", 409, "website_snapshot_mismatch");
      }
      persistedAnalysis.websiteSnapshotId = scan.websiteSnapshot.id;
    }
    const canReusePersistedAnalysis = Boolean(persistedAnalysis);
    if (canReusePersistedAnalysis && persistedAnalysis) {
      business = persistedAnalysis.business;
      profile = persistedAnalysis.profile;
      analysisMode = persistedAnalysis.analysisMode;
    } else if (aiProvider && isContextScan) {
      const analyzed = await aiProvider.analyzeBusinessFromContext({
        workspaceId: scan.workspaceId,
        businessId,
        contextText,
        sourceId: websiteSources[0].id,
        models,
      });
      business = analyzed.value;
      profile = profileFromBusiness(business);
      usage.push(usageRecord(analyzed, "website-analysis"));
      analysisMode = "openai";
    } else if (aiProvider) {
      // crawl is always set here: this branch only runs when !isContextScan
      // (that case is handled above), and the website branch above always
      // assigns crawl before this point.
      const websiteCrawl = crawl as WebsiteCrawlResult;
      const analyzed = await aiProvider.analyzeBusiness({
        workspaceId: scan.workspaceId,
        businessId,
        websiteUrl: websiteCrawl.canonicalUrl,
        canonicalDomain: websiteCrawl.canonicalDomain,
        pages,
        models,
      });
      assertWebsiteProfileEvidence(scan, analyzed.value);
      business = analyzed.value;
      profile = profileFromBusiness(business);
      usage.push(usageRecord(analyzed, "website-analysis"));
      analysisMode = "openai";
    } else if (isContextScan) {
      profile = conservativeProfileFromContext(contextText, websiteSources[0].id);
      business = toBusinessUnderstanding({
        profile,
        workspaceId: scan.workspaceId,
        businessId,
        canonicalDomain: "",
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
    } else {
      // Same reasoning as the branch above: crawl is always set here.
      const websiteCrawl = crawl as WebsiteCrawlResult;
      profile = conservativeProfile(websiteCrawl.canonicalUrl, pages);
      business = toBusinessUnderstanding({
        profile,
        workspaceId: scan.workspaceId,
        businessId,
        canonicalDomain: websiteCrawl.canonicalDomain,
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
      // discovery terms while the scan waits.
      scan.discoveryProfile = {
        ...(!isContextScan ? { websiteSnapshotId: scan.websiteSnapshot?.id } : {}),
        profile,
        business,
        analysisMode,
        analyzedAt: new Date().toISOString(),
        profileStage: "full",
      };
      scan.updatedAt = new Date().toISOString();
      await persistScan(scan);
    }

    // Note: options.stopAfterUnderstanding is handled entirely by the
    // branch near the top of this function, which always returns before
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
    // attempts. `persistedDiscovery` may be either a fully-complete result
    // from an attempt that finished, or a partial one saved mid-discovery by
    // onChunkSucceeded below (e.g. this process was restarted -- by a
    // deploy, a job-level timeout, or a reclaim after the worker lost its
    // heartbeat -- before discovery finished). Passing it as `resumeFrom`
    // lets the provider itself work out what's still outstanding: nothing
    // (zero new Apify calls) if it was already complete, or only the
    // queries that never finished if it was partial. Either way this
    // replaces the previous "reuse in full or redo from scratch" choice,
    // which paid for and re-ran every query on any interruption mid-stage.
    const persistedDiscovery = scan.redditDiscovery;
    // What gets searched here must be exactly what the review screen showed
    // and let the user edit (DiscoveryProfile.tsx's MAX_TERMS-capped chips)
    // -- not a superset that includes AI-generated terms the user never saw
    // a chance to see or remove. See REVIEW_TERM_CAP / dedupedTerms /
    // reviewCompetitorTerms above for the full history of why this matters.
    const reviewProductTerms = dedupedTerms(business.productTerms.value, REVIEW_TERM_CAP);
    const reviewCustomerProblems = dedupedTerms(
      business.customerProblemLanguage.value.length > 0
        ? business.customerProblemLanguage.value
        : business.problemsSolved.value,
      REVIEW_TERM_CAP,
    );
    const reviewCompetitors = reviewCompetitorTerms(business, scan.competitorProfiles);
    if (aiProvider && scan.runConfiguration.flags.overlapDiscoveryTriage) {
      const aiCapacity = aiCapacityFromEnv(env);
      scan.discoveryTriageCheckpoint ??= newDiscoveryTriageCheckpoint();
      scan.triageCoverage = undefined;
      discoveryTriage = createDiscoveryTriageCoordinator({
        provider: aiProvider, request: { business, models, signal: guard.signal, compactOutput: scan.runConfiguration.flags.compactTriage,
          coverageRetries: 3, tolerateUnrecoverableBatches: true },
        since, checkpoint: scan.discoveryTriageCheckpoint,
        maxCandidates: Number(env.SCAN_EARLY_TRIAGE_LIMIT ?? 100), flushDelayMs: Number(env.SCAN_EARLY_TRIAGE_FLUSH_MS ?? 1_000),
        batchSize: aiCapacity.triageBatchSize, concurrency: aiCapacity.requestConcurrency,
        onCheckpoint: async () => { recordScanWork(scan); await persistScan(scan); },
        onProgress: progress => {
          const live = runtimeProgress(scan);
          live.canonicalEligible = progress.eligible;
          live.triage = { expected: null, succeeded: progress.succeeded, promising: progress.promising, pending: null, unresolved: null };
          live.triageComplete = false;
        },
      });
      if (persistedDiscovery) discoveryTriage.offer(persistedDiscovery.candidates);
      await setStage(scan, "triage", "active", "Relevance checks will run as search results arrive. Final coverage is checked after all searches finish.");
    }
    const discovery = await redditProvider.discover(
      {
        queries: {
          productTerms: reviewProductTerms,
          brandTerms: business.brandTerms.value,
          productCategories: [],
          customerProblems: reviewCustomerProblems,
          jobsToBeDone: business.jobsToBeDone?.value ?? [],
          workarounds: business.likelyWorkarounds?.value ?? [],
          triggerEvents: business.triggerEvents?.value ?? [],
          buyerIntent: ["recommendations", "alternative", "comparing tools", "need a tool"],
          competitors: reviewCompetitors,
          excludedTerms: business.irrelevantTopics.value,
          ambiguityRisks: business.ambiguityRisks.value,
        },
        limit: acquisitionCandidateTarget(env),
        since,
      },
      {
        onProgress: async queries => {
          const progress = runtimeProgress(scan);
          if ((queries.succeeded ?? 0) > (progress.queries.succeeded ?? 0)) recordScanWork(scan);
          progress.queries = queries;
          progress.discoveryComplete = queries.succeeded === queries.planned;
          await persistScan(scan);
        },
        // Surfaced live so a slow/retrying search isn't silent: the frontend
        // already renders this stage's `detail` text on every poll tick.
        onRetry: async (notice) => {
          trace.milestone("discovery.retry", { attempt: notice.attempt, retryDelayMs: notice.delayMs, category: "transient" });
          await setStage(
            scan,
            "discovery",
            "active",
            `Reddit search is taking longer than expected, retrying automatically ` +
              `(attempt ${Math.min(notice.attempt + 1, notice.maxAttempts)} of ${notice.maxAttempts})…`,
          );
        },
        resumeFrom: persistedDiscovery ?? undefined,
        // Persisted as soon as each query chunk succeeds, not only once the
        // whole stage finishes -- see the discoveryProfile comment above.
        // Best-effort: a save failing here must never fail discovery itself,
        // it only means a subsequent interruption would redo a bit more work.
        onChunkSucceeded: async (partial) => {
          trace.milestone("discovery.checkpoint", { candidates: partial.candidates.length, queries: partial.searchPlan.length });
          scan.redditDiscovery = partial;
          // Cumulative input; offer computes exact-version deltas. It never
          // waits for AI, so Apify workers remain free to finish other queries.
          discoveryTriage?.offer(partial.candidates);
          scan.updatedAt = new Date().toISOString();
          try {
            await persistScan(scan);
          } catch (error) {
            console.error("Failed to checkpoint partial Reddit discovery.", error);
          }
        },
      },
    ).catch((error) => {
      const message = error instanceof Error ? error.message : "Unknown Reddit discovery failure.";
      throw new ApiError(
        `Reddit discovery failed: ${message}`,
        502,
        scanPipelineErrorCode(error) ?? "reddit_discovery_failed",
      );
    });
    if (discovery.candidates.length === 0 && discovery.diagnostics.degraded) {
      // Zero results here would otherwise be indistinguishable from a real
      // "searched and found nothing" outcome. A degraded run means coverage
      // was lost to retries being exhausted, not that the search completed
      // cleanly with nothing to show -- that must never be reported as a
      // successful empty scan. This is intentionally not persisted as the
      // scan's final redditDiscovery, so the next job attempt retries the
      // still-missing queries (whatever onChunkSucceeded did manage to
      // checkpoint along the way is reused; nothing usable was lost).
      throw new ApiError(
        "Reddit discovery timed out and returned no usable results after retrying.",
        503,
        "reddit_discovery_failed",
      );
    }
    // Always persist the final result, even though onChunkSucceeded above
    // already checkpointed along the way: this is the authoritative,
    // fully-merged version with final diagnostics, and must be what a
    // later stage or a future resume actually sees.
    scan.redditDiscovery = discovery;
    const discoveryProgress = runtimeProgress(scan);
    // Other provider adapters need not emit live query events. Their completed
    // response still provides a bounded fallback; failed coverage is not zero.
    const queryCount = discoveryProgress.queries.planned ?? discovery.diagnostics.queryCount;
    const failedQueries = discovery.diagnostics.queriesFailed ?? 0;
    discoveryProgress.queries = { planned: queryCount,
      succeeded: discovery.diagnostics.queriesSucceeded ?? Math.max(0, queryCount - failedQueries),
      failed: failedQueries, active: 0, retrying: 0, pending: 0 };
    discoveryProgress.discoveryComplete = discovery.diagnostics.degraded !== true && failedQueries === 0
      && discoveryProgress.queries.succeeded === queryCount;
    scan.updatedAt = new Date().toISOString();
    await persistScan(scan);
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
    runtimeProgress(scan).canonicalEligible = new Set(cleaned.survivors.map(row => row.externalId)).size;
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

    if (aiProvider && cleaned.survivors.length > triageCandidateBudget(env)) {
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
            budget: triageCandidateBudget(env),
            floor: embeddingPrefilterFloor(env),
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

    const inputVersions = new Map(prefilteredSurvivors.map(candidate => [candidate.externalId, triageInputVersion({ business, models,
      compactOutput: scan.runConfiguration?.flags.compactTriage === true }, candidate)]));
    const overlap = await discoveryTriage?.finish(prefilteredSurvivors);
    if (overlap) {
      for (const result of overlap.results) usage.push(usageRecord(result, "triage"));
      scan.triageCheckpoint ??= {};
      scan.triageCheckpointVersions ??= {};
      for (const [id, judgment] of overlap.retained) {
        scan.triageCheckpoint[id] = judgment;
        scan.triageCheckpointVersions[id] = inputVersions.get(id)!;
      }
      trace.milestone("triage.overlap_reconciled", { candidates: overlap.submitted, completed: overlap.reused,
        unresolved: overlap.supersededOrExcluded, category: overlap.failed ? "early_failure_recovered_by_final_pass" : "reconciled" });
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
        isUsableTriageJudgment(previous.triage, candidate.externalId) &&
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

    // A legacy synthetic negative is not completed work. Validate checkpoint
    // shape and IDs as well; ordinary valid negative judgments remain reusable.
    const priorCheckpointCount = Object.keys(scan.triageCheckpoint ?? {}).length;
    scan.triageCheckpoint = Object.fromEntries(Object.entries(scan.triageCheckpoint ?? {})
      .filter(([id, value]) => isUsableTriageJudgment(value, id)
        && (scan.triageCheckpointVersions?.[id]
          ? scan.triageCheckpointVersions[id] === inputVersions.get(id)
          : !scan.runConfiguration?.flags.overlapDiscoveryTriage)));
    scan.triageCheckpointVersions = Object.fromEntries(Object.keys(scan.triageCheckpoint)
      .filter(id => inputVersions.has(id)).map(id => [id, inputVersions.get(id)!]));
    if (Object.keys(scan.triageCheckpoint).length < priorCheckpointCount) {
      trace.milestone("triage.invalid_checkpoint", { unresolved: priorCheckpointCount - Object.keys(scan.triageCheckpoint).length });
    }
    const eligibleIds = new Set(prefilteredSurvivors.map(row => row.externalId));
    const hasJudgment = (id: string) => triageById.has(id) || isUsableTriageJudgment(scan.triageCheckpoint?.[id], id);
    const updateTriageCoverage = () => {
      const ids = [...eligibleIds];
      const succeeded = ids.filter(hasJudgment).length;
      const unresolved = ids.filter(id => !hasJudgment(id) && scan.triageProcessing?.[id]?.status === "unresolved").length;
      if (succeeded > (scan.triageCoverage?.succeeded ?? 0)) recordScanWork(scan);
      scan.triageCoverage = { expected: ids.length, succeeded, unresolved, pending: ids.length - succeeded - unresolved, complete: succeeded === ids.length };
      runtimeProgress(scan).triage.promising = ids.filter(id => (triageById.get(id) ?? scan.triageCheckpoint?.[id])?.worthEnriching === true).length;
    };
    scan.triageProcessing = Object.fromEntries([...eligibleIds].map(externalId => [externalId, {
      externalId, status: hasJudgment(externalId) ? "succeeded" : "pending",
      attempts: scan.triageProcessing?.[externalId]?.attempts ?? 0,
    } satisfies TriageProcessingOutcome]));
    updateTriageCoverage();
    await persistScan(scan);
    const recordProcessing = async (items: readonly TriageProcessingOutcome[]) => {
      for (const item of items) {
        if (!eligibleIds.has(item.externalId)) continue;
        scan.triageProcessing![item.externalId] = hasJudgment(item.externalId)
          ? { externalId: item.externalId, attempts: item.attempts, status: "succeeded" }
          : item.status === "succeeded" ? { externalId: item.externalId, attempts: item.attempts, status: "pending" } : item;
      }
      updateTriageCoverage();
      await persistScan(scan);
    };
    let triageReturned = 0;
    if (needsTriage.length > 0) {
      if (aiProvider) {
        // See ScanRecord.triageCheckpoint's doc comment: reuses whatever an
        // earlier, interrupted attempt of this same scan already triaged
        // successfully, and persists each newly-triaged batch as it
        // completes so a future interruption resumes from here too.
        const triaged = await aiProvider.triageConversations({
          signal: guard.signal,
          business,
          candidates: needsTriage,
          models,
          compactOutput: scan.runConfiguration.flags.compactTriage,
          // Raised to the max coverageRetries allows (see
          // isNetworkTransportError in openai.server.ts): this budget is
          // now also what absorbs a transient network stall inside triage's
          // batch workers, not just incomplete-coverage responses, and
          // extra attempts cost nothing unless something actually failed.
          coverageRetries: 3,
          // Drain independent batches, then fail incomplete coverage below.
          // Unresolved processing can never masquerade as negative relevance.
          tolerateUnrecoverableBatches: true,
          resumeFrom: scan.triageCheckpoint
            ? new Map(Object.entries(scan.triageCheckpoint))
            : undefined,
          resumeProcessing: new Map(Object.entries(scan.triageProcessing)),
          onProcessingUpdated: recordProcessing,
          onBatchSucceeded: async (items) => {
            const judgments = items.filter(item => eligibleIds.has(item.externalId) && isUsableTriageJudgment(item.triage, item.externalId));
            trace.milestone("triage.batch", { completed: judgments.length });
            const next = { ...(scan.triageCheckpoint ?? {}) };
            for (const item of judgments) {
              next[item.externalId] = item.triage;
              scan.triageCheckpointVersions![item.externalId] = inputVersions.get(item.externalId)!;
              scan.triageProcessing![item.externalId] = { externalId: item.externalId, status: "succeeded", attempts: scan.triageProcessing?.[item.externalId]?.attempts ?? 0 };
            }
            scan.triageCheckpoint = next;
            updateTriageCoverage();
            scan.updatedAt = new Date().toISOString();
            try {
              await persistScan(scan);
            } catch (error) {
              console.error("Failed to checkpoint a successfully triaged batch.", error);
            }
          },
        });
        usage.push(usageRecord(triaged, "triage"));
        const judgments = triaged.value.filter(item => eligibleIds.has(item.externalId) && isUsableTriageJudgment(item.triage, item.externalId));
        triageReturned = judgments.length;
        for (const item of judgments) {
          triageById.set(item.externalId, item.triage);
          scan.triageCheckpoint[item.externalId] = item.triage;
          scan.triageCheckpointVersions![item.externalId] = inputVersions.get(item.externalId)!;
          scan.triageProcessing![item.externalId] = { externalId: item.externalId, status: "succeeded", attempts: scan.triageProcessing?.[item.externalId]?.attempts ?? 0 };
        }
        if (triaged.processing) await recordProcessing(triaged.processing);
      } else {
        const triaged = needsTriage.map((candidate) => localMockTriage(candidate));
        triageReturned = triaged.length;
        for (const item of triaged) triageById.set(item.externalId, item);
      }
    }

    for (const id of eligibleIds) {
      if (!triageById.has(id) && isUsableTriageJudgment(scan.triageCheckpoint?.[id], id)) triageById.set(id, scan.triageCheckpoint![id]);
    }
    const missingTriage = prefilteredSurvivors.filter(candidate => !triageById.has(candidate.externalId));
    for (const candidate of missingTriage) {
      const prior = scan.triageProcessing![candidate.externalId];
      if (prior?.status !== "unresolved") scan.triageProcessing![candidate.externalId] = {
        externalId: candidate.externalId, status: "unresolved", attempts: prior?.attempts ?? 0,
        code: "ai_coverage_incomplete", recoverable: false,
      };
    }
    updateTriageCoverage();
    await persistScan(scan);
    if (missingTriage.length > 0) {
      throw new ApiError("Triage coverage is incomplete. Successful work was saved; the scan will not report a definitive zero.", 502, "triage_coverage_incomplete");
    }
    const worthEnriching = prefilteredSurvivors.filter(
      (candidate) => triageById.get(candidate.externalId)?.worthEnriching,
    );
    if (scan.runConfiguration.flags.partialResults) {
      replaceCandidatePreviews(scan, prefilteredSurvivors, triageById);
    }
    const zeroResultAuditCandidates = worthEnriching.length === 0
      ? selectZeroResultAuditCandidates({
          candidates: cleaned.survivors,
          triageById,
          // Acquisition gets a three-candidate audit. Incremental scans get one
          // independent deep check so a cached/cheap triage false-negative cannot
          // silently turn real demand into a valid-looking zero.
          budget: Math.min(previousResult ? 2 : 3, enrichmentBudget(env)),
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
          budget: enrichmentBudget(env),
        });
    const primaryIds = new Set(primaryEnrichmentCandidates.map((candidate) => candidate.externalId));
    const requiredReviews = minimumFullContextReviews(env);
    const intelligenceReviewBudget = Math.max(
      0,
      Math.min(
        enrichmentSelectionTarget(requiredReviews, env) - primaryEnrichmentCandidates.length,
        enrichmentBudget(env) - primaryEnrichmentCandidates.length,
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
    runtimeProgress(scan).deepReview = { target: new Set(selectedForEnrichment.map(row => row.externalId)).size, completed: 0, threadsVerified: 0 };
    await persistScan(scan);
    let intelligenceCoverageReviews = intelligenceReviewCandidates.length;
    // Review depth is chosen independently of the lookback window, so
    // narrowing the scan to 7 days cannot quietly halve verification quality.
    const requiredFullContextReviews = Math.min(
      requiredReviews,
      cleaned.survivors.length,
      enrichmentBudget(env),
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
    // Only a provider that explicitly reports fetching off relaxes the bar.
    // An unrelated/absent Apify variable must not relax another provider.
    const enrichmentDisabled = redditSettings.enrichmentLimit === 0;
    const meetsPublishingContextBar = (conversation: EnrichedRedditConversation): boolean =>
      hasVerifiedThreadContext(conversation) || enrichmentDisabled;

    // Enrichment is useful context, not an all-or-nothing website-analysis gate.
    // If one selected Reddit URL cannot be expanded, try the next-best candidate
    // within the existing bounded budget. This protects zero-result confidence
    // without throwing away the website profile, discovery, and triage already done.
    const initialEnrichment = await redditProvider.enrich({
      candidates: selectedForEnrichment,
      maxComments: Number(env.APIFY_REDDIT_ENRICHMENT_COMMENTS ?? 6),
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
      selectedForEnrichment.length < Math.min(enrichmentBudget(env), cleaned.survivors.length)
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
        maxComments: Number(env.APIFY_REDDIT_ENRICHMENT_COMMENTS ?? 6),
      });
      absorbEnrichment(replacementEnrichment);
      if (verifiedContextCount() > before) enrichmentReplacementSuccesses += 1;
    }

    const enrichmentConversations = selectedForEnrichment.map((candidate) =>
      enrichmentById.get(candidate.externalId) ?? discoveryOnlyReview(candidate),
    );
    const enrichedSuccessfully = enrichmentConversations.filter(hasVerifiedThreadContext).length;
    const discoveryOnlyCount = Math.max(0, selectedForEnrichment.length - enrichedSuccessfully);
    const enrichmentFailures = enrichmentDisabled ? 0 : discoveryOnlyCount;
    const coverageLimited = enrichedSuccessfully < requiredFullContextReviews;
    const enrichment = {
      conversations: enrichmentConversations,
      sourceMode: discovery.sourceMode,
      diagnostics: {
        requested: enrichmentRequested,
        enriched: enrichedSuccessfully,
        failed: enrichmentFailures,
        fallbackUsed: discoveryOnlyCount,
        ...(enrichmentFailureReasons.length > 0
          ? { failureReason: enrichmentFailureReasons.join(" | ").slice(0, 1_500) }
          : {}),
      },
    };

    runtimeProgress(scan).deepReview.target = new Set(enrichmentConversations.map(row => row.externalId)).size;
    // Synthetic fixture context is not an actually fetched public thread.
    runtimeProgress(scan).deepReview.threadsVerified = new Set(enrichmentConversations
      .filter(row => row.sourceMode !== "mock" && row.provenance.metadata?.enriched === true).map(row => row.externalId)).size;

    await setStage(
      scan,
      "enrichment",
      "complete",
      enrichmentDisabled
        ? `${enrichmentConversations.length} conversations retained for deep AI review using discovery evidence. Thread fetching is disabled; 0 additional threads verified.`
        : coverageLimited
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
          // Same reasoning as the triageConversations call above.
          coverageRetries: 3,
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
      runtimeProgress(scan).deepReview.completed = deepById.size;
      await persistScan(scan);
      throw new Error("Deep qualification coverage is incomplete. The scan will not convert model failure into zero customers.");
    }

    const deepRows = [...deepById.values()];
    runtimeProgress(scan).deepReview.completed = deepById.size;
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
        id: stableScanOutputId("intel", scan.id, row.externalId),
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
        replyId: qualification.shouldReply === true ? stableScanOutputId("reply", scan.id, `intel:${row.externalId}`) : undefined,
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
      const replyId = stableScanOutputId("reply", scan.id, `opportunity:${conversation.externalId}`);
      const priorState = previousStates.get(`${conversation.provider}:${conversation.externalId}`) ??
        previousStates.get(`${conversation.sourceMode === "apify-test" ? "apify-test" : conversation.provider}:${conversation.externalId}`);
      return [{
        id: stableScanOutputId("opp", scan.id, conversation.externalId),
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

    runtimeProgress(scan).results.qualifiedPeople = aggregated.summary.total;
    runtimeProgress(scan).results.relevantConversations = new Set(marketIntelligence.map(row => row.externalId)).size;
    if (scan.runConfiguration.flags.partialResults) {
      const deepExternalBySource = new Map(deepRows.map(row => [row.conversation.provenance.id, row]));
      const leadSourceIds = new Set(opportunities.map(row => row.sourceId));
      replaceQualifiedPartialResults(scan, {
        opportunities: opportunities.flatMap(record => {
          const row = deepExternalBySource.get(record.sourceId);
          return row ? [{ externalId: row.externalId, record, source: redditProvenance(row.conversation) }] : [];
        }),
        intelligence: marketIntelligence.filter(record => !leadSourceIds.has(record.sourceId)).flatMap(record => {
          const row = deepExternalBySource.get(record.sourceId);
          return row ? [{ externalId: row.externalId, record, source: redditProvenance(row.conversation) }] : [];
        }),
      });
    }
    await setStage(
      scan,
      "qualification",
      "complete",
      coverageLimited && aggregated.summary.total === 0
        ? `No verified potential customer was promoted from ${enrichedSuccessfully} full-context review${enrichedSuccessfully === 1 ? "" : "s"}. The confidence target was ${requiredFullContextReviews}, so this is a limited-coverage result rather than a definitive zero.${unverifiedQualifiedCandidates.length > 0 ? ` ${unverifiedQualifiedCandidates.length} provisional signal${unverifiedQualifiedCandidates.length === 1 ? "" : "s"} lacked full thread verification.` : ""}`
        : `${aggregated.summary.total} unique potential customer${aggregated.summary.total === 1 ? "" : "s"} identified from ${rawOpportunities.length} qualified conversation${rawOpportunities.length === 1 ? "" : "s"}; ranking was applied only after qualification.${unverifiedQualifiedCandidates.length > 0 ? ` ${unverifiedQualifiedCandidates.length} provisional signal${unverifiedQualifiedCandidates.length === 1 ? "" : "s"} lacked full thread verification and was not promoted.` : ""}`,
    );

    const fallbackInsightSet = buildFallbackInsights(opportunities);
    runtimeProgress(scan).insights = aiProvider && relevantDeepRows.length > 0 ? "active" : "complete";
    await persistScan(scan);
    // Insight decoration and reply drafting consume the same immutable,
    // evidence-gated qualification set. Start insights now; the provider's
    // shared request gate coordinates capacity with the reply queue below.
    const insightPromise = (async () => {
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
          runtimeProgress(scan).insights = "complete";
        } catch (error) {
          runtimeProgress(scan).insights = "fallback";
          console.error("OpenAI insight generation failed; using deterministic sourced insights", error);
        }
      }
      await persistScan(scan);
      return insightSet;
    })();

    await setStage(scan, "replies", "active");
    const now = new Date().toISOString();
    // Reply generation is bounded, so ordering decides which conversations get
    // a drafted reply. That has to be reply value, not lead value: the best
    // thread to answer is often not the strongest buyer.
    const replyEligible = [...opportunities]
      .filter((opportunity) => opportunity.shouldReply === true)
      .sort((left, right) => right.replyScore - left.replyScore);
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
    type ReplyTask = { strict: boolean; replyId: string; opportunityId: string;
      row: QualifiedOpportunity & { conversation: EnrichedRedditConversation }; previousContent?: string };
    const leadTasks: ReplyTask[] = replyEligible.flatMap(opportunity => {
      const row = qualifiedOpportunities.find(qualified => qualified.id === opportunity.id);
      if (!row) return [];
      const previousOpportunity = previousBySource.get(opportunity.sourceId);
      const previousReply = previousOpportunity ? previousReplies.get(previousOpportunity.id) : undefined;
      const state = previousStates.get(`${row.conversation.sourceMode === "apify-test" ? "apify-test" : row.conversation.provider}:${row.conversation.externalId}`);
      const currentContextHash = structuredContextHash(row.conversation);
      const previousContent = previousReply?.content.trim() && state && state.contentHash === row.conversation.provenance.contentHash
        && state.contextHash !== null && state.contextHash === currentContextHash ? previousReply.content : undefined;
      return [{ strict: true, replyId: opportunity.replyId, opportunityId: opportunity.id, row, previousContent }];
    });
    const relevantTasks: ReplyTask[] = relevantReplyEligible.flatMap(intelligence => {
      const source = relevantDeepRows.find(candidate => candidate.conversation.provenance.id === intelligence.sourceId);
      if (!source) return [];
      return [{ strict: false, replyId: intelligence.replyId!, opportunityId: intelligence.id,
        row: { id: intelligence.id, workspaceId: scan.workspaceId, businessId, conversation: source.conversation,
          qualification: source.qualification, classification: legacyClassificationFromDeep(source.qualification),
          rankScore: Math.max(0, Math.min(1, (intelligence.replyScore ?? 0) / 100)), status: "new" as const,
          provenanceIds: [intelligence.sourceId], discoveredAt: source.conversation.createdAt } }];
    });
    const replyTasks = [...leadTasks, ...relevantTasks];
    const replyTaskIds = new Set(replyTasks.map(task => task.replyId));
    scan.replyCheckpoint = Object.fromEntries(Object.entries(scan.replyCheckpoint ?? {}).filter(([id]) => replyTaskIds.has(id)));
    const existingReplies = new Map((await repository.listRepliesForScan(scan.id)).map(reply => [reply.id, reply]));
    const placeholder = (task: ReplyTask): ReplyRecord => ({ id: task.replyId, opportunityId: task.opportunityId,
      workspaceId: scan.workspaceId, scanId: scan.id, content: "", status: "draft", generation: 1,
      createdAt: scan.createdAt, updatedAt: scan.createdAt, publishedAt: null, publishedUrl: null,
      publishedVia: null, redditCommentId: null });
    if (scan.runConfiguration.flags.partialResults) {
      let changed = removePartialRepliesExcept(scan, replyTaskIds);
      for (const task of replyTasks) {
        const version = replyInputVersion({ business, models, conversation: task.row.conversation,
          qualification: task.row.qualification, instructions: task.row.qualification.replyAngle });
        const checkpoint = scan.replyCheckpoint[task.replyId];
        const saved = checkpoint?.inputVersion === version ? existingReplies.get(task.replyId) ?? checkpoint.reply : undefined;
        changed = publishPartialReply(scan, saved ?? placeholder(task), saved ? "ready" : "pending") || changed;
      }
      if (changed) await persistScan(scan);
    }
    let replyFailure: unknown;
    let replyDrafts: Array<ReplyRecord | null> = [];
    try { replyDrafts = await mapConcurrently(replyTasks, REPLY_GENERATION_CONCURRENCY, async (task): Promise<ReplyRecord | null> => {
      const inputVersion = replyInputVersion({ business, models, conversation: task.row.conversation,
        qualification: task.row.qualification, instructions: task.row.qualification.replyAngle });
      const checkpoint = scan.replyCheckpoint![task.replyId];
      const sameScan = checkpoint?.inputVersion === inputVersion
        ? existingReplies.get(task.replyId) ?? checkpoint.reply : undefined;
      try {
        let content = sameScan?.content.trim() ? sameScan.content : task.previousContent ?? "";
        if (!content && aiProvider) {
          const generated = await aiProvider.generateReply({ business, opportunity: task.row, models,
            instructions: task.row.qualification.replyAngle });
          usage.push(usageRecord(generated, "reply-generation"));
          content = generated.value.body.trim();
        } else if (!content && discovery.sourceMode === "mock") content = fallbackReply(profile);
        if (!content) throw new Error("A reply-eligible conversation did not produce a grounded reply.");
        const draft: ReplyRecord = sameScan?.content.trim() ? sameScan : { ...placeholder(task), content, createdAt: now, updatedAt: now };
        await repository.saveReply(draft, owner);
        scan.replyCheckpoint![task.replyId] = { inputVersion, reply: draft };
        if (scan.runConfiguration!.flags.partialResults) publishPartialReply(scan, draft, "ready");
        runtimeProgress(scan).results.repliesReady = new Set(Object.values(scan.replyCheckpoint!).map(value => value.reply.id)).size;
        await persistScan(scan);
        return draft;
      } catch (error) {
        if (scan.runConfiguration!.flags.partialResults) {
          publishPartialReply(scan, placeholder(task), "failed");
          await persistScan(scan);
        }
        if (task.strict) throw error;
        console.error("Relevant-conversation reply generation failed", error);
        return null;
      }
    }); } catch (error) { replyFailure = error; }
    const insightSet = await insightPromise;
    if (replyFailure) throw replyFailure;
    const replies = replyDrafts.filter((reply): reply is ReplyRecord => reply !== null);
    runtimeProgress(scan).results.repliesReady = new Set(replies.map(reply => reply.id)).size;
    await setStage(
      scan,
      "replies",
      "complete",
      replies.length > 0
        ? `${replies.length} complete grounded repl${replies.length === 1 ? "y" : "ies"} prepared for qualified conversations.`
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

    const redditSources: Provenance[] = deepRows.map(({ conversation }) => redditProvenance(conversation));

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
    const completedAt = new Date().toISOString();
    if (scan.timing) {
      scan.timing.firstResultAt ??= completedAt;
      if (opportunities.length > 0 || marketIntelligence.length > 0) scan.timing.firstQualifiedAt ??= completedAt;
      scan.timing.finishedAt = completedAt;
    }
    trace.milestone("scan.results_ready", { firstResult: true, completed: opportunities.length });
    scan.phase = "complete";
    if (scan.scanKind !== "monitoring") {
      scan.completionNotice ??= { version: "scan-complete-v1", createdAt: completedAt, readAt: null };
    }
    scan.updatedAt = completedAt;
    await persistScan(scan);
    if (scan.scanKind !== "monitoring") {
      // Best-effort sidecar: never fail, delay, or retry the primary scan.
      void ensureAiVisibilityTrackingStarted(scan).catch((error) => {
        console.error("Could not start AI visibility tracking.", error);
      });
    }
    await captureFunnelEvent(scan, "scan_completed");
    return scan;
  } catch (error) {
    await discoveryTriage?.stop();
    if (guard.signal.aborted || error instanceof ScanOwnershipLostError) throw new ScanOwnershipLostError();
    const message =
      error instanceof UnsafeWebsiteUrlError
        ? error.message
        : error instanceof Error
          ? error.message
          : "The scan failed unexpectedly.";
    const code = scanPipelineErrorCode(error);
    // A thrown error here does not necessarily mean the scan is done: if a
    // background job attempt is in progress and attempts remain, the job
    // queue (scripts/background-worker.mjs) is about to retry the whole
    // scan on its own schedule. Landing on "failed" in that window is
    // exactly what stopped the frontend from polling while a retry was
    // already coming -- so only do that once retries are truly exhausted or
    // the error is one retrying cannot fix.
    const jobWillRetry = jobWillRetryScanFailure({ code, jobAttempts: options.jobAttempts, jobMaxAttempts: options.jobMaxAttempts });
    scan.status = jobWillRetry ? "retrying" : "failed";
    if (!jobWillRetry) scan.phase = "failed";
    if (!jobWillRetry && scan.timing) scan.timing.finishedAt = new Date().toISOString();
    trace.milestone("scan.failure", { category: code ?? "scan_failed" });
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
    await persistScan(scan);
    throw error;
  } finally {
    await discoveryTriage?.stop();
    await guard.stop();
    scanExecutions.delete(scan);
    const succeeded = scan.status === "complete" || (options.stopAfterUnderstanding && scan.status === "queued");
    for (const finish of scanTraces.get(scan)?.stages.values() ?? []) finish(succeeded ? "succeeded" : "failed");
    finishExecution(succeeded ? "succeeded" : "failed");
    scanTraces.delete(scan);
  }
}

export function getConfiguredModelRolesForDiagnostics() {
  return openAiModelsFromEnv();
}
