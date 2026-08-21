import { redditDemandDemoData } from "./demo-data";
import type {
  ConfidenceLevel,
  LockedStoredResult,
  NavigationSection,
  RedditDemandDemoData,
  RedditOpportunity,
  ScanEvidence,
} from "./types";

type ApiSource = {
  id: string;
  kind: "website" | "reddit" | "user_supplied";
  url: string;
  title: string;
  excerpt: string;
  capturedAt: string;
  synthetic: boolean;
  provider?: string;
  sourceMode?: "mock" | "live" | "apify-test";
};

type ApiProfile = {
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

type ApiInsight = {
  id: string;
  title: string;
  summary: string;
  evidence: string;
  signal: "rising" | "steady" | "emerging";
  opportunityIds: string[];
  sourceIds: string[];
  evidenceScope?: "single-conversation" | "recurring-pattern";
  sourceCount?: number;
};

type ApiRelevantConversation = {
  id: string;
  title: string;
  summary: string;
  subreddit: string;
  author: string | null;
  permalink: string | null;
  postedAt: string;
  tags: string[];
  demandSignals: string[];
  competitor: string | null;
  sourceIds: string[];
  provider: string;
  dataMode: "mock" | "live" | "apify-test";
  replyId?: string | null;
  reliabilityScore?: number;
};

type ApiOpportunity = {
  id: string;
  title: string;
  excerpt: string;
  subreddit: string;
  author: string;
  permalink: string | null;
  postedAt: string;
  commentCount: number;
  relevanceScore?: number;
  whyItMatters: string;
  intent: "actively-looking" | "evaluating" | "problem-aware";
  recommendedAction: "reply" | "monitor" | "learn";
  communityRisk: "low" | "medium" | "high";
  competitorSignal: string | null;
  customerProblem: string;
  replyId: string;
  sourceIds: string[];
  dataMode: "mock" | "live" | "apify-test";
  canReplyOnReddit: boolean;
  conversationType: "post" | "comment";
  potentialCustomerIntent: "high_intent" | "competitor_switching" | "problem_aware" | null;
  qualificationScore: number;
  firstSeenAt: string;
  sourceCreatedAt: string;
  supportingSourceIds: string[];
  supportingSignalCount: number;
  appearedInPreviousDemandDrop: boolean;
  mentionProduct: boolean;
  disclosureRequired: boolean;
};

type ApiReply = {
  id: string;
  opportunityId: string;
  content: string;
  status: "draft" | "published";
  version: number;
  updatedAt: string;
  publishedAt: string | null;
  publishedUrl: string | null;
  publishedVia: "manual" | "reddit" | null;
  redditCommentId: string | null;
};

type ApiReport = {
  profile: ApiProfile;
  insights: ApiInsight[];
  relevantConversations?: ApiRelevantConversation[];
  conversationThemes?: Array<{
    id: string;
    label: string;
    kind: "struggle" | "request";
    conversationCount: number;
    sourceIds: string[];
  }>;
  competitorWeakness: {
    id: string;
    verified: boolean;
    competitor: string | null;
    title: string;
    summary: string;
    opportunityIds: string[];
    sourceIds: string[];
  };
  opportunities: ApiOpportunity[];
  potentialCustomers: {
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
  qualificationCoverage?: {
    credibleCandidates: number;
    fullContextReviewed: number;
    requiredFullContextReviews?: number;
    limited?: boolean;
  };
  scanEvidence?: ScanEvidence;
  lockedOpportunityPreviews: Array<{
    id: string;
    subreddit: string;
    postedAt: string;
    conversationType: "post" | "comment";
    potentialCustomerIntent: "high_intent" | "competitor_switching" | "problem_aware" | null;
    supportingSignalCount: number;
    hasSuggestedReply: boolean;
    dataMode: "mock" | "live" | "apify-test";
  }>;
  replies: ApiReply[];
  sources: ApiSource[];
  dataMode: "mock" | "live" | "apify-test";
  dataNotice: string;
  analysisMode: "openai" | "local-fallback";
  storedCounts: {
    opportunities: number;
    relevantConversations?: number;
    insights: number;
    competitorSignals: number;
    replies: number;
  };
  additionalLockedCounts: {
    opportunities: number;
    relevantConversations?: number;
    insights: number;
    competitorSignals: number;
    replies: number;
  };
  resultTotals: {
    clicks: number;
    conversions: number;
    valueCents: number;
  };
};

export type ApiScanResponse = {
  scan: {
    id: string;
    /**
     * "retrying" mirrors lib/server/contracts.ts's ScanRecord.status: the
     * pipeline hit an error, but a background job attempt is still
     * scheduled to try again. Treat it like "running" -- keep polling, do
     * not show an error screen.
     */
    status: "queued" | "running" | "retrying" | "complete" | "failed";
    websiteUrl: string;
    /** Absent on scans created before this field existed; treat as "website". */
    inputMode?: "website" | "context";
    contextText?: string | null;
    progress: Array<{
      id: string;
      label: string;
      detail: string;
      status: "pending" | "active" | "complete" | "failed";
    }>;
    createdAt: string;
    updatedAt: string;
    error: string | null;
    errorCode?: string | null;
  };
  access : {
    plan: "free" | "pass" | "core";
    status: string;
    unlocked: boolean;
    verifiedByWebhook: boolean;
  };
  report: ApiReport | null;
  error?: { code: string; message: string };
};

function confidence(signal: ApiInsight["signal"]): ConfidenceLevel {
  if (signal === "rising") return "high";
  if (signal === "emerging") return "medium";
  return "medium";
}

function intent(value: ApiOpportunity["intent"]): "high" | "medium" | "low" {
  if (value === "actively-looking") return "high";
  if (value === "evaluating") return "medium";
  return "low";
}

function redditProviderLabel(dataMode: ApiReport["dataMode"]): string {
  if (dataMode === "mock") return "mock-reddit-provider";
  if (dataMode === "apify-test") return "apify-reddit-test";
  return "approved-reddit-provider";
}

function sourceEvidenceLabel(source: ApiSource, dataMode: ApiReport["dataMode"]): string {
  if (source.kind === "website") return "Verified business website evidence";
  if (source.kind === "user_supplied") return "Business context you provided";
  if (dataMode === "mock") return "Mock provider evidence";
  if (dataMode === "apify-test") return "Public Reddit evidence via Apify test source";
  return "Public conversation evidence";
}

function lockedRecords(report: ApiReport): LockedStoredResult[] {
  return (report.lockedOpportunityPreviews ?? []).map((record) => ({
    id: record.id,
    kind: "opportunity" as const,
    headline: "",
    sourceLabel: record.dataMode === "apify-test" ? "Apify test source" : "Public Reddit source",
    capturedAt: record.postedAt,
    provider: redditProviderLabel(record.dataMode),
    isMock: record.dataMode === "mock",
    hasSuggestedReply: record.hasSuggestedReply,
    potentialCustomerIntent: record.potentialCustomerIntent,
    subreddit: record.subreddit.startsWith("r/") ? record.subreddit : `r/${record.subreddit}`,
    conversationType: record.conversationType,
    supportingSignalCount: record.supportingSignalCount,
  }));
}

export function scanResponseToDashboard(response: ApiScanResponse): RedditDemandDemoData | null {
  const report = response.report;
  if (!report || response.scan.status !== "complete") return null;
  const hostname = new URL(report.profile.websiteUrl).hostname.replace(/^www\./, "");
  const replyByOpportunity = new Map(report.replies.map((reply) => [reply.opportunityId, reply]));
  const sourceById = new Map(report.sources.map((source) => [source.id, source]));
  const factIds = [
    "profile-summary",
    "profile-audience",
    "profile-problems",
    "profile-features",
    "profile-competitors",
  ];

  const opportunities: RedditOpportunity[] = report.opportunities.map((opportunity) => {
    const reply = replyByOpportunity.get(opportunity.id);
    const mock = opportunity.dataMode === "mock";
    return {
      id: opportunity.id,
      provider: redditProviderLabel(opportunity.dataMode),
      isMock: mock,
      conversationType: opportunity.conversationType,
      subreddit: opportunity.subreddit.startsWith("r/")
        ? opportunity.subreddit
        : `r/${opportunity.subreddit}`,
      authorLabel: opportunity.author,
      title: opportunity.title,
      excerpt: opportunity.excerpt,
      capturedAt: opportunity.postedAt,
      permalink: opportunity.permalink,
      canReplyOnReddit: opportunity.canReplyOnReddit,
      potentialCustomerIntent: opportunity.potentialCustomerIntent,
      qualificationScore: opportunity.qualificationScore,
      firstSeenAt: opportunity.firstSeenAt,
      sourceCreatedAt: opportunity.sourceCreatedAt,
      supportingSignalCount: opportunity.supportingSignalCount,
      supportingSourceIds: opportunity.supportingSourceIds,
      appearedInPreviousDemandDrop: opportunity.appearedInPreviousDemandDrop,
      mentionProduct: opportunity.mentionProduct,
      disclosureRequired: opportunity.disclosureRequired,
      matchReasons: [opportunity.customerProblem, opportunity.whyItMatters].filter(Boolean),
      classification: {
        relevanceScore: opportunity.relevanceScore ?? 0,
        buyerIntent: intent(opportunity.intent),
        customerProblem: opportunity.customerProblem,
        competitorComplaint: Boolean(opportunity.competitorSignal),
        recommendedAction:
          opportunity.recommendedAction === "reply"
            ? "Answer the question first, then disclose the business connection when relevant"
            : opportunity.recommendedAction === "monitor"
              ? "Monitor for a clearer request before joining"
              : "Use this conversation to improve the business understanding",
        communityRisk: opportunity.communityRisk,
      },
      reply: {
        id: reply?.id ?? opportunity.replyId,
        opportunityId: opportunity.id,
        status: reply?.status ?? "draft",
        draft:
          reply?.content ??
          "This reply is stored but hidden in the free Market Scan. Unlocking does not publish it.",
        alternateDrafts: [],
        disclosure: opportunity.disclosureRequired
          ? "Disclose the business connection because this reply mentions the product."
          : "No disclosure is needed while the reply remains product-neutral.",
        verifiedClaims: report.profile.features,
        sourceFactIds: factIds,
        provenanceIds: [...report.profile.sourceIds, ...opportunity.sourceIds],
        publishedVia: reply?.publishedVia ?? null,
        publishedUrl: reply?.publishedUrl ?? null,
      },
      provenanceIds: opportunity.sourceIds,
    };
  });

  const lockedResults = lockedRecords(report);
  const lockedCounts = {
    opportunities: report.additionalLockedCounts.opportunities,
    relevantConversations: report.additionalLockedCounts.relevantConversations ?? 0,
    insights: report.additionalLockedCounts.insights,
    competitorSignals: report.additionalLockedCounts.competitorSignals,
    visibilityOpportunities: 0,
    replies: report.additionalLockedCounts.replies,
    readyReplies: report.additionalLockedCounts.replies,
  };
  const navigation: NavigationSection[] = redditDemandDemoData.navigation.map((item) => ({
    ...item,
    badge:
      item.id === "opportunities"
        ? report.storedCounts.opportunities
        : item.id === "insights"
          ? report.storedCounts.insights + (report.storedCounts.relevantConversations ?? 0)
          : item.id === "competitors"
            ? report.storedCounts.competitorSignals
            : item.id === "replies"
              ? report.storedCounts.replies
              : item.badge,
  }));

  return {
    fixtureLabel:
      report.dataMode === "mock"
        ? "Live website analysis · mock Reddit provider"
        : report.dataMode === "apify-test"
          ? "Live website analysis » real Apify Reddit test data"
          : "Live website and approved-provider analysis",
    fixtureDisclosure:
      report.dataMode === "mock"
        ? "Business facts below come from the submitted public website. Reddit records are clearly marked, generated mock-provider fixtures with no invented permalinks. No customer, traffic or ranking claim is implied."
        : report.dataMode === "apify-test"
          ? "Reddit records are real public records retrieved by a community-maintained Apify web-scraping actor for MVP testing. This source is not an approved production Reddit API integration. No traffic, ranking or customer claim is implied."
          : "Business facts and public conversations retain their source provenance. No traffic, ranking or customer claim is shown without a supporting provider.",
    generatedAt: response.scan.updatedAt,
    business: {
      name: report.profile.name,
      url: report.profile.websiteUrl,
      hostname,
      isFictionalDemoBusiness: false,
      oneLineSummary: report.profile.summary,
      productCategory: "Website-derived business profile",
      targetAudience: report.profile.targetAudience,
      problemsSolved: report.profile.problemsSolved,
      features: report.profile.features,
      competitors: report.profile.competitors,
      irrelevantTopics: report.profile.irrelevantTopics,
      facts: [
        { id: factIds[0], label: "Summary", value: report.profile.summary, provenanceIds: report.profile.sourceIds },
        { id: factIds[1], label: "Audience", value: report.profile.targetAudience.join(" · ") || "Not confidently identified", provenanceIds: report.profile.sourceIds },
        { id: factIds[2], label: "Problems", value: report.profile.problemsSolved.join(" · ") || "Not confidently identified", provenanceIds: report.profile.sourceIds },
        { id: factIds[3], label: "Features", value: report.profile.features.join(" · ") || "Not confidently identified", provenanceIds: report.profile.sourceIds },
        { id: factIds[4], label: "Competitors", value: report.profile.competitors.join(" · ") || "No competitor verified", provenanceIds: report.profile.sourceIds },
      ],
      analyzedPageCount: report.sources.filter((source) => source.kind === "website").length,
      analyzedAt: response.scan.updatedAt,
    },
    provenance: report.sources.map((source) => ({
      id: source.id,
      kind:
        source.kind === "website"
          ? "website-page"
          : source.kind === "user_supplied"
            ? "user-action"
            : "reddit-conversation",
      title: source.title,
      provider:
        source.provider ??
        (source.kind === "website"
          ? "same-domain crawler"
          : source.kind === "user_supplied"
            ? "your description"
            : redditProviderLabel(source.sourceMode ?? report.dataMode)),
      url: source.url || null,
      retrievedAt: source.capturedAt,
      excerpt: source.excerpt,
      isMock: source.synthetic,
      verifiedWithinDemoFixture:
        source.kind === "website" || source.kind === "user_supplied" || (source.sourceMode ?? report.dataMode) === "live",
    })),
    relevantConversations: (report.relevantConversations ?? []).map((conversation) => {
      const reply = conversation.replyId ? replyByOpportunity.get(conversation.id) : undefined;
      return {
        id: conversation.id,
        provider: conversation.provider,
        isMock: conversation.dataMode === "mock",
        title: conversation.title,
        summary: conversation.summary,
        subreddit: conversation.subreddit.startsWith("r/")
          ? conversation.subreddit
          : `r/${conversation.subreddit}`,
        authorLabel: conversation.author ?? "Reddit participant",
        capturedAt: conversation.postedAt,
        permalink: conversation.permalink,
        tags: conversation.tags,
        demandSignals: conversation.demandSignals,
        competitorName: conversation.competitor,
        provenanceIds: conversation.sourceIds,
        reliabilityScore: conversation.reliabilityScore ?? 0,
        // Independent of lead status: present only when this relevant
        // conversation was classified reply-suitable and a grounded reply was
        // drafted for it. Never counted as a potential customer.
        reply: conversation.replyId
          ? {
              id: reply?.id ?? conversation.replyId,
              opportunityId: conversation.id,
              status: reply?.status ?? "draft",
              draft:
                reply?.content ??
                "This reply is stored but hidden in the free Market Scan. Unlocking does not publish it.",
              alternateDrafts: [],
              disclosure: "Review before posting; disclose the business connection if the reply mentions the product.",
              verifiedClaims: [],
              sourceFactIds: [],
              provenanceIds: conversation.sourceIds,
              publishedVia: reply?.publishedVia ?? null,
              publishedUrl: reply?.publishedUrl ?? null,
            }
          : undefined,
      };
    }),
    // Themes resolve their sourceIds against the relevant corpus so each one can
    // link the actual conversations behind it. A theme whose evidence cannot be
    // resolved is dropped rather than shown as an unbacked claim.
    conversationThemes: (report.conversationThemes ?? []).flatMap((theme) => {
      const evidence = theme.sourceIds.flatMap((sourceId) => {
        const conversation = (report.relevantConversations ?? []).find((row) =>
          row.sourceIds.includes(sourceId),
        );
        if (!conversation) return [];
        return [{
          sourceId,
          title: conversation.title,
          subreddit: conversation.subreddit,
          permalink: conversation.permalink ?? "",
        }];
      });
      if (evidence.length === 0) return [];
      return [{
        id: theme.id,
        label: theme.label,
        kind: theme.kind,
        // Report only what can be shown, so the count always matches evidence.
        conversationCount: evidence.length,
        evidence,
      }];
    }),
    insights: report.insights.map((insight) => {
      const sourceCount = insight.sourceCount ?? new Set(insight.sourceIds).size;
      const evidenceScope = insight.evidenceScope ??
        (sourceCount >= 2 ? "recurring-pattern" : "single-conversation");
      return {
        id: insight.id,
        eyebrow: evidenceScope === "recurring-pattern"
          ? String(sourceCount) + "-conversation demand pattern"
          : "Single-conversation demand signal",
        title: insight.title,
        summary: insight.summary,
        evidence: [...new Set(insight.sourceIds)].slice(0, 2).flatMap((sourceId) => {
          const source = sourceById.get(sourceId);
          return source
            ? [{
                quote: source.excerpt,
                sourceLabel: sourceEvidenceLabel(source, report.dataMode),
                provenanceId: sourceId,
                sourceUrl: source.url || null,
              }]
            : [];
        }),
        whyItMatters: insight.summary,
        recommendedAction: "Use the underlying question to guide a useful answer and product messaging.",
        signalStrength: evidenceScope === "single-conversation"
          ? "medium"
          : confidence(insight.signal),
        opportunityIds: insight.opportunityIds,
        provenanceIds: insight.sourceIds,
        evidenceScope,
        sourceCount,
      };
    }),
    competitorWeaknesses: [
      {
        id: report.competitorWeakness.id,
        verified: report.competitorWeakness.verified,
        competitorName: report.competitorWeakness.competitor,
        competitorIsFictionalDemo: report.dataMode === "mock",
        headline: report.competitorWeakness.title,
        summary: report.competitorWeakness.summary,
        evidence: report.competitorWeakness.sourceIds.slice(0, 2).flatMap((sourceId) => {
          const source = sourceById.get(sourceId);
          return source
            ? [{
                quote: source.excerpt,
                sourceLabel: sourceEvidenceLabel(source, report.dataMode),
                provenanceId: sourceId,
                sourceUrl: source.url || null,
              }]
            : [];
        }),
        recommendedAction: "Address the workflow gap directly without attacking or overstating the competitor.",
        signalStrength: "medium",
        opportunityIds: report.competitorWeakness.opportunityIds,
        provenanceIds: report.competitorWeakness.sourceIds,
      },
    ],
    opportunities,
    potentialCustomers: report.potentialCustomers ?? {
      total: report.storedCounts.opportunities,
      conversationCount: report.storedCounts.opportunities,
      windowDays: 7,
      windowStartedAt: response.scan.createdAt,
      windowEndedAt: response.scan.updatedAt,
      breakdown: {
        highIntent: opportunities.filter((item) => item.classification.buyerIntent === "high").length,
        competitorSwitching: opportunities.filter(
          (item) => item.classification.buyerIntent !== "high" && item.classification.competitorComplaint,
        ).length,
        problemAware: opportunities.filter(
          (item) => item.classification.buyerIntent !== "high" && !item.classification.competitorComplaint,
        ).length,
      },
      newSincePreviousDemandDrop: report.storedCounts.opportunities,
    },
    qualificationCoverage: report.qualificationCoverage,
    scanEvidence: report.scanEvidence,
    lockedResults,
    lockedCounts,
    metrics: {
      qualifiedOpportunities: report.storedCounts.opportunities,
      highIntentOpportunities:
        report.potentialCustomers?.breakdown.highIntent ??
        opportunities.filter((item) => item.classification.buyerIntent === "high").length,
      readyReplies: report.storedCounts.replies,
      competitorSignals: report.storedCounts.competitorSignals,
      publishedReplies: report.replies.filter((reply) => reply.status === "published").length,
      trackedClicks: report.resultTotals.clicks,
      trackedConversions: report.resultTotals.conversions,
    },
    navigation,
    analysisProgress: response.scan.progress,
    visibilityOpportunities: [],
    pricing: redditDemandDemoData.pricing,
  };
}
