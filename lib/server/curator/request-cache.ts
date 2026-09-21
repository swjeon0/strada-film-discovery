type SharedRequest<T, P> = {
  controller: AbortController;
  promise: Promise<T>;
  listeners: Set<(progress: P) => void>;
  latest?: P;
  waiters: number;
  settledAt: number;
  abortTimer?: ReturnType<typeof setTimeout>;
};

/** Idempotent transport retries share work; a new request ID is a new curation.
 * A caller can cancel without aborting another caller's still-needed result. */
export class CuratorRequestCache<T, P> {
  private entries = new Map<string, SharedRequest<T, P>>();
  constructor(private ttlMs = 60_000, private limit = 32, private orphanGraceMs = 5000) {}

  /** Keep the host alive through existing work, without becoming a subscriber
   * or extending the orphan cancellation window. No new request is started. */
  settlement(key: string): Promise<void> {
    const pending = this.entries.get(key)?.promise;
    return pending ? pending.then(() => {}, () => {}) : Promise.resolve();
  }

  run(
    key: string,
    signal: AbortSignal,
    execute: (signal: AbortSignal, emit: (progress: P) => void) => Promise<T>,
    onProgress?: (progress: P) => void,
  ): Promise<T> {
    if (signal.aborted) return Promise.reject(signal.reason);
    for (const [id, entry] of this.entries)
      if (entry.settledAt && Date.now() - entry.settledAt > this.ttlMs)
        this.entries.delete(id);
    let entry = this.entries.get(key);
    if (!entry) {
      const controller = new AbortController(), listeners = new Set<(p: P) => void>();
      const created: SharedRequest<T, P> = {
        controller, listeners, waiters: 0, settledAt: 0,
        promise: Promise.resolve().then(() => execute(controller.signal, (progress) => {
          created.latest = progress;
          for (const listener of listeners) listener(progress);
        })).then((result) => {
          clearTimeout(created.abortTimer);
          created.settledAt = Date.now();
          this.trim();
          return result;
        }, (error) => {
          clearTimeout(created.abortTimer);
          created.settledAt = Date.now();
          if (this.entries.get(key) === created) this.entries.delete(key);
          throw error;
        }),
      };
      entry = created;
      this.entries.set(key, entry);
    }
    const shared = entry;
    clearTimeout(shared.abortTimer);
    shared.waiters++;
    if (onProgress) {
      shared.listeners.add(onProgress);
      if (shared.latest) onProgress(shared.latest);
    }
    return new Promise<T>((resolve, reject) => {
      let detached = false;
      const detach = () => {
        if (detached) return;
        detached = true;
        signal.removeEventListener("abort", abort);
        if (onProgress) shared.listeners.delete(onProgress);
        shared.waiters--;
        if (!shared.waiters && !shared.settledAt) {
          // A short transport reconnect must not restart the paid model call.
          // Explicit cancellation stops waiting immediately; abandoned work
          // is canceled after this bounded reconnect window.
          shared.abortTimer = setTimeout(() => {
            if (shared.waiters || shared.settledAt) return;
            if (this.entries.get(key) === shared) this.entries.delete(key);
            shared.controller.abort();
          }, this.orphanGraceMs);
          shared.abortTimer.unref?.();
        }
      };
      const abort = () => { detach(); reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      shared.promise.then((result) => { detach(); resolve(result); }, (error) => {
        detach(); reject(error);
      });
      if (signal.aborted) abort();
    });
  }

  private trim() {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.limit) break;
      if (entry.settledAt) this.entries.delete(key);
    }
  }
}
