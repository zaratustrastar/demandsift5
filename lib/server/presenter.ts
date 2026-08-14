import type { OpportunityRecord, ReplyRecord, ScanRecord } from "./contracts";
import { entitlementCoversWebsite, normalizedBusinessHostname } from "./business-access";
import { ApiError } from "./http";
import { getEffectiveEntitlement, getStateRepository } from "./repository";
import { summarizeTrackedResults } from "./result-totals";

export { entitlementCoversWebsite, normalizedBusinessHostname } from "./business-access";

async function isUnlocked(workspaceId: string, websiteUrl: string): Promise<boolean> {
  const entitlement = await getEffectiveEntitlement(workspaceId);
  return entitlementCoversWebsite(entitlement, websiteUrl);
}

function publicOpportunity(opportunity: OpportunityRecord) {
  return {
    id: opportunity.id,
    title: opportunity.title,
    excerpt: opportunity.excerpt,
    subreddit: opportunity.subreddit,
    author: opportunity.author,
    permalink: opportunity.permalink || null,
    postedAt: opportunity.postedAt,
    relevanceScore: opportunity.score,
    commentCount: opportunity.commentCount,
    whyItMatters: opportunity.whyItMatters,
    intent: opportunity.intent,
    recommendedAction: opportunity.recommendedAction,
    communityRisk: opportunity.communityRisk,
    competitorSignal: opportunity.competitorSignal,
    customerProblem: opportunity.customerProblem,
    replyId: opportunity.replyId,
    sourceIds: [opportunity.sourceId],
    dataMode: opportunity.sourceMode ?? (opportunity.synthetic ? "mock" : "live"),
    canReplyOnReddit: Boolean(
      opportunity.shouldReply !== false &&
      opportunity.redditThingId &&
      opportunity.permalink &&
      !opportunity.synthetic
    ),
    conversationType: opportunity.conversationType ?? "post",
    potentialCustomerIntent: opportunity.potentialCustomerIntent ?? null,
    qualificationScore: opportunity.qualificationScore ?? opportunity.score,
    firstSeenAt: opportunity.firstSeenAt ?? opportunity.postedAt,
    scanId: opportunity.scanId,
    sourceCreatedAt: opportunity.sourceCreatedAt ?? opportunity.postedAt,
    supportingSourceIds: opportunity.supportingSourceIds ?? [opportunity.sourceId],
    supportingSignalCount: opportunity.supportingSignalCount ?? 1,
    appearedInPreviousDemandDrop: opportunity.appearedInPreviousDemandDrop ?? false,
    mentionProduct: opportunity.mentionProduct === true,
    disclosureRequired: opportunity.disclosureRequired === true,
  };
}

function publicReply(reply: ReplyRecord) {
  return {
    id: reply.id,
    opportunityId: reply.opportunityId,
    content: reply.content,
    status: reply.status,
    version: reply.generation,
    updatedAt: reply.updatedAt,
    publishedAt: reply.publishedAt,
    publishedUrl: reply.publishedUrl,
    publishedVia: reply.publishedVia ?? null,
    redditCommentId: reply.redditCommentId ?? null,
  };
}

export async function presentAccess(workspaceId: string, websiteUrl?: string) {
  const entitlement = await getEffectiveEntitlement(workspaceId);
  const hasPinnedPaidAccess = Boolean(
    entitlement.status === "active" &&
    entitlement.plan !== "free" &&
    entitlement.verifiedByEventId &&
    entitlement.seedScanId &&
    normalizedBusinessHostname(entitlement.websiteUrl),
  );
  const unlocked = websiteUrl
    ? entitlementCoversWebsite(entitlement, websiteUrl)
    : hasPinnedPaidAccess;
  return {
    plan: entitlement.plan,
    status: entitlement.status,
    unlocked,
    accessUntil: entitlement.accessUntil,
    businessWebsiteUrl: entitlement.websiteUrl,
    seedScanId: entitlement.seedScanId,
    verifiedByWebhook: Boolean(entitlement.verifiedByEventId),
    capabilities: {
      allExistingFindings: unlocked,
      allSuggestedReplies: unlocked,
      sevenDayMonitoring: unlocked,
      continuousMonitoring: unlocked && entitlement.plan === "core",
      resultsTracking: unlocked && entitlement.plan === "core",
    },
  };
}

function freeVisibleOpportunities(
  opportunities: OpportunityRecord[],
  generatedReplies: ReplyRecord[],
): OpportunityRecord[] {
  const previewReply = generatedReplies[0];
  if (!previewReply) return opportunities.slice(0, 3);
  const replyOpportunity = opportunities.find((row) => row.id === previewReply.opportunityId);
  if (!replyOpportunity) return opportunities.slice(0, 3);
  return [
    replyOpportunity,
    ...opportunities.filter((row) => row.id !== replyOpportunity.id),
  ].slice(0, 3);
}

export async function presentScan(scan: ScanRecord) {
  const access = await presentAccess(scan.workspaceId, scan.websiteUrl);
  const result = scan.result;
  if (!result) {
    return {
      scan: {
        id: scan.id,
        status: scan.status,
        websiteUrl: scan.websiteUrl,
        progress: scan.progress,
        createdAt: scan.createdAt,
        updatedAt: scan.updatedAt,
        error: scan.error,
      },
      access,
      report: null,
    };
  }

  const fullAccess = access.unlocked;
  const repository = getStateRepository();
  const candidateResults = access.capabilities.resultsTracking
    ? await repository.listConversions(scan.workspaceId)
    : [];
  const trackedResults = (
    await Promise.all(candidateResults.map(async (row) => ({
      row,
      sourceScan: await repository.getScan(row.scanId),
    })))
  )
    .filter(({ sourceScan }) =>
      Boolean(
        sourceScan &&
        normalizedBusinessHostname(sourceScan.websiteUrl) ===
          normalizedBusinessHostname(scan.websiteUrl),
      ))
    .map(({ row }) => row);

  const resultTotals = summarizeTrackedResults(trackedResults);

  const persistedReplies = await repository.listRepliesForScan(scan.id);
  const persistedById = new Map(persistedReplies.map((reply) => [reply.id, reply]));
  const latestReplies = result.replies.map((reply) => persistedById.get(reply.id) ?? reply);
  const generatedReplies = latestReplies.filter((reply) => reply.content.trim().length > 0);
  const generatedByOpportunity = new Map(generatedReplies.map((reply) => [reply.opportunityId, reply]));

  const competitorSignalCount = result.competitorWeakness.verified ? 1 : 0;
  const visibleOpportunities = fullAccess
    ? result.opportunities
    : freeVisibleOpportunities(result.opportunities, generatedReplies);
  const visibleOpportunityIds = new Set(visibleOpportunities.map((opportunity) => opportunity.id));
  const lockedOpportunities = fullAccess
    ? []
    : result.opportunities.filter((opportunity) => !visibleOpportunityIds.has(opportunity.id));
  const visibleReplies = fullAccess
    ? latestReplies
    : generatedReplies.filter((reply) => visibleOpportunityIds.has(reply.opportunityId)).slice(0, 1);
  const visibleGeneratedReplyIds = new Set(
    visibleReplies.filter((reply) => reply.content.trim()).map((reply) => reply.id),
  );
  const visibleInsights = fullAccess ? result.insights : result.insights.slice(0, 2);
  const visibleSourceIds = new Set([
    ...result.profile.sourceIds,
    ...visibleOpportunities.flatMap((opportunity) =>
      opportunity.supportingSourceIds ?? [opportunity.sourceId],
    ),
    ...visibleInsights.flatMap((insight) => insight.sourceIds),
    ...result.competitorWeakness.sourceIds,
  ]);

  return {
    scan: {
      id: scan.id,
      status: scan.status,
      websiteUrl: scan.websiteUrl,
      progress: scan.progress,
      createdAt: scan.createdAt,
      updatedAt: scan.updatedAt,
      error: scan.error,
    },
    access,
    report: {
      profile: result.profile,
      insights: visibleInsights,
      competitorWeakness: result.competitorWeakness,
      opportunities: visibleOpportunities.map(publicOpportunity),
      potentialCustomers: result.potentialCustomers ?? {
        total: result.opportunities.length,
        conversationCount: result.opportunities.length,
        windowDays: 7,
        windowStartedAt: new Date(Date.parse(scan.createdAt) - 7 * 86_400_000).toISOString(),
        windowEndedAt: scan.createdAt,
        breakdown: {
          highIntent: result.opportunities.filter((row) => row.intent === "actively-looking").length,
          competitorSwitching: result.opportunities.filter(
            (row) => row.intent !== "actively-looking" && row.competitorComplaint,
          ).length,
          problemAware: result.opportunities.filter(
            (row) => row.intent !== "actively-looking" && !row.competitorComplaint,
          ).length,
        },
        newSincePreviousDemandDrop: result.opportunities.length,
      },
      qualificationCoverage: {
        credibleCandidates: result.diagnostics.deterministicSurvivors,
        fullContextReviewed:
          result.diagnostics.submittedForDeepQualification + result.diagnostics.reusedUnchanged,
      },
      lockedOpportunityPreviews: lockedOpportunities.map((opportunity) => ({
        id: opportunity.id,
        subreddit: opportunity.subreddit,
        postedAt: opportunity.postedAt,
        conversationType: opportunity.conversationType ?? "post",
        potentialCustomerIntent: opportunity.potentialCustomerIntent ?? null,
        supportingSignalCount: opportunity.supportingSignalCount ?? 1,
        hasSuggestedReply: Boolean(generatedByOpportunity.get(opportunity.id)?.content.trim()),
        dataMode: opportunity.sourceMode ?? (opportunity.synthetic ? "mock" : "live"),
      })),
      replies: visibleReplies.map(publicReply),
      sources: result.sources.filter((source) => visibleSourceIds.has(source.id)),
      dataMode: result.dataMode,
      dataNotice: result.dataNotice,
      analysisMode: result.analysisMode,
      storedCounts: {
        opportunities: result.opportunities.length,
        insights: result.insights.length,
        competitorSignals: competitorSignalCount,
        replies: generatedReplies.length,
      },
      additionalLockedCounts: fullAccess
        ? { opportunities: 0, insights: 0, competitorSignals: 0, replies: 0 }
        : {
            opportunities: Math.max(0, result.opportunities.length - visibleOpportunityIds.size),
            insights: Math.max(0, result.insights.length - visibleInsights.length),
            competitorSignals: 0,
            replies: Math.max(0, generatedReplies.length - visibleGeneratedReplyIds.size),
          },
      resultTotals,
    },
    pricing: {
      marketScan: { amountCents: 0, label: "Personalized Market Scan" },
      pass: {
        amountCents: Number(process.env.STRIPE_PASS_AMOUNT_CENTS ?? 1200),
        interval: "one_time",
        accessDays: 7,
        label: "Full Access Pass",
        tax: "exclusive",
      },
      core: {
        amountCents: Number(process.env.STRIPE_CORE_AMOUNT_CENTS ?? 3000),
        interval: "month",
        label: "Core",
        tax: "exclusive",
      },
    },
  };
}

export async function requireOwnedScan(workspaceId: string, scanId: string): Promise<ScanRecord> {
  const scan = await getStateRepository().getScan(scanId);
  if (!scan || scan.workspaceId !== workspaceId) {
    throw new ApiError("Scan was not found.", 404, "scan_not_found");
  }
  return scan;
}

export async function requireAccessibleReply(workspaceId: string, replyId: string): Promise<{
  scan: ScanRecord;
  reply: ReplyRecord;
  opportunity: OpportunityRecord;
}> {
  const reply = await getStateRepository().getReply(replyId);
  if (!reply || reply.workspaceId !== workspaceId) {
    throw new ApiError("Reply was not found.", 404, "reply_not_found");
  }
  const scan = await requireOwnedScan(workspaceId, reply.scanId);
  const opportunity = scan.result?.opportunities.find((item) => item.id === reply.opportunityId);
  if (!opportunity || !scan.result) {
    throw new ApiError("Reply source was not found.", 404, "opportunity_not_found");
  }
  const previewReplyId = scan.result.replies.find((row) => row.content.trim())?.id;
  if (!(await isUnlocked(workspaceId, scan.websiteUrl)) && reply.id !== previewReplyId) {
    throw new ApiError(
      "This reply is included with the Full Access Pass or Core plan.",
      402,
      "upgrade_required",
    );
  }
  return { scan, reply, opportunity };
}

export function presentReply(reply: ReplyRecord) {
  return publicReply(reply);
}
