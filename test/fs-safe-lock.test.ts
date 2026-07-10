import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { withFileLock } from '../src/fs-safe.js';

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function exists(destination: string): Promise<boolean> {
  return stat(destination)
    .then(() => true)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
}

async function makeAbandonedLock(lockDirectory: string): Promise<void> {
  await mkdir(lockDirectory, { mode: 0o700 });
  await writeFile(
    path.join(lockDirectory, 'owner.json'),
    `${JSON.stringify({
      token: 'abandoned-owner',
      // The current PID plus a different process nonce deterministically
      // models an old lock whose PID has been reused.
      pid: process.pid,
      processToken: 'dead-process',
      processStartedAt: '2000-01-01T00:00:00.000Z',
      acquiredAt: '2000-01-01T00:00:00.000Z',
    })}\n`,
  );
}

test('competing stale reapers preserve mutual exclusion', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-lock-reapers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockDirectory = path.join(root, 'write.lock');
  await makeAbandonedLock(lockDirectory);

  let active = 0;
  let maximumActive = 0;
  const entrants: number[] = [];
  await Promise.all(
    [1, 2, 3].map((id) =>
      withFileLock(
        lockDirectory,
        async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          entrants.push(id);
          await new Promise((resolve) => setTimeout(resolve, 8));
          active -= 1;
        },
        { timeoutMs: 1_000, staleMs: 1, retryMs: 1 },
      ),
    ),
  );

  assert.equal(maximumActive, 1);
  assert.deepEqual([...entrants].sort(), [1, 2, 3]);
  assert.equal(await exists(lockDirectory), false);
});

test('a delayed stale observer cannot rename a successor lock', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-lock-stale-observer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockDirectory = path.join(root, 'write.lock');
  const retiredDirectory = path.join(root, 'retired.lock');
  await makeAbandonedLock(lockDirectory);

  const staleObserved = deferred();
  const resumeStaleObserver = deferred();
  const successorEntered = deferred();
  const releaseSuccessor = deferred();
  let pauseOnce = true;
  let staleObserverEntered = false;
  let successorActive = false;

  const staleObserver = withFileLock(
    lockDirectory,
    async () => {
      assert.equal(successorActive, false);
      staleObserverEntered = true;
    },
    {
      timeoutMs: 1_000,
      staleMs: 1,
      retryMs: 1,
      onStaleObserved: async () => {
        if (!pauseOnce) return;
        pauseOnce = false;
        staleObserved.resolve();
        await resumeStaleObserver.promise;
      },
    },
  );

  await staleObserved.promise;
  await rename(lockDirectory, retiredDirectory);
  await rm(retiredDirectory, { recursive: true });

  const successor = withFileLock(
    lockDirectory,
    async () => {
      successorActive = true;
      successorEntered.resolve();
      await releaseSuccessor.promise;
      successorActive = false;
    },
    { timeoutMs: 1_000, staleMs: 1, retryMs: 1 },
  );
  await successorEntered.promise;
  resumeStaleObserver.resolve();

  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(staleObserverEntered, false);
  assert.equal(await exists(lockDirectory), true);

  releaseSuccessor.resolve();
  await successor;
  await staleObserver;
  assert.equal(staleObserverEntered, true);
});

test('a delayed old release never deletes a successor lock', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-lock-old-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockDirectory = path.join(root, 'write.lock');
  const retiredDirectory = path.join(root, 'retired.lock');

  const releaseObserved = deferred();
  const resumeOldRelease = deferred();
  const successorEntered = deferred();
  const releaseSuccessor = deferred();
  let pauseOnce = true;
  let thirdEntered = false;

  const oldAcquisition = withFileLock(
    lockDirectory,
    async () => 'old result',
    {
      timeoutMs: 1_000,
      staleMs: 1,
      retryMs: 1,
      onReleaseOwnershipObserved: async () => {
        if (!pauseOnce) return;
        pauseOnce = false;
        releaseObserved.resolve();
        await resumeOldRelease.promise;
      },
    },
  );

  await releaseObserved.promise;
  await rename(lockDirectory, retiredDirectory);
  const successor = withFileLock(
    lockDirectory,
    async () => {
      successorEntered.resolve();
      await releaseSuccessor.promise;
    },
    { timeoutMs: 1_000, staleMs: 1, retryMs: 1 },
  );
  await successorEntered.promise;
  const successorOwnerBefore = await readFile(path.join(lockDirectory, 'owner.json'), 'utf8');

  resumeOldRelease.resolve();
  assert.equal(await oldAcquisition, 'old result');
  assert.equal(await exists(lockDirectory), true);
  assert.equal(
    await readFile(path.join(lockDirectory, 'owner.json'), 'utf8'),
    successorOwnerBefore,
  );

  await assert.rejects(
    withFileLock(
      lockDirectory,
      async () => {
        thirdEntered = true;
      },
      { timeoutMs: 20, staleMs: 1, retryMs: 1 },
    ),
    /Timed out waiting for Chronicle lock/,
  );
  assert.equal(thirdEntered, false);

  releaseSuccessor.resolve();
  await successor;
  await rm(retiredDirectory, { recursive: true });
  assert.equal(await exists(lockDirectory), false);
});

test('an ownerless crash gap is recovered only after the stale threshold', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-lock-ownerless-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockDirectory = path.join(root, 'write.lock');
  await mkdir(lockDirectory);

  await assert.rejects(
    withFileLock(lockDirectory, async () => undefined, {
      timeoutMs: 10,
      staleMs: 60_000,
      retryMs: 1,
    }),
    /Timed out waiting for Chronicle lock/,
  );

  let entered = false;
  await withFileLock(
    lockDirectory,
    async () => {
      entered = true;
    },
    { timeoutMs: 1_000, staleMs: 0, retryMs: 1 },
  );
  assert.equal(entered, true);
  assert.equal(await exists(lockDirectory), false);
});
