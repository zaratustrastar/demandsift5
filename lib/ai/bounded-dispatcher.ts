/** FIFO request permits. Callers hold a permit through response-body consumption,
 * not through retry backoff or recursive splitting. No provider-specific policy. */
export class RequestGate {
  private activeCount = 0;
  private readonly waiting: Array<() => void> = [];
  private maximum: number;
  constructor(limit: number, private readonly outer?: {
    run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  }) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Request concurrency must be a positive integer.");
    this.maximum = limit;
  }
  get limit() { return this.maximum; }
  get active() { return this.activeCount; }
  get queued() { return this.waiting.length; }
  /** Shared process gates may become more conservative while old/new scan
   * configurations overlap. They never increase until process restart. */
  capAt(limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("Request concurrency must be a positive integer.");
    this.maximum = Math.min(this.maximum, limit);
  }
  private acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener("abort", abort);
        this.activeCount++;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true; this.activeCount--;
          if (this.activeCount < this.maximum) this.waiting.shift()?.();
        });
      };
      const abort = () => {
        const index = this.waiting.indexOf(grant);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(signal?.reason);
      };
      if (this.activeCount < this.maximum) grant();
      else { this.waiting.push(grant); signal?.addEventListener("abort", abort, { once: true }); }
    });
  }
  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      signal?.throwIfAborted();
      return this.outer ? await this.outer.run(operation, signal) : await operation();
    }
    finally { release(); }
  }
}

export type DispatchItem<T> = { key: string; value: T };
export type DispatchBatch<T, R> = { items: readonly DispatchItem<T>[]; result: R; startedAt: number; finishedAt: number };

/** Incremental batching with one bounded worker pool. A failed batch stops new
 * dispatch, then drains siblings; successful callbacks cannot arrive after a
 * rejected drain. Keys identify immutable input versions, not just record IDs. */
export class BoundedBatchDispatcher<T, R> {
  private readonly controller = new AbortController();
  private readonly seen = new Set<string>();
  private buffer: DispatchItem<T>[] = [];
  private readonly pending: DispatchItem<T>[][] = [];
  private readonly completed: DispatchBatch<T, R>[] = [];
  private active = 0;
  private failed = false;
  private failure: unknown;
  private readonly waiters = new Set<() => void>();
  private readonly parentAbort: () => void;
  constructor(private readonly options: {
    batchSize: number;
    concurrency: number;
    process(items: readonly DispatchItem<T>[], signal: AbortSignal): Promise<R>;
    signal?: AbortSignal;
    now?: () => number;
  }) {
    if (![options.batchSize, options.concurrency].every(value => Number.isInteger(value) && value > 0)) {
      throw new Error("Batch size and concurrency must be positive integers.");
    }
    this.parentAbort = () => this.cancel(options.signal?.reason);
    if (options.signal?.aborted) this.parentAbort();
    else options.signal?.addEventListener("abort", this.parentAbort, { once: true });
  }
  get signal() { return this.controller.signal; }
  get queuedItems() { return this.buffer.length + this.pending.reduce((count, batch) => count + batch.length, 0); }
  get activeBatches() { return this.active; }
  get completedBatches(): readonly DispatchBatch<T, R>[] { return this.completed.slice(); }
  submit(items: readonly DispatchItem<T>[]) {
    if (this.failed) throw this.failure;
    for (const item of items) {
      if (this.seen.has(item.key)) continue;
      this.seen.add(item.key);
      this.buffer.push({ key: item.key, value: structuredClone(item.value) });
      if (this.buffer.length === this.options.batchSize) { this.pending.push(this.buffer); this.buffer = []; }
    }
    this.pump();
  }
  flush() {
    if (this.failed) return;
    if (this.buffer.length) { this.pending.push(this.buffer); this.buffer = []; }
    this.pump();
  }
  cancel(reason: unknown = new DOMException("Dispatch canceled", "AbortError")) {
    if (!this.failed) { this.failed = true; this.failure = reason; }
    this.pending.length = 0; this.buffer = [];
    this.controller.abort(reason);
    this.notify();
  }
  private notify() {
    if (this.active || (!this.failed && this.pending.length)) return;
    for (const waiter of this.waiters) waiter();
    this.waiters.clear();
  }
  private pump() {
    while (!this.failed && this.active < this.options.concurrency && this.pending.length) {
      const items = this.pending.shift()!;
      const now = this.options.now ?? Date.now;
      const startedAt = now();
      this.active++;
      void (async () => {
        try {
          const result = await this.options.process(items, this.signal);
          this.completed.push({ items, result, startedAt, finishedAt: now() });
        } catch (error) {
          if (!this.failed) { this.failed = true; this.failure = error; this.pending.length = 0; this.buffer = []; }
          // Do not abort siblings on an ordinary batch failure: retain their
          // successful results. Explicit cancellation does abort local work.
        } finally { this.active--; this.pump(); this.notify(); }
      })();
    }
  }
  async drain(): Promise<readonly DispatchBatch<T, R>[]> {
    this.flush();
    if (this.active || (!this.failed && this.pending.length)) await new Promise<void>(resolve => this.waiters.add(resolve));
    if (this.failed) throw this.failure;
    return this.completed.slice();
  }
  dispose() { this.options.signal?.removeEventListener("abort", this.parentAbort); }
}

export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => { signal?.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}
