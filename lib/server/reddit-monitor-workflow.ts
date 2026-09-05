import type { ConversationTriage, IntelligenceTag, RedditSearchLane } from "@/lib/domain/types";
import { dedupeMarketIntelligenceRecords } from "@/lib/intelligence/reddit-pipeline";
import { fetchRedditMonitorCandidates } from "@/lib/providers/reddit-monitor.server";
import type { RedditDiscoveryResponse } from "@/lib/providers/contracts";
import type { MarketIntelligenceRecord, RedditMonitorRunRecord, ScanRecord, ScanStage } from "@/lib/server/contracts";
import { createId } from "@/lib/server/ids";
import {
  applyRedditMonitorOutcomes,
  completeRedditMonitorRun,
  failRedditMonitorRun,
  getRedditMonitorRun,
  getRedditMonitorSettings,
  ingestRedditMonitorMatches,
  saveRedditMonitorRun,
} from "@/lib/server/reddit-monitor-repository";
import { getStateRepository } from "@/lib/server/repository";
import { runScan } from "@/lib/server/scan-workflow";
import { sharedProviderCapacity } from "@/lib/server/provider-capacity";

const MONITOR_PROGRESS: ScanStage[] = [
  { id: "website", label: "Reusing your business context", status: "pending", detail: "Using the verified business profile from your Market Scan." },
  { id: "understanding", label: "Loading monitored terms", status: "pending", detail: "Brand, competitor and keyword watches are fixed for this run." },
  { id: "discovery", label: "Checking new Reddit activity", status: "pending", detail: "Searching posts and comments in one daily monitoring run." },
  { id: "triage", label: "Reading unseen matches", status: "pending", detail: "Lexical matches must still pass the existing AI relevance gate." },
  { id: "enrichment", label: "Opening the strongest conversations", status: "pending", detail: "Fetching useful context only for candidates worth deeper review." },
  { id: "qualification", label: "Qualifying signals", status: "pending", detail: "Separating potential customers from relevant market intelligence." },
  { id: "replies", label: "Drafting a reply", status: "pending", detail: "Grounded replies are drafted only for appropriate conversations." },
];

function emptyRejectionCounts() {
  return {
    invalid_record: 0,
    invalid_url: 0,
    query_mismatch: 0,
    bot_author: 0,
    deleted: 0,
    nsfw: 0,
    missing_timestamp: 0,
    outside_window: 0,
  };
}

function checkpointFromCandidates(
  candidates: RedditDiscoveryResponse["candidates"],
  terms: string[],
  fetched: number,
): RedditDiscoveryResponse {
  const lane: RedditSearchLane = "brand_competitor_mentions";
  return {
    candidates,
    searchPlan: terms.map((term) => ({ lane, query: term, seed: term })),
    sourceMode: "apify-test",
    diagnostics: {
      queryCount: terms.length,
      fetchedCandidates: fetched,
      normalizedCandidates: candidates.length,
      verifiedRecentCandidates: candidates.length,
      rejectedByReason: emptyRejectionCounts(),
      laneQueryCounts: { [lane]: terms.length },
      degraded: false,
      queriesFailed: 0,
      queriesSucceeded: terms.length,
      retryAttempts: 0,
    },
  };
}

export function isRelevantMonitorTriage(triage: ConversationTriage): boolean {
  return triage.relevant === true &&
    triage.intent !== "irrelevant" &&
    triage.intent !== "promotional";
}

function monitorTriageTags(triage: ConversationTriage): IntelligenceTag[] {
  const tags = new Set<IntelligenceTag>(["market_insight"]);
  if (triage.demandSignal === "pain") tags.add("problem_signal");
  if (triage.demandSignal === "workaround") tags.add("workaround");
  return [...tags];
}

function monitorTriageResearchScore(triage: ConversationTriage): number {
  const fit = triage.productFit === "high"
    ? 85
    : triage.productFit === "medium"
      ? 70
      : triage.productFit === "low"
        ? 35
        : 50;
  const demandBonus = triage.demandSignal === "none" ? 0 : 10;
  const timingBonus = triage.timing === "current" || triage.timing === "near_term" ? 5 : 0;
  return Math.min(100, fit + demandBonus + timingBonus);
}

function monitoringScan(input: {
  run: RedditMonitorRunRecord;
  seed: ScanRecord;
  discovery: RedditDiscoveryResponse;
}): ScanRecord {
  const now = new Date().toISOString();
  return {
    id: createId("scan"),
    workspaceId: input.run.workspaceId,
    websiteUrl: input.seed.websiteUrl,
    status: "queued",
    progress: MONITOR_PROGRESS.map((stage) => ({ ...stage })),
    createdAt: input.run.windowEndedAt,
    updatedAt: now,
    error: null,
    errorCode: null,
    result: null,
    scanKind: "monitoring",
    monitorRunId: input.run.id,
    discoveryProfile: input.seed.discoveryProfile,
    discoveryOverrides: input.seed.discoveryOverrides,
    competitorProfiles: input.seed.competitorProfiles,
    redditDiscovery: input.discovery,
  };
}

export async function runRedditMonitorScan(monitorRunId: string): Promise<RedditMonitorRunRecord> {
  const repository = getStateRepository();
  let run = await getRedditMonitorRun(monitorRunId);
  if (!run) throw new Error("Reddit monitor run was not found.");
  if (run.status === "succeeded") return run;
  try {
    const settings = await getRedditMonitorSettings(run.workspaceId, run.seedScanId);
    if (!settings || !settings.enabled) throw new Error("Reddit monitoring is no longer enabled.");
    const seed = await repository.getScan(run.seedScanId);
    if (!seed || seed.workspaceId !== run.workspaceId || seed.status !== "complete" || !seed.discoveryProfile) {
      throw new Error("Reddit monitoring requires an owned completed Market Scan.");
    }
    const watchTerms = settings.watchTerms.filter((term) => term.active).map((term) => term.value);
    if (watchTerms.length === 0) throw new Error("Reddit monitoring has no active watch terms.");

    run = { ...run, status: "running", error: null, updatedAt: new Date().toISOString() };
    await saveRedditMonitorRun(run);
    const providerCapacity = sharedProviderCapacity();
    const fetched = await fetchRedditMonitorCandidates({
      watchTerms,
      from: new Date(run.windowStartedAt),
      to: new Date(run.windowEndedAt),
      workspaceId: run.workspaceId,
      holderKey: `reddit-monitor:${run.id}`,
      actorCapacity: providerCapacity?.capacity,
      actorCapacityLimit: providerCapacity?.configuration.apifyActorLimit,
    });
    const unseen = await ingestRedditMonitorMatches({
      workspaceId: run.workspaceId,
      runId: run.id,
      candidates: fetched.candidates,
    });
    run = {
      ...run,
      actorRunId: fetched.actorRunId,
      watchTerms,
      fetched: fetched.fetched,
      normalized: fetched.candidates.length,
      unseen: unseen.length,
      updatedAt: new Date().toISOString(),
    };
    await saveRedditMonitorRun(run);

    // A successful zero/new-duplicate-only Actor run is a valid daily check.
    // No AI work or report snapshot is created when there is nothing unseen.
    if (unseen.length === 0) {
      await completeRedditMonitorRun(run);
      return (await getRedditMonitorRun(run.id)) ?? { ...run, status: "succeeded" };
    }

    const scan = monitoringScan({
      run,
      seed,
      discovery: checkpointFromCandidates(unseen, watchTerms, fetched.fetched),
    });
    run = { ...run, scanId: scan.id, updatedAt: new Date().toISOString() };
    // The monitor run has a foreign key to runtime_scans. Persist the scan first;
    // running these writes concurrently can race and make PostgreSQL reject scan_id.
    await repository.saveScan(scan);
    await saveRedditMonitorRun(run);

    const completedScan = await runScan(scan.id, { jobAttempts: 1, jobMaxAttempts: 1 });
    if (completedScan.status !== "complete" || !completedScan.result) {
      throw new Error(completedScan.error || "Reddit monitoring analysis did not complete.");
    }
    const externalIdBySourceId = new Map(
      unseen.map((candidate) => [candidate.provenance.id, candidate.externalId]),
    );
    const opportunityIds = completedScan.result.opportunities
      .map((opportunity) => externalIdBySourceId.get(opportunity.sourceId))
      .filter((externalId): externalId is string => Boolean(externalId));

    // Daily monitoring is a relevance feed first. Every unseen candidate is
    // cheaply triaged; deep qualification remains selective and only decides
    // lead/intelligence depth. A triage-relevant post must not be relabelled
    // irrelevant merely because it was not selected for expensive enrichment.
    const deepRelevantIds = new Set(
      completedScan.result.marketIntelligence.map((item) => item.externalId),
    );
    const opportunityIdSet = new Set(opportunityIds);
    const triageRelevantStates = completedScan.result.processedRedditState.filter((state) => {
      if (!isRelevantMonitorTriage(state.triage)) return false;
      if (!state.deepQualification) return true;
      return deepRelevantIds.has(state.externalId) || opportunityIdSet.has(state.externalId);
    });
    const relevantIds = [...new Set([
      ...deepRelevantIds,
      ...opportunityIds,
      ...triageRelevantStates.map((state) => state.externalId),
    ])];

    // Surface triage-relevant, non-enriched matches as relevant conversations
    // with their real source link. They are not leads, have no reply, and make
    // no deep-qualification claim.
    const candidateByExternalId = new Map(
      unseen.map((candidate) => [candidate.externalId, candidate]),
    );
    const triageOnlyIntelligence = triageRelevantStates.flatMap((state): MarketIntelligenceRecord[] => {
      if (state.deepQualification || deepRelevantIds.has(state.externalId)) return [];
      const candidate = candidateByExternalId.get(state.externalId);
      if (!candidate) return [];
      return [{
        id: createId("intel"),
        sourceId: candidate.provenance.id,
        externalId: candidate.externalId,
        title: candidate.title ?? "Relevant Reddit conversation",
        summary: state.triage.reason,
        subreddit: candidate.subreddit,
        author: candidate.author ?? null,
        tags: monitorTriageTags(state.triage),
        demandSignals: state.triage.demandSignal === "none" ? [] : [state.triage.demandSignal],
        competitor: null,
        sourceCreatedAt: candidate.createdAt,
        sourceIds: [candidate.provenance.id],
        competitorScore: 0,
        researchScore: monitorTriageResearchScore(state.triage),
        replyScore: 0,
      }];
    });
    if (triageOnlyIntelligence.length > 0) {
      const existingSourceIds = new Set(completedScan.result.sources.map((source) => source.id));
      const triageSources = triageOnlyIntelligence.flatMap((intelligence) => {
        if (existingSourceIds.has(intelligence.sourceId)) return [];
        const candidate = candidateByExternalId.get(intelligence.externalId);
        if (!candidate) return [];
        existingSourceIds.add(intelligence.sourceId);
        return [{
          id: candidate.provenance.id,
          kind: "reddit" as const,
          url: candidate.permalink ?? candidate.provenance.url ?? "",
          title: candidate.title ?? "Relevant Reddit conversation",
          excerpt: candidate.body.slice(0, 280),
          capturedAt: candidate.provenance.observedAt,
          synthetic: candidate.sourceMode === "mock",
          provider: candidate.provider,
          sourceMode: candidate.sourceMode,
        }];
      });
      completedScan.result.marketIntelligence = dedupeMarketIntelligenceRecords([
        ...completedScan.result.marketIntelligence,
        ...triageOnlyIntelligence,
      ]);
      completedScan.result.sources = [...completedScan.result.sources, ...triageSources];
      completedScan.result.diagnostics.marketIntelligenceSignals =
        completedScan.result.marketIntelligence.length;
      completedScan.updatedAt = new Date().toISOString();
      await repository.saveScan(completedScan);
    }

    await applyRedditMonitorOutcomes({
      workspaceId: run.workspaceId,
      runId: run.id,
      reviewed: unseen.map((candidate) => candidate.externalId),
      opportunities: opportunityIds,
      relevant: relevantIds,
    });
    run = {
      ...run,
      relevant: relevantIds.length,
      opportunities: opportunityIds.length,
      updatedAt: new Date().toISOString(),
    };
    await completeRedditMonitorRun(run);
    return (await getRedditMonitorRun(run.id)) ?? { ...run, status: "succeeded" };
  } catch (error) {
    await failRedditMonitorRun(run, error);
    throw error;
  }
}
