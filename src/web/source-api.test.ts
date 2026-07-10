import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { EncryptedSourceCatalog, type CaptureDiscordMessageInput } from '../source-catalog.js';
import { createChronicleWebServer } from './server.js';

const KEY = Buffer.alloc(32, 11).toString('base64');

function message(
  messageId: string,
  workspaceId: string,
  text = `source ${messageId}`,
): CaptureDiscordMessageInput {
  return {
    workspaceId,
    guildId: workspaceId,
    channelId: 'inbox-1',
    messageId,
    author: { id: 'author-1', username: 'ethan' },
    text,
    messageCreatedAt: '2026-07-10T10:00:00.000Z',
  };
}

test('source API pages within one workspace and supports detail and discard', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chronicle-source-api-'));
  const previousDirectory = process.env.SOURCE_CATALOG_DIR;
  const previousKey = process.env.SOURCE_ENCRYPTION_KEY;
  const previousRetention = process.env.INBOX_RETENTION_DAYS;
  process.env.SOURCE_CATALOG_DIR = directory;
  process.env.SOURCE_ENCRYPTION_KEY = KEY;
  process.env.INBOX_RETENTION_DAYS = '30';

  const catalog = new EncryptedSourceCatalog({ directory, encryptionKey: KEY });
  const one = await catalog.captureDiscordMessage(message('message-1', 'guild-a'));
  const two = await catalog.captureDiscordMessage(message('message-2', 'guild-a'));
  assert.equal(two.entry.recordType, 'source');
  const secondSourceId = two.entry.source.id;
  await catalog.captureDiscordMessage(message('message-other', 'guild-b', 'must not leak'));
  assert.equal(one.entry.recordType, 'source');
  const sourceId = one.entry.source.id;
  const expiredCatalog = new EncryptedSourceCatalog({
    directory,
    encryptionKey: KEY,
    now: () => new Date('2020-01-01T00:00:00.000Z'),
  });
  const expired = await expiredCatalog.captureDiscordMessage(
    message('message-expired', 'guild-expired'),
  );
  assert.equal(expired.entry.recordType, 'source');
  const expiredSourceId = expired.entry.source.id;

  const server = createChronicleWebServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = { 'X-Chronicle-Workspace': 'guild-a' };

  try {
    const expiredDetail = await fetch(`${base}/api/sources/${expiredSourceId}`, {
      headers: { 'X-Chronicle-Workspace': 'guild-expired' },
    });
    assert.equal(expiredDetail.status, 200);
    const expiredBody = await expiredDetail.json() as {
      source: { recordType: string; sourceStatus: string; text?: string };
    };
    assert.equal(expiredBody.source.recordType, 'tombstone');
    assert.equal(expiredBody.source.sourceStatus, 'discarded');
    assert.equal(expiredBody.source.text, undefined);

    const first = await fetch(`${base}/api/sources?limit=1`, { headers });
    assert.equal(first.status, 200);
    const firstBody = await first.json() as {
      sources: Array<{ recordType: string }>;
      nextCursor: string | null;
      workspaceId: string;
    };
    assert.equal(firstBody.sources.length, 1);
    assert.equal(firstBody.workspaceId, 'guild-a');
    assert.ok(firstBody.nextCursor);

    const second = await fetch(
      `${base}/api/sources?limit=10&cursor=${encodeURIComponent(firstBody.nextCursor!)}`,
      { headers },
    );
    assert.equal(second.status, 200);
    const secondBody = await second.json() as { sources: unknown[]; nextCursor: null };
    assert.equal(secondBody.sources.length, 1);
    assert.equal(secondBody.nextCursor, null);

    const invalidCursor = await fetch(`${base}/api/sources?cursor=invalid`, { headers });
    assert.equal(invalidCursor.status, 400);

    const detail = await fetch(`${base}/api/sources/${sourceId}`, { headers });
    assert.equal(detail.status, 200);
    const detailBody = await detail.json() as {
      source: { recordType: string; source: { text: string } };
    };
    assert.equal(detailBody.source.recordType, 'source');
    assert.equal(detailBody.source.source.text, 'source message-1');

    const hidden = await fetch(`${base}/api/sources/${sourceId}`, {
      headers: { 'X-Chronicle-Workspace': 'guild-b' },
    });
    assert.equal(hidden.status, 404);

    const discarded = await fetch(`${base}/api/sources/${sourceId}`, {
      method: 'DELETE',
      headers: { ...headers, Origin: base },
    });
    assert.equal(discarded.status, 200);
    const discardedBody = await discarded.json() as {
      source: { recordType: string; sourceStatus: string; text?: string };
    };
    assert.equal(discardedBody.source.recordType, 'tombstone');
    assert.equal(discardedBody.source.sourceStatus, 'discarded');
    assert.equal(discardedBody.source.text, undefined);

    delete process.env.INBOX_RETENTION_DAYS;
    const listRetentionRequired = await fetch(`${base}/api/sources`, { headers });
    assert.equal(listRetentionRequired.status, 503);
    const retentionRequired = await fetch(`${base}/api/sources/${secondSourceId}`, { headers });
    assert.equal(retentionRequired.status, 503);
    const deletionWithoutRetention = await fetch(`${base}/api/sources/${secondSourceId}`, {
      method: 'DELETE',
      headers: { ...headers, Origin: base },
    });
    assert.equal(deletionWithoutRetention.status, 200);
  } finally {
    server.close();
    await once(server, 'close');
    if (previousDirectory === undefined) delete process.env.SOURCE_CATALOG_DIR;
    else process.env.SOURCE_CATALOG_DIR = previousDirectory;
    if (previousKey === undefined) delete process.env.SOURCE_ENCRYPTION_KEY;
    else process.env.SOURCE_ENCRYPTION_KEY = previousKey;
    if (previousRetention === undefined) delete process.env.INBOX_RETENTION_DAYS;
    else process.env.INBOX_RETENTION_DAYS = previousRetention;
    await rm(directory, { recursive: true, force: true });
  }
});
