import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ProcessingCancelledError,
  ProcessingQueue,
  ProcessingQueueQuarantinedError,
  ProcessingTimeoutError,
} from '../src/jobs.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('processing queue runs one job at a time', async () => {
  const queue = new ProcessingQueue<string>({ retries: 0, timeoutMs: 1_000 });
  let active = 0;
  let peak = 0;
  const run = (id: string) =>
    queue.enqueue({
      id,
      run: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await sleep(15);
        active -= 1;
        return id;
      },
    });
  assert.deepEqual(await Promise.all([run('a'), run('b'), run('c')]), ['a', 'b', 'c']);
  assert.equal(peak, 1);
});

test('processing queue retries a transient failure within its bound', async () => {
  const queue = new ProcessingQueue<number>({ retries: 2, retryDelayMs: 0, timeoutMs: 1_000 });
  let attempts = 0;
  const result = await queue.enqueue({
    id: 'retry',
    run: async () => {
      attempts += 1;
      if (attempts < 3) throw new Error('transient');
      return attempts;
    },
  });
  assert.equal(result, 3);
  assert.equal(attempts, 3);
});

test('processing timeout settles even when the worker ignores AbortSignal', async () => {
  const queue = new ProcessingQueue<void>({ retries: 0, timeoutMs: 20 });
  const started = Date.now();
  await assert.rejects(
    queue.enqueue({
      id: 'slow',
      run: async () => new Promise<void>(() => {}),
    }),
    ProcessingTimeoutError,
  );
  assert.ok(Date.now() - started < 500, 'queue should not await the non-cooperative worker');
  await queue.drain();
});

test('a non-cooperative timed-out worker is quarantined instead of overlapping the next job', async () => {
  const queue = new ProcessingQueue<void>({ retries: 0, timeoutMs: 20 });
  let secondStarted = false;
  const first = queue.enqueue({ id: 'hung', run: async () => new Promise<void>(() => {}) });
  const second = queue.enqueue({
    id: 'must-not-overlap',
    run: async () => {
      secondStarted = true;
    },
  });
  const firstRejected = assert.rejects(first, ProcessingTimeoutError);
  const secondRejected = assert.rejects(second, ProcessingQueueQuarantinedError);
  await Promise.all([firstRejected, secondRejected]);
  assert.equal(secondStarted, false);
  await assert.rejects(
    queue.enqueue({ id: 'still-quarantined', run: async () => {} }),
    ProcessingQueueQuarantinedError,
  );
  await queue.drain();
});

test('cancelAll rejects queued work so shutdown does not start new jobs', async () => {
  const queue = new ProcessingQueue<void>({ retries: 0, timeoutMs: 1_000 });
  const first = queue.enqueue({
    id: 'running',
    run: (signal) =>
      new Promise<void>((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
  });
  const second = queue.enqueue({ id: 'waiting', run: async () => {} });
  const firstRejected = assert.rejects(first, /shutdown/);
  const secondRejected = assert.rejects(second, /shutdown/);
  assert.equal(queue.cancelAll('shutdown'), 2);
  await Promise.all([firstRejected, secondRejected]);
  await queue.drain();
});

test('cancelAndWait reports whether cancellation won the result race', async () => {
  const queue = new ProcessingQueue<void>({ retries: 0, timeoutMs: 1_000 });
  const running = queue.enqueue({ id: 'cancel-me', run: async () => new Promise<void>(() => {}) });
  const rejected = assert.rejects(running, ProcessingCancelledError);
  assert.equal(await queue.cancelAndWait('cancel-me', 'discarded'), 'cancelled');
  await rejected;
  assert.equal(await queue.cancelAndWait('missing'), 'not_found');
});
