import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  createDiscordInboxService,
  inboxMessageAuthorized,
  type DiscordInboxMessage,
  type DiscordInboxQueue,
} from '../src/discord-inbox.js';
import type { ProcessingJob } from '../src/jobs.js';
import {
  EncryptedSourceCatalog,
  type StoredDiscordReceipt,
} from '../src/source-catalog.js';

const KEY = Buffer.alloc(32, 9).toString('base64');
const POLICY = {
  guildIds: ['guild-1'],
  channelIds: ['inbox-1'],
  userIds: ['author-1'],
  roleIds: [],
};

function message(overrides: Partial<DiscordInboxMessage> = {}): DiscordInboxMessage {
  return {
    id: 'message-1',
    guildId: 'guild-1',
    channelId: 'inbox-1',
    author: { id: 'author-1', username: 'ethan', displayName: 'Ethan', bot: false },
    roleIds: [],
    content: 'A useful idea.',
    createdAt: '2026-07-10T10:00:00.000Z',
    type: 'default',
    ...overrides,
  };
}

class ImmediateQueue implements DiscordInboxQueue {
  readonly jobs: string[] = [];
  readonly cancelled: string[] = [];

  async enqueue(job: ProcessingJob<unknown>): Promise<unknown> {
    this.jobs.push(job.id);
    await job.onAttempt?.(1);
    return job.run(new AbortController().signal, 1);
  }

  cancel(jobId: string): boolean {
    this.cancelled.push(jobId);
    return true;
  }
}

async function fixture(t: Parameters<typeof test>[1] extends (context: infer T) => unknown ? T : never) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chronicle-discord-inbox-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return new EncryptedSourceCatalog({ directory, encryptionKey: KEY });
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Condition did not become true within ${timeoutMs}ms`);
}

test('inbox eligibility fails closed before content handling', () => {
  assert.equal(inboxMessageAuthorized(message(), POLICY), true);
  assert.equal(inboxMessageAuthorized(message({ channelId: 'other' }), POLICY), false);
  assert.equal(inboxMessageAuthorized(message({ roleIds: undefined }), POLICY), false);
  assert.equal(inboxMessageAuthorized(message({ author: { id: 'author-1', username: 'bot', bot: true } }), POLICY), false);
  assert.equal(inboxMessageAuthorized(message({ webhookId: 'webhook-1' }), POLICY), false);
  assert.equal(inboxMessageAuthorized(message({ type: 'other' }), POLICY), false);
});

test('durable capture precedes one receipt and processing; replay is idempotent', async (t) => {
  const catalog = await fixture(t);
  const queue = new ImmediateQueue();
  const events: string[] = [];
  const service = createDiscordInboxService({
    catalog,
    queue,
    policy: POLICY,
    disclosure: 'The source will be sent to the configured remote model.',
    process: async (record) => {
      events.push(`processed:${record.source.id}`);
      return { capability: 'processable', title: 'Captured idea', summary: 'Useful.' };
    },
    sendReceipt: async (_message, content) => {
      const page = await catalog.list({ workspaceId: 'guild-1' });
      assert.equal(page.items.length, 1);
      events.push(`receipt:${content}`);
      return { update: async (next) => { events.push(`update:${next}`); } };
    },
  });

  const first = await service.handleCreate(message());
  const replay = await service.handleCreate(message());
  assert.equal(first.status, 'captured');
  assert.equal(replay.status, 'duplicate');
  assert.equal(queue.jobs.length, 1);
  assert.equal(events.filter((event) => event.startsWith('receipt:')).length, 1);
  const receipts = events.filter((event) => /^(receipt|update):/.test(event));
  assert.equal(receipts.every((event) => event.includes('encrypted Library storage')), true);
  assert.equal(receipts.every((event) => !/local only/i.test(event)), true);
  assert.equal(
    receipts.every((event) => event.includes('sent to the configured remote model')),
    true,
  );
  const stored = await catalog.get(first.sourceId!);
  assert.equal(stored?.recordType, 'source');
  if (stored?.recordType === 'source') {
    assert.equal(stored.save.processingStatus, 'succeeded');
    assert.equal(stored.analysis?.title, 'Captured idea');
  }
});

test('edits revise and reprocess only an existing capture', async (t) => {
  const catalog = await fixture(t);
  const queue = new ImmediateQueue();
  let receiptNumber = 0;
  const service = createDiscordInboxService({
    catalog,
    queue,
    policy: POLICY,
    process: async (record) => ({
      capability: 'processable',
      summary: record.source.text,
    }),
    sendReceipt: async () => {
      receiptNumber += 1;
      return {
        identity: { channelId: 'inbox-1', messageId: `receipt-${receiptNumber}` },
        update: async () => undefined,
      };
    },
  });

  assert.equal((await service.handleUpdate(message({ id: 'missing' }))).status, 'ignored');
  await service.handleCreate(message());
  const edited = await service.handleUpdate(message({
    content: 'Edited useful idea.',
    editedAt: '2026-07-10T11:00:00.000Z',
  }));
  assert.equal(edited.status, 'revised');
  assert.equal(queue.cancelled.length, 1);
  const stored = await catalog.get(edited.sourceId!);
  assert.equal(stored?.recordType, 'source');
  if (stored?.recordType === 'source') {
    assert.equal(stored.source.sourceRevision, 2);
    assert.equal(stored.analysis?.summary, 'Edited useful idea.');
    assert.deepEqual(stored.save.receipt, {
      channelId: 'inbox-1',
      messageId: 'receipt-2',
      sourceRevision: 2,
    });
  }
});

test('a concurrent edit during receipt binding never enqueues the stale revision', async (t) => {
  const catalog = await fixture(t);
  const queue = new ImmediateQueue();
  const staleReceiptUpdates: string[] = [];
  const currentReceiptUpdates: string[] = [];
  const processedRevisions: number[] = [];
  let receiptNumber = 0;
  let concurrentUpdateStatus: string | undefined;
  let service!: ReturnType<typeof createDiscordInboxService>;
  service = createDiscordInboxService({
    catalog,
    queue,
    policy: POLICY,
    process: async (record) => {
      processedRevisions.push(record.source.sourceRevision);
      return { capability: 'processable', summary: record.source.text };
    },
    sendReceipt: async () => {
      receiptNumber += 1;
      if (receiptNumber === 1) {
        const updated = await service.handleUpdate(message({
          content: 'Newer content won the race.',
          editedAt: '2026-07-10T11:00:00.000Z',
        }));
        concurrentUpdateStatus = updated.status;
        return {
          identity: { channelId: 'inbox-1', messageId: 'receipt-stale' },
          update: async (content) => { staleReceiptUpdates.push(content); },
        };
      }
      return {
        identity: { channelId: 'inbox-1', messageId: 'receipt-current' },
        update: async (content) => { currentReceiptUpdates.push(content); },
      };
    },
  });

  const created = await service.handleCreate(message());
  assert.equal(created.status, 'captured');
  assert.equal(concurrentUpdateStatus, 'revised');
  assert.equal(receiptNumber, 2);
  assert.equal(queue.jobs.length, 1);
  assert.match(queue.jobs[0] ?? '', /:revision:2$/);
  assert.deepEqual(processedRevisions, [2]);
  assert.equal(staleReceiptUpdates.length, 1);
  assert.match(staleReceiptUpdates[0] ?? '', /superseded by a newer Discord edit/i);
  assert.match(currentReceiptUpdates.at(-1) ?? '', /Processed by Chronicle/);

  const stored = await catalog.get(created.sourceId!);
  assert.equal(stored?.recordType, 'source');
  if (stored?.recordType === 'source') {
    assert.equal(stored.source.sourceRevision, 2);
    assert.equal(stored.save.processingStatus, 'succeeded');
    assert.equal(stored.analysis?.summary, 'Newer content won the race.');
    assert.deepEqual(stored.save.receipt, {
      channelId: 'inbox-1',
      messageId: 'receipt-current',
      sourceRevision: 2,
    });
  }
  await service.close();
});

test('message deletion cancels work and leaves only a content-free tombstone', async (t) => {
  const catalog = await fixture(t);
  const queue = new ImmediateQueue();
  const service = createDiscordInboxService({
    catalog,
    queue,
    policy: POLICY,
    process: async () => ({ capability: 'partial', warning: 'Metadata only.' }),
  });
  const captured = await service.handleCreate(message());
  assert.equal(await service.handleDelete({
    guildId: 'guild-1',
    channelId: 'inbox-1',
    messageId: 'message-1',
  }), true);
  const stored = await catalog.get(captured.sourceId!);
  assert.equal(stored?.recordType, 'tombstone');
  assert.equal(queue.cancelled.length, 1);
});

test('queue admission failure preserves the durable queued source for recovery', async (t) => {
  const catalog = await fixture(t);
  const queue: DiscordInboxQueue = {
    enqueue: async () => { throw new Error('Processing queue is full.'); },
    cancel: () => false,
  };
  const updates: string[] = [];
  const service = createDiscordInboxService({
    catalog,
    queue,
    policy: POLICY,
    process: async () => ({ capability: 'processable' }),
    sendReceipt: async () => ({ update: async (content) => { updates.push(content); } }),
  });
  const captured = await service.handleCreate(message());
  assert.equal(captured.status, 'waiting');
  const stored = await catalog.get(captured.sourceId!);
  assert.equal(stored?.recordType, 'source');
  if (stored?.recordType === 'source') assert.equal(stored.save.processingStatus, 'queued');
  assert.match(updates.at(-1) ?? '', /waiting for capacity/);
  await service.close();
});

test('role-only authorization resolves current roles when recovering durable work', async (t) => {
  const catalog = await fixture(t);
  const rolePolicy = {
    guildIds: ['guild-1'],
    channelIds: ['inbox-1'],
    userIds: [],
    roleIds: ['inbox-role'],
  };
  const unavailableQueue: DiscordInboxQueue = {
    enqueue: async () => { throw new Error('Processing queue is full.'); },
    cancel: () => false,
  };
  const initial = createDiscordInboxService({
    catalog,
    queue: unavailableQueue,
    policy: rolePolicy,
    process: async () => ({ capability: 'processable' }),
    retryInitialDelayMs: 10_000,
  });
  const captured = await initial.handleCreate(message({ roleIds: ['inbox-role'] }));
  assert.equal(captured.status, 'waiting');
  await initial.close();

  const queue = new ImmediateQueue();
  const roleLookups: string[] = [];
  const recovering = createDiscordInboxService({
    catalog,
    queue,
    policy: rolePolicy,
    process: async () => ({ capability: 'processable', summary: 'Recovered by role.' }),
    resolveCurrentRoleIds: async (guildId, userId) => {
      roleLookups.push(`${guildId}:${userId}`);
      return ['inbox-role'];
    },
  });

  assert.equal(await recovering.recover(), 1);
  assert.deepEqual(roleLookups, ['guild-1:author-1']);
  const stored = await catalog.get(captured.sourceId!);
  assert.equal(stored?.recordType, 'source');
  if (stored?.recordType === 'source') {
    assert.equal(stored.save.processingStatus, 'succeeded');
    assert.equal(stored.analysis?.summary, 'Recovered by role.');
  }
  await recovering.close();
});

test('queue admission failures retry automatically with one durable job', async (t) => {
  const catalog = await fixture(t);
  let admissions = 0;
  const initialReceiptUpdates: string[] = [];
  const restoredReceiptUpdates: string[] = [];
  const restoredReceipts: StoredDiscordReceipt[] = [];
  const queue: DiscordInboxQueue = {
    enqueue: async (job) => {
      admissions += 1;
      if (admissions === 1) throw new Error('Processing queue is full.');
      await job.onAttempt?.(1);
      return job.run(new AbortController().signal, 1);
    },
    cancel: () => false,
  };
  const service = createDiscordInboxService({
    catalog,
    queue,
    policy: POLICY,
    process: async () => ({ capability: 'processable', summary: 'Retried automatically.' }),
    sendReceipt: async () => ({
      identity: { channelId: 'inbox-1', messageId: 'receipt-retry' },
      update: async (content) => { initialReceiptUpdates.push(content); },
    }),
    restoreReceipt: (receipt) => {
      restoredReceipts.push(receipt);
      return {
        identity: receipt,
        update: async (content) => { restoredReceiptUpdates.push(content); },
      };
    },
    retryInitialDelayMs: 5,
    retryMaxDelayMs: 10,
  });

  const captured = await service.handleCreate(message());
  assert.equal(captured.status, 'waiting');
  const waiting = await catalog.get(captured.sourceId!);
  assert.equal(waiting?.recordType, 'source');
  if (waiting?.recordType === 'source') {
    assert.deepEqual(waiting.save.receipt, {
      channelId: 'inbox-1',
      messageId: 'receipt-retry',
      sourceRevision: 1,
    });
  }
  await waitFor(async () => {
    const stored = await catalog.get(captured.sourceId!);
    return stored?.recordType === 'source' && stored.save.processingStatus === 'succeeded';
  });
  await waitFor(async () => /Processed by Chronicle/.test(restoredReceiptUpdates.at(-1) ?? ''));
  assert.equal(admissions, 2);
  assert.match(initialReceiptUpdates.at(-1) ?? '', /waiting for capacity/);
  assert.deepEqual(restoredReceipts, [{
    channelId: 'inbox-1',
    messageId: 'receipt-retry',
    sourceRevision: 1,
  }]);
  assert.equal(restoredReceiptUpdates.some((content) => /processing/.test(content)), true);
  assert.match(restoredReceiptUpdates.at(-1) ?? '', /Processed by Chronicle/);
  const stored = await catalog.get(captured.sourceId!);
  assert.equal(stored?.recordType, 'source');
  if (stored?.recordType === 'source') {
    assert.equal(stored.analysis?.summary, 'Retried automatically.');
  }
  await service.close();
});

test('restart recovery edits the original durable receipt through a restored adapter', async (t) => {
  const catalog = await fixture(t);
  const initialReceiptUpdates: string[] = [];
  const unavailableQueue: DiscordInboxQueue = {
    enqueue: async () => { throw new Error('Processing queue is full.'); },
    cancel: () => false,
  };
  const initial = createDiscordInboxService({
    catalog,
    queue: unavailableQueue,
    policy: POLICY,
    process: async () => ({ capability: 'processable' }),
    sendReceipt: async () => ({
      identity: { channelId: 'inbox-1', messageId: 'receipt-before-restart' },
      update: async (content) => { initialReceiptUpdates.push(content); },
    }),
    retryInitialDelayMs: 10_000,
  });

  const captured = await initial.handleCreate(message());
  assert.equal(captured.status, 'waiting');
  assert.match(initialReceiptUpdates.at(-1) ?? '', /waiting for capacity/);
  await initial.close();

  const restoredReceipts: StoredDiscordReceipt[] = [];
  const restoredReceiptUpdates: string[] = [];
  const recovering = createDiscordInboxService({
    catalog,
    queue: new ImmediateQueue(),
    policy: POLICY,
    process: async () => ({ capability: 'processable', summary: 'Recovered after restart.' }),
    restoreReceipt: (receipt) => {
      restoredReceipts.push(receipt);
      return {
        identity: receipt,
        update: async (content) => { restoredReceiptUpdates.push(content); },
      };
    },
  });

  assert.equal(await recovering.recover(), 1);
  assert.deepEqual(restoredReceipts, [{
    channelId: 'inbox-1',
    messageId: 'receipt-before-restart',
    sourceRevision: 1,
  }]);
  assert.equal(restoredReceiptUpdates.some((content) => /processing/.test(content)), true);
  assert.match(restoredReceiptUpdates.at(-1) ?? '', /Processed by Chronicle/);
  const stored = await catalog.get(captured.sourceId!);
  assert.equal(stored?.recordType, 'source');
  if (stored?.recordType === 'source') {
    assert.equal(stored.save.processingStatus, 'succeeded');
    assert.equal(stored.analysis?.summary, 'Recovered after restart.');
  }
  await recovering.close();
});

test('exhausted processing failures remain durable and retry automatically', async (t) => {
  const catalog = await fixture(t);
  const queue = new ImmediateQueue();
  const receiptUpdates: string[] = [];
  let processingAttempts = 0;
  const service = createDiscordInboxService({
    catalog,
    queue,
    policy: POLICY,
    process: async () => {
      processingAttempts += 1;
      if (processingAttempts === 1) throw new Error('Model is temporarily unavailable.');
      return { capability: 'processable', summary: 'Recovered after model failure.' };
    },
    sendReceipt: async () => ({
      update: async (content) => { receiptUpdates.push(content); },
    }),
    retryInitialDelayMs: 5,
    retryMaxDelayMs: 10,
  });

  const captured = await service.handleCreate(message());
  assert.equal(captured.status, 'failed');
  assert.match(receiptUpdates.at(-1) ?? '', /retrying automatically/i);
  await waitFor(async () => {
    const stored = await catalog.get(captured.sourceId!);
    return stored?.recordType === 'source' && stored.save.processingStatus === 'succeeded';
  });
  assert.equal(processingAttempts, 2);
  const stored = await catalog.get(captured.sourceId!);
  assert.equal(stored?.recordType, 'source');
  if (stored?.recordType === 'source') {
    assert.equal(stored.analysis?.summary, 'Recovered after model failure.');
  }
  await service.close();
});
