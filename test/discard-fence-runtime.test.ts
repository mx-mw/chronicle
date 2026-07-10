import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { ProcessingCancelledError, ProcessingQueue } from '../src/jobs.js';
import {
  createSessionManifest,
  manifestPath,
  readSessionManifest,
  tombstoneSession,
  writeJsonAtomic,
} from '../src/session-manifest.js';

const kbRoot = await mkdtemp(path.join(os.tmpdir(), 'chronicle-discard-kb-'));
const previousKbDir = process.env.KB_DIR;
process.env.KB_DIR = kbRoot;
after(async () => {
  if (previousKbDir === undefined) delete process.env.KB_DIR;
  else process.env.KB_DIR = previousKbDir;
  await rm(kbRoot, { recursive: true, force: true });
});

const {
  OperationTombstonedError,
  approveDraft,
  listDrafts,
  persistRawCapture,
  readDraft,
  stageSourceDraft,
  tombstoneOperation,
  workspaceRoot,
} = await import('../src/kb.js');
const { reconcileDiscardedSessions } = await import('../src/pipeline.js');

const summary = {
  title: 'Discard race',
  slug: 'discard-race',
  summary: 'A deterministic discard test.',
  decisions: [],
  action_items: [],
  open_questions: [],
  facts: [],
};
const meta = {
  date: '2026-07-10',
  kind: 'meeting' as const,
  origin: 'discord:test',
  attribution: ['Tester'],
  durationMinutes: 1,
};

test('KB tombstone is acquired before queue cancellation and fences late staging', async () => {
  const operationId = 'session-late-stage';
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  let releaseWorker!: () => void;
  const workerRelease = new Promise<void>((resolve) => {
    releaseWorker = resolve;
  });
  let markLateSettled!: (value: unknown) => void;
  const lateSettled = new Promise<unknown>((resolve) => {
    markLateSettled = resolve;
  });
  const queue = new ProcessingQueue<void>({ retries: 0, timeoutMs: 5_000 });
  const ordering: string[] = [];
  const queued = queue.enqueue({
    id: operationId,
    run: async () => {
      markStarted();
      await workerRelease; // deliberately ignores AbortSignal
      try {
        await stageSourceDraft(summary, 'late transcript', meta, {
          workspaceId: 'guild-a',
          operationId,
        });
        markLateSettled('staged');
      } catch (error) {
        markLateSettled(error);
      }
    },
  });
  const rejected = assert.rejects(queued, ProcessingCancelledError);
  await started;
  ordering.push('kb-fence-start');
  assert.equal(
    (await tombstoneOperation(operationId, { workspaceId: 'guild-a', reason: 'discard test' })).outcome,
    'tombstoned',
  );
  ordering.push('kb-fence-durable');
  assert.equal(await queue.cancelAndWait(operationId, 'discard test'), 'cancelled');
  ordering.push('queue-cancelled');
  await rejected;
  releaseWorker();

  assert.ok((await lateSettled) instanceof OperationTombstonedError);
  assert.deepEqual(ordering, ['kb-fence-start', 'kb-fence-durable', 'queue-cancelled']);
  assert.equal((await listDrafts({ workspaceId: 'guild-a' })).length, 0);
  const transcripts = await readdir(path.join(workspaceRoot('guild-a'), 'transcripts')).catch(
    () => [],
  );
  assert.deepEqual(transcripts, [], 'late worker must not preserve a raw transcript after discard');
});

test('a tombstone acquired after staging but before approval prevents auto-approval', async () => {
  const operationId = 'session-before-approval';
  const draft = await stageSourceDraft(summary, 'staged transcript', meta, {
    workspaceId: 'guild-b',
    operationId,
  });
  assert.equal(
    (await tombstoneOperation(operationId, { workspaceId: 'guild-b', reason: 'discard test' })).outcome,
    'tombstoned',
  );
  await assert.rejects(
    approveDraft(draft.id, { workspaceId: 'guild-b' }),
    OperationTombstonedError,
  );
  const meetings = await readdir(path.join(kbRoot, 'workspaces'), { recursive: true }).catch(() => []);
  assert.equal(meetings.some((entry) => String(entry).endsWith('.md') && String(entry).includes('meetings')), false);
});

test('durable session identity distinguishes equal transcripts while retrying idempotently', async () => {
  const first = await persistRawCapture({
    rawText: 'identical words',
    meta: { ...meta, sourceEventId: 'discord-session-one' },
    workspaceId: 'guild-c',
    operationId: 'discord-session-one',
  });
  const firstRetry = await persistRawCapture({
    rawText: 'identical words',
    meta: { ...meta, sourceEventId: 'discord-session-one' },
    workspaceId: 'guild-c',
    operationId: 'discord-session-one',
  });
  const second = await persistRawCapture({
    rawText: 'identical words',
    meta: { ...meta, sourceEventId: 'discord-session-two' },
    workspaceId: 'guild-c',
    operationId: 'discord-session-two',
  });
  assert.equal(firstRetry.id, first.id);
  assert.notEqual(second.id, first.id);
});

test('startup reconciliation closes a crash after session tombstone but before KB fence', async () => {
  const operationId = 'crash-before-kb-fence';
  const workspaceId = 'guild-reconcile-a';
  const draft = await stageSourceDraft(summary, 'discarded draft transcript', meta, {
    workspaceId,
    operationId,
  });
  const sessionsRoot = path.join(kbRoot, 'sessions-reconcile-a');
  const dir = path.join(sessionsRoot, operationId);
  await mkdir(dir, { recursive: true });
  const file = manifestPath(dir);
  const manifest = createSessionManifest({
    id: operationId,
    workspaceId,
    guildId: workspaceId,
    channelId: 'channel-a',
  });
  manifest.stage = 'needs_review';
  manifest.draftId = draft.id;
  await writeJsonAtomic(file, manifest);
  await tombstoneSession(file, 'crashed discard');

  const [result] = await reconcileDiscardedSessions(sessionsRoot);
  assert.equal(result.outcome, 'tombstoned');
  assert.deepEqual(result.rejectedDraftIds, [draft.id]);
  assert.equal((await readDraft(draft.id, { workspaceId })).status, 'rejected');
  await assert.rejects(
    approveDraft(draft.id, { workspaceId }),
    OperationTombstonedError,
  );
});

test('startup reconciliation unconditionally removes media left after discard crash', async () => {
  const operationId = 'crash-before-media-purge';
  const workspaceId = 'guild-reconcile-b';
  const sessionsRoot = path.join(kbRoot, 'sessions-reconcile-b');
  const dir = path.join(sessionsRoot, operationId);
  await mkdir(dir, { recursive: true });
  const pcm = path.join(dir, '0000000001-user.pcm');
  const wav = path.join(dir, '0000000001-user.wav');
  const transcriptArtifact = path.join(dir, '0000000001-user.txt');
  const diagnostic = path.join(dir, 'keep.txt');
  await writeFile(pcm, Buffer.alloc(32));
  await writeFile(wav, Buffer.alloc(32));
  await writeFile(transcriptArtifact, 'orphaned ASR output');
  await writeFile(diagnostic, 'operator diagnostic');
  const manifest = createSessionManifest({
    id: operationId,
    workspaceId,
    guildId: workspaceId,
    channelId: 'channel-b',
  });
  manifest.stage = 'discarded';
  manifest.segments = [{ userId: 'user', startMs: 1, pcmPath: pcm }];
  await writeJsonAtomic(manifestPath(dir), manifest);

  const [result] = await reconcileDiscardedSessions(sessionsRoot);
  assert.equal(result.outcome, 'tombstoned');
  assert.equal(result.removedMedia, 3);
  await assert.rejects(access(pcm), { code: 'ENOENT' });
  await assert.rejects(access(wav), { code: 'ENOENT' });
  await assert.rejects(access(transcriptArtifact), { code: 'ENOENT' });
  await access(diagnostic);
  assert.deepEqual((await readSessionManifest(manifestPath(dir))).segments, []);
});

test('startup reconciliation closes the reverse crash after KB fence but before session tombstone', async () => {
  const operationId = 'reverse-crash-after-kb-fence';
  const workspaceId = 'guild-reconcile-reverse';
  const draft = await stageSourceDraft(summary, 'reverse crash transcript', meta, {
    workspaceId,
    operationId,
  });
  assert.equal(
    (await tombstoneOperation(operationId, { workspaceId, reason: 'KB fence won first' })).outcome,
    'tombstoned',
  );
  const sessionsRoot = path.join(kbRoot, 'sessions-reconcile-reverse');
  const dir = path.join(sessionsRoot, operationId);
  await mkdir(dir, { recursive: true });
  const pcm = path.join(dir, '0000000001-user.pcm');
  await writeFile(pcm, Buffer.alloc(32));
  const manifest = createSessionManifest({
    id: operationId,
    workspaceId,
    guildId: workspaceId,
    channelId: 'channel-reverse',
  });
  manifest.stage = 'captured'; // crash happened before the session tombstone
  manifest.draftId = draft.id;
  manifest.segments = [{ userId: 'user', startMs: 1, pcmPath: pcm }];
  await writeJsonAtomic(manifestPath(dir), manifest);

  const [result] = await reconcileDiscardedSessions(sessionsRoot);
  assert.equal(result.outcome, 'tombstoned');
  assert.deepEqual(result.rejectedDraftIds, [draft.id]);
  assert.equal((await readSessionManifest(manifestPath(dir))).stage, 'discarded');
  assert.equal((await readDraft(draft.id, { workspaceId })).status, 'rejected');
  await assert.rejects(access(pcm), { code: 'ENOENT' });
});

test('startup reconciliation preserves an approval that won before discard', async () => {
  const operationId = 'approval-won-before-crash';
  const workspaceId = 'guild-reconcile-c';
  const draft = await stageSourceDraft(summary, 'already approved transcript', meta, {
    workspaceId,
    operationId,
  });
  const approval = await approveDraft(draft.id, { workspaceId });
  const sessionsRoot = path.join(kbRoot, 'sessions-reconcile-c');
  const dir = path.join(sessionsRoot, operationId);
  await mkdir(dir, { recursive: true });
  const pcm = path.join(dir, '0000000001-user.pcm');
  await writeFile(pcm, Buffer.alloc(32));
  const manifest = createSessionManifest({
    id: operationId,
    workspaceId,
    guildId: workspaceId,
    channelId: 'channel-c',
  });
  manifest.stage = 'discarded';
  manifest.segments = [{ userId: 'user', startMs: 1, pcmPath: pcm }];
  await writeJsonAtomic(manifestPath(dir), manifest);

  const [result] = await reconcileDiscardedSessions(sessionsRoot);
  assert.equal(result.outcome, 'already_approved');
  assert.equal(result.removedMedia, 1);
  const reconciled = await readSessionManifest(manifestPath(dir));
  assert.equal(reconciled.stage, 'completed');
  assert.equal(reconciled.meetingPath, approval.meetingPath);
  assert.equal((await readDraft(draft.id, { workspaceId })).status, 'approved');
  await assert.rejects(access(pcm), { code: 'ENOENT' });
});
