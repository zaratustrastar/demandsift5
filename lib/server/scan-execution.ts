/** Database-enforced execution identity; never sent to public clients. */
export type ScanExecutionOwner = { token: string; jobId?: string; attempt?: number; workerId?: string };
export type ScanExecutionLease = ScanExecutionOwner & { heartbeatAt: string; active: boolean };
export const SCAN_EXECUTION_LEASE_MS = 90_000;

export class ScanOwnershipLostError extends Error {
  readonly name = "ApiError";
  readonly code = "scan_ownership_lost";
  readonly status = 409;
  constructor() { super("This scan execution no longer owns the saved work."); }
}
export class ScanWriteConflictError extends Error {
  readonly name = "ApiError";
  readonly code = "scan_write_conflict";
  readonly status = 409;
  constructor() { super("The scan changed while this update was being prepared. Refresh and try again."); }
}
/**
 * A detached scan execution (app/api/internal/jobs/[jobId]/execute/route.ts
 * starts runScan() as a fire-and-forget promise, tracked only in an
 * in-memory Map, and returns the HTTP response immediately) has no caller
 * left to time it out. The background worker's own poll loop
 * (waitForScanExecution in scripts/background-worker.mjs) has a ceiling,
 * but that only stops the *worker* from waiting -- it does not reach back
 * into the web process and cancel the execution that's still running
 * there. Once the worker gives up, `scan_execution_timeout` is a terminal,
 * non-retryable job error, so nothing ever reclaims that job again either:
 * the orphaned execution just keeps running, unsupervised, for as long as
 * whatever it's doing (or waiting on) takes -- potentially forever, if it
 * hits an await with no bound of its own. This is a *second*, independent
 * ceiling: not "how long will the worker wait for an answer" but "how long
 * can this execution run before it must give up on itself and let the scan
 * record reach a terminal state." Deliberately reuses the same
 * `scan_execution_timeout` code the worker's own timeout already produces,
 * so both call sites are classified identically by
 * lib/server/job-retry-classification.ts and scripts/background-worker.mjs.
 */
export class ScanExecutionTimeoutError extends Error {
  readonly name = "ApiError";
  readonly code = "scan_execution_timeout";
  readonly status = 504;
  constructor(maxDurationMs: number) {
    super(`Scan execution exceeded its ${Math.round(maxDurationMs / 60_000)}-minute ceiling and was aborted.`);
  }
}
export function sameExecution(lease: ScanExecutionLease | undefined, owner: ScanExecutionOwner): boolean {
  return !!lease && lease.token === owner.token && lease.jobId === owner.jobId
    && lease.workerId === owner.workerId && lease.attempt === owner.attempt;
}
export function liveExecution(lease: ScanExecutionLease | undefined, now = Date.now()): boolean {
  return !!lease?.active && now - Date.parse(lease.heartbeatAt) < SCAN_EXECUTION_LEASE_MS;
}

/**
 * Heartbeats are ownership checks, not evidence of completed scan work.
 * `maxDurationMs`, when given, is an absolute wall-clock ceiling on the
 * whole execution -- independent of whether the ownership heartbeat keeps
 * succeeding -- so a hung or unexpectedly slow execution still eventually
 * aborts and lets the scan reach a terminal DB state instead of running
 * orphaned indefinitely. Omit it (as every existing caller other than
 * runScan does) to keep the previous heartbeat-only behavior.
 */
export function maintainScanExecution(refresh: () => Promise<void>, intervalMs = 15_000, maxDurationMs?: number) {
  const controller = new AbortController();
  let pending: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (pending || controller.signal.aborted) return;
    pending = refresh().catch(() => controller.abort(new ScanOwnershipLostError())).finally(() => { pending = undefined; });
  }, intervalMs);
  timer.unref?.();
  const deadline = maxDurationMs && maxDurationMs > 0
    ? setTimeout(() => controller.abort(new ScanExecutionTimeoutError(maxDurationMs)), maxDurationMs)
    : undefined;
  deadline?.unref?.();
  return {
    signal: controller.signal,
    lose() { controller.abort(new ScanOwnershipLostError()); },
    async check() {
      controller.signal.throwIfAborted();
      try { await refresh(); } catch { controller.abort(new ScanOwnershipLostError()); }
      controller.signal.throwIfAborted();
    },
    async stop() { clearInterval(timer); if (deadline) clearTimeout(deadline); await pending; },
    wrapFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
      return async (input, init) => {
        controller.signal.throwIfAborted();
        try { await refresh(); } catch { controller.abort(new ScanOwnershipLostError()); }
        controller.signal.throwIfAborted();
        const inputSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        return fetchImpl(input, { ...init, signal: inputSignal
          ? AbortSignal.any([inputSignal, controller.signal]) : controller.signal });
      };
    },
  };
}
