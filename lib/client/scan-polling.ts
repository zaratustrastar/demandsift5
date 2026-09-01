export const SCAN_POLL_INTERVAL_MS = 3_000;
export const HIDDEN_SCAN_POLL_INTERVAL_MS = 30_000;
export const SCAN_POLL_BACKOFF_BASE_MS = 1_500;
export const SCAN_POLL_BACKOFF_MAX_MS = 10_000;

export function isTransientPollFailure(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return error instanceof Error && (error.name === "AbortError"
    || /networkerror|failed to fetch|fetch failed|load failed|network request failed/i.test(error.message));
}

export type PollEnvironment = {
  visible(): boolean;
  timer(callback: () => void, ms: number): () => void;
  subscribeWake(callback: () => void): () => void;
};
function browserEnvironment(): PollEnvironment {
  return {
    visible: () => document.visibilityState !== "hidden",
    timer: (callback, ms) => { const id = window.setTimeout(callback, ms); return () => window.clearTimeout(id); },
    subscribeWake: callback => {
      const visibility = () => { if (document.visibilityState !== "hidden") callback(); };
      window.addEventListener("focus", callback); window.addEventListener("online", callback);
      document.addEventListener("visibilitychange", visibility);
      return () => {
        window.removeEventListener("focus", callback); window.removeEventListener("online", callback);
        document.removeEventListener("visibilitychange", visibility);
      };
    },
  };
}

/** A single-flight poll loop: focus can wake a timer, never duplicate a request.
 * A task may fetch status and then the full report sequentially before returning.
 * No mutations/scan creation are inferred from a failed status request. */
export function startScanPolling(options: {
  run(signal: AbortSignal): Promise<boolean>;
  onConnectionChange?(connected: boolean): void;
  onError(error: unknown): void;
  environment?: PollEnvironment;
  requestTimeoutMs?: number;
}) {
  const env = options.environment ?? browserEnvironment();
  let stopped = false, inFlight = false, wakeRequested = false, failures = 0;
  let cancelTimer: (() => void) | undefined;
  let controller: AbortController | undefined;
  const stop = () => { stopped = true; cancelTimer?.(); unsubscribe(); controller?.abort(); };
  const wake = () => {
    if (stopped) return;
    cancelTimer?.();
    if (inFlight) { wakeRequested = true; return; }
    void tick();
  };
  const unsubscribe = env.subscribeWake(wake);
  async function tick() {
    if (stopped || inFlight) return;
    inFlight = true; controller = new AbortController();
    const cancelTimeout = env.timer(() => controller?.abort(), options.requestTimeoutMs ?? 30_000);
    try {
      const done = await options.run(controller.signal);
      if (stopped) return;
      failures = 0; options.onConnectionChange?.(true);
      if (done) { stop(); return; }
    } catch (error) {
      if (stopped) return;
      if (!isTransientPollFailure(error)) { stop(); options.onError(error); return; }
      failures += 1; options.onConnectionChange?.(false);
    } finally { cancelTimeout(); inFlight = false; }
    if (stopped) return;
    const retryDelay = failures ? Math.min(SCAN_POLL_BACKOFF_MAX_MS, SCAN_POLL_BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 3)) : SCAN_POLL_INTERVAL_MS;
    const delay = !env.visible() ? Math.max(HIDDEN_SCAN_POLL_INTERVAL_MS, retryDelay) : wakeRequested ? 0 : retryDelay;
    wakeRequested = false;
    cancelTimer = env.timer(() => void tick(), delay);
  }
  void tick();
  return { stop, refresh: wake };
}

export async function readScanResponse<T extends { error?: { message?: string } }>(response: Response): Promise<T> {
  if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
    throw new TypeError(`Temporary status connection problem (${response.status}).`);
  }
  let value: T;
  try { value = await response.json() as T; }
  catch { throw new TypeError("The status response was interrupted or unreadable."); }
  if (!response.ok) throw new Error(value.error?.message ?? "The saved scan could not be opened. Check your session and try again.");
  return value;
}
