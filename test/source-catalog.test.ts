import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  EncryptedSourceCatalog,
  SourceRevisionConflictError,
  type CaptureDiscordMessageInput,
  type SourceCatalogRecord,
} from '../src/source-catalog.js';

const KEY = Buffer.alloc(32, 7).toString('base64');

function message(id: string, text = `message ${id}`): CaptureDiscordMessageInput {
  return {
    workspaceId: 'workspace-1',
    guildId: 'guild-1',
    channelId: 'inbox-1',
    messageId: id,
    author: {
      id: 'author-1',
      username: 'ethan',
      displayName: 'Ethan Wu',
    },
    text,
    urls: ['https://www.youtube.com/watch?v=abc123#clip'],
    attachments: [
      {
        id: 'attachment-1',
        filename: 'reference.png',
        contentType: 'image/png',
        sizeBytes: 120,
        url: 'https://cdn.discordapp.com/attachments/channel/file/reference.png?ex=secret&is=secret',
      },
    ],
    messageCreatedAt: '2026-07-10T09:00:00.000Z',
  };
}

async function fixture(t: Parameters<typeof test>[1] extends (context: infer T) => unknown ? T : never) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-source-catalog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

function asRecord(value: unknown): SourceCatalogRecord {
  assert.equal((value as { recordType?: string }).recordType, 'source');
  return value as SourceCatalogRecord;
}

test('records are AES-256-GCM ciphertext at rest with private permissions', async (t) => {
  const root = await fixture(t);
  const catalog = new EncryptedSourceCatalog({ directory: root, encryptionKey: KEY });
  const result = await catalog.captureDiscordMessage(message('message-secret', 'plaintext secret'));
  const record = asRecord(result.entry);
  assert.equal(record.source.urls[0]?.url, 'https://www.youtube.com/watch?v=abc123');
  assert.equal(
    record.source.attachments[0]?.url,
    'https://cdn.discordapp.com/attachments/channel/file/reference.png',
  );

  const [filename] = await readdir(path.join(root, 'records'));
  const raw = await readFile(path.join(root, 'records', filename), 'utf8');
  assert.doesNotMatch(raw, /plaintext secret|message-secret|Ethan Wu|cdn\.discordapp/);
  const envelope = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(envelope.algorithm, 'aes-256-gcm');
  assert.equal(typeof envelope.ciphertext, 'string');
  assert.equal((await catalog.get(record.source.id))?.recordType, 'source');

  if (process.platform !== 'win32') {
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(root, 'records'))).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(root, 'records', filename))).mode & 0o777, 0o600);
  }
});

test('Discord media signatures are removed from stored URLs and message text only', async (t) => {
  const root = await fixture(t);
  const catalog = new EncryptedSourceCatalog({ directory: root, encryptionKey: KEY });
  const input = message(
    'message-signed-url',
    'See https://cdn.discordapp.com/attachments/1/2/file.png?ex=aaa&is=bbb&hm=secret&width=800. ' +
      'Keep https://youtube.com/watch?v=functional&ex=normal',
  );
  input.urls = [
    'https://media.discordapp.net/attachments/1/2/file.png?hm=secret&width=640',
    'https://youtube.com/watch?v=functional&ex=normal',
  ];
  const record = asRecord((await catalog.captureDiscordMessage(input)).entry);

  assert.equal(
    record.source.text,
    'See https://cdn.discordapp.com/attachments/1/2/file.png?width=800. ' +
      'Keep https://youtube.com/watch?v=functional&ex=normal',
  );
  assert.deepEqual(
    record.source.urls.map(({ url }) => url),
    [
      'https://media.discordapp.net/attachments/1/2/file.png?width=640',
      'https://youtube.com/watch?v=functional&ex=normal',
    ],
  );
});

test('exact Discord replay is idempotent and an edit creates a reset revision', async (t) => {
  const root = await fixture(t);
  const catalog = new EncryptedSourceCatalog({ directory: root, encryptionKey: KEY });
  const first = await catalog.captureDiscordMessage(message('message-1'));
  const replay = await catalog.captureDiscordMessage(message('message-1'));
  assert.equal(first.outcome, 'created');
  assert.equal(replay.outcome, 'unchanged');
  assert.deepEqual(replay.entry, first.entry);

  const id = asRecord(first.entry).source.id;
  await catalog.update(id, {
    processingStatus: 'succeeded',
    reviewStatus: 'needs_review',
    analysis: { capability: 'processable', summary: 'Old analysis' },
  });
  const editedInput = message('message-1', 'edited content');
  editedInput.messageEditedAt = '2026-07-10T10:00:00.000Z';
  const edited = await catalog.captureDiscordMessage(editedInput);
  const editedRecord = asRecord(edited.entry);
  assert.equal(edited.outcome, 'revised');
  assert.equal(editedRecord.source.sourceRevision, 2);
  assert.equal(editedRecord.source.status, 'edited');
  assert.equal(editedRecord.save.processingStatus, 'queued');
  assert.equal(editedRecord.save.reviewStatus, 'not_generated');
  assert.equal(editedRecord.analysis, undefined);
  assert.equal((await readdir(path.join(root, 'records'))).length, 1);
});

test('list is newest-first and recoverable list excludes succeeded and partial work', async (t) => {
  const root = await fixture(t);
  const times = [
    new Date('2026-07-10T09:00:00.000Z'),
    new Date('2026-07-10T10:00:00.000Z'),
    new Date('2026-07-10T11:00:00.000Z'),
    new Date('2026-07-10T12:00:00.000Z'),
  ];
  const catalog = new EncryptedSourceCatalog({
    directory: root,
    encryptionKey: KEY,
    now: () => times.shift() ?? new Date('2026-07-10T13:00:00.000Z'),
  });
  const first = asRecord((await catalog.captureDiscordMessage(message('message-1'))).entry);
  const second = asRecord((await catalog.captureDiscordMessage(message('message-2'))).entry);
  await catalog.captureDiscordMessage(message('message-3'));

  const page1 = await catalog.list({ limit: 2 });
  assert.deepEqual(
    page1.items.map((entry) => asRecord(entry).source.discord.messageId),
    ['message-3', 'message-2'],
  );
  assert.ok(page1.nextCursor);
  const page2 = await catalog.list({ limit: 2, cursor: page1.nextCursor });
  assert.deepEqual(
    page2.items.map((entry) => asRecord(entry).source.discord.messageId),
    ['message-1'],
  );
  assert.equal(page2.nextCursor, undefined);

  await catalog.update(first.source.id, { processingStatus: 'succeeded' });
  await catalog.update(second.source.id, { processingStatus: 'partial' });
  const recoverable = await catalog.listRecoverable();
  assert.deepEqual(
    recoverable.items.map((entry) => asRecord(entry).source.discord.messageId),
    ['message-3'],
  );
});

test('workspace filtering happens before pagination and never leaks another workspace order', async (t) => {
  const root = await fixture(t);
  const times = [
    new Date('2026-07-10T09:00:00.000Z'),
    new Date('2026-07-10T10:00:00.000Z'),
    new Date('2026-07-10T11:00:00.000Z'),
  ];
  const catalog = new EncryptedSourceCatalog({
    directory: root,
    encryptionKey: KEY,
    now: () => times.shift() ?? new Date('2026-07-10T12:00:00.000Z'),
  });
  await catalog.captureDiscordMessage(message('workspace-1-old'));
  const otherWorkspace = message('workspace-2-newest');
  otherWorkspace.workspaceId = 'workspace-2';
  await catalog.captureDiscordMessage(otherWorkspace);
  await catalog.captureDiscordMessage(message('workspace-1-new'));

  const firstPage = await catalog.list({ workspaceId: 'workspace-1', limit: 1 });
  assert.deepEqual(
    firstPage.items.map((entry) => asRecord(entry).source.discord.messageId),
    ['workspace-1-new'],
  );
  assert.ok(firstPage.nextCursor);
  const secondPage = await catalog.list({
    workspaceId: 'workspace-1',
    limit: 1,
    cursor: firstPage.nextCursor,
  });
  assert.deepEqual(
    secondPage.items.map((entry) => asRecord(entry).source.discord.messageId),
    ['workspace-1-old'],
  );
  assert.equal(secondPage.nextCursor, undefined);

  const isolated = await catalog.list({ workspaceId: 'workspace-2' });
  assert.deepEqual(
    isolated.items.map((entry) => asRecord(entry).source.discord.messageId),
    ['workspace-2-newest'],
  );
});

test('status and encrypted analysis updates persist', async (t) => {
  const root = await fixture(t);
  const catalog = new EncryptedSourceCatalog({ directory: root, encryptionKey: KEY });
  const created = asRecord((await catalog.captureDiscordMessage(message('message-2'))).entry);
  const updated = await catalog.update(created.source.id, {
    sourceStatus: 'edited',
    processingStatus: 'partial',
    reviewStatus: 'needs_review',
    analysis: {
      capability: 'partial',
      title: 'Design reference',
      summary: 'A useful visual reference.',
      actionItems: [{ owner: 'Ethan', task: 'Review the composition' }],
      topics: [{ topic: 'Design', fact: 'The reel uses a compact type scale.' }],
      warning: 'Video bytes were unavailable.',
    },
  });
  assert.equal(updated.source.status, 'edited');
  assert.equal(updated.save.processingStatus, 'partial');
  assert.equal(updated.save.reviewStatus, 'needs_review');
  assert.equal(updated.analysis?.title, 'Design reference');

  const [filename] = await readdir(path.join(root, 'records'));
  const raw = await readFile(path.join(root, 'records', filename), 'utf8');
  assert.doesNotMatch(raw, /Design reference|compact type scale|Video bytes/);
});

test('revision compare-and-swap fences stale processing results after a Discord edit', async (t) => {
  const root = await fixture(t);
  const catalog = new EncryptedSourceCatalog({ directory: root, encryptionKey: KEY });
  const created = asRecord((await catalog.captureDiscordMessage(message('message-cas'))).entry);
  const editedInput = message('message-cas', 'new content');
  editedInput.messageEditedAt = '2026-07-10T10:00:00.000Z';
  const edited = asRecord((await catalog.captureDiscordMessage(editedInput)).entry);
  assert.equal(created.source.sourceRevision, 1);
  assert.equal(edited.source.sourceRevision, 2);

  await assert.rejects(
    catalog.update(
      edited.source.id,
      {
        processingStatus: 'succeeded',
        analysis: { capability: 'processable', summary: 'Stale analysis' },
      },
      { expectedSourceRevision: 1 },
    ),
    (error: unknown) => {
      assert.ok(error instanceof SourceRevisionConflictError);
      assert.equal(error.expectedSourceRevision, 1);
      assert.equal(error.actualSourceRevision, 2);
      return true;
    },
  );
  const fenced = asRecord(await catalog.get(edited.source.id));
  assert.equal(fenced.save.processingStatus, 'queued');
  assert.equal(fenced.analysis, undefined);

  const accepted = await catalog.update(
    edited.source.id,
    {
      processingStatus: 'succeeded',
      analysis: { capability: 'processable', summary: 'Current analysis' },
    },
    { expectedSourceRevision: 2 },
  );
  assert.equal(accepted.analysis?.summary, 'Current analysis');
});

test('discard removes content and preserves a terminal identity tombstone', async (t) => {
  const root = await fixture(t);
  const catalog = new EncryptedSourceCatalog({ directory: root, encryptionKey: KEY });
  const created = asRecord(
    (await catalog.captureDiscordMessage(message('message-discard', 'content to erase'))).entry,
  );
  const tombstone = await catalog.discardByDiscordMessage(
    { guildId: 'guild-1', channelId: 'inbox-1', messageId: 'message-discard' },
    'user_requested',
  );
  assert.ok(tombstone);
  assert.equal(tombstone.recordType, 'tombstone');
  assert.equal(tombstone.sourceId, created.source.id);
  assert.equal(tombstone.discord.messageId, 'message-discard');
  assert.equal('text' in tombstone, false);
  assert.equal('author' in tombstone, false);
  assert.equal('attachments' in tombstone, false);
  assert.equal('analysis' in tombstone, false);
  assert.deepEqual(await catalog.discard(created.source.id), tombstone);
  assert.equal((await catalog.captureDiscordMessage(message('message-discard'))).outcome, 'unchanged');
});

test('retention tombstones expired content once and leaves newer records intact', async (t) => {
  const root = await fixture(t);
  const times = [
    new Date('2026-07-01T00:00:00.000Z'),
    new Date('2026-07-09T00:00:00.000Z'),
  ];
  const catalog = new EncryptedSourceCatalog({
    directory: root,
    encryptionKey: KEY,
    now: () => times.shift() ?? new Date('2026-07-10T00:00:00.000Z'),
  });
  await catalog.captureDiscordMessage(message('old'));
  await catalog.captureDiscordMessage(message('new'));
  assert.equal(await catalog.purgeExpired(7, new Date('2026-07-10T00:00:00.000Z')), 1);
  assert.equal(await catalog.purgeExpired(7, new Date('2026-07-10T00:00:00.000Z')), 0);
  const entries = (await catalog.list()).items;
  assert.equal(entries.filter((entry) => entry.recordType === 'tombstone').length, 1);
  assert.equal(entries.filter((entry) => entry.recordType === 'source').length, 1);
});

test('invalid encryption keys are rejected without touching the filesystem', async (t) => {
  const root = await fixture(t);
  assert.throws(
    () => new EncryptedSourceCatalog({ directory: root, encryptionKey: 'not-a-valid-key' }),
    /base64-encoded 32-byte key/,
  );
  assert.throws(
    () =>
      new EncryptedSourceCatalog({
        directory: root,
        encryptionKey: Buffer.alloc(31).toString('base64'),
      }),
    /base64-encoded 32-byte key/,
  );

  const catalog = new EncryptedSourceCatalog({ directory: root, encryptionKey: KEY });
  const record = asRecord((await catalog.captureDiscordMessage(message('encrypted'))).entry);
  const wrongKeyCatalog = new EncryptedSourceCatalog({
    directory: root,
    encryptionKey: Buffer.alloc(32, 8).toString('base64'),
  });
  await assert.rejects(wrongKeyCatalog.get(record.source.id), /Unable to decrypt/);
});
