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
export function sameExecution(lease: ScanExecutionLease | undefined, owner: ScanExecutionOwner): boolean {
  return !!lease && lease.token === owner.token && lease.jobId === owner.jobId
    && lease.workerId === owner.workerId && lease.attempt === owner.attempt;
}
export function liveExecution(lease: ScanExecutionLease | undefined, now = Date.now()): boolean {
  return !!lease?.active && now - Date.parse(lease.heartbeatAt) < SCAN_EXECUTION_LEASE_MS;
}

/** Heartbeats are ownership checks, not evidence of completed scan work. */
export function maintainScanExecution(refresh: () => Promise<void>, intervalMs = 15_000) {
  const controller = new AbortController();
  let pending: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (pending || controller.signal.aborted) return;
    pending = refresh().catch(() => controller.abort(new ScanOwnershipLostError())).finally(() => { pending = undefined; });
  }, intervalMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    lose() { controller.abort(new ScanOwnershipLostError()); },
    async check() {
      controller.signal.throwIfAborted();
      try { await refresh(); } catch { controller.abort(new ScanOwnershipLostError()); }
      controller.signal.throwIfAborted();
    },
    async stop() { clearInterval(timer); await pending; },
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
