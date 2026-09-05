import { createHash } from "node:crypto";
import { abortableDelay } from "../ai/bounded-dispatcher";
import { retryAfterMs } from "../ai/recovery-budget";
import { ApifyTransientError, isApifyRetryableHttpStatus } from "./apify-retry";
import type { RedditActorCheckpoint } from "./contracts";

type Receipt = { actorId: string; inputHash: string; attempts: number; startedAt: string; deadlineAt: number;
  actorRunId?: string; datasetId?: string; status: string; retryableTerminal?: boolean; notBeforeAt?: number };
export type ApifyRunLedger = Record<string, Receipt>;
export class ApifyRecoveryError extends Error {
  constructor(readonly code: "apify_start_ambiguous" | "apify_recovery_exhausted" | "apify_reconciliation_required" | "provider_auth_failed" | "provider_invalid_request", message: string) { super(message); }
}
const terminal = new Set(["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"]);
const string = (value: unknown) => typeof value === "string" ? value.slice(0, 120) : "";
type RunOptions = {
  actorId: string; actorInput: object; platformMaxItems: number; wantedItems: number;
  maxChargeUsd: number; timeoutMs: number; actorTimeoutSeconds?: number; maxStarts?: number;
  token: string; fetchImpl: typeof fetch; signal?: AbortSignal; label: string;
  maximumMetadataBytes?: number; maximumDatasetPageBytes?: number;
  /** Existing intentional semantic recovery, distinct from retrying a lost poll. */
  purpose?: "mapping-recovery";
  onStarted?: (checkpoint: RedditActorCheckpoint) => Promise<void>;
};

type ActorCapacity = {
  acquire(input: {
    pool: "apify-actor";
    holderKey: string;
    workspaceId: string;
    limit: number;
    leaseMs: number;
    signal?: AbortSignal;
  }): Promise<{ release(): Promise<boolean> }>;
};

/** One ledger per scan. No cross-scan result caching. Known runs are always
 * inspected before replacement; unknown outcomes fail closed without a new
 * paid POST. A confirmed failed terminal run alone permits another start. */
export class ApifyRunRecovery {
  private readonly inFlight = new Map<string, Promise<unknown[]>>();
  constructor(private readonly options: { ledger: ApifyRunLedger; onChange?: () => Promise<void>;
    previousRuns?: readonly RedditActorCheckpoint[]; actorCapacity?: ActorCapacity;
    actorCapacityLimit?: number; workspaceId?: string; holderPrefix?: string } = { ledger: {} }) {
    for (const previous of [...(options.previousRuns ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt))) {
      options.ledger[previous.inputHash] ??= { ...previous, attempts: 1, status: "UNKNOWN", deadlineAt: Date.parse(previous.startedAt) + 900_000 };
    }
  }
  run(options: RunOptions): Promise<unknown[]> {
    const inputHash = createHash("sha256").update(JSON.stringify({ actorId: options.actorId,
      actorInput: options.actorInput, platformMaxItems: options.platformMaxItems,
      ...(options.purpose ? { purpose: options.purpose } : {}) })).digest("hex");
    const active = this.inFlight.get(inputHash); if (active) return active;
    const running = this.execute(inputHash, options).finally(() => this.inFlight.delete(inputHash));
    this.inFlight.set(inputHash, running); return running;
  }
  private async execute(inputHash: string, options: RunOptions): Promise<unknown[]> {
    options.signal?.throwIfAborted();
    let receipt = this.options.ledger[inputHash];
    const capacityLease = this.options.actorCapacity && this.options.workspaceId
      ? await this.options.actorCapacity.acquire({
          pool: "apify-actor",
          holderKey: `${this.options.holderPrefix ?? this.options.workspaceId}:${inputHash}`,
          workspaceId: this.options.workspaceId,
          limit: this.options.actorCapacityLimit ?? 1,
          // Cover the Actor lifecycle, not each short status/dataset request.
          // Crash recovery gets enough grace to inspect the durable run ID.
          leaseMs: options.timeoutMs + 120_000,
          signal: options.signal,
        })
      : null;
    if (receipt && !receipt.actorRunId && !receipt.retryableTerminal) throw new ApifyRecoveryError("apify_start_ambiguous",
      "A previous Apify start has an unknown outcome. Reconciliation is required before another paid run can start.");
    const resume = Boolean(receipt?.actorRunId && !receipt.retryableTerminal);
    const controller = new AbortController();
    // An overdue saved run gets a bounded status reconciliation, not another
    // full execution timeout and not a blind replacement.
    const remaining = resume ? Math.max(30_000, Math.min(options.timeoutMs, receipt.deadlineAt - Date.now())) : options.timeoutMs;
    const timer = setTimeout(() => controller.abort(), remaining);
    const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const headers = { accept: "application/json", authorization: `Bearer ${options.token}`, "content-type": "application/json" };
    const save = () => this.options.onChange?.() ?? Promise.resolve();
    const waitCooldown = async () => {
      const wait = (receipt?.notBeforeAt ?? 0) - Date.now();
      if (wait > 1_800_000) throw new ApifyRecoveryError("apify_reconciliation_required", "Apify cooldown exceeds the execution deadline.");
      if (wait > 0) await abortableDelay(wait, signal);
    };
    const statusUrl = (id: string) => new URL(`/v2/actor-runs/${encodeURIComponent(id)}`, "https://api.apify.com");
    const json = async (response: Response, maximum?: number): Promise<unknown> => {
      if (maximum && Number(response.headers.get("content-length") ?? 0) > maximum) throw new Error(`${options.label} response exceeded the size limit.`);
      const raw = await response.text();
      if (maximum && (Number(response.headers.get("content-length") ?? 0) > maximum || new TextEncoder().encode(raw).byteLength > maximum)) {
        throw new Error(`${options.label} response exceeded the size limit.`);
      }
      if (!response.ok) {
        const message = `${options.label} request failed with HTTP ${response.status}.`;
        if (response.status === 401 || response.status === 403) throw new ApifyRecoveryError("provider_auth_failed", message);
        if (response.status >= 400 && response.status < 500 && !isApifyRetryableHttpStatus(response.status)) throw new ApifyRecoveryError("provider_invalid_request", message);
        throw isApifyRetryableHttpStatus(response.status) ? new ApifyTransientError(message) : new Error(message);
      }
      try { return raw ? JSON.parse(raw) : {}; }
      catch { throw new Error(`${options.label} returned invalid JSON.`); }
    };
    const metadata = (payload: unknown): Record<string, unknown> => {
      const data = (payload as { data?: unknown } | null)?.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${options.label} returned invalid run metadata.`);
      return data as Record<string, unknown>;
    };
    const safeGet = async (url: URL): Promise<Response> => {
      for (let attempt = 0; attempt < 3; attempt++) {
        signal.throwIfAborted(); let delay = Math.min(500 * 2 ** attempt, 2_000);
        await waitCooldown();
        try {
          const response = await options.fetchImpl(url, { method: "GET", headers, signal });
          if (!isApifyRetryableHttpStatus(response.status)) return response;
          const requested = retryAfterMs(response.headers.get("retry-after"));
          if (requested !== undefined) { receipt.notBeforeAt = Date.now() + requested; await save(); delay = requested; }
          if (attempt === 2) return response;
          await response.text().catch(() => "");
        } catch (error) {
          signal.throwIfAborted();
          if (attempt === 2) throw new ApifyTransientError(`${options.label} GET request failed: ${error instanceof Error ? error.message : "network failure"}`);
        }
        // Avoid overflowing timers. The execution's abort signal bounds a
        // long server cooldown; never shorten it and issue an early request.
        if (delay > 1_800_000) throw new ApifyRecoveryError("apify_reconciliation_required", "Apify requested a cooldown beyond this execution's deadline.");
        await abortableDelay(delay, signal);
      }
      throw new ApifyTransientError(`${options.label} GET request failed.`);
    };
    const update = async (data: Record<string, unknown>) => {
      const id = string(data.id);
      if (id && receipt.actorRunId && id !== receipt.actorRunId) throw new ApifyRecoveryError("apify_reconciliation_required", "Apify returned mismatched run metadata.");
      receipt.actorRunId = id || receipt.actorRunId;
      receipt.status = string(data.status).toUpperCase();
      receipt.datasetId = string(data.defaultDatasetId) || receipt.datasetId;
      await save();
      if (!receipt.actorRunId || !receipt.status) throw new ApifyRecoveryError("apify_reconciliation_required", `${options.label} returned incomplete run metadata.`);
    };
    try {
      if (resume) {
        await options.onStarted?.({ actorId: receipt.actorId, actorRunId: receipt.actorRunId!, datasetId: receipt.datasetId ?? "", inputHash, startedAt: receipt.startedAt });
        // SUCCEEDED is still inspected: do not trust a stale receipt or launch
        // another run just because the previous dataset read was interrupted.
        await update(metadata(await json(await safeGet(statusUrl(receipt.actorRunId!)), options.maximumMetadataBytes)));
      } else {
        if ((receipt?.attempts ?? 0) >= (options.maxStarts ?? 3)) throw new ApifyRecoveryError("apify_recovery_exhausted", "Apify start budget exhausted; saved results are retained and search coverage is incomplete.");
        await waitCooldown();
        receipt = this.options.ledger[inputHash] = { actorId: options.actorId, inputHash, attempts: (receipt?.attempts ?? 0) + 1,
          startedAt: new Date().toISOString(), deadlineAt: Date.now() + options.timeoutMs, status: "STARTING" };
        await save(); // Persist intent before the non-idempotent request.
        const url = new URL(`/v2/actors/${encodeURIComponent(options.actorId)}/runs`, "https://api.apify.com");
        url.searchParams.set("waitForFinish", "0");
        url.searchParams.set("timeout", String(options.actorTimeoutSeconds ?? Math.ceil(options.timeoutMs / 1_000)));
        url.searchParams.set("maxItems", String(options.platformMaxItems));
        url.searchParams.set("maxTotalChargeUsd", options.maxChargeUsd.toFixed(2));
        let response: Response;
        try { response = await options.fetchImpl(url, { method: "POST", headers, body: JSON.stringify(options.actorInput), signal }); }
        catch {
          options.signal?.throwIfAborted();
          throw new ApifyRecoveryError("apify_start_ambiguous", "Apify start response was lost; the run may exist. No duplicate run was started.");
        }
        if (response.status >= 500 || response.status === 408) {
          await response.text().catch(() => "");
          throw new ApifyRecoveryError("apify_start_ambiguous", `Apify start returned HTTP ${response.status}; acceptance is uncertain. No duplicate run was started.`);
        }
        if (response.status === 429) {
          const delay = retryAfterMs(response.headers.get("retry-after"));
          receipt.status = "START_REJECTED"; receipt.retryableTerminal = true;
          if (delay !== undefined) receipt.notBeforeAt = Date.now() + delay;
          await save();
          await response.text().catch(() => "");
          if (delay !== undefined) {
            if (delay > options.timeoutMs) throw new ApifyRecoveryError("apify_recovery_exhausted", "Apify cooldown exceeds the execution deadline.");
            await abortableDelay(delay, signal);
          }
          throw new ApifyTransientError("Apify start was rate limited (HTTP 429).");
        }
        if (!response.ok && response.status >= 400 && response.status < 500) {
          receipt.status = "START_REJECTED"; receipt.retryableTerminal = true; await save();
        }
        let data: Record<string, unknown>;
        try { data = metadata(await json(response, options.maximumMetadataBytes)); }
        catch (error) {
          if (error instanceof ApifyRecoveryError) throw error;
          throw new ApifyRecoveryError("apify_start_ambiguous", "Apify start returned unreadable metadata; acceptance is uncertain.");
        }
        if (!string(data.id)) throw new ApifyRecoveryError("apify_start_ambiguous", "Apify start did not return a run ID; acceptance is uncertain.");
        await update(data);
        await options.onStarted?.({ actorId: options.actorId, actorRunId: receipt.actorRunId!, datasetId: receipt.datasetId ?? "",
          inputHash, startedAt: receipt.startedAt });
      }
      while (!terminal.has(receipt.status)) {
        const url = statusUrl(receipt.actorRunId!); url.searchParams.set("waitForFinish", "60");
        await update(metadata(await json(await safeGet(url), options.maximumMetadataBytes)));
      }
      const partial = receipt.status === "TIMED-OUT" && !!receipt.datasetId;
      if ((receipt.status !== "SUCCEEDED" && !partial) || !receipt.datasetId) {
        receipt.retryableTerminal = receipt.status !== "SUCCEEDED"; await save();
        throw new ApifyTransientError(`${options.label} run ended with status ${receipt.status} without a usable dataset.`);
      }
      const payload: unknown[] = [];
      for (let offset = 0; offset < options.wantedItems; offset += 100) {
        const limit = Math.min(100, options.wantedItems - offset);
        const url = new URL(`/v2/datasets/${encodeURIComponent(receipt.datasetId)}/items`, "https://api.apify.com");
        for (const [key, value] of Object.entries({ clean: "true", format: "json", limit: String(limit), offset: String(offset) })) url.searchParams.set(key, value);
        const page = await json(await safeGet(url), options.maximumDatasetPageBytes);
        if (!Array.isArray(page)) throw new Error(`${options.label} returned an invalid dataset.`);
        payload.push(...page); if (page.length < limit) break;
      }
      if (partial && !payload.length) {
        receipt.retryableTerminal = true; await save();
        throw new ApifyTransientError(`The timed-out ${options.label} run did not retain any usable records.`);
      }
      return payload;
    } catch (error) {
      // An old owner cannot abort a run now owned by its successor. For other
      // failures, a best-effort abort is NOT proof of termination: persist and
      // inspect its returned status, otherwise the next attempt resumes GETs.
      if (receipt?.actorRunId && !terminal.has(receipt.status) && !options.signal?.aborted) {
        const url = new URL(`/v2/actor-runs/${encodeURIComponent(receipt.actorRunId)}/abort`, "https://api.apify.com");
        try {
          const response = await options.fetchImpl(url, { method: "POST", headers, signal: AbortSignal.timeout(5_000) });
          if (response.ok) {
            await update(metadata(await json(response, options.maximumMetadataBytes)));
            if (terminal.has(receipt.status) && receipt.status !== "SUCCEEDED") { receipt.retryableTerminal = true; await save(); }
          }
        } catch { /* Keep the existing run ID; no replacement is authorized. */ }
      }
      options.signal?.throwIfAborted();
      if (error instanceof ApifyRecoveryError) throw error;
      if (controller.signal.aborted) throw new ApifyTransientError(`${options.label} run timed out after ${Math.ceil(options.timeoutMs / 1_000)} seconds.`);
      throw error;
    } finally {
      clearTimeout(timer);
      // Ambiguous starts and known-running Actors deliberately keep their
      // lease until expiry. A later owner reconciles the saved run before it
      // may start replacement work.
      if (!receipt || terminal.has(receipt.status) || receipt.status === "START_REJECTED") {
        await capacityLease?.release().catch(() => false);
      }
    }
  }
}
