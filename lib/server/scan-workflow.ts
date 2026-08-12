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
  legacyClassificationFromDeep,
  opportunityRankScore,
  potentialCustomerIntentFromQualification,
  selectCandidatesForEnrichment,
} from "@/lib/intelligence/reddit-pipeline";
import { contentFingerprint, isUsefulSearchPhrase } from "@/lib/intelligence/opportunity-ranking";
import { aggregatePotentialCustomers, normalizedRedditAuthor } from "@/lib/intelligence/potential-customers";
import { createRedditProviderFromEnv } from "@/lib/providers/reddit.server";
import { createOpenAiProviderFromEnv, openAiModelsFromEnv } from "@/lib/providers/openai.server";
import { crawlWebsite, UnsafeWebsiteUrlError } from "@/lib/security/website-crawler";
import type {
  CompetitorWeaknessRecord,
  DemandInsightRecord,
  MarketIntelligenceRecord,
  OpportunityRecord,
  ProcessedRedditState,
  Provenance,
  ReplyRecord,
  ScanBusinessProfile,
  ScanDiagnostics,
  ScanRecord,
  ScanResult,
  ScanStage,
  UsageRecord,
} from "./contracts";
import { captureFunnelEvent } from "./funnel";
import { ApiError } from "./http";
import { createId } from "./ids";
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
  const insights = inputs.filter((input) => input.rows.length > 0).map((input) => ({
    id: createId("ins"),
    title: input.title,
    summary: input.summary,
    evidence: input.evidence,
    signal: input.signal,
    opportunityIds: input.rows.map((row) => row.id),
    sourceIds: input.rows.map((row) => row.sourceId),
  }));
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

function enrichmentBudget(): number {
  const value = Number(process.env.REDDIT_ENRICHMENT_BUDGET ?? process.env.APIFY_REDDIT_ENRICHMENT_LIMIT ?? 8);
  return Number.isFinite(value) ? Math.max(1, Math.min(Math.trunc(value), 20)) : 8;
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

export async function runScan(scanId: string): Promise<ScanRecord> {
  const repository = getStateRepository();
  const claim = await repository.beginScanRun(scanId);
  if (claim.state === "missing" || !claim.scan) {
    throw new ApiError("Scan was not found.", 404, "scan_not_found");
  }
  if (claim.state === "complete") return claim.scan;
  if (claim.state === "running") return claim.scan;
  const scan = claim.scan;

  try {
    await setStage(scan, "website", "active");
    const crawl = await crawlWebsite(scan.websiteUrl, { maxPages: 4 });
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
    if (aiProvider) {
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
    await setStage(scan, "understanding", "complete", `Built a source-backed context pack for ${profile.name}.`);

    const since = new Date(Date.parse(scan.createdAt) - 7 * 86_400_000).toISOString();
    await setStage(scan, "discovery", "active");
    const discovery = await redditProvider.discover({
      queries: {
        productTerms: business.productTerms.value,
        brandTerms: business.brandTerms.value,
        productCategories: [business.productCategory.value],
        customerProblems:
          business.customerProblemLanguage.value.length > 0
            ? business.customerProblemLanguage.value
            : business.problemsSolved.value,
        jobsToBeDone: business.jobsToBeDone?.value ?? [],
        workarounds: business.likelyWorkarounds?.value ?? [],
        triggerEvents: business.triggerEvents?.value ?? [],
        buyerIntent: ["recommendations", "alternative", "comparing tools", "need a tool"],
        competitors: business.competitors.value
          .filter(
            (competitor) =>
              competitor.verification !== "unverified_hypothesis" &&
              (competitor.relationship === "direct" || competitor.relationship === "alternative"),
          )
          .map((competitor) => competitor.name),
        excludedTerms: business.irrelevantTopics.value,
        ambiguityRisks: business.ambiguityRisks.value,
      },
      limit: 25,
      since,
    });
    const cleaned = cleanDiscoveryCandidates({
      candidates: discovery.candidates,
      business,
      since,
      now: new Date(scan.createdAt),
    });
    await setStage(
      scan,
      "discovery",
      "complete",
      `${discovery.diagnostics.fetchedCandidates} public candidates retrieved; ${cleaned.survivors.length} credible recent records remained after deterministic cleaning.`,
    );

    const previousScan = await repository.getLatestScan(scan.workspaceId);
    const previousResult = previousScan?.result && sameWebsite(previousScan.websiteUrl, scan.websiteUrl)
      ? previousScan.result
      : null;
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
    const triageById = new Map<string, ConversationTriage>();
    let reusedUnchanged = 0;
    let reusedTriageOnly = 0;
    const needsTriage: RedditDiscoveryCandidate[] = [];

    for (const candidate of cleaned.survivors) {
      const previous = previousStates.get(`${candidate.provider}:${candidate.externalId}`);
      if (previous && previous.contentHash === candidate.provenance.contentHash) {
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

    if (cleaned.survivors.some((candidate) => !triageById.has(candidate.externalId))) {
      throw new Error("Triage coverage is incomplete. The scan will not report a valid zero-result outcome.");
    }
    const worthEnriching = cleaned.survivors.filter(
      (candidate) => triageById.get(candidate.externalId)?.worthEnriching,
    );
    await setStage(
      scan,
      "triage",
      "complete",
      `${cleaned.survivors.length} of ${cleaned.survivors.length} credible candidates were accounted for; ${worthEnriching.length} warranted full-context review.`,
    );

    await setStage(scan, "enrichment", "active");
    const selectedForEnrichment = selectCandidatesForEnrichment({
      candidates: worthEnriching,
      triageById,
      budget: enrichmentBudget(),
    });
    const enrichment = await redditProvider.enrich({
      candidates: selectedForEnrichment,
      maxComments: Number(process.env.APIFY_REDDIT_ENRICHMENT_COMMENTS ?? 6),
    });
    if (selectedForEnrichment.length > 0 && enrichment.conversations.length === 0) {
      const failed = Math.max(enrichment.diagnostics.failed, selectedForEnrichment.length);
      const technicalReason = enrichment.diagnostics.failureReason
        ? ` Technical reason: ${enrichment.diagnostics.failureReason}`
        : "";
      throw new ApiError(
        `Reddit enrichment failed: selected ${selectedForEnrichment.length}, enriched 0, failed ${failed}.${technicalReason}`,
        502,
        "reddit_enrichment_failed",
      );
    }
    await setStage(
      scan,
      "enrichment",
      "complete",
      `${enrichment.diagnostics.enriched} conversation${enrichment.diagnostics.enriched === 1 ? "" : "s"} enriched; ${enrichment.diagnostics.failed} failure${enrichment.diagnostics.failed === 1 ? "" : "s"} recorded.`,
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

      if (sourceUnchanged && contextUnchanged && previous?.deepQualification) {
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
    const marketIntelligence: MarketIntelligenceRecord[] = deepRows.flatMap((row) => {
      const qualification = row.qualification;
      const demandSignals = qualification.demandSignals.filter((signal) => signal !== "none");
      if (qualification.intelligenceTags.length === 0 && demandSignals.length === 0) return [];
      return [{
        id: createId("intel"),
        sourceId: row.conversation.provenance.id,
        externalId: row.externalId,
        title: row.conversation.title ?? "Reddit conversation signal",
        summary: qualification.whyItMatters,
        subreddit: row.conversation.subreddit,
        author: row.conversation.author ?? null,
        tags: qualification.intelligenceTags,
        demandSignals,
        competitor: qualification.competitorMentioned ?? null,
        sourceCreatedAt: row.conversation.createdAt,
        sourceIds: [row.conversation.provenance.id],
      }];
    });

    const rawOpportunities: OpportunityRecord[] = deepRows.flatMap((row) => {
      const { conversation, qualification } = row;
      if (qualification.leadStatus !== "potential_customer") return [];
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
        commentCount: conversation.metrics.comments,
        whyItMatters: qualification.whyItMatters,
        intent: intentForQualification(qualification),
        recommendedAction: qualification.shouldReply ? "reply" : "monitor",
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
      windowDays: 7,
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
      `${aggregated.summary.total} unique potential customer${aggregated.summary.total === 1 ? "" : "s"} identified from ${rawOpportunities.length} qualified conversation${rawOpportunities.length === 1 ? "" : "s"}; ranking was applied only after qualification.`,
    );

    const fallbackInsightSet = buildFallbackInsights(opportunities);
    let insightSet = fallbackInsightSet;
    if (aiProvider && deepRows.length > 0) {
      try {
        const generated = await aiProvider.generateInsights({
          business,
          opportunities: qualifiedOpportunities,
          evidenceConversations: deepRows,
          models,
        });
        usage.push(usageRecord(generated, "insight-generation"));
        const generatedInsights: DemandInsightRecord[] = generated.value.demandInsights.map((insight) => ({
          id: createId("ins"),
          title: insight.title,
          summary: insight.summary,
          evidence: insight.implication,
          signal: insight.confidence >= 0.75 ? "rising" : insight.confidence >= 0.5 ? "steady" : "emerging",
          opportunityIds: opportunities
            .filter((opportunity) => insight.provenanceIds.includes(opportunity.sourceId))
            .map((opportunity) => opportunity.id),
          sourceIds: [...new Set(insight.provenanceIds)],
        }));
        const combinedInsights = [
          ...generatedInsights,
          ...fallbackInsightSet.insights.filter((fallback) =>
            !generatedInsights.some((generatedInsight) => generatedInsight.title === fallback.title),
          ),
        ].slice(0, 3);

        const generatedCompetitor = generated.value.competitorSignals.find((signal) =>
          deepRows.some((row) =>
            signal.provenanceIds.includes(row.conversation.provenance.id) &&
            row.qualification.intelligenceTags.includes("competitor_intelligence") &&
            Boolean(row.qualification.competitorMentioned),
          ),
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
              sourceIds: [...new Set(generatedCompetitor.provenanceIds)],
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
    const replyEligible = [...opportunities]
      .filter((opportunity) => opportunity.shouldReply === true)
      .sort((left, right) => right.score - left.score);
    const strongest = replyEligible[0];

    if (strongest) {
      const row = qualifiedOpportunities.find((opportunity) => opportunity.id === strongest.id);
      let content = "";
      const previousOpportunity = previousBySource.get(strongest.sourceId);
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
        throw new Error("The strongest reply-eligible opportunity did not produce a grounded reply.");
      }
      replies.push({
        id: strongest.replyId,
        opportunityId: strongest.id,
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

    // Create empty placeholders only for additional reply-eligible paid results.
    // They make lazy/on-demand generation possible without pretending a draft exists.
    for (const opportunity of replyEligible.slice(1)) {
      replies.push({
        id: opportunity.replyId,
        opportunityId: opportunity.id,
        workspaceId: scan.workspaceId,
        scanId: scan.id,
        content: "",
        status: "draft",
        generation: 0,
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
      strongest ? "One complete grounded reply prepared for the strongest appropriate opportunity." : "No conversation was appropriate for reply generation in this scan.",
    );

    const generatedReplyIds = new Set(replies.filter((reply) => reply.content.trim()).map((reply) => reply.opportunityId));
    const processedRedditState: ProcessedRedditState[] = cleaned.survivors.map((candidate) => {
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
      reusedUnchanged,
      reusedTriageOnly,
      submittedForTriage: needsTriage.length,
      triageReturned,
      triageMissing: 0,
      triageDuplicateIds: 0,
      triageUnknownIds: 0,
      worthEnriching: worthEnriching.length,
      requestedForEnrichment: enrichment.diagnostics.requested,
      enrichedSuccessfully: enrichment.diagnostics.enriched,
      enrichmentFailures: enrichment.diagnostics.failed,
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
    return scan;
  } catch (error) {
    scan.status = "failed";
    scan.error =
      error instanceof UnsafeWebsiteUrlError
        ? error.message
        : error instanceof Error
          ? error.message
          : "The scan failed unexpectedly.";
    scan.progress = scan.progress.map((stage) =>
      stage.status === "active" ? { ...stage, status: "failed" as const, detail: scan.error ?? stage.detail } : stage,
    );
    scan.updatedAt = new Date().toISOString();
    await repository.saveScan(scan);
    throw error;
  }
}

export function getConfiguredModelRolesForDiagnostics() {
  return openAiModelsFromEnv();
}
