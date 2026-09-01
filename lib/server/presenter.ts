import { candidateReliabilityScore, dedupeMarketIntelligenceRecords } from "@/lib/intelligence/reddit-pipeline";
import type { EntitlementRecord, MarketIntelligenceRecord, OpportunityRecord, Provenance, ReplyRecord, ScanRecord } from "./contracts";
import { entitlementCoversWebsite, normalizedBusinessHostname } from "./business-access";
import { ApiError } from "./http";
import { getEffectiveEntitlement, getStateRepository } from "./repository";
import { summarizeTrackedResults } from "./result-totals";
import { scanPhase } from "./scan-lifecycle";
import { refreshRuntimeProgress } from "./scan-progress";
import type { ScanPartialResults } from "./partial-results";

export function presentScanLifecycle(scan: ScanRecord) {
  return { phase: scanPhase(scan), analysisReady: !!scan.discoveryProfile && scan.discoveryProfile.profileStage !== "fast",
    runtimeProgress: refreshRuntimeProgress(scan),
    durable: !!scan.durableJob && getStateRepository().kind === "postgres",
    completionNotice: scan.completionNotice ?? null,
    approvedProfile: scan.discoveryProfile ? {
      name: scan.discoveryProfile.profile.name,
      summary: scan.discoveryProfile.profile.summary,
      targetAudience: scan.discoveryProfile.profile.targetAudience,
      problemsSolved: scan.discoveryProfile.profile.problemsSolved,
    } : null };
}

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

function publicRelevantConversation(
  intelligence: MarketIntelligenceRecord,
  source: Provenance | undefined,
) {
  const dataMode = source?.sourceMode ?? (source?.synthetic ? "mock" : "live");
  return {
    id: intelligence.id,
    externalId: intelligence.externalId,
    title: intelligence.title,
    summary: intelligence.summary,
    subreddit: intelligence.subreddit,
    author: intelligence.author,
    permalink: source?.url || null,
    postedAt: intelligence.sourceCreatedAt,
    tags: intelligence.tags,
    demandSignals: intelligence.demandSignals,
    competitor: intelligence.competitor,
    sourceIds: intelligence.sourceIds,
    provider: source?.provider ?? "reddit",
    dataMode,
    replyId: intelligence.replyId ?? null,
    // Same 0-100 scale as an opportunity's classification.relevanceScore, so
    // the frontend can merge opportunities and relevant-but-not-lead
    // conversations into one carousel ordered by a single reliability axis
    // instead of two separately-sorted lists.
    reliabilityScore: Math.max(0, Math.min(100, Math.round(intelligence.researchScore ?? 0))),
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

// websiteUrl kept in the signature so every call site keeps working
// unchanged while the TEMPORARY FULL ACCESS OVERRIDE below is in effect.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function presentAccess(workspaceId: string, websiteUrl?: string) {
  const entitlement = await getEffectiveEntitlement(workspaceId);
  // TEMPORARY FULL ACCESS OVERRIDE (2026-08-24) -- see entitlementCoversWebsite's
  // doc comment in business-access.ts for why. `unlocked` and `plan` are
  // hardcoded to the highest tier for every workspace here too, since a
  // "core"-unlocked-but-plan-reported-as-"free" response would leave the
  // frontend's effectiveAccessLevel() (ThreadlineExperience.tsx) reading
  // "free" anyway. Real per-workspace fields (status/accessUntil/
  // businessWebsiteUrl/seedScanId/verifiedByWebhook) are left truthful for
  // debugging -- only the gate itself is bypassed. Revert by restoring the
  // real hasPinnedPaidAccess/unlocked/plan computation below.
  const unlocked = true;
  const plan: EntitlementRecord["plan"] = "core";
  return {
    plan,
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
      continuousMonitoring: unlocked && plan === "core",
      resultsTracking: unlocked && plan === "core",
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

/** Applies the same opportunity/reply/relevant-conversation visibility rules
 * as presentScan. Raw checkpoints and internal fingerprints never leave. */
export function presentPartialResults(store: ScanPartialResults | null, access: Awaited<ReturnType<typeof presentAccess>>, afterVersion = 0) {
  if (!store) return { schemaVersion: 1 as const, version: 0, updatedAt: null, snapshot: true as const,
    complete: false as const, previews: [], opportunities: [], relevantConversations: [], replies: [], replyStates: [], sources: [], tombstones: [],
    foundSoFar: { reviewedCandidates: 0, qualifiedPeople: 0, relevantConversations: 0, repliesReady: 0 } };
  const qualified = Object.values(store.qualified);
  const previews = Object.values(store.previews);
  const opportunities = qualified.flatMap(row => row.kind === "potential_customer" && row.opportunity ? [row.opportunity] : []);
  const relevant = qualified.flatMap(row => row.kind === "relevant_conversation" && row.intelligence ? [row] : []);
  const replies = Object.values(store.replies).filter(row => row.state === "ready" && row.reply.content.trim()).map(row => row.reply);
  const visibleOpportunities = access.unlocked ? opportunities : freeVisibleOpportunities(opportunities, replies);
  const visibleOpportunityIds = new Set(visibleOpportunities.map(row => row.id));
  const visibleRelevant = access.unlocked ? relevant : relevant.slice(0, 3);
  const visibleTargetIds = new Set([...visibleOpportunityIds, ...visibleRelevant.map(row => row.intelligence!.id)]);
  const visibleReplies = access.unlocked ? replies : replies.filter(row => visibleOpportunityIds.has(row.opportunityId)).slice(0, 1);
  const visibleSourceIds = new Set([
    ...visibleOpportunities.map(row => row.sourceId),
    ...visibleRelevant.flatMap(row => row.intelligence!.sourceIds),
  ]);
  const sources = qualified.filter(row => visibleSourceIds.has(row.source.id))
    .map(row => row.source).filter((row, index, rows) => rows.findIndex(value => value.id === row.id) === index);
  return {
    schemaVersion: store.schemaVersion,
    version: store.version,
    updatedAt: store.updatedAt,
    snapshot: true as const,
    complete: false as const,
    previews: (access.unlocked ? previews : previews.slice(0, 3))
      .map(row => Object.fromEntries(Object.entries(row).filter(([key]) => key !== "fingerprint"))),
    opportunities: visibleOpportunities.map(opportunity => ({ ...publicOpportunity(opportunity),
      outputVersion: store.qualified[opportunity.id]?.version ?? store.version })),
    relevantConversations: visibleRelevant.map(row => ({ ...publicRelevantConversation(row.intelligence!, row.source),
      outputVersion: row.version })),
    replies: visibleReplies.map(reply => ({ ...publicReply(reply), outputVersion: store.replies[reply.id]?.version ?? store.version })),
    replyStates: Object.values(store.replies).filter(row => visibleTargetIds.has(row.reply.opportunityId))
      .map(row => ({ id: row.id, opportunityId: row.reply.opportunityId,
      state: row.state, outputVersion: row.version, ...(row.safeErrorCode ? { safeErrorCode: row.safeErrorCode } : {}) })),
    sources,
    tombstones: store.tombstones.filter(row => row.version > afterVersion),
    // These are observations, not final totals. Qualification/coverage may
    // still replace or remove records before completion.
    foundSoFar: {
      reviewedCandidates: Object.keys(store.previews).length,
      qualifiedPeople: new Set(opportunities.map(row => row.authorIdentifier).filter(Boolean)).size,
      relevantConversations: relevant.length,
      repliesReady: replies.length,
    },
  };
}

export async function presentScan(scan: ScanRecord) {
  const access = await presentAccess(scan.workspaceId, scan.websiteUrl);
  const result = scan.result;
  if (!result) {
    return {
      scan: {
        ...presentScanLifecycle(scan),
        id: scan.id,
        status: scan.status,
        websiteUrl: scan.websiteUrl,
        inputMode: scan.inputMode ?? "website",
        contextText: scan.contextText ?? null,
        progress: scan.progress,
        createdAt: scan.createdAt,
        updatedAt: scan.updatedAt,
        error: scan.error,
        errorCode: scan.errorCode ?? null,
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
  const leadSourceIds = new Set(result.opportunities.map((opportunity) => opportunity.sourceId));
  // Competitor intelligence ranks by competitor value; the rest of the relevant
  // corpus ranks by research value. Neither uses lead value.
  const relevantConversations = dedupeMarketIntelligenceRecords(
    result.marketIntelligence.filter(
      (conversation) => !leadSourceIds.has(conversation.sourceId),
    ),
  ).sort((left, right) => {
    // A named competitor makes a conversation competitor intelligence first;
    // everything else ranks by research value.
    const leftKey = left.competitor ? (left.competitorScore ?? 0) + 1_000 : (left.researchScore ?? 0);
    const rightKey = right.competitor ? (right.competitorScore ?? 0) + 1_000 : (right.researchScore ?? 0);
    return rightKey - leftKey;
  });
  const visibleRelevantConversations = fullAccess
    ? relevantConversations
    : relevantConversations.slice(0, 3);
  const redditSourceById = new Map(
    result.sources.filter((source) => source.kind === "reddit").map((source) => [source.id, source]),
  );
  const visibleSourceIds = new Set([
    ...result.profile.sourceIds,
    ...visibleOpportunities.flatMap((opportunity) =>
      opportunity.supportingSourceIds ?? [opportunity.sourceId],
    ),
    ...visibleInsights.flatMap((insight) => insight.sourceIds),
    ...visibleRelevantConversations.flatMap((conversation) => conversation.sourceIds),
    ...result.competitorWeakness.sourceIds,
  ]);

  return {
    scan: {
      ...presentScanLifecycle(scan),
      id: scan.id,
      status: scan.status,
      websiteUrl: scan.websiteUrl,
      inputMode: scan.inputMode ?? "website",
      contextText: scan.contextText ?? null,
      progress: scan.progress,
      createdAt: scan.createdAt,
      updatedAt: scan.updatedAt,
      error: scan.error,
      errorCode: scan.errorCode ?? null,
    },
    access,
    report: {
      profile: result.profile,
      insights: visibleInsights,
      // Themes are aggregations over the relevant corpus. Older stored results
      // predate them, so an absent field is an empty list rather than an error.
      conversationThemes: (result.conversationThemes ?? []).filter(
        (theme) => theme.sourceIds.length > 0,
      ),
      relevantConversations: visibleRelevantConversations.map((conversation) =>
        publicRelevantConversation(conversation, redditSourceById.get(conversation.sourceId))
      ),
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
        // Only provider-confirmed thread enrichment counts as context coverage.
        // Discovery-only fallbacks may still be classified internally, but are
        // never presented to the user as full-context review.
        fullContextReviewed: result.diagnostics.enrichedSuccessfully,
        requiredFullContextReviews: result.diagnostics.requiredFullContextReviews ?? 0,
        limited: result.diagnostics.coverageLimited ?? false,
      },
      // MVP transparency: expose every credible candidate that reached AI triage,
      // its exact public Reddit destination, search attribution, and decisions.
      // This is intentionally not paywalled while retrieval/qualification quality
      // is being validated. Raw provider-invalid records remain counts only.
      scanEvidence: {
        searchPlan: result.retrievalDiagnostics?.searchPlan ?? [],
        diagnostics: result.diagnostics,
        candidates: result.processedRedditState.map((state) => ({
          externalId: state.externalId,
          title: state.title,
          excerpt: state.excerpt,
          subreddit: state.subreddit,
          author: state.author,
          permalink: state.canonicalPermalink,
          sourceCreatedAt: state.sourceCreatedAt,
          matchedQueries: state.matchedQueries,
          discoveryLanes: state.discoveryLanes,
          fullContextVerified:
            state.threadContextVerified ?? Boolean(state.contextHash && state.deepQualification),
          triage: state.triage,
          deepQualification: state.deepQualification,
          reliabilityScore: candidateReliabilityScore({
            triage: state.triage,
            deepQualification: state.deepQualification,
          }),
        })),
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
        relevantConversations: relevantConversations.length,
        insights: result.insights.length,
        competitorSignals: competitorSignalCount,
        replies: generatedReplies.length,
      },
      additionalLockedCounts: fullAccess
        ? { opportunities: 0, relevantConversations: 0, insights: 0, competitorSignals: 0, replies: 0 }
        : {
            opportunities: Math.max(0, result.opportunities.length - visibleOpportunityIds.size),
            relevantConversations: Math.max(
              0,
              relevantConversations.length - visibleRelevantConversations.length,
            ),
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
