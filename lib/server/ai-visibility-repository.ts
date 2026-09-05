import { and, desc, eq } from "drizzle-orm";

import { getDb } from "@/db";
import {
  backgroundJobs,
  runtimeAiVisibilityScans,
  runtimeAiVisibilitySchedules,
  runtimeScans,
} from "@/db/postgres/schema";
import type {
  AiVisibilityAiProvider,
  AiVisibilityMetrics,
  AiVisibilityScanRecord,
  AiVisibilitySettingsRecord,
} from "@/lib/server/contracts";
import { createId } from "@/lib/server/ids";
import { isProductionRuntime } from "@/lib/server/runtime-env";

/**
 * AI Visibility Tracking's own repository, isolated from
 * reddit-monitor-repository.ts -- same shape/conventions (memory-store dev
 * fallback, one settings row per workspace, one row per scan run) but a
 * fully separate module and separate tables, per the "keep this isolated"
 * requirement.
 */

const memorySettings = new Map<string, AiVisibilitySettingsRecord>();
const memoryScans = new Map<string, AiVisibilityScanRecord>();

// One settings row per (workspace, business) now, not per workspace --
// see migration 0013. The memory-store map key has to carry both parts of
// that same composite identity.
function settingsKey(workspaceId: string, seedScanId: string): string {
  return `${workspaceId}:${seedScanId}`;
}

function isMemoryStore(): boolean {
  const configured = process.env.STATE_STORE?.trim().toLocaleLowerCase("en-US");
  return configured === "memory" || (!process.env.DATABASE_URL && !isProductionRuntime());
}

function configuredMaxAttempts(): number {
  const value = Number(process.env.AI_VISIBILITY_JOB_MAX_ATTEMPTS ?? 3);
  return Number.isInteger(value) ? Math.max(1, Math.min(value, 10)) : 3;
}

/**
 * The next Monday strictly after `from`, at a fixed hour (09:00 UTC) --
 * always at least 1 day and at most 7 days out, so "run once every Monday"
 * never re-fires the same day it was just satisfied.
 */
export function nextMonday(from: Date): Date {
  const result = new Date(from);
  result.setUTCHours(9, 0, 0, 0);
  const day = result.getUTCDay();
  const daysUntilMonday = ((8 - day) % 7) || 7;
  result.setUTCDate(result.getUTCDate() + daysUntilMonday);
  return result;
}

function defaultProviderErrors(): Record<AiVisibilityAiProvider, string | null> {
  return { chatgpt: null, gemini: null, perplexity: null };
}

function settingsFromRow(row: typeof runtimeAiVisibilitySchedules.$inferSelect): AiVisibilitySettingsRecord {
  return {
    workspaceId: row.workspaceId,
    seedScanId: row.seedScanId,
    enabled: row.enabled,
    lastSuccessfulScanAt: row.lastSuccessfulScanAt?.toISOString() ?? null,
    nextRunAt: row.nextRunAt.toISOString(),
    lastScanId: row.lastScanId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function scanFromRow(row: typeof runtimeAiVisibilityScans.$inferSelect): AiVisibilityScanRecord {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    seedScanId: row.seedScanId,
    status: row.status as AiVisibilityScanRecord["status"],
    questions: row.questions,
    answers: row.answers,
    metrics: (row.metrics as AiVisibilityMetrics | null) ?? null,
    error: row.error,
    providerErrors: (row.providerErrors as Record<AiVisibilityAiProvider, string | null> | null) ?? defaultProviderErrors(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getAiVisibilitySettings(workspaceId: string, seedScanId: string): Promise<AiVisibilitySettingsRecord | null> {
  if (isMemoryStore()) return memorySettings.get(settingsKey(workspaceId, seedScanId)) ?? null;
  const [row] = await getDb()
    .select()
    .from(runtimeAiVisibilitySchedules)
    .where(and(eq(runtimeAiVisibilitySchedules.workspaceId, workspaceId), eq(runtimeAiVisibilitySchedules.seedScanId, seedScanId)))
    .limit(1);
  return row ? settingsFromRow(row) : null;
}

/**
 * Finds an already-tracked business's schedule by matching this scan's
 * websiteUrl against the seed scan of any existing schedule in the same
 * workspace. Used only by ensureAiVisibilityTrackingStarted: a monitoring
 * re-scan of an already-tracked business gets a brand new scan id every
 * cycle (see createMonitoringScanRecord in background-worker.mjs), so
 * checking getAiVisibilitySettings by that new id alone would never find
 * the existing schedule and would create a second, separate one for the
 * same business on every single monitoring pass.
 *
 * Skipped for context-mode businesses (empty websiteUrl): they have no
 * stable identity to match re-scans against across scans, only a scan id.
 * Known, narrower gap -- not the cross-business collision this migration
 * fixes -- left for a follow-up rather than expanding this one further.
 */
export async function findAiVisibilitySettingsForWebsite(workspaceId: string, websiteUrl: string): Promise<AiVisibilitySettingsRecord | null> {
  if (!websiteUrl) return null;
  if (isMemoryStore()) return null; // no cross-repository scan lookup available in the memory store.
  const [row] = await getDb()
    .select({ schedule: runtimeAiVisibilitySchedules })
    .from(runtimeAiVisibilitySchedules)
    .innerJoin(runtimeScans, eq(runtimeScans.id, runtimeAiVisibilitySchedules.seedScanId))
    .where(and(eq(runtimeAiVisibilitySchedules.workspaceId, workspaceId), eq(runtimeScans.websiteUrl, websiteUrl)))
    .limit(1);
  return row ? settingsFromRow(row.schedule) : null;
}

/**
 * Creates the weekly schedule the first time AI visibility tracking starts
 * for a business (identified by seedScanId, the scan that seeded it -- see
 * migration 0013: a workspace can track several businesses over time, each
 * with its own schedule). Idempotent by design at the call site (see
 * ensureAiVisibilityTrackingStarted in ai-visibility-workflow.ts): once a
 * schedule row exists for that business, it is never recreated or reset by
 * a later scan of the same business.
 */
export async function createAiVisibilitySettings(input: {
  workspaceId: string;
  seedScanId: string;
  nextRunAt: Date;
}): Promise<AiVisibilitySettingsRecord> {
  const now = new Date();
  if (isMemoryStore()) {
    const record: AiVisibilitySettingsRecord = {
      workspaceId: input.workspaceId,
      seedScanId: input.seedScanId,
      enabled: false,
      lastSuccessfulScanAt: null,
      nextRunAt: input.nextRunAt.toISOString(),
      lastScanId: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    memorySettings.set(settingsKey(input.workspaceId, input.seedScanId), record);
    return record;
  }
  const [row] = await getDb()
    .insert(runtimeAiVisibilitySchedules)
    .values({
      workspaceId: input.workspaceId,
      seedScanId: input.seedScanId,
      enabled: false,
      nextRunAt: input.nextRunAt,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [runtimeAiVisibilitySchedules.workspaceId, runtimeAiVisibilitySchedules.seedScanId] })
    .returning();
  if (row) return settingsFromRow(row);
  // Another concurrent completion already created it; read it back.
  const existing = await getAiVisibilitySettings(input.workspaceId, input.seedScanId);
  if (!existing) throw new Error("Could not create or read AI visibility settings.");
  return existing;
}

/**
 * Flips the per-business `enabled` flag from the (not-yet-built) dashboard
 * toggle -- the AI-visibility equivalent of saveRedditMonitorSettings in
 * reddit-monitor-repository.ts. Requires a settings row to already exist
 * (created by ensureAiVisibilityTrackingStarted the first time a scan
 * completes); this function only ever flips the flag on an existing row,
 * it never creates one.
 *
 * Turning tracking on (false -> true) pulls nextRunAt forward to now, the
 * same way the Reddit monitor does, so the very next scheduler poll picks
 * it up instead of waiting for the stored Monday watermark, which could be
 * up to a week away and would otherwise make the toggle feel broken.
 */
export async function updateAiVisibilitySettings(input: {
  workspaceId: string;
  seedScanId: string;
  enabled: boolean;
}): Promise<AiVisibilitySettingsRecord> {
  const now = new Date();
  if (isMemoryStore()) {
    const key = settingsKey(input.workspaceId, input.seedScanId);
    const existing = memorySettings.get(key);
    if (!existing) throw new Error("AI visibility settings have not been created for this workspace yet.");
    const turningOn = input.enabled && !existing.enabled;
    const record: AiVisibilitySettingsRecord = {
      ...existing,
      enabled: input.enabled,
      nextRunAt: turningOn ? now.toISOString() : existing.nextRunAt,
      updatedAt: now.toISOString(),
    };
    memorySettings.set(key, record);
    return record;
  }
  const existing = await getAiVisibilitySettings(input.workspaceId, input.seedScanId);
  if (!existing) throw new Error("AI visibility settings have not been created for this workspace yet.");
  const turningOn = input.enabled && !existing.enabled;
  const nextRunAt = turningOn ? now : new Date(existing.nextRunAt);
  const [row] = await getDb()
    .update(runtimeAiVisibilitySchedules)
    .set({ enabled: input.enabled, nextRunAt, updatedAt: now })
    .where(and(eq(runtimeAiVisibilitySchedules.workspaceId, input.workspaceId), eq(runtimeAiVisibilitySchedules.seedScanId, input.seedScanId)))
    .returning();
  if (!row) throw new Error("AI visibility settings have not been created for this workspace yet.");
  return settingsFromRow(row);
}

export async function createAiVisibilityScan(input: {
  workspaceId: string;
  seedScanId: string;
  id?: string;
}): Promise<AiVisibilityScanRecord> {
  const now = new Date().toISOString();
  const record: AiVisibilityScanRecord = {
    id: input.id ?? createId("aivis"),
    workspaceId: input.workspaceId,
    seedScanId: input.seedScanId,
    status: "queued",
    questions: [],
    answers: [],
    metrics: null,
    error: null,
    providerErrors: defaultProviderErrors(),
    createdAt: now,
    updatedAt: now,
  };
  if (isMemoryStore()) {
    memoryScans.set(record.id, record);
    return record;
  }
  await getDb().insert(runtimeAiVisibilityScans).values({
    id: record.id,
    workspaceId: record.workspaceId,
    seedScanId: record.seedScanId,
    status: record.status,
    questions: record.questions,
    answers: record.answers,
    metrics: null,
    error: null,
    providerErrors: record.providerErrors,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  });
  return record;
}

export async function getAiVisibilityScan(id: string): Promise<AiVisibilityScanRecord | null> {
  if (isMemoryStore()) return memoryScans.get(id) ?? null;
  const [row] = await getDb()
    .select()
    .from(runtimeAiVisibilityScans)
    .where(eq(runtimeAiVisibilityScans.id, id))
    .limit(1);
  return row ? scanFromRow(row) : null;
}

export async function saveAiVisibilityScan(record: AiVisibilityScanRecord): Promise<void> {
  const updatedAt = new Date(record.updatedAt);
  if (isMemoryStore()) {
    memoryScans.set(record.id, record);
    return;
  }
  await getDb()
    .update(runtimeAiVisibilityScans)
    .set({
      status: record.status,
      questions: record.questions,
      answers: record.answers,
      metrics: record.metrics,
      error: record.error,
      providerErrors: record.providerErrors,
      updatedAt,
    })
    .where(eq(runtimeAiVisibilityScans.id, record.id));
}

/**
 * Marks the scan succeeded and advances the workspace's weekly watermark in
 * one boundary, the same way completeRedditMonitorRun does -- so a process
 * exit between the two never leaves the schedule pointing at a stale
 * next-run time for a scan that actually finished.
 */
export async function completeAiVisibilityScan(record: AiVisibilityScanRecord): Promise<void> {
  const completedAt = new Date();
  const completed: AiVisibilityScanRecord = {
    ...record,
    status: "succeeded",
    error: null,
    updatedAt: completedAt.toISOString(),
  };
  const nextRunAt = nextMonday(completedAt);
  if (isMemoryStore()) {
    memoryScans.set(completed.id, completed);
    const key = settingsKey(completed.workspaceId, completed.seedScanId);
    const settings = memorySettings.get(key);
    if (settings) {
      memorySettings.set(key, {
        ...settings,
        lastSuccessfulScanAt: completedAt.toISOString(),
        nextRunAt: nextRunAt.toISOString(),
        lastScanId: completed.id,
        updatedAt: completedAt.toISOString(),
      });
    }
    return;
  }
  await getDb().transaction(async (transaction) => {
    await transaction
      .update(runtimeAiVisibilityScans)
      .set({
        status: completed.status,
        questions: completed.questions,
        answers: completed.answers,
        metrics: completed.metrics,
        error: null,
        providerErrors: completed.providerErrors,
        updatedAt: completedAt,
      })
      .where(eq(runtimeAiVisibilityScans.id, completed.id));
    await transaction
      .update(runtimeAiVisibilitySchedules)
      .set({
        lastSuccessfulScanAt: completedAt,
        nextRunAt,
        lastScanId: completed.id,
        updatedAt: completedAt,
      })
      .where(and(eq(runtimeAiVisibilitySchedules.workspaceId, completed.workspaceId), eq(runtimeAiVisibilitySchedules.seedScanId, completed.seedScanId)));
  });
}

/**
 * How long a terminally-failed scan blocks the next attempt. Deliberately
 * short relative to the weekly cadence (unlike completeAiVisibilityScan's
 * week-out watermark) so a real transient failure still recovers the same
 * day -- but long enough that the scheduler poll (default every 5 min, see
 * aiVisibilityConfiguration in scripts/background-worker.mjs) can't
 * immediately re-enqueue a brand new scan (and a brand new, paid trio of
 * Apify Actor runs) on its very next tick.
 */
const FAILURE_RETRY_DELAY_MS = 30 * 60 * 1_000;

/**
 * Marks the scan failed and pushes the workspace's watermark forward by
 * FAILURE_RETRY_DELAY_MS, mirroring completeAiVisibilityScan's watermark
 * advance on the success path. Without this, a scan that fails inside
 * runAiVisibilityScan (e.g. the OpenAI analysis step, which runs after the
 * Apify Actors already succeeded) leaves next_run_at stuck at whatever
 * "now" the toggle/previous cycle set -- and because job-level retries are
 * a no-op once scan.status is "failed" (see the claimedVisibilitySnapshot
 * guard in app/api/internal/jobs/[jobId]/execute/route.ts, which only
 * re-invokes ensureVisibilityExecution while status is neither "succeeded"
 * nor "failed"), scheduleAiVisibilityScans's own poll would otherwise pick
 * the stale next_run_at right back up and enqueue an entirely new scan --
 * rerunning all 3 Actors from scratch -- every single poll, indefinitely,
 * until one attempt happens to succeed.
 */
export async function failAiVisibilityScan(record: AiVisibilityScanRecord, error: unknown): Promise<void> {
  const failedAt = new Date();
  const failed: AiVisibilityScanRecord = {
    ...record,
    status: "failed",
    error: error instanceof Error ? error.message.slice(0, 2_000) : "AI visibility tracking failed.",
    updatedAt: failedAt.toISOString(),
  };
  const nextRunAt = new Date(failedAt.getTime() + FAILURE_RETRY_DELAY_MS);
  if (isMemoryStore()) {
    memoryScans.set(failed.id, failed);
    const key = settingsKey(failed.workspaceId, failed.seedScanId);
    const settings = memorySettings.get(key);
    if (settings) {
      memorySettings.set(key, {
        ...settings,
        nextRunAt: nextRunAt.toISOString(),
        updatedAt: failedAt.toISOString(),
      });
    }
    return;
  }
  await getDb().transaction(async (transaction) => {
    await transaction
      .update(runtimeAiVisibilityScans)
      .set({
        status: failed.status,
        questions: failed.questions,
        answers: failed.answers,
        metrics: failed.metrics,
        error: failed.error,
        providerErrors: failed.providerErrors,
        updatedAt: failedAt,
      })
      .where(eq(runtimeAiVisibilityScans.id, failed.id));
    await transaction
      .update(runtimeAiVisibilitySchedules)
      .set({ nextRunAt, updatedAt: failedAt })
      .where(and(eq(runtimeAiVisibilitySchedules.workspaceId, failed.workspaceId), eq(runtimeAiVisibilitySchedules.seedScanId, failed.seedScanId)));
  });
}

/** Scan history for a business, most recent first -- so weekly results can be compared. */
export async function listAiVisibilityScans(workspaceId: string, seedScanId: string, limit = 20): Promise<AiVisibilityScanRecord[]> {
  const bounded = Math.max(1, Math.min(limit, 100));
  if (isMemoryStore()) {
    return [...memoryScans.values()]
      .filter((scan) => scan.workspaceId === workspaceId && scan.seedScanId === seedScanId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, bounded);
  }
  const rows = await getDb()
    .select()
    .from(runtimeAiVisibilityScans)
    .where(and(eq(runtimeAiVisibilityScans.workspaceId, workspaceId), eq(runtimeAiVisibilityScans.seedScanId, seedScanId)))
    .orderBy(desc(runtimeAiVisibilityScans.createdAt))
    .limit(bounded);
  return rows.map(scanFromRow);
}

/**
 * Enqueues the ai_visibility_scan background job for an already-created
 * scan record. dedupeKey is per-scan-id, so retrying the same enqueue call
 * (e.g. two concurrent completions of the seed scan) never creates a
 * duplicate job.
 */
export async function enqueueAiVisibilityJob(input: {
  visibilityScanId: string;
  workspaceId: string;
  runAt?: Date;
}): Promise<void> {
  if (isMemoryStore()) return;
  const dedupeKey = `ai-visibility-run:${input.visibilityScanId}`;
  await getDb()
    .insert(backgroundJobs)
    .values({
      type: "ai_visibility_scan",
      payload: { visibilityScanId: input.visibilityScanId, workspaceId: input.workspaceId },
      dedupeKey,
      maxAttempts: configuredMaxAttempts(),
      runAt: input.runAt ?? new Date(),
    })
    .onConflictDoNothing();
}

export async function getClaimedAiVisibilityJob(jobId: string, workerId: string) {
  if (isMemoryStore()) return null;
  const [row] = await getDb()
    .select()
    .from(backgroundJobs)
    .where(and(
      eq(backgroundJobs.id, jobId),
      eq(backgroundJobs.type, "ai_visibility_scan"),
      eq(backgroundJobs.status, "running"),
      eq(backgroundJobs.lockedBy, workerId),
    ))
    .limit(1);
  if (!row) return null;
  const visibilityScanId = typeof row.payload.visibilityScanId === "string" ? row.payload.visibilityScanId : "";
  const workspaceId = typeof row.payload.workspaceId === "string" ? row.payload.workspaceId : "";
  return visibilityScanId && workspaceId ? { id: row.id, visibilityScanId, workspaceId } : null;
}
