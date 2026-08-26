import { and, desc, eq, sql } from "drizzle-orm";

import { getDb } from "@/db";
import {
  backgroundJobs,
  runtimeCheckouts,
  runtimeConversions,
  runtimeEntitlements,
  runtimeFunnelEvents,
  runtimeMonitoringSchedules,
  runtimeRedditConnections,
  runtimeRedditPublications,
  runtimeReplies,
  runtimeScans,
  runtimeWorkspaces,
  stripeEvents,
} from "@/db/postgres/schema";
import type {
  BackgroundJobRecord,
  CheckoutRecord,
  ConversionRecord,
  EntitlementRecord,
  FunnelEventRecord,
  RedditConnectionRecord,
  RedditPublicationRecord,
  ReplyRecord,
  ScanRecord,
} from "./contracts";
import { createId } from "./ids";
import { isProductionRuntime } from "./runtime-env";
import { getStore } from "./store";

export type WorkspaceSessionRecord = {
  id: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
};

export type StripeStateCommit = {
  eventId: string;
  eventType: string;
  eventPayload: Record<string, unknown>;
  livemode: boolean;
  entitlement?: EntitlementRecord;
  checkout?: CheckoutRecord;
};

export type RedditPublicationClaim = {
  state: "claimed" | "pending" | "succeeded" | "unknown";
  record: RedditPublicationRecord;
};

export interface StateRepository {
  readonly kind: "memory" | "postgres";
  saveWorkspace(record: WorkspaceSessionRecord): Promise<void>;
  verifyWorkspaceToken(workspaceId: string, token: string): Promise<boolean>;
  workspaceExists(workspaceId: string): Promise<boolean>;
  saveScan(record: ScanRecord): Promise<void>;
  getScan(scanId: string): Promise<ScanRecord | null>;
  getLatestScan(workspaceId: string): Promise<ScanRecord | null>;
  getLatestWorkspaceScan(workspaceId: string): Promise<ScanRecord | null>;
  beginScanRun(scanId: string): Promise<{
    state: "claimed" | "complete" | "running" | "missing";
    scan: ScanRecord | null;
  }>;
  saveReply(record: ReplyRecord): Promise<void>;
  getReply(replyId: string): Promise<ReplyRecord | null>;
  listRepliesForScan(scanId: string): Promise<ReplyRecord[]>;
  saveEntitlement(record: EntitlementRecord): Promise<void>;
  getEntitlement(workspaceId: string): Promise<EntitlementRecord | null>;
  saveCheckout(record: CheckoutRecord): Promise<void>;
  getCheckout(checkoutId: string): Promise<CheckoutRecord | null>;
  saveConversion(record: ConversionRecord): Promise<void>;
  listConversions(workspaceId: string): Promise<ConversionRecord[]>;
  saveFunnelEvent(record: FunnelEventRecord): Promise<void>;
  saveRedditConnection(record: RedditConnectionRecord): Promise<void>;
  getRedditConnection(workspaceId: string): Promise<RedditConnectionRecord | null>;
  deleteRedditConnection(workspaceId: string): Promise<void>;
  claimRedditPublication(record: RedditPublicationRecord): Promise<RedditPublicationClaim>;
  saveRedditPublication(record: RedditPublicationRecord): Promise<void>;
  getRedditPublication(replyId: string): Promise<RedditPublicationRecord | null>;
  commitStripeEvent(commit: StripeStateCommit): Promise<boolean>;
  enqueueScan(scanId: string, workspaceId: string): Promise<BackgroundJobRecord>;
  claimJob(workerId: string, staleAfterMs?: number): Promise<BackgroundJobRecord | null>;
  getJob(jobId: string): Promise<BackgroundJobRecord | null>;
  completeJob(jobId: string, workerId: string): Promise<void>;
  failJob(jobId: string, workerId: string, error: string): Promise<void>;
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function safeEqual(left: string | null | undefined, right: string | null | undefined): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function effectiveEntitlement(record: EntitlementRecord | null): EntitlementRecord | null {
  const passExpiry = record?.accessUntil ? Date.parse(record.accessUntil) : Number.NaN;
  if (
    record?.plan === "pass" &&
    record.status === "active" &&
    (!Number.isFinite(passExpiry) || passExpiry <= Date.now())
  ) {
    return { ...record, status: "expired", updatedAt: new Date().toISOString() };
  }
  return record;
}

function configuredMaxAttempts(): number {
  const value = Number(process.env.BACKGROUND_JOB_MAX_ATTEMPTS ?? 5);
  return Number.isInteger(value) ? Math.max(1, Math.min(value, 20)) : 5;
}

function boundedMonitoringCadence(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.max(minimum, Math.min(parsed, maximum))
    : fallback;
}

function monitoringCadenceSeconds(plan: CheckoutRecord["plan"]): number {
  if (plan === "pass") {
    const hours = boundedMonitoringCadence(
      process.env.MONITOR_PASS_INTERVAL_HOURS,
      24,
      1,
      168,
    );
    return Math.round(hours * 60 * 60);
  }
  const minutes = boundedMonitoringCadence(
    process.env.MONITOR_CORE_INTERVAL_MINUTES,
    360,
    5,
    10_080,
  );
  return Math.round(minutes * 60);
}

function scanRunIsStale(scan: ScanRecord): boolean {
  const configuredSeconds = Number(process.env.BACKGROUND_JOB_STALE_SECONDS ?? 900);
  const staleSeconds = Number.isFinite(configuredSeconds)
    ? Math.max(60, Math.min(configuredSeconds, 3_600))
    : 900;
  const updatedAt = Date.parse(scan.updatedAt);
  return Number.isFinite(updatedAt) && updatedAt <= Date.now() - staleSeconds * 1_000;
}

class MemoryStateRepository implements StateRepository {
  readonly kind = "memory" as const;

  async saveWorkspace(record: WorkspaceSessionRecord) {
    getStore().workspaces.set(record.id, record);
  }

  async verifyWorkspaceToken(workspaceId: string, token: string) {
    const workspace = getStore().workspaces.get(workspaceId);
    if (!workspace || Date.parse(workspace.expiresAt) <= Date.now()) return false;
    return safeEqual(workspace.tokenHash, await sha256(token));
  }

  async workspaceExists(workspaceId: string) {
    return getStore().workspaces.has(workspaceId);
  }

  async saveScan(record: ScanRecord) {
    getStore().scans.set(record.id, record);
  }

  async getScan(scanId: string) {
    return getStore().scans.get(scanId) ?? null;
  }

  async getLatestScan(workspaceId: string) {
    return [...getStore().scans.values()]
      .filter((scan) => scan.workspaceId === workspaceId && scan.status === "complete")
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ?? null;
  }

  /**
   * The "latest scan" shown by default when the report page loads/refreshes
   * (see GET /api/scans/latest) must stay pinned to the user's own primary
   * Market Scan (scanKind "discovery", or absent on scans that predate this
   * field) -- never a daily Reddit monitor's own scoped scan (scanKind
   * "monitoring", see monitoringScan() in reddit-monitor-workflow.ts).
   * Those are a fundamentally different kind of scan: the primary scan
   * searches roughly a year of Reddit broadly, a monitor run only checks
   * the fixed watch terms for one day. Without this filter, a monitor run
   * that happens to be newer (even one that legitimately found 0 relevant
   * matches that day) would silently replace the primary scan's results on
   * every refresh, with no way back. Monitor-run scans stay reachable only
   * through their own explicit "View results" action (viewMonitorRun in
   * ThreadlineExperience.tsx), which fetches them by id, not through this
   * "latest" lookup.
   */
  async getLatestWorkspaceScan(workspaceId: string) {
    return [...getStore().scans.values()]
      .filter((scan) => scan.workspaceId === workspaceId && scan.scanKind !== "monitoring")
      .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))[0] ?? null;
  }

  async beginScanRun(scanId: string) {
    const scan = getStore().scans.get(scanId) ?? null;
    if (!scan) return { state: "missing" as const, scan: null };
    if (scan.status === "complete") return { state: "complete" as const, scan };
    if (scan.status === "running" && !scanRunIsStale(scan)) {
      return { state: "running" as const, scan };
    }
    scan.status = "running";
    scan.updatedAt = new Date().toISOString();
    getStore().scans.set(scan.id, scan);
    return { state: "claimed" as const, scan };
  }

  async saveReply(record: ReplyRecord) {
    getStore().replies.set(record.id, record);
  }

  async getReply(replyId: string) {
    return getStore().replies.get(replyId) ?? null;
  }

  async listRepliesForScan(scanId: string) {
    return [...getStore().replies.values()].filter((reply) => reply.scanId === scanId);
  }

  async saveEntitlement(record: EntitlementRecord) {
    getStore().entitlements.set(record.workspaceId, record);
  }

  async getEntitlement(workspaceId: string) {
    const current = getStore().entitlements.get(workspaceId) ?? null;
    const effective = effectiveEntitlement(current);
    if (effective && effective !== current) await this.saveEntitlement(effective);
    return effective;
  }

  async saveCheckout(record: CheckoutRecord) {
    getStore().checkouts.set(record.id, record);
  }

  async getCheckout(checkoutId: string) {
    return getStore().checkouts.get(checkoutId) ?? null;
  }

  async saveConversion(record: ConversionRecord) {
    getStore().conversions.set(record.id, record);
  }

  async listConversions(workspaceId: string) {
    return [...getStore().conversions.values()].filter((record) => record.workspaceId === workspaceId);
  }

  async saveFunnelEvent(record: FunnelEventRecord) {
    getStore().funnelEvents.set(record.id, record);
  }

  async saveRedditConnection(record: RedditConnectionRecord) {
    getStore().redditConnections.set(record.workspaceId, record);
  }

  async getRedditConnection(workspaceId: string) {
    return getStore().redditConnections.get(workspaceId) ?? null;
  }

  async deleteRedditConnection(workspaceId: string) {
    getStore().redditConnections.delete(workspaceId);
  }

  async claimRedditPublication(record: RedditPublicationRecord): Promise<RedditPublicationClaim> {
    const existing = getStore().redditPublications.get(record.replyId);
    if (!existing) {
      getStore().redditPublications.set(record.replyId, record);
      return { state: "claimed", record };
    }
    if (existing.status === "succeeded") return { state: "succeeded", record: existing };
    if (existing.status === "unknown") return { state: "unknown", record: existing };
    if (existing.status === "pending") return { state: "pending", record: existing };
    const retried = {
      ...record,
      attempts: existing.attempts + 1,
      createdAt: existing.createdAt,
    };
    getStore().redditPublications.set(record.replyId, retried);
    return { state: "claimed", record: retried };
  }

  async saveRedditPublication(record: RedditPublicationRecord) {
    getStore().redditPublications.set(record.replyId, record);
  }

  async getRedditPublication(replyId: string) {
    return getStore().redditPublications.get(replyId) ?? null;
  }

  async commitStripeEvent(commit: StripeStateCommit) {
    const store = getStore();
    if (store.processedStripeEvents.has(commit.eventId)) return false;
    let entitlement = commit.entitlement;
    if (entitlement && entitlement.verifiedByEventId !== commit.eventId) {
      throw new Error("The entitlement did not reference the verified Stripe event.");
    }
    if (
      entitlement?.status === "active" &&
      (entitlement.plan === "pass" || entitlement.plan === "core")
    ) {
      if (
        commit.checkout &&
        (commit.checkout.status !== "completed" ||
          commit.checkout.workspaceId !== entitlement.workspaceId ||
          commit.checkout.plan !== entitlement.plan)
      ) {
        throw new Error("The completed checkout did not match the entitlement.");
      }
      const seedScanId = commit.checkout?.scanId ?? entitlement.seedScanId;
      const seedScan = seedScanId ? store.scans.get(seedScanId) : undefined;
      if (
        !seedScan ||
        seedScan.workspaceId !== entitlement.workspaceId ||
        seedScan.status !== "complete" ||
        !seedScan.result
      ) {
        throw new Error("The purchased scan was not an owned completed scan.");
      }
      entitlement = {
        ...entitlement,
        seedScanId: seedScan.id,
        websiteUrl: seedScan.websiteUrl,
      };
    }
    if (entitlement) store.entitlements.set(entitlement.workspaceId, entitlement);
    if (commit.checkout) store.checkouts.set(commit.checkout.id, commit.checkout);
    store.processedStripeEvents.add(commit.eventId);
    return true;
  }

  async enqueueScan(scanId: string, workspaceId: string) {
    const existing = [...getStore().jobs.values()].find((job) => job.dedupeKey === `scan:${scanId}`);
    if (existing) return existing;
    const now = new Date().toISOString();
    const job: BackgroundJobRecord = {
      id: createId("job"),
      type: "scan.run",
      status: "queued",
      payload: { scanId, workspaceId },
      dedupeKey: `scan:${scanId}`,
      attempts: 0,
      maxAttempts: configuredMaxAttempts(),
      runAt: now,
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      finishedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    getStore().jobs.set(job.id, job);
    return job;
  }

  async claimJob(workerId: string, staleAfterMs = 15 * 60_000) {
    const now = Date.now();
    const candidate = [...getStore().jobs.values()]
      .filter(
        (job) =>
          job.attempts < job.maxAttempts &&
          (((job.status === "queued" || job.status === "retrying") && Date.parse(job.runAt) <= now) ||
            (job.status === "running" && Boolean(job.lockedAt) && Date.parse(job.lockedAt ?? "") <= now - staleAfterMs)),
      )
      .sort((left, right) => Date.parse(left.runAt) - Date.parse(right.runAt))[0];
    if (!candidate) return null;
    const claimed: BackgroundJobRecord = {
      ...candidate,
      status: "running",
      attempts: candidate.attempts + 1,
      lockedAt: new Date(now).toISOString(),
      lockedBy: workerId,
      updatedAt: new Date(now).toISOString(),
    };
    getStore().jobs.set(claimed.id, claimed);
    return claimed;
  }

  async getJob(jobId: string) {
    return getStore().jobs.get(jobId) ?? null;
  }

  async completeJob(jobId: string, workerId: string) {
    const job = getStore().jobs.get(jobId);
    if (!job || job.lockedBy !== workerId) return;
    const now = new Date().toISOString();
    getStore().jobs.set(job.id, {
      ...job,
      status: "succeeded",
      lockedAt: null,
      lockedBy: null,
      finishedAt: now,
      updatedAt: now,
    });
  }

  async failJob(jobId: string, workerId: string, error: string) {
    const job = getStore().jobs.get(jobId);
    if (!job || job.lockedBy !== workerId) return;
    const exhausted = job.attempts >= job.maxAttempts;
    const now = Date.now();
    getStore().jobs.set(job.id, {
      ...job,
      status: exhausted ? "failed" : "retrying",
      runAt: new Date(now + Math.min(300, 2 ** job.attempts * 5) * 1_000).toISOString(),
      lockedAt: null,
      lockedBy: null,
      lastError: error.slice(0, 4_000),
      finishedAt: exhausted ? new Date(now).toISOString() : null,
      updatedAt: new Date(now).toISOString(),
    });
  }
}

function toJob(row: {
  id: string;
  type: string;
  status: "queued" | "running" | "retrying" | "succeeded" | "failed";
  payload: Record<string, unknown>;
  dedupeKey: string | null;
  attempts: number;
  maxAttempts: number;
  runAt: Date;
  lockedAt: Date | null;
  lockedBy: string | null;
  lastError: string | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): BackgroundJobRecord {
  const scanId = typeof row.payload.scanId === "string" ? row.payload.scanId : "";
  const workspaceId = typeof row.payload.workspaceId === "string" ? row.payload.workspaceId : "";
  return {
    id: row.id,
    type: "scan.run",
    status: row.status,
    payload: { scanId, workspaceId },
    dedupeKey: row.dedupeKey ?? `scan:${scanId}`,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    runAt: row.runAt.toISOString(),
    lockedAt: row.lockedAt?.toISOString() ?? null,
    lockedBy: row.lockedBy,
    lastError: row.lastError,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

class PostgresStateRepository implements StateRepository {
  readonly kind = "postgres" as const;

  /**
   * Real production finding: discovery and triage both checkpoint progress
   * from several concurrent chunks/batches (see onChunkSucceeded in
   * reddit-harshmaur.server.ts's discover(), onBatchSucceeded in
   * openai.server.ts's triageConversations()). Each completion mutates the
   * same in-memory ScanRecord to a monotonically MORE complete checkpoint,
   * then calls saveScan -- but with no ordering guarantee between them,
   * two concurrent saveScan calls for the same scan can have their network
   * round trips finish out of call order. One real scan's Reddit discovery
   * lost 5 of 8 already-completed, already-paid-for query checkpoints this
   * way: a later (more complete) write's round trip finished first, and an
   * earlier (less complete) write's round trip landed after it, silently
   * reverting the row to the smaller snapshot. The next job attempt then
   * saw those 5 queries as not-yet-covered and resubmitted them to Apify.
   * Queuing every write for a given scan id so it cannot start until the
   * previous one for that same id has fully landed guarantees writes hit
   * Postgres in the same order they were enqueued -- which is always
   * call order, which is always monotonic here -- so a later, larger
   * snapshot can never be clobbered by an earlier, smaller one again.
   */
  private readonly scanSaveQueues = new Map<string, Promise<unknown>>();

  async saveWorkspace(record: WorkspaceSessionRecord) {
    const now = new Date();
    await getDb()
      .insert(runtimeWorkspaces)
      .values({
        id: record.id,
        tokenHash: record.tokenHash,
        expiresAt: new Date(record.expiresAt),
        createdAt: new Date(record.createdAt),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: runtimeWorkspaces.id,
        set: { tokenHash: record.tokenHash, expiresAt: new Date(record.expiresAt), updatedAt: now },
      });
  }

  async verifyWorkspaceToken(workspaceId: string, token: string) {
    const [row] = await getDb()
      .select({ tokenHash: runtimeWorkspaces.tokenHash, expiresAt: runtimeWorkspaces.expiresAt })
      .from(runtimeWorkspaces)
      .where(eq(runtimeWorkspaces.id, workspaceId))
      .limit(1);
    return Boolean(
      row && row.expiresAt.getTime() > Date.now() && safeEqual(row.tokenHash, await sha256(token)),
    );
  }

  async workspaceExists(workspaceId: string) {
    const [row] = await getDb()
      .select({ id: runtimeWorkspaces.id })
      .from(runtimeWorkspaces)
      .where(eq(runtimeWorkspaces.id, workspaceId))
      .limit(1);
    return Boolean(row);
  }

  async saveScan(record: ScanRecord) {
    // See scanSaveQueues's doc comment: chain onto whatever is already
    // pending for this exact scan id so writes always land in call order,
    // never in whatever order their network round trips happen to finish.
    const previous = this.scanSaveQueues.get(record.id) ?? Promise.resolve();
    const write = () => this.writeScan(record);
    const next = previous.then(write, write);
    this.scanSaveQueues.set(record.id, next);
    try {
      await next;
    } finally {
      // Only this exact write's own turn, not a newer one queued behind it
      // in the meantime -- drop the entry so the map does not grow forever
      // for scans that have finished checkpointing.
      if (this.scanSaveQueues.get(record.id) === next) this.scanSaveQueues.delete(record.id);
    }
  }

  private async writeScan(record: ScanRecord) {
    const now = new Date(record.updatedAt);
    await getDb()
      .insert(runtimeScans)
      .values({
        id: record.id,
        workspaceId: record.workspaceId,
        websiteUrl: record.websiteUrl,
        status: record.status,
        record,
        createdAt: new Date(record.createdAt),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: runtimeScans.id,
        set: { websiteUrl: record.websiteUrl, status: record.status, record, updatedAt: now },
      });
  }

  async getScan(scanId: string) {
    const [row] = await getDb()
      .select({ record: runtimeScans.record })
      .from(runtimeScans)
      .where(eq(runtimeScans.id, scanId))
      .limit(1);
    return row?.record ?? null;
  }

  async getLatestScan(workspaceId: string) {
    const [row] = await getDb()
      .select({ record: runtimeScans.record })
      .from(runtimeScans)
      .where(and(eq(runtimeScans.workspaceId, workspaceId), eq(runtimeScans.status, "complete")))
      .orderBy(desc(runtimeScans.createdAt))
      .limit(1);
    return row?.record ?? null;
  }

  /** See the memory-store implementation above for why monitoring-kind scans are excluded. */
  async getLatestWorkspaceScan(workspaceId: string) {
    const [row] = await getDb()
      .select({ record: runtimeScans.record })
      .from(runtimeScans)
      .where(
        and(
          eq(runtimeScans.workspaceId, workspaceId),
          sql`(${runtimeScans.record} ->> 'scanKind') IS DISTINCT FROM 'monitoring'`,
        ),
      )
      .orderBy(desc(runtimeScans.createdAt))
      .limit(1);
    return row?.record ?? null;
  }

  async beginScanRun(scanId: string) {
    return getDb().transaction(async (tx) => {
      const [row] = await tx
        .select({ record: runtimeScans.record })
        .from(runtimeScans)
        .where(eq(runtimeScans.id, scanId))
        .limit(1)
        .for("update");
      if (!row) return { state: "missing" as const, scan: null };
      if (row.record.status === "complete") {
        return { state: "complete" as const, scan: row.record };
      }
      if (row.record.status === "running" && !scanRunIsStale(row.record)) {
        return { state: "running" as const, scan: row.record };
      }
      const scan: ScanRecord = {
        ...row.record,
        status: "running",
        updatedAt: new Date().toISOString(),
      };
      await tx
        .update(runtimeScans)
        .set({ status: "running", record: scan, updatedAt: new Date(scan.updatedAt) })
        .where(eq(runtimeScans.id, scanId));
      return { state: "claimed" as const, scan };
    });
  }

  async saveReply(record: ReplyRecord) {
    const now = new Date(record.updatedAt);
    await getDb()
      .insert(runtimeReplies)
      .values({
        id: record.id,
        workspaceId: record.workspaceId,
        scanId: record.scanId,
        status: record.status,
        record,
        createdAt: new Date(record.createdAt),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: runtimeReplies.id,
        set: { status: record.status, record, updatedAt: now },
      });
  }

  async getReply(replyId: string) {
    const [row] = await getDb()
      .select({ record: runtimeReplies.record })
      .from(runtimeReplies)
      .where(eq(runtimeReplies.id, replyId))
      .limit(1);
    return row?.record ?? null;
  }

  async listRepliesForScan(scanId: string) {
    const rows = await getDb()
      .select({ record: runtimeReplies.record })
      .from(runtimeReplies)
      .where(eq(runtimeReplies.scanId, scanId));
    return rows.map((row) => row.record);
  }

  async saveEntitlement(record: EntitlementRecord) {
    const now = new Date(record.updatedAt);
    await getDb()
      .insert(runtimeEntitlements)
      .values({
        workspaceId: record.workspaceId,
        plan: record.plan,
        status: record.status,
        record,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: runtimeEntitlements.workspaceId,
        set: { plan: record.plan, status: record.status, record, updatedAt: now },
      });
  }

  async getEntitlement(workspaceId: string) {
    const [row] = await getDb()
      .select({ record: runtimeEntitlements.record })
      .from(runtimeEntitlements)
      .where(eq(runtimeEntitlements.workspaceId, workspaceId))
      .limit(1);
    const effective = effectiveEntitlement(row?.record ?? null);
    if (effective && row && effective !== row.record) await this.saveEntitlement(effective);
    return effective;
  }

  async saveCheckout(record: CheckoutRecord) {
    const now = new Date();
    await getDb()
      .insert(runtimeCheckouts)
      .values({
        id: record.id,
        workspaceId: record.workspaceId,
        plan: record.plan,
        status: record.status,
        record,
        createdAt: new Date(record.createdAt),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: runtimeCheckouts.id,
        set: { plan: record.plan, status: record.status, record, updatedAt: now },
      });
  }

  async getCheckout(checkoutId: string) {
    const [row] = await getDb()
      .select({ record: runtimeCheckouts.record })
      .from(runtimeCheckouts)
      .where(eq(runtimeCheckouts.id, checkoutId))
      .limit(1);
    return row?.record ?? null;
  }

  async saveConversion(record: ConversionRecord) {
    await getDb()
      .insert(runtimeConversions)
      .values({
        id: record.id,
        workspaceId: record.workspaceId,
        scanId: record.scanId,
        kind: record.kind,
        record,
        createdAt: new Date(record.createdAt),
      })
      .onConflictDoNothing();
  }

  async listConversions(workspaceId: string) {
    const rows = await getDb()
      .select({ record: runtimeConversions.record })
      .from(runtimeConversions)
      .where(eq(runtimeConversions.workspaceId, workspaceId));
    return rows.map((row) => row.record);
  }

  async saveFunnelEvent(record: FunnelEventRecord) {
    await getDb()
      .insert(runtimeFunnelEvents)
      .values({
        id: record.id,
        workspaceId: record.workspaceId,
        scanId: record.scanId,
        name: record.name,
        potentialCustomerCount: record.potentialCustomerCount,
        record,
        createdAt: new Date(record.createdAt),
      })
      .onConflictDoNothing();
  }

  async saveRedditConnection(record: RedditConnectionRecord) {
    const updatedAt = new Date(record.updatedAt);
    await getDb()
      .insert(runtimeRedditConnections)
      .values({
        workspaceId: record.workspaceId,
        redditUserId: record.redditUserId,
        username: record.username,
        record,
        createdAt: new Date(record.connectedAt),
        updatedAt,
      })
      .onConflictDoUpdate({
        target: runtimeRedditConnections.workspaceId,
        set: {
          redditUserId: record.redditUserId,
          username: record.username,
          record,
          updatedAt,
        },
      });
  }

  async getRedditConnection(workspaceId: string) {
    const [row] = await getDb()
      .select({ record: runtimeRedditConnections.record })
      .from(runtimeRedditConnections)
      .where(eq(runtimeRedditConnections.workspaceId, workspaceId))
      .limit(1);
    return row?.record ?? null;
  }

  async deleteRedditConnection(workspaceId: string) {
    await getDb()
      .delete(runtimeRedditConnections)
      .where(eq(runtimeRedditConnections.workspaceId, workspaceId));
  }

  async claimRedditPublication(record: RedditPublicationRecord): Promise<RedditPublicationClaim> {
    return getDb().transaction(async (tx) => {
      const [inserted] = await tx
        .insert(runtimeRedditPublications)
        .values({
          replyId: record.replyId,
          workspaceId: record.workspaceId,
          status: record.status,
          record,
          createdAt: new Date(record.createdAt),
          updatedAt: new Date(record.updatedAt),
        })
        .onConflictDoNothing()
        .returning({ replyId: runtimeRedditPublications.replyId });
      if (inserted) return { state: "claimed" as const, record };

      const [existingRow] = await tx
        .select({ record: runtimeRedditPublications.record })
        .from(runtimeRedditPublications)
        .where(eq(runtimeRedditPublications.replyId, record.replyId))
        .limit(1)
        .for("update");
      if (!existingRow) throw new Error("The Reddit publication claim disappeared.");
      const existing = existingRow.record;
      if (existing.status === "succeeded") return { state: "succeeded" as const, record: existing };
      if (existing.status === "unknown") return { state: "unknown" as const, record: existing };
      if (existing.status === "pending") return { state: "pending" as const, record: existing };

      const retried: RedditPublicationRecord = {
        ...record,
        attempts: existing.attempts + 1,
        createdAt: existing.createdAt,
      };
      await tx
        .update(runtimeRedditPublications)
        .set({ status: "pending", record: retried, updatedAt: new Date(retried.updatedAt) })
        .where(eq(runtimeRedditPublications.replyId, retried.replyId));
      return { state: "claimed" as const, record: retried };
    });
  }

  async saveRedditPublication(record: RedditPublicationRecord) {
    await getDb()
      .insert(runtimeRedditPublications)
      .values({
        replyId: record.replyId,
        workspaceId: record.workspaceId,
        status: record.status,
        record,
        createdAt: new Date(record.createdAt),
        updatedAt: new Date(record.updatedAt),
      })
      .onConflictDoUpdate({
        target: runtimeRedditPublications.replyId,
        set: { status: record.status, record, updatedAt: new Date(record.updatedAt) },
      });
  }

  async getRedditPublication(replyId: string) {
    const [row] = await getDb()
      .select({ record: runtimeRedditPublications.record })
      .from(runtimeRedditPublications)
      .where(eq(runtimeRedditPublications.replyId, replyId))
      .limit(1);
    return row?.record ?? null;
  }

  async commitStripeEvent(commit: StripeStateCommit) {
    return getDb().transaction(async (tx) => {
      const committedAt = new Date();
      const [inserted] = await tx
        .insert(stripeEvents)
        .values({
          stripeEventId: commit.eventId,
          type: commit.eventType,
          livemode: commit.livemode,
          payload: commit.eventPayload,
          signatureVerified: true,
          processedAt: committedAt,
        })
        .onConflictDoNothing({ target: stripeEvents.stripeEventId })
        .returning({ id: stripeEvents.id });
      if (!inserted) return false;

      let entitlement = commit.entitlement;
      if (entitlement && entitlement.verifiedByEventId !== commit.eventId) {
        throw new Error("The entitlement did not reference the verified Stripe event.");
      }
      if (
        entitlement?.status === "active" &&
        (entitlement.plan === "pass" || entitlement.plan === "core")
      ) {
        if (
          commit.checkout &&
          (commit.checkout.status !== "completed" ||
            commit.checkout.workspaceId !== entitlement.workspaceId ||
            commit.checkout.plan !== entitlement.plan)
        ) {
          throw new Error("The completed checkout did not match the entitlement.");
        }

        let seedScanId = commit.checkout?.scanId ?? entitlement.seedScanId;
        if (!commit.checkout) {
          const [existingSchedule] = await tx
            .select({ seedScanId: runtimeMonitoringSchedules.seedScanId })
            .from(runtimeMonitoringSchedules)
            .where(eq(runtimeMonitoringSchedules.workspaceId, entitlement.workspaceId))
            .limit(1);
          seedScanId = existingSchedule?.seedScanId ?? seedScanId;
        }
        if (!seedScanId) {
          throw new Error("The entitlement did not identify a purchased scan.");
        }

        const [seedScan] = await tx
          .select({
            id: runtimeScans.id,
            workspaceId: runtimeScans.workspaceId,
            websiteUrl: runtimeScans.websiteUrl,
            status: runtimeScans.status,
            record: runtimeScans.record,
          })
          .from(runtimeScans)
          .where(
            and(
              eq(runtimeScans.id, seedScanId),
              eq(runtimeScans.workspaceId, entitlement.workspaceId),
              eq(runtimeScans.status, "complete"),
            ),
          )
          .limit(1)
          .for("share");
        if (!seedScan || seedScan.status !== "complete" || !seedScan.record.result) {
          throw new Error("The purchased scan was not an owned completed scan.");
        }
        entitlement = {
          ...entitlement,
          seedScanId: seedScan.id,
          websiteUrl: seedScan.websiteUrl,
        };
      }

      if (entitlement) {
        const record = entitlement;
        await tx
          .insert(runtimeEntitlements)
          .values({
            workspaceId: record.workspaceId,
            plan: record.plan,
            status: record.status,
            record,
            updatedAt: new Date(record.updatedAt),
          })
          .onConflictDoUpdate({
            target: runtimeEntitlements.workspaceId,
            set: {
              plan: record.plan,
              status: record.status,
              record,
              updatedAt: new Date(record.updatedAt),
            },
          });
      }
      if (commit.checkout) {
        const record = commit.checkout;
        await tx
          .insert(runtimeCheckouts)
          .values({
            id: record.id,
            workspaceId: record.workspaceId,
            plan: record.plan,
            status: record.status,
            record,
            createdAt: new Date(record.createdAt),
            updatedAt: committedAt,
          })
          .onConflictDoUpdate({
            target: runtimeCheckouts.id,
            set: { status: record.status, record, updatedAt: committedAt },
          });
      }

      if (
        entitlement?.status === "active" &&
        (entitlement.plan === "pass" || entitlement.plan === "core")
      ) {
        if (!entitlement.seedScanId || !entitlement.websiteUrl) {
          throw new Error("The active entitlement was not pinned to a website scan.");
        }
        const cadenceSeconds = monitoringCadenceSeconds(entitlement.plan);
        const entitlementUpdatedAt = Date.parse(entitlement.updatedAt);
        if (!Number.isFinite(entitlementUpdatedAt)) {
          throw new Error("The entitlement timestamp was invalid.");
        }
        const nextRunAt = new Date(entitlementUpdatedAt + cadenceSeconds * 1_000);
        const scheduleUpdate = commit.checkout
          ? {
              seedScanId: entitlement.seedScanId,
              websiteUrl: entitlement.websiteUrl,
              plan: entitlement.plan,
              cadenceSeconds,
              nextRunAt,
              lastScanId: null,
              enabled: true,
              updatedAt: committedAt,
            }
          : {
              seedScanId: entitlement.seedScanId,
              websiteUrl: entitlement.websiteUrl,
              plan: entitlement.plan,
              cadenceSeconds,
              enabled: true,
              updatedAt: committedAt,
            };
        await tx
          .insert(runtimeMonitoringSchedules)
          .values({
            workspaceId: entitlement.workspaceId,
            seedScanId: entitlement.seedScanId,
            websiteUrl: entitlement.websiteUrl,
            plan: entitlement.plan,
            cadenceSeconds,
            nextRunAt,
            lastScanId: null,
            enabled: true,
            updatedAt: committedAt,
          })
          .onConflictDoUpdate({
            target: runtimeMonitoringSchedules.workspaceId,
            set: scheduleUpdate,
          });
      } else if (entitlement) {
        await tx
          .update(runtimeMonitoringSchedules)
          .set({ enabled: false, updatedAt: committedAt })
          .where(eq(runtimeMonitoringSchedules.workspaceId, entitlement.workspaceId));
      }
      return true;
    });
  }

  async enqueueScan(scanId: string, workspaceId: string) {
    const dedupeKey = `scan:${scanId}`;
    const [inserted] = await getDb()
      .insert(backgroundJobs)
      .values({
        type: "scan.run",
        payload: { scanId, workspaceId },
        dedupeKey,
        maxAttempts: configuredMaxAttempts(),
      })
      .onConflictDoNothing()
      .returning();
    if (inserted) return toJob(inserted);
    const [existing] = await getDb()
      .select()
      .from(backgroundJobs)
      .where(eq(backgroundJobs.dedupeKey, dedupeKey))
      .limit(1);
    if (!existing) throw new Error("Could not enqueue scan job.");
    return toJob(existing);
  }

  async claimJob(workerId: string, staleAfterMs = 15 * 60_000) {
    const staleBefore = new Date(Date.now() - staleAfterMs);
    const rows = await getDb().execute(sql`
      WITH candidate AS (
        SELECT id
        FROM background_jobs
        WHERE (
          (status IN ('queued', 'retrying') AND run_at <= now())
          OR (status = 'running' AND locked_at <= ${staleBefore})
        )
        AND type = 'scan.run'
        AND attempts < max_attempts
        ORDER BY run_at ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE background_jobs AS job
      SET status = 'running',
          attempts = job.attempts + 1,
          locked_at = now(),
          locked_by = ${workerId},
          updated_at = now()
      FROM candidate
      WHERE job.id = candidate.id
      RETURNING job.*
    `);
    const row = (rows as unknown as Array<{
      id: string;
      type: string;
      status: BackgroundJobRecord["status"];
      payload: Record<string, unknown>;
      dedupe_key: string | null;
      attempts: number;
      max_attempts: number;
      run_at: Date;
      locked_at: Date | null;
      locked_by: string | null;
      last_error: string | null;
      finished_at: Date | null;
      created_at: Date;
      updated_at: Date;
    }>)[0];
    if (!row) return null;
    return toJob({
      id: row.id,
      type: row.type,
      status: row.status,
      payload: row.payload,
      dedupeKey: row.dedupe_key,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      runAt: new Date(row.run_at),
      lockedAt: row.locked_at ? new Date(row.locked_at) : null,
      lockedBy: row.locked_by,
      lastError: row.last_error,
      finishedAt: row.finished_at ? new Date(row.finished_at) : null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    });
  }

  async getJob(jobId: string) {
    const [row] = await getDb()
      .select()
      .from(backgroundJobs)
      .where(and(eq(backgroundJobs.id, jobId), eq(backgroundJobs.type, "scan.run")))
      .limit(1);
    return row ? toJob(row) : null;
  }

  async completeJob(jobId: string, workerId: string) {
    await getDb()
      .update(backgroundJobs)
      .set({
        status: "succeeded",
        lockedAt: null,
        lockedBy: null,
        finishedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(backgroundJobs.id, jobId), eq(backgroundJobs.lockedBy, workerId)));
  }

  async failJob(jobId: string, workerId: string, error: string) {
    const job = await this.getJob(jobId);
    if (!job || job.lockedBy !== workerId) return;
    const exhausted = job.attempts >= job.maxAttempts;
    const now = Date.now();
    await getDb()
      .update(backgroundJobs)
      .set({
        status: exhausted ? "failed" : "retrying",
        runAt: new Date(now + Math.min(300, 2 ** job.attempts * 5) * 1_000),
        lockedAt: null,
        lockedBy: null,
        lastError: error.slice(0, 4_000),
        finishedAt: exhausted ? new Date(now) : null,
        updatedAt: new Date(now),
      })
      .where(and(eq(backgroundJobs.id, jobId), eq(backgroundJobs.lockedBy, workerId)));
  }
}

const memoryRepository = new MemoryStateRepository();
const postgresRepository = new PostgresStateRepository();

export function getStateRepository(): StateRepository {
  const configured = process.env.STATE_STORE?.trim().toLowerCase();
  if (configured && configured !== "memory" && configured !== "postgres") {
    throw new Error("STATE_STORE must be `memory` or `postgres`.");
  }
  if (configured === "memory") {
    if (isProductionRuntime()) {
      throw new Error("STATE_STORE=memory is forbidden in production.");
    }
    return memoryRepository;
  }
  if (configured === "postgres" || process.env.DATABASE_URL) return postgresRepository;
  if (isProductionRuntime()) {
    throw new Error("DATABASE_URL and STATE_STORE=postgres are required in production.");
  }
  return memoryRepository;
}

export async function getEffectiveEntitlement(workspaceId: string): Promise<EntitlementRecord> {
  const repository = getStateRepository();
  return (
    (await repository.getEntitlement(workspaceId)) ?? {
      workspaceId,
      plan: "free",
      status: "active",
      accessUntil: null,
      seedScanId: null,
      websiteUrl: null,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      verifiedByEventId: null,
      updatedAt: new Date().toISOString(),
    }
  );
}
