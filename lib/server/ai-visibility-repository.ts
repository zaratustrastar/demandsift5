import { and, desc, eq } from "drizzle-orm";

import { getDb } from "@/db";
import {
  backgroundJobs,
  runtimeAiVisibilityScans,
  runtimeAiVisibilitySchedules,
} from "@/db/postgres/schema";
import type {
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
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getAiVisibilitySettings(workspaceId: string): Promise<AiVisibilitySettingsRecord | null> {
  if (isMemoryStore()) return memorySettings.get(workspaceId) ?? null;
  const [row] = await getDb()
    .select()
    .from(runtimeAiVisibilitySchedules)
    .where(eq(runtimeAiVisibilitySchedules.workspaceId, workspaceId))
    .limit(1);
  return row ? settingsFromRow(row) : null;
}

/**
 * Creates the weekly schedule the first time AI visibility tracking starts
 * for a workspace. Idempotent by design at the call site (see
 * ensureAiVisibilityTrackingStarted in ai-visibility-workflow.ts): once a
 * schedule row exists, it is never recreated or reset by a later scan.
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
      enabled: true,
      lastSuccessfulScanAt: null,
      nextRunAt: input.nextRunAt.toISOString(),
      lastScanId: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    memorySettings.set(input.workspaceId, record);
    return record;
  }
  const [row] = await getDb()
    .insert(runtimeAiVisibilitySchedules)
    .values({
      workspaceId: input.workspaceId,
      seedScanId: input.seedScanId,
      enabled: true,
      nextRunAt: input.nextRunAt,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: runtimeAiVisibilitySchedules.workspaceId })
    .returning();
  if (row) return settingsFromRow(row);
  // Another concurrent completion already created it; read it back.
  const existing = await getAiVisibilitySettings(input.workspaceId);
  if (!existing) throw new Error("Could not create or read AI visibility settings.");
  return existing;
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
    const settings = memorySettings.get(completed.workspaceId);
    if (settings) {
      memorySettings.set(completed.workspaceId, {
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
      .where(eq(runtimeAiVisibilitySchedules.workspaceId, completed.workspaceId));
  });
}

export async function failAiVisibilityScan(record: AiVisibilityScanRecord, error: unknown): Promise<void> {
  await saveAiVisibilityScan({
    ...record,
    status: "failed",
    error: error instanceof Error ? error.message.slice(0, 2_000) : "AI visibility tracking failed.",
    updatedAt: new Date().toISOString(),
  });
}

/** Scan history for a workspace, most recent first -- so weekly results can be compared. */
export async function listAiVisibilityScans(workspaceId: string, limit = 20): Promise<AiVisibilityScanRecord[]> {
  const bounded = Math.max(1, Math.min(limit, 100));
  if (isMemoryStore()) {
    return [...memoryScans.values()]
      .filter((scan) => scan.workspaceId === workspaceId)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .slice(0, bounded);
  }
  const rows = await getDb()
    .select()
    .from(runtimeAiVisibilityScans)
    .where(eq(runtimeAiVisibilityScans.workspaceId, workspaceId))
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
