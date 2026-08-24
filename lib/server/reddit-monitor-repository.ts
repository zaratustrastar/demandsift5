import { and, desc, eq } from "drizzle-orm";

import { getDb } from "@/db";
import {
  backgroundJobs,
  runtimeRedditMonitorMatches,
  runtimeRedditMonitorRuns,
  runtimeRedditMonitors,
} from "@/db/postgres/schema";
import type { RedditDiscoveryCandidate } from "@/lib/domain/types";
import { REDDIT_MONITOR_LIMITS } from "@/lib/intelligence/reddit-monitor-limits";
import type {
  RedditMonitorRunRecord,
  RedditMonitorSettingsRecord,
  RedditWatchTerm,
  ScanRecord,
} from "@/lib/server/contracts";
import { createId } from "@/lib/server/ids";
import { isProductionRuntime } from "@/lib/server/runtime-env";

const memorySettings = new Map<string, RedditMonitorSettingsRecord>();
const memoryRuns = new Map<string, RedditMonitorRunRecord>();
const memoryMatches = new Map<string, RedditDiscoveryCandidate>();

function isMemoryStore(): boolean {
  const configured = process.env.STATE_STORE?.trim().toLocaleLowerCase("en-US");
  return configured === "memory" || (!process.env.DATABASE_URL && !isProductionRuntime());
}

function settingsFromRow(row: typeof runtimeRedditMonitors.$inferSelect): RedditMonitorSettingsRecord {
  return {
    workspaceId: row.workspaceId,
    seedScanId: row.seedScanId,
    websiteUrl: row.websiteUrl,
    enabled: row.enabled,
    watchTerms: row.watchTerms,
    lastSuccessfulMonitorAt: row.lastSuccessfulMonitorAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt.toISOString(),
    lastRunId: row.lastRunId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function runFromRow(row: typeof runtimeRedditMonitorRuns.$inferSelect): RedditMonitorRunRecord {
  return {
    ...row.record,
    id: row.id,
    workspaceId: row.workspaceId,
    seedScanId: row.seedScanId,
    scanId: row.scanId,
    status: row.status as RedditMonitorRunRecord["status"],
    windowStartedAt: row.windowStartedAt.toISOString(),
    windowEndedAt: row.windowEndedAt.toISOString(),
    actorRunId: row.actorRunId,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function normalizedWatchTermRecords(terms: readonly RedditWatchTerm[]): RedditWatchTerm[] {
  const seen = new Set<string>();
  const result: RedditWatchTerm[] = [];
  for (const item of terms) {
    const value = item.value.replace(/\s+/gu, " ").trim().slice(0, 120);
    const key = value.toLocaleLowerCase("en-US");
    if (value.length < 2 || seen.has(key)) continue;
    seen.add(key);
    result.push({
      value,
      kind: item.kind === "brand" || item.kind === "competitor" ? item.kind : "keyword",
      active: item.active !== false,
    });
    if (result.length >= REDDIT_MONITOR_LIMITS.maxWatchTerms) break;
  }
  return result;
}

export function defaultWatchTerms(scan: ScanRecord): RedditWatchTerm[] {
  const business = scan.discoveryProfile?.business;
  if (!business) return [];
  const terms: RedditWatchTerm[] = [
    ...business.brandTerms.value.map((value) => ({ value, kind: "brand" as const, active: true })),
    ...business.competitors.value
      .filter((competitor) => competitor.verification !== "unverified_hypothesis")
      .map((competitor) => ({ value: competitor.name, kind: "competitor" as const, active: true })),
    ...business.productTerms.value.map((value) => ({ value, kind: "keyword" as const, active: true })),
    ...business.customerProblemLanguage.value.slice(0, 8).map((value) => ({
      value,
      kind: "keyword" as const,
      active: true,
    })),
  ];
  return normalizedWatchTermRecords(terms);
}

export async function getRedditMonitorSettings(workspaceId: string) {
  if (isMemoryStore()) return memorySettings.get(workspaceId) ?? null;
  const [row] = await getDb()
    .select()
    .from(runtimeRedditMonitors)
    .where(eq(runtimeRedditMonitors.workspaceId, workspaceId))
    .limit(1);
  return row ? settingsFromRow(row) : null;
}

export async function saveRedditMonitorSettings(input: {
  workspaceId: string;
  seedScanId: string;
  websiteUrl: string;
  enabled: boolean;
  watchTerms: RedditWatchTerm[];
}): Promise<RedditMonitorSettingsRecord> {
  const now = new Date();
  const watchTerms = normalizedWatchTermRecords(input.watchTerms);
  if (input.enabled && watchTerms.every((term) => !term.active)) {
    throw new Error("Enable at least one Reddit watch term before turning monitoring on.");
  }
  if (isMemoryStore()) {
    const existing = memorySettings.get(input.workspaceId);
    const record: RedditMonitorSettingsRecord = {
      workspaceId: input.workspaceId,
      seedScanId: input.seedScanId,
      websiteUrl: input.websiteUrl,
      enabled: input.enabled,
      watchTerms,
      lastSuccessfulMonitorAt: existing?.lastSuccessfulMonitorAt ?? null,
      nextRunAt: input.enabled && !existing?.enabled ? now.toISOString() : existing?.nextRunAt ?? now.toISOString(),
      lastRunId: existing?.lastRunId ?? null,
      createdAt: existing?.createdAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
    };
    memorySettings.set(input.workspaceId, record);
    return record;
  }
  const existing = await getRedditMonitorSettings(input.workspaceId);
  const nextRunAt = input.enabled && !existing?.enabled
    ? now
    : new Date(existing?.nextRunAt ?? now.toISOString());
  const [row] = await getDb()
    .insert(runtimeRedditMonitors)
    .values({
      workspaceId: input.workspaceId,
      seedScanId: input.seedScanId,
      websiteUrl: input.websiteUrl,
      enabled: input.enabled,
      watchTerms,
      nextRunAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: runtimeRedditMonitors.workspaceId,
      set: {
        seedScanId: input.seedScanId,
        websiteUrl: input.websiteUrl,
        enabled: input.enabled,
        watchTerms,
        nextRunAt,
        updatedAt: now,
      },
    })
    .returning();
  return settingsFromRow(row);
}

export async function createRedditMonitorRun(input: {
  id?: string;
  workspaceId: string;
  seedScanId: string;
  windowStartedAt: Date;
  windowEndedAt: Date;
  watchTerms: string[];
}): Promise<RedditMonitorRunRecord> {
  const now = new Date();
  const record: RedditMonitorRunRecord = {
    id: input.id ?? createId("monrun"),
    workspaceId: input.workspaceId,
    seedScanId: input.seedScanId,
    scanId: null,
    status: "queued",
    windowStartedAt: input.windowStartedAt.toISOString(),
    windowEndedAt: input.windowEndedAt.toISOString(),
    actorRunId: null,
    watchTerms: input.watchTerms,
    fetched: 0,
    normalized: 0,
    unseen: 0,
    relevant: 0,
    opportunities: 0,
    error: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  if (isMemoryStore()) {
    memoryRuns.set(record.id, record);
    return record;
  }
  await getDb().insert(runtimeRedditMonitorRuns).values({
    id: record.id,
    workspaceId: record.workspaceId,
    seedScanId: record.seedScanId,
    scanId: null,
    status: record.status,
    windowStartedAt: input.windowStartedAt,
    windowEndedAt: input.windowEndedAt,
    actorRunId: null,
    record,
    error: null,
    createdAt: now,
    updatedAt: now,
  });
  return record;
}

export async function getRedditMonitorRun(id: string): Promise<RedditMonitorRunRecord | null> {
  if (isMemoryStore()) return memoryRuns.get(id) ?? null;
  const [row] = await getDb()
    .select()
    .from(runtimeRedditMonitorRuns)
    .where(eq(runtimeRedditMonitorRuns.id, id))
    .limit(1);
  return row ? runFromRow(row) : null;
}

export async function saveRedditMonitorRun(record: RedditMonitorRunRecord): Promise<void> {
  const updatedAt = new Date(record.updatedAt);
  if (isMemoryStore()) {
    memoryRuns.set(record.id, record);
    return;
  }
  await getDb()
    .update(runtimeRedditMonitorRuns)
    .set({
      scanId: record.scanId,
      status: record.status,
      actorRunId: record.actorRunId,
      record,
      error: record.error,
      updatedAt,
    })
    .where(eq(runtimeRedditMonitorRuns.id, record.id));
}

export async function ingestRedditMonitorMatches(input: {
  workspaceId: string;
  runId: string;
  candidates: RedditDiscoveryCandidate[];
}): Promise<RedditDiscoveryCandidate[]> {
  const unseen: RedditDiscoveryCandidate[] = [];
  const now = new Date();
  if (isMemoryStore()) {
    for (const candidate of input.candidates) {
      const key = `${input.workspaceId}:${candidate.provider}:${candidate.externalId}`;
      if (!memoryMatches.has(key)) unseen.push(candidate);
      const existing = memoryMatches.get(key);
      memoryMatches.set(key, existing ? {
        ...existing,
        matchedQueries: [...new Set([...existing.matchedQueries, ...candidate.matchedQueries])],
      } : candidate);
    }
    return unseen;
  }
  const database = getDb();
  for (const candidate of input.candidates) {
    const [inserted] = await database
      .insert(runtimeRedditMonitorMatches)
      .values({
        workspaceId: input.workspaceId,
        provider: candidate.provider,
        externalId: candidate.externalId,
        canonicalUrl: candidate.permalink ?? null,
        sourceCreatedAt: new Date(candidate.createdAt),
        matchedTerms: candidate.matchedQueries,
        firstRunId: input.runId,
        lastRunId: input.runId,
        firstSeenAt: now,
        lastSeenAt: now,
        outcome: "unreviewed",
        record: candidate as unknown as Record<string, unknown>,
      })
      .onConflictDoNothing()
      .returning({ externalId: runtimeRedditMonitorMatches.externalId });
    if (inserted) {
      unseen.push(candidate);
      continue;
    }
    const [existing] = await database
      .select({
        matchedTerms: runtimeRedditMonitorMatches.matchedTerms,
        outcome: runtimeRedditMonitorMatches.outcome,
      })
      .from(runtimeRedditMonitorMatches)
      .where(and(
        eq(runtimeRedditMonitorMatches.workspaceId, input.workspaceId),
        eq(runtimeRedditMonitorMatches.provider, candidate.provider),
        eq(runtimeRedditMonitorMatches.externalId, candidate.externalId),
      ))
      .limit(1);
    // A record inserted by a run whose AI pipeline later failed is still
    // unreviewed. Re-submit it when the unchanged successful watermark causes
    // the next exact-window Actor run to see it again; otherwise a transient
    // classifier outage would permanently suppress a possible lead.
    if (existing?.outcome === "unreviewed") unseen.push(candidate);
    await database
      .update(runtimeRedditMonitorMatches)
      .set({
        canonicalUrl: candidate.permalink ?? null,
        matchedTerms: [...new Set([...(existing?.matchedTerms ?? []), ...candidate.matchedQueries])],
        lastRunId: input.runId,
        lastSeenAt: now,
      })
      .where(and(
        eq(runtimeRedditMonitorMatches.workspaceId, input.workspaceId),
        eq(runtimeRedditMonitorMatches.provider, candidate.provider),
        eq(runtimeRedditMonitorMatches.externalId, candidate.externalId),
      ));
  }
  return unseen;
}

export async function applyRedditMonitorOutcomes(input: {
  workspaceId: string;
  runId: string;
  reviewed: readonly string[];
  opportunities: readonly string[];
  relevant: readonly string[];
}): Promise<void> {
  if (isMemoryStore()) return;
  const reviewedIds = new Set(input.reviewed);
  const opportunityIds = new Set(input.opportunities);
  const relevantIds = new Set(input.relevant);
  const rows = await getDb()
    .select({
      provider: runtimeRedditMonitorMatches.provider,
      externalId: runtimeRedditMonitorMatches.externalId,
    })
    .from(runtimeRedditMonitorMatches)
    .where(and(
      eq(runtimeRedditMonitorMatches.workspaceId, input.workspaceId),
      eq(runtimeRedditMonitorMatches.lastRunId, input.runId),
    ));
  for (const row of rows) {
    // `last_run_id` also covers already-reviewed duplicates returned by the
    // Actor. Only mutate candidates that this run actually sent through AI;
    // this also lets a previously-unreviewed record recover after a transient
    // AI failure without overwriting outcomes for ordinary duplicates.
    if (!reviewedIds.has(row.externalId)) continue;
    const outcome = opportunityIds.has(row.externalId)
      ? "opportunity"
      : relevantIds.has(row.externalId)
        ? "relevant"
        : "irrelevant";
    await getDb()
      .update(runtimeRedditMonitorMatches)
      .set({ outcome })
      .where(and(
        eq(runtimeRedditMonitorMatches.workspaceId, input.workspaceId),
        eq(runtimeRedditMonitorMatches.provider, row.provider),
        eq(runtimeRedditMonitorMatches.externalId, row.externalId),
      ));
  }
}

export async function completeRedditMonitorRun(record: RedditMonitorRunRecord): Promise<void> {
  const completed: RedditMonitorRunRecord = {
    ...record,
    status: "succeeded",
    error: null,
    updatedAt: new Date().toISOString(),
  };
  const nextRunAt = new Date(Date.parse(completed.windowEndedAt) + 24 * 60 * 60 * 1_000);
  if (isMemoryStore()) {
    await saveRedditMonitorRun(completed);
    const settings = memorySettings.get(record.workspaceId);
    if (settings) memorySettings.set(record.workspaceId, {
      ...settings,
      lastSuccessfulMonitorAt: completed.windowEndedAt,
      nextRunAt: nextRunAt.toISOString(),
      lastRunId: completed.id,
      updatedAt: completed.updatedAt,
    });
    return;
  }
  // The run state and watermark are one success boundary. If the process
  // exits between them, the exact window must remain eligible for retry.
  await getDb().transaction(async (transaction) => {
    await transaction
      .update(runtimeRedditMonitorRuns)
      .set({
        scanId: completed.scanId,
        status: completed.status,
        actorRunId: completed.actorRunId,
        record: completed,
        error: null,
        updatedAt: new Date(completed.updatedAt),
      })
      .where(eq(runtimeRedditMonitorRuns.id, completed.id));
    await transaction
      .update(runtimeRedditMonitors)
      .set({
        lastSuccessfulMonitorAt: new Date(completed.windowEndedAt),
        nextRunAt,
        lastRunId: completed.id,
        updatedAt: new Date(completed.updatedAt),
      })
      .where(eq(runtimeRedditMonitors.workspaceId, completed.workspaceId));
  });
}

/**
 * How long a terminally-failed run blocks the next attempt. Deliberately
 * short relative to the daily cadence (unlike completeRedditMonitorRun's
 * 24h-out watermark) so a real transient failure still recovers the same
 * day -- but long enough that the scheduler poll (default every 60s, see
 * REDDIT_MONITOR_SCHEDULER_POLL_MS in scripts/background-worker.mjs) can't
 * immediately re-enqueue a brand new run (and a brand new, paid Apify
 * search) on its very next tick.
 */
const FAILURE_RETRY_DELAY_MS = 15 * 60 * 1_000;

/**
 * Marks the run failed and pushes the workspace's watermark forward by
 * FAILURE_RETRY_DELAY_MS, mirroring completeRedditMonitorRun's watermark
 * advance on the success path. Without this, a run that fails inside
 * runRedditMonitorScan (e.g. anywhere in the full scan pipeline it kicks
 * off once unseen matches are found) leaves next_run_at stuck at whatever
 * "now" the toggle/previous cycle set -- and because job-level retries are
 * a no-op once the run's status is "failed" (see the claimedMonitorSnapshot
 * guard in app/api/internal/jobs/[jobId]/execute/route.ts, which only
 * re-invokes ensureMonitorExecution while status is neither "succeeded" nor
 * "failed"), scheduleRedditMonitorScans's own poll would otherwise pick the
 * stale next_run_at right back up and enqueue an entirely new run --
 * rerunning the Apify search (and possibly the whole scan pipeline) from
 * scratch -- every single poll, indefinitely, until one attempt succeeds.
 */
export async function failRedditMonitorRun(record: RedditMonitorRunRecord, error: unknown) {
  const failedAt = new Date();
  const failed: RedditMonitorRunRecord = {
    ...record,
    status: "failed",
    error: error instanceof Error ? error.message.slice(0, 2_000) : "Reddit monitoring failed.",
    updatedAt: failedAt.toISOString(),
  };
  const nextRunAt = new Date(failedAt.getTime() + FAILURE_RETRY_DELAY_MS);
  if (isMemoryStore()) {
    await saveRedditMonitorRun(failed);
    const settings = memorySettings.get(failed.workspaceId);
    if (settings) {
      memorySettings.set(failed.workspaceId, {
        ...settings,
        nextRunAt: nextRunAt.toISOString(),
        updatedAt: failedAt.toISOString(),
      });
    }
    return;
  }
  await getDb().transaction(async (transaction) => {
    await transaction
      .update(runtimeRedditMonitorRuns)
      .set({
        scanId: failed.scanId,
        status: failed.status,
        actorRunId: failed.actorRunId,
        record: failed,
        error: failed.error,
        updatedAt: failedAt,
      })
      .where(eq(runtimeRedditMonitorRuns.id, failed.id));
    await transaction
      .update(runtimeRedditMonitors)
      .set({ nextRunAt, updatedAt: failedAt })
      .where(eq(runtimeRedditMonitors.workspaceId, failed.workspaceId));
  });
}

export async function latestRedditMonitorRun(workspaceId: string) {
  if (isMemoryStore()) {
    return [...memoryRuns.values()]
      .filter((run) => run.workspaceId === workspaceId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null;
  }
  const [row] = await getDb()
    .select()
    .from(runtimeRedditMonitorRuns)
    .where(eq(runtimeRedditMonitorRuns.workspaceId, workspaceId))
    .orderBy(desc(runtimeRedditMonitorRuns.createdAt))
    .limit(1);
  return row ? runFromRow(row) : null;
}

/**
 * Run history for a workspace, most recent first -- the daily-monitoring
 * results view's "recent runs" list (status, counts, error if any, and the
 * scanId to jump into that run's full report), not just the single latest
 * run latestRedditMonitorRun returns.
 */
export async function listRedditMonitorRuns(workspaceId: string, limit = 10): Promise<RedditMonitorRunRecord[]> {
  const bounded = Math.max(1, Math.min(limit, 50));
  if (isMemoryStore()) {
    return [...memoryRuns.values()]
      .filter((run) => run.workspaceId === workspaceId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, bounded);
  }
  const rows = await getDb()
    .select()
    .from(runtimeRedditMonitorRuns)
    .where(eq(runtimeRedditMonitorRuns.workspaceId, workspaceId))
    .orderBy(desc(runtimeRedditMonitorRuns.createdAt))
    .limit(bounded);
  return rows.map(runFromRow);
}

export async function getClaimedRedditMonitorJob(jobId: string, workerId: string) {
  if (isMemoryStore()) return null;
  const [row] = await getDb()
    .select()
    .from(backgroundJobs)
    .where(and(
      eq(backgroundJobs.id, jobId),
      eq(backgroundJobs.type, "reddit_monitor_scan"),
      eq(backgroundJobs.status, "running"),
      eq(backgroundJobs.lockedBy, workerId),
    ))
    .limit(1);
  if (!row) return null;
  const monitorRunId = typeof row.payload.monitorRunId === "string" ? row.payload.monitorRunId : "";
  const workspaceId = typeof row.payload.workspaceId === "string" ? row.payload.workspaceId : "";
  return monitorRunId && workspaceId ? { id: row.id, monitorRunId, workspaceId } : null;
}
