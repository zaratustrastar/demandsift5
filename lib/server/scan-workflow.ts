import type { BusinessUnderstanding, QualifiedOpportunity } from "@/lib/domain/types";
import { identifyVerifiedCompetitorSignal } from "@/lib/intelligence/competitor-signal";
import {
  deduplicateConversations,
  isUsefulSearchPhrase,
  rankConversations,
} from "@/lib/intelligence/opportunity-ranking";
import {
  aggregatePotentialCustomers,
  normalizedRedditAuthor,
  potentialCustomerIntent,
} from "@/lib/intelligence/potential-customers";
import { createRedditProviderFromEnv } from "@/lib/providers/reddit.server";
import {
  createOpenAiProviderFromEnv,
  openAiModelsFromEnv,
  type OpenAiUsageEvent,
} from "@/lib/providers/openai.server";
import { crawlWebsite, UnsafeWebsiteUrlError } from "@/lib/security/website-crawler";
import {
  analyzeWebsiteWithOpenAi,
  configuredModelRoles,
  embedTextsWithOpenAi,
  generateRepliesWithOpenAi,
} from "./ai";
import type {
  CompetitorWeaknessRecord,
  DemandInsightRecord,
  OpportunityRecord,
  Provenance,
  ReplyRecord,
  ScanBusinessProfile,
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
    detail: "Building a source-backed product, audience and problem profile.",
  },
  {
    id: "discovery",
    label: "Searching recent Reddit conversations",
    status: "pending",
    detail: "Looking only inside the current seven-day scan window.",
  },
  {
    id: "reading",
    label: "Reading relevant posts and replies",
    status: "pending",
    detail: "Checking context, problem fit and source quality.",
  },
  {
    id: "ranking",
    label: "Identifying potential customers",
    status: "pending",
    detail: "Removing noise and deduplicating qualified people by Reddit author.",
  },
  {
    id: "competitors",
    label: "Checking competitor frustrations",
    status: "pending",
    detail: "Verifying complaints and alternative-seeking signals from their sources.",
  },
  {
    id: "replies",
    label: "Ranking the strongest opportunities",
    status: "pending",
    detail: "Ordering the best fits and preparing one source-grounded reply for each.",
  },
];

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
      const commentsIndex = segments.findIndex(
        (segment) => segment.toLowerCase() === "comments",
      );
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
    .filter(
      (title) =>
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
    targetAudience: [],
    problemsSolved: problemSentences,
    features: [...new Set(pageTitles)].slice(0, 6),
    competitors: [],
    irrelevantTopics: [],
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
  const productTerms = [profile.name, ...profile.features.slice(0, 4)].filter(isUsefulSearchPhrase);
  return {
    businessId: input.businessId,
    workspaceId: input.workspaceId,
    websiteUrl: profile.websiteUrl,
    canonicalDomain: input.canonicalDomain,
    name: cited(profile.name),
    summary: cited(profile.summary),
    productCategory: cited(profile.features[0] ?? profile.name),
    targetAudiences: cited(
      profile.targetAudience.map((audience) => ({ name: audience, description: audience, pains: [] })),
    ),
    problemsSolved: cited(profile.problemsSolved),
    features: cited(
      profile.features.map((feature) => ({ name: feature, description: feature, verified: true })),
    ),
    competitors: cited(
      profile.competitors.map((competitor) => ({
        name: competitor,
        relationship: "unknown" as const,
        verification: "website_claim" as const,
      })),
    ),
    irrelevantTopics: cited(profile.irrelevantTopics),
    productTerms: cited(productTerms),
    customerProblemLanguage: cited(profile.problemsSolved),
    version: 1,
    generatedAt: new Date().toISOString(),
  };
}

function intentFor(buyerIntent: number): OpportunityRecord["intent"] {
  if (buyerIntent >= 0.6) return "actively-looking";
  if (buyerIntent >= 0.3) return "evaluating";
  return "problem-aware";
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || left.length !== right.length) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return Math.max(0, Math.min(1, dot / Math.sqrt(leftMagnitude * rightMagnitude)));
}

function fallbackReply(profile: ScanBusinessProfile, opportunity: OpportunityRecord): string {
  const fact = profile.features[0] ?? profile.problemsSolved[0] ?? profile.summary;
  const opening =
    opportunity.intent === "actively-looking"
      ? "A practical way to narrow this down is to start with the one workflow you need to improve, then test each option against setup time, day-to-day effort, and the reporting you actually need."
      : "It helps to map the manual steps first, especially the handoffs that repeat every week, and use that as a short checklist for evaluating a better process.";
  return `${opening}\n\nFull disclosure: I work with ${profile.name}. Our public site describes ${fact}. It could be worth including in your comparison if that directly matches the problem you outlined, but I would still test it against the same checklist rather than choosing on feature count alone.`;
}

function buildInsights(
  opportunities: OpportunityRecord[],
): { insights: DemandInsightRecord[]; weakness: CompetitorWeaknessRecord } {
  const recommendationRequests = opportunities.filter(
    (opportunity) => opportunity.intent === "actively-looking" || opportunity.intent === "evaluating",
  );
  const problemAware = opportunities.filter((opportunity) =>
    /manual|spreadsheet|maintenance|scal/i.test(`${opportunity.title} ${opportunity.excerpt}`),
  );
  const competitorOpportunities = opportunities.filter(
    (opportunity) => opportunity.competitorComplaint && opportunity.competitorSignal,
  );
  const insightInputs = [
    {
      title: "Buyers are asking for practical recommendations",
      summary:
        "The strongest conversations are not passive mentions: people are actively comparing approaches and asking peers what works.",
      evidence: `${recommendationRequests.length} stored opportunities contain recommendation or evaluation intent.`,
      signal: "rising" as const,
      rows: recommendationRequests,
    },
    {
      title: "Manual work is the clearest demand language",
      summary:
        "People describe repeated handoffs, spreadsheet overhead, and maintenance burden before they describe a desired product category.",
      evidence: `${problemAware.length} stored opportunities explicitly describe manual work or a process that is no longer scaling.`,
      signal: "steady" as const,
      rows: problemAware,
    },
    {
      title: "Simple evaluation guidance can earn attention",
      summary:
        "Helpful replies that explain trade-offs can meet demand before a buyer has settled on a shortlist.",
      evidence: `${opportunities.length} qualified conversations are stored in this scan.`,
      signal: "emerging" as const,
      rows: opportunities,
    },
  ];
  const insights = insightInputs.filter((input) => input.rows.length > 0).map((input) => ({
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
        title: "A qualified competitor complaint reveals a workflow opening",
        summary:
          "A stored comparison conversation asks for a lighter option focused on the core workflow. This is one source-backed conversation signal, not a market-wide claim.",
        opportunityIds: competitorOpportunities.map((row) => row.id),
        sourceIds: competitorOpportunities.map((row) => row.sourceId),
      }
    : {
        id: createId("comp"),
        verified: false,
        competitor: null,
        title: "No verified competitor weakness in this scan",
        summary:
          "No qualified conversation contained a source-backed competitor complaint or comparison, so no competitor weakness is inferred.",
        opportunityIds: [],
        sourceIds: [],
      };
  return { insights, weakness };
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
  if (claim.state === "running") {
    return claim.scan;
  }
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
    await setStage(scan, "website", "complete", `${pages.length} public page${pages.length === 1 ? "" : "s"} read from the submitted domain.`);

    const redditProvider = createRedditProviderFromEnv({
      ...process.env,
      REDDIT_PROVIDER: process.env.REDDIT_PROVIDER?.trim() || "mock",
    });
    const requiresAiQualification = redditProvider.sourceMode !== "mock";

    await setStage(scan, "understanding", "active");
    let profile: ScanBusinessProfile;
    let discoveryCategory = "";
    let discoveryProblems: string[] = [];
    let analysisMode: ScanResult["analysisMode"] = "local-fallback";
    const usage: UsageRecord[] = [];
    try {
      const analyzed = await analyzeWebsiteWithOpenAi(crawl.canonicalUrl, pages);
      if (analyzed) {
        profile = analyzed.profile;
        discoveryCategory = analyzed.discovery.productCategory;
        discoveryProblems = analyzed.discovery.customerProblemQueries;
        usage.push(analyzed.usage);
        analysisMode = "openai";
      } else {
        if (requiresAiQualification) {
          throw new Error("AI website analysis is required when using real Reddit records.");
        }
        profile = conservativeProfile(crawl.canonicalUrl, pages);
        discoveryCategory = profile.features[0] ?? profile.name;
        discoveryProblems = profile.problemsSolved.slice(0, 4);
        usage.push({
          provider: "local",
          purpose: "website-analysis",
          model: "conservative-parser",
          inputTokens: 0,
          outputTokens: 0,
          estimatedCostUsd: 0,
        });
      }
    } catch (error) {
      console.error("OpenAI website analysis failed", error);
      if (requiresAiQualification) {
        throw new Error(
          "The configured AI provider could not build a reliable business profile. Check its API style and model settings, then retry.",
        );
      }
      profile = conservativeProfile(crawl.canonicalUrl, pages);
      discoveryCategory = profile.features[0] ?? profile.name;
      discoveryProblems = profile.problemsSolved.slice(0, 4);
      usage.push({
        provider: "local",
        purpose: "website-analysis",
        model: "conservative-parser",
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
      });
    }
    await setStage(scan, "understanding", "complete", `Built a source-backed profile for ${profile.name}.`);

    const businessId = createId("biz");
    const business = toBusinessUnderstanding({
      profile,
      workspaceId: scan.workspaceId,
      businessId,
      canonicalDomain: crawl.canonicalDomain,
    });
    await setStage(scan, "discovery", "active");
    const reddit = await redditProvider.search({
      queries: {
        productTerms: business.productTerms.value,
        productCategories: [discoveryCategory],
        customerProblems:
          discoveryProblems.length > 0
            ? discoveryProblems
            : business.customerProblemLanguage.value,
        buyerIntent: ["recommendations", "alternative", "comparing tools", "need a tool"],
        competitors: business.competitors.value.map((item) => item.name),
        excludedTerms: business.irrelevantTopics.value,
      },
      limit: 20,
      since: new Date(Date.parse(scan.createdAt) - 7 * 86_400_000).toISOString(),
    });
    const retrieval = reddit.diagnostics;
    console.info("Reddit retrieval completed", {
      scanId: scan.id,
      provider: redditProvider.name,
      sourceMode: reddit.sourceMode,
      ...(retrieval ?? {
        fetchedCandidates: reddit.conversations.length,
        verifiedRecentConversations: reddit.conversations.length,
      }),
    });
    await setStage(
      scan,
      "discovery",
      "complete",
      retrieval
        ? `${retrieval.fetchedCandidates} public candidates found; ${retrieval.locallyMatchedCandidates} matched the business before detailed review.`
        : `${reddit.conversations.length} public records found for detailed review.`,
    );

    await setStage(scan, "reading", "active");
    const deduplicated = deduplicateConversations(reddit.conversations);
    let aiClassifications: Awaited<
      ReturnType<ReturnType<typeof createOpenAiProviderFromEnv>["classifyConversations"]>
    >["value"] = [];
    if (analysisMode === "openai" && deduplicated.unique.length > 0) {
      try {
        const classificationUsage: OpenAiUsageEvent[] = [];
        const classifier = createOpenAiProviderFromEnv(process.env, {
          onUsage: (event) => {
            classificationUsage.push(event);
          },
        });
        const classified = await classifier.classifyConversations({
          business,
          conversations: deduplicated.unique,
          models: openAiModelsFromEnv(),
        });
        aiClassifications = classified.value;
        usage.push(
          ...classificationUsage.map((event) => ({
            provider: "openai" as const,
            purpose: "classification" as const,
            model: event.model,
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            estimatedCostUsd: event.estimatedCostUsd,
          })),
        );
      } catch (error) {
        console.error("OpenAI conversation classification failed", error);
        if (requiresAiQualification) {
          throw new Error(
            "The configured AI provider could not qualify the Reddit conversations. No unclassified real records were shown.",
          );
        }
      }
    }
    let semanticSimilarities: Record<string, number> | undefined;
    if (analysisMode === "openai" && deduplicated.unique.length > 0) {
      try {
        const reference = [profile.summary, ...profile.problemsSolved, ...profile.features].join("\n");
        const embedded = await embedTextsWithOpenAi([
          reference,
          ...deduplicated.unique.map(
            (conversation) =>
              `${conversation.title ?? ""}\n${conversation.body}\n${conversation.threadContext ?? ""}`,
          ),
        ]);
        if (embedded) {
          const referenceVector = embedded.vectors[0];
          semanticSimilarities = Object.fromEntries(
            deduplicated.unique.map((conversation, index) => [
              conversation.externalId,
              cosineSimilarity(referenceVector, embedded.vectors[index + 1]),
            ]),
          );
          usage.push(embedded.usage);
        }
      } catch (error) {
        console.error("OpenAI semantic matching failed; continuing without embeddings", error);
      }
    }
    const deterministicRanked = rankConversations(deduplicated.unique, business, {
      semanticSimilarities,
      minimumScore: analysisMode === "openai" ? 0 : 0.12,
      requireBusinessEvidence: analysisMode !== "openai",
      now: new Date(),
    });
    const classificationById = new Map(
      aiClassifications.map((item) => [item.externalId, item.classification]),
    );
    const ranked = deterministicRanked
      .map((row) => {
        const classified = classificationById.get(row.conversation.externalId);
        if (!classified) return row;
        const aiScore =
          classified.relevance * 0.4 +
          classified.buyerIntent * 0.25 +
          classified.customerProblem * 0.2 +
          classified.semanticSimilarity * 0.1 +
          classified.competitorComplaint * 0.05;
        return { ...row, score: row.score * 0.45 + aiScore * 0.55 };
      })
      .filter((row) => {
        const classified = classificationById.get(row.conversation.externalId);
        if (!classified) return analysisMode !== "openai";
        const hasConcreteDemandSignal =
          classified.buyerIntent >= 0.35 ||
          classified.customerProblem >= 0.5 ||
          classified.competitorComplaint >= 0.6 ||
          classified.semanticSimilarity >= 0.65;
        return (
          classified.recommendedAction !== "avoid" &&
          classified.communityRisk !== "high" &&
          classified.relevance >= 0.6 &&
          hasConcreteDemandSignal
        );
      })
      .sort((left, right) => right.score - left.score);
    await setStage(
      scan,
      "reading",
      "complete",
      ranked.length > 0
        ? `${ranked.length} records retained enough context and verified business fit to assess.`
        : retrieval && retrieval.fetchedCandidates > 0
          ? `Reviewed ${retrieval.fetchedCandidates} public candidates; none met the verified business-fit and demand threshold.`
          : "No recent public candidates were returned for the source-backed business queries.",
    );
    await setStage(scan, "ranking", "active");
    const selected = ranked.slice(0, 20);
    const redditSources: Provenance[] = selected.map(({ conversation }) => ({
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
    const rawOpportunities: OpportunityRecord[] = selected.map((row) => {
      const conversation = row.conversation;
      const ai = classificationById.get(conversation.externalId);
      const id = createId("opp");
      const replyId = createId("reply");
      const competitorEvidence = identifyVerifiedCompetitorSignal({
        conversationText: `${conversation.title ?? ""}\n${conversation.body}`,
        sourceMode: conversation.sourceMode,
        externalId: conversation.externalId,
        businessCompetitors: business.competitors.value.map((competitor) => competitor.name),
        deterministicCompetitorScore: row.components.competitorSignal,
        classifiedComplaintScore: ai?.competitorComplaint,
        classifiedCompetitor: ai?.competitorMentioned,
      });
      const competitorComplaint = competitorEvidence.verified;
      const competitorSignal = competitorEvidence.competitor;
      const qualificationScore = Math.round(
        Math.max(
          row.score,
          ai?.relevance ?? 0,
          ai?.buyerIntent ?? 0,
          ai?.customerProblem ?? 0,
          competitorComplaint ? ai?.competitorComplaint ?? 0.75 : 0,
        ) * 100,
      );
      return {
        id,
        sourceId: conversation.provenance.id,
        title: conversation.title ?? "Relevant Reddit conversation",
        excerpt: conversation.body,
        conversationContext: conversation.threadContext,
        subreddit: conversation.subreddit,
        author: conversation.author ?? "Reddit user",
        permalink: conversation.permalink ?? "",
        postedAt: conversation.createdAt,
        score: Math.round(row.score * 100),
        commentCount: conversation.metrics.comments,
        whyItMatters:
          ai?.rationale[0] ?? row.reasons[0] ?? "The conversation describes a workflow related to the verified business profile.",
        intent: intentFor(ai?.buyerIntent ?? row.components.buyerIntent),
        recommendedAction:
          ai?.recommendedAction === "reply_helpfully"
            ? "reply"
            : ai?.recommendedAction === "monitor"
            ? "monitor"
            : ai?.recommendedAction === "learn"
              ? "learn"
              : row.score >= 0.2
                ? "reply"
                : "learn",
        communityRisk:
          ai?.communityRisk === "unknown" || !ai?.communityRisk
            ? "medium"
            : ai.communityRisk,
        competitorSignal,
        competitorComplaint,
        customerProblem:
          ai?.problemSummary ??
          business.problemsSolved.value[0] ??
          "Choosing a more workable approach to the current process",
        replyId,
        synthetic: conversation.sourceMode === "mock",
        sourceMode: conversation.sourceMode,
        conversationType: conversation.kind,
        authorIdentifier: normalizedRedditAuthor(conversation.author),
        potentialCustomerIntent: potentialCustomerIntent({
          buyerIntent: ai?.buyerIntent ?? row.components.buyerIntent,
          customerProblem: ai?.customerProblem ?? row.components.problemLanguage,
          competitorComplaint,
        }),
        qualificationScore,
        firstSeenAt: scan.createdAt,
        scanId: scan.id,
        sourceCreatedAt: conversation.createdAt,
        supportingSourceIds: [conversation.provenance.id],
        supportingSignalCount: 1,
        appearedInPreviousDemandDrop: false,
        redditThingId: redditThingId(conversation),
      };
    });
    const previousScan = await repository.getLatestScan(scan.workspaceId);
    const previousMatchesBusiness = (() => {
      if (!previousScan?.result) return false;
      try {
        return new URL(previousScan.websiteUrl).hostname.toLowerCase() ===
          new URL(scan.websiteUrl).hostname.toLowerCase();
      } catch {
        return false;
      }
    })();
    const aggregated = aggregatePotentialCustomers({
      opportunities: rawOpportunities,
      previousOpportunities: previousMatchesBusiness
        ? previousScan?.result?.opportunities
        : [],
      scanId: scan.id,
      windowEndedAt: scan.createdAt,
      windowDays: 7,
    });
    // Keep labeled mock records available to the paid/demo workspace without
    // ever promoting them into the free acquisition claim. Real provider
    // scans use only the author-deduplicated, seven-day qualified set.
    const opportunities = reddit.sourceMode === "mock"
      ? rawOpportunities
      : aggregated.opportunities;
    const selectedBySourceId = new Map(selected.map((row) => [row.conversation.provenance.id, row]));
    const qualifiedOpportunities: QualifiedOpportunity[] = opportunities.flatMap((opportunity) => {
      const row = selectedBySourceId.get(opportunity.sourceId);
      if (!row) return [];
      const classified = classificationById.get(row.conversation.externalId);
      return [{
        id: opportunity.id,
        workspaceId: scan.workspaceId,
        businessId,
        conversation: row.conversation,
        classification: classified ?? {
          relevance: Math.max(row.components.productTerm, row.components.problemLanguage),
          buyerIntent: row.components.buyerIntent,
          customerProblem: row.components.problemLanguage,
          competitorComplaint: opportunity.competitorComplaint
            ? Math.max(0.75, row.components.competitorSignal)
            : 0,
          semanticSimilarity: row.components.semanticSimilarity,
          recommendedAction:
            opportunity.recommendedAction === "reply"
              ? "reply_helpfully"
              : opportunity.recommendedAction,
          communityRisk: opportunity.communityRisk,
          problemSummary: opportunity.customerProblem,
          competitorMentioned: opportunity.competitorSignal ?? undefined,
          rationale: [opportunity.whyItMatters],
        },
        rankScore: Math.max(0, Math.min(1, opportunity.score / 100)),
        status: "new",
        provenanceIds: [opportunity.sourceId],
        discoveredAt: opportunity.postedAt,
      }];
    });
    await setStage(
      scan,
      "ranking",
      "complete",
      `${aggregated.summary.total} potential customer${aggregated.summary.total === 1 ? "" : "s"} identified from ${aggregated.summary.conversationCount} source-backed conversation${aggregated.summary.conversationCount === 1 ? "" : "s"}.`,
    );

    await setStage(scan, "competitors", "active");
    const verifiedCompetitorSignal = opportunities.some(
      (opportunity) => opportunity.competitorComplaint && opportunity.competitorSignal,
    );
    await setStage(
      scan,
      "competitors",
      "complete",
      verifiedCompetitorSignal
        ? "Verified a competitor-frustration signal from the stored conversations."
        : "No source-backed competitor frustration passed the qualification threshold.",
    );

    await setStage(scan, "replies", "active");
    let generatedReplies: Map<string, string> | null = null;
    if (analysisMode === "openai") {
      try {
        const generated = await generateRepliesWithOpenAi({ profile, opportunities });
        if (generated) {
          generatedReplies = generated.replies;
          usage.push(generated.usage);
        }
      } catch (error) {
        console.error("OpenAI batch reply generation failed", error);
        if (requiresAiQualification) {
          throw new Error(
            "The configured AI provider could not prepare verified reply drafts. No generic replies were substituted.",
          );
        }
      }
    }
    if (
      requiresAiQualification &&
      opportunities.some((opportunity) => !generatedReplies?.get(opportunity.id)?.trim())
    ) {
      throw new Error(
        "The configured AI provider returned an incomplete reply batch. No generic replies were substituted.",
      );
    }
    const now = new Date().toISOString();
    const replies: ReplyRecord[] = opportunities.map((opportunity) => {
      const reply: ReplyRecord = {
        id: opportunity.replyId,
        opportunityId: opportunity.id,
        workspaceId: scan.workspaceId,
        scanId: scan.id,
        content: generatedReplies?.get(opportunity.id) ?? fallbackReply(profile, opportunity),
        status: "draft",
        generation: 1,
        createdAt: now,
        updatedAt: now,
        publishedAt: null,
        publishedUrl: null,
        publishedVia: null,
        redditCommentId: null,
      };
      return reply;
    });
    await Promise.all(replies.map((reply) => repository.saveReply(reply)));
    await setStage(scan, "replies", "complete", `${replies.length} editable reply drafts prepared.`);
    const fallbackInsightSet = buildInsights(opportunities);
    let insightSet = fallbackInsightSet;
    if (analysisMode === "openai" && qualifiedOpportunities.length > 0) {
      try {
        const insightProvider = createOpenAiProviderFromEnv();
        const generated = await insightProvider.generateInsights({
          business,
          opportunities: qualifiedOpportunities,
          models: openAiModelsFromEnv(),
        });
        usage.push({
          provider: "openai",
          purpose: "insight-generation",
          model: generated.model,
          inputTokens: generated.usage.inputTokens,
          outputTokens: generated.usage.outputTokens,
          estimatedCostUsd: generated.estimatedCostUsd,
        });

        const generatedInsights = generated.value.demandInsights.flatMap((insight) => {
          const sourceIds = [...new Set(insight.provenanceIds)];
          const matched = opportunities.filter((opportunity) =>
            sourceIds.includes(opportunity.sourceId),
          );
          if (matched.length === 0) return [];
          return [{
            id: createId("ins"),
            title: insight.title,
            summary: insight.summary,
            evidence: insight.implication,
            signal:
              insight.confidence >= 0.75
                ? "rising" as const
                : insight.confidence >= 0.5
                  ? "steady" as const
                  : "emerging" as const,
            opportunityIds: matched.map((opportunity) => opportunity.id),
            sourceIds,
          }];
        });
        const combinedInsights = [
          ...generatedInsights,
          ...fallbackInsightSet.insights.filter(
            (fallback) => !generatedInsights.some((generatedInsight) => generatedInsight.title === fallback.title),
          ),
        ].slice(0, 3);
        const generatedCompetitor = generated.value.competitorSignals.find((signal) =>
          opportunities.some(
            (opportunity) =>
              opportunity.competitorComplaint &&
              opportunity.competitorSignal &&
              signal.provenanceIds.includes(opportunity.sourceId),
          ),
        );
        const generatedCompetitorOpportunity = generatedCompetitor
          ? opportunities.find(
              (opportunity) =>
                opportunity.competitorComplaint &&
                opportunity.competitorSignal &&
                generatedCompetitor.provenanceIds.includes(opportunity.sourceId),
            )
          : undefined;
        const weakness = generatedCompetitor
          ? {
              id: createId("comp"),
              verified: true,
              competitor:
                generatedCompetitorOpportunity?.competitorSignal ??
                fallbackInsightSet.weakness.competitor,
              title: generatedCompetitor.signal,
              summary: generatedCompetitor.customerImpact,
              opportunityIds: opportunities
                .filter((opportunity) =>
                  generatedCompetitor.provenanceIds.includes(opportunity.sourceId),
                )
                .map((opportunity) => opportunity.id),
              sourceIds: [...new Set(generatedCompetitor.provenanceIds)],
            }
          : fallbackInsightSet.weakness;
        insightSet = { insights: combinedInsights, weakness };
      } catch (error) {
        console.error("OpenAI insight generation failed; using deterministic sourced insights", error);
      }
    }
    scan.result = {
      profile,
      insights: insightSet.insights,
      competitorWeakness: insightSet.weakness,
      opportunities,
      potentialCustomers: aggregated.summary,
      replies,
      sources: [...websiteSources, ...redditSources],
      usage,
      analysisMode,
      dataMode: reddit.sourceMode,
      dataNotice:
        reddit.sourceMode === "mock"
          ? "Website evidence was fetched from the submitted domain. Reddit conversations are synthetic mock-provider records, clearly labeled and never represented as live Reddit activity."
          : reddit.sourceMode === "apify-test"
            ? "Website evidence came from the submitted domain. Reddit records are real public records retrieved by an Apify web-scraping actor for internal MVP testing. This is not an approved production Reddit API integration."
            : "Website evidence and Reddit records came from their identified approved live providers.",
      retrievalDiagnostics: retrieval
        ? {
            provider: redditProvider.name,
            ...retrieval,
            qualifiedOpportunities: opportunities.length,
          }
        : undefined,
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
  return configuredModelRoles();
}
