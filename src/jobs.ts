export class ProcessingTimeoutError extends Error {
  constructor(readonly jobId: string, readonly timeoutMs: number) {
    super(`Processing job ${jobId} exceeded ${timeoutMs}ms.`);
    this.name = 'ProcessingTimeoutError';
  }
}

export class ProcessingCancelledError extends Error {
  constructor(readonly jobId: string, message = `Processing job ${jobId} was cancelled.`) {
    super(message);
    this.name = 'ProcessingCancelledError';
  }
}

export class ProcessingQueueQuarantinedError extends Error {
  constructor(readonly blockingJobId: string) {
    super(
      `Processing queue is quarantined because job ${blockingJobId} did not settle after cancellation or timeout. Restart after checking the worker.`,
    );
    this.name = 'ProcessingQueueQuarantinedError';
  }
}

export interface ProcessingJob<T> {
  id: string;
  run: (signal: AbortSignal, attempt: number) => Promise<T>;
  onAttempt?: (attempt: number) => Promise<void> | void;
  onRetry?: (error: unknown, nextAttempt: number) => Promise<void> | void;
}

export interface ProcessingQueueOptions {
  /** Queued + running jobs. The worker itself always has concurrency one. */
  maxPending?: number;
  /** Retries after the first attempt. */
  retries?: number;
  timeoutMs?: number;
  retryDelayMs?: number;
}

export type ProcessingCancellationOutcome = 'cancelled' | 'completed' | 'not_found';

interface QueueItem<T> {
  job: ProcessingJob<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  controller?: AbortController;
  cancelled?: ProcessingCancelledError;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A deliberately small, bounded, single-worker queue. Discord can begin a new
 * capture while an earlier meeting is transcribing, but CPU-heavy ASR jobs do
 * not pile up concurrently and exhaust the host.
 */
export class ProcessingQueue<T> {
  private readonly waiting: QueueItem<T>[] = [];
  private readonly byId = new Map<string, { item: QueueItem<T>; promise: Promise<T> }>();
  private readonly drainWaiters = new Set<() => void>();
  private running: QueueItem<T> | null = null;
  private pumping = false;
  private accepting = true;
  private quarantinedBy?: string;

  readonly maxPending: number;
  readonly retries: number;
  readonly timeoutMs: number;
  readonly retryDelayMs: number;

  constructor(options: ProcessingQueueOptions = {}) {
    this.maxPending = options.maxPending ?? 25;
    this.retries = options.retries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 30 * 60_000;
    this.retryDelayMs = options.retryDelayMs ?? 1_000;
    if (this.maxPending < 1) throw new Error('ProcessingQueue maxPending must be at least 1.');
    if (this.retries < 0) throw new Error('ProcessingQueue retries cannot be negative.');
    if (this.timeoutMs < 1) throw new Error('ProcessingQueue timeoutMs must be positive.');
  }

  get size(): number {
    return this.waiting.length + (this.running ? 1 : 0);
  }

  get activeJobId(): string | undefined {
    return this.running?.job.id;
  }

  enqueue(job: ProcessingJob<T>): Promise<T> {
    const existing = this.byId.get(job.id);
    if (existing) return existing.promise;
    if (!this.accepting) {
      return Promise.reject(new Error('The processing queue is shutting down.'));
    }
    if (this.quarantinedBy) {
      return Promise.reject(new ProcessingQueueQuarantinedError(this.quarantinedBy));
    }
    if (this.size >= this.maxPending) {
      return Promise.reject(
        new Error(`The processing queue is full (${this.maxPending} jobs); the capture remains recoverable.`),
      );
    }

    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const item: QueueItem<T> = { job, resolve, reject };
    this.waiting.push(item);
    this.byId.set(job.id, { item, promise });
    void this.pump();
    return promise;
  }

  cancel(jobId: string, reason?: string): boolean {
    const entry = this.byId.get(jobId);
    if (!entry) return false;
    const error = new ProcessingCancelledError(jobId, reason);
    entry.item.cancelled = error;
    entry.item.controller?.abort(error);

    const index = this.waiting.indexOf(entry.item);
    if (index >= 0) {
      this.waiting.splice(index, 1);
      this.byId.delete(jobId);
      entry.item.reject(error);
      this.resolveDrainersIfIdle();
    }
    return true;
  }

  cancelAll(reason = 'Processing queue cancelled.'): number {
    const ids = [...this.byId.keys()];
    for (const id of ids) this.cancel(id, reason);
    return ids.length;
  }

  async cancelAndWait(jobId: string, reason?: string): Promise<ProcessingCancellationOutcome> {
    const entry = this.byId.get(jobId);
    if (!entry) return 'not_found';
    const promise = entry.promise;
    this.cancel(jobId, reason);
    try {
      await promise;
      return 'completed';
    } catch (error) {
      if (error instanceof ProcessingCancelledError) return 'cancelled';
      throw error;
    }
  }

  /** Stop accepting work; already queued captures remain durable and are drained. */
  close(): void {
    this.accepting = false;
    this.resolveDrainersIfIdle();
  }

  async drain(): Promise<void> {
    if (this.size === 0) return;
    await new Promise<void>((resolve) => this.drainWaiters.add(resolve));
  }

  private async runAttempt(item: QueueItem<T>, attempt: number): Promise<T> {
    const controller = new AbortController();
    item.controller = controller;
    if (item.cancelled) controller.abort(item.cancelled);

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new ProcessingTimeoutError(item.job.id, this.timeoutMs);
        controller.abort(error);
        reject(error);
      }, this.timeoutMs);
    });
    let removeAbortListener = () => {};

    try {
      await item.job.onAttempt?.(attempt);
      if (controller.signal.aborted) throw controller.signal.reason;
      const cancellation = new Promise<never>((_, reject) => {
        const onAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => controller.signal.removeEventListener('abort', onAbort);
      });
      const work = Promise.resolve().then(() => item.job.run(controller.signal, attempt));
      // A late worker is deliberately fenced from this queue result. Pipeline
      // jobs also receive the aborted signal and consult their durable session
      // tombstone before any final write.
      try {
        return await Promise.race([work, timeout, cancellation]);
      } catch (error) {
        if (error instanceof ProcessingTimeoutError || error instanceof ProcessingCancelledError) {
          this.quarantineUntil(item.job.id, work);
        }
        throw error;
      }
    } finally {
      if (timer) clearTimeout(timer);
      removeAbortListener();
      item.controller = undefined;
    }
  }

  private async execute(item: QueueItem<T>): Promise<T> {
    const attempts = this.retries + 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (item.cancelled) throw item.cancelled;
      try {
        return await this.runAttempt(item, attempt);
      } catch (error) {
        lastError = error;
        if (item.cancelled || error instanceof ProcessingTimeoutError || attempt >= attempts) break;
        await item.job.onRetry?.(error, attempt + 1);
        if (this.retryDelayMs > 0) await delay(this.retryDelayMs);
      }
    }
    throw lastError;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.waiting.length > 0) {
        const item = this.waiting.shift()!;
        this.running = item;
        try {
          item.resolve(await this.execute(item));
        } catch (error) {
          item.reject(error);
        } finally {
          this.byId.delete(item.job.id);
          this.running = null;
        }
        if (this.quarantinedBy) {
          this.rejectWaitingForQuarantine(this.quarantinedBy);
          break;
        }
      }
    } finally {
      this.pumping = false;
      this.resolveDrainersIfIdle();
      // An enqueue can land between the while condition and pumping=false.
      if (this.waiting.length > 0) void this.pump();
    }
  }

  private resolveDrainersIfIdle(): void {
    if (this.size !== 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }

  private quarantineUntil(jobId: string, work: Promise<T>): void {
    this.quarantinedBy = jobId;
    void work
      .catch(() => {})
      .finally(() => {
        if (this.quarantinedBy === jobId) this.quarantinedBy = undefined;
      });
  }

  private rejectWaitingForQuarantine(jobId: string): void {
    const error = new ProcessingQueueQuarantinedError(jobId);
    for (const item of this.waiting.splice(0)) {
      this.byId.delete(item.job.id);
      item.reject(error);
    }
  }
}
