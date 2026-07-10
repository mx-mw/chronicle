import assert from 'node:assert/strict';
import { finished } from 'node:stream/promises';
import { access, mkdir, mkdtemp, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  appendSessionWarning,
  backfillSessionRetentionDeadlines,
  createSessionManifest,
  ensurePrivateDirectory,
  findRecoverableSessions,
  manifestPath,
  purgeRawSessionAudio,
  purgeExpiredSessionAudio,
  purgeSessionAudioAfterAttempt,
  readSessionManifest,
  recoverInterruptedActiveSessions,
  setSessionStage,
  tombstoneSession,
  writeJsonAtomic,
} from '../src/session-manifest.js';
import { createPrivatePcmWriteStream, fenceParticipantOptOut } from '../src/recorder.js';
import { ParticipantAdmissionGate } from '../src/voice-policy.js';

test('session manifests keep a stable id/workspace and serialize concurrent updates', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-manifest-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'session-a');
  await mkdir(dir);
  const file = manifestPath(dir);
  const created = createSessionManifest({
    id: '11111111-1111-4111-8111-111111111111',
    workspaceId: 'guild-a',
    guildId: 'guild-a',
    channelId: 'channel-a',
  });
  await writeJsonAtomic(file, created);

  await Promise.all([
    appendSessionWarning(file, 'first warning'),
    appendSessionWarning(file, 'second warning'),
  ]);
  await setSessionStage(file, 'captured', { durationMs: 2_000 });
  const read = await readSessionManifest(file);
  assert.equal(read.id, created.id);
  assert.equal(read.workspace.id, 'guild-a');
  assert.equal(read.stage, 'captured');
  assert.deepEqual(new Set(read.warnings), new Set(['first warning', 'second warning']));
  assert.equal(read.durationMs, 2_000);

  const recoverable = await findRecoverableSessions(root);
  assert.deepEqual(recoverable.map((item) => item.manifest.id), [created.id]);
});

test('raw-audio purge preserves the session manifest', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-retention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'session-b');
  await mkdir(dir);
  const file = manifestPath(dir);
  const created = createSessionManifest({ guildId: 'g', channelId: 'c' });
  await writeJsonAtomic(file, created);
  await writeFile(path.join(dir, 'audio.pcm'), 'private audio');
  await writeFile(path.join(dir, '0000001250-user-a.txt'), 'orphaned ASR output');
  await writeFile(path.join(dir, 'keep.txt'), 'diagnostic');

  const removed = await purgeRawSessionAudio({ path: file, dir, manifest: created });
  assert.equal(removed, 2);
  await assert.rejects(access(path.join(dir, '0000001250-user-a.txt')), { code: 'ENOENT' });
  await access(path.join(dir, 'keep.txt'));
  assert.equal((await readSessionManifest(file)).id, created.id);
});

test('startup tombstones an interrupted connecting session and arms retention', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-connecting-crash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'connecting');
  await mkdir(dir);
  const file = manifestPath(dir);
  const created = createSessionManifest({
    guildId: 'g',
    channelId: 'c',
    startedAt: new Date('2026-07-10T08:00:00.000Z'),
  });
  await writeJsonAtomic(file, created);

  const [recovered] = await recoverInterruptedActiveSessions(root, {
    retentionHours: 2,
  });
  assert.equal(recovered.manifest.stage, 'failed');
  assert.equal(recovered.manifest.recoverable, false);
  assert.equal(recovered.manifest.rawAudioExpiresAt, '2026-07-10T10:00:00.000Z');
  assert.match(recovered.manifest.error ?? '', /no recoverable PCM/);
});

test('startup converts every interrupted recording PCM file into a recoverable capture', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-recording-crash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'recording');
  await mkdir(dir);
  const file = manifestPath(dir);
  const created = createSessionManifest({ guildId: 'g', channelId: 'c' });
  created.stage = 'recording';
  await writeJsonAtomic(file, created);
  await writeFile(path.join(dir, '0000001250-user-a.pcm'), Buffer.alloc(128));

  const [recovered] = await recoverInterruptedActiveSessions(root, {
    retentionHours: 1,
  });
  assert.equal(recovered.manifest.stage, 'captured');
  assert.equal(recovered.manifest.recoverable, true);
  assert.deepEqual(
    recovered.manifest.segments.map(({ userId, startMs }) => ({ userId, startMs })),
    [{ userId: 'user-a', startMs: 1_250 }],
  );
  assert.match(recovered.manifest.warnings.join(' '), /interrupted while recording/);
});

test('session directories, manifests, and PCM files use private POSIX permissions', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX mode bits are not available on Windows');
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-permissions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'session');
  await ensurePrivateDirectory(dir);
  const file = manifestPath(dir);
  await writeJsonAtomic(file, createSessionManifest({ guildId: 'g', channelId: 'c' }));
  const pcm = path.join(dir, '0000000001-user.pcm');
  const stream = createPrivatePcmWriteStream(pcm);
  stream.end(Buffer.from('private'));
  await finished(stream);

  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(pcm)).mode & 0o777, 0o600);
});

test('discard tombstone is terminal against late stage updates', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-discard-fence-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'session');
  await mkdir(dir);
  const file = manifestPath(dir);
  await writeJsonAtomic(file, createSessionManifest({ guildId: 'g', channelId: 'c' }));
  await setSessionStage(file, 'captured');

  assert.equal((await tombstoneSession(file, 'test discard')).outcome, 'discarded');
  await setSessionStage(file, 'queued');
  await setSessionStage(file, 'completed', { meetingPath: '/should/not/exist' });
  const final = await readSessionManifest(file);
  assert.equal(final.stage, 'discarded');
  assert.equal(final.meetingPath, undefined);
  assert.equal(final.discardReason, 'test discard');
});

test('discard reports already-completed work without rewriting it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-complete-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'session');
  await mkdir(dir);
  const file = manifestPath(dir);
  await writeJsonAtomic(file, createSessionManifest({ guildId: 'g', channelId: 'c' }));
  await setSessionStage(file, 'completed', { meetingPath: '/approved.md' });

  const result = await tombstoneSession(file, 'too late');
  assert.equal(result.outcome, 'already_completed');
  assert.equal(result.manifest.stage, 'completed');
  assert.equal(result.manifest.meetingPath, '/approved.md');
  assert.equal(result.manifest.discardedAt, undefined);
});

test('interrupted recovery erases opted-out participant media and metadata', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-optout-crash-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'recording');
  await mkdir(dir);
  const optedPcm = path.join(dir, '0000000100-opted.pcm');
  const keptPcm = path.join(dir, '0000000200-kept.pcm');
  await writeFile(optedPcm, Buffer.alloc(128));
  await writeFile(keptPcm, Buffer.alloc(128));
  const manifest = createSessionManifest({ guildId: 'g', channelId: 'c' });
  manifest.stage = 'recording';
  manifest.optedOutUserIds = ['opted'];
  manifest.speakers = { opted: 'Private person', kept: 'Kept person' };
  manifest.segments = [
    { userId: 'opted', startMs: 100, pcmPath: optedPcm },
    { userId: 'kept', startMs: 200, pcmPath: keptPcm },
  ];
  await writeJsonAtomic(manifestPath(dir), manifest);

  const [recovered] = await recoverInterruptedActiveSessions(root, { retentionHours: 24 });
  assert.deepEqual(recovered.manifest.segments.map((segment) => segment.userId), ['kept']);
  assert.deepEqual(recovered.manifest.speakers, { kept: 'Kept person' });
  await assert.rejects(access(optedPcm), { code: 'ENOENT' });
  await assert.doesNotReject(access(keptPcm));
});

test('interrupted recovery bases expiry on capture activity, never restart time', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-downtime-expiry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'recording');
  await mkdir(dir);
  const pcm = path.join(dir, '0000000100-user.pcm');
  await writeFile(pcm, Buffer.alloc(128));
  await utimes(pcm, new Date('2026-07-01T09:00:00.000Z'), new Date('2026-07-01T09:00:00.000Z'));
  const manifest = createSessionManifest({
    guildId: 'g',
    channelId: 'c',
    startedAt: new Date('2026-07-01T08:00:00.000Z'),
  });
  manifest.stage = 'recording';
  manifest.rawAudioExpiresAt = '2026-08-01T00:00:00.000Z';
  await writeJsonAtomic(manifestPath(dir), manifest);

  const [recovered] = await recoverInterruptedActiveSessions(root, { retentionHours: 2 });
  assert.equal(recovered.manifest.endedAt, '2026-07-01T09:00:00.000Z');
  assert.equal(recovered.manifest.rawAudioExpiresAt, '2026-07-01T11:00:00.000Z');
});

test('zero retention preserves recoverable audio through startup and purges after success', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-zero-retention-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'recording');
  await mkdir(dir);
  const pcm = path.join(dir, '0000000100-user.pcm');
  await writeFile(pcm, Buffer.alloc(128));
  const manifest = createSessionManifest({ guildId: 'g', channelId: 'c' });
  manifest.stage = 'recording';
  await writeJsonAtomic(manifestPath(dir), manifest);

  const [recovered] = await recoverInterruptedActiveSessions(root, { retentionHours: 0 });
  assert.equal(recovered.manifest.stage, 'captured');
  assert.equal(recovered.manifest.rawAudioExpiresAt, undefined);
  assert.equal(await purgeExpiredSessionAudio(root, new Date('2099-01-01T00:00:00Z')), 0);
  await assert.doesNotReject(access(pcm));

  const reviewed = await setSessionStage(manifestPath(dir), 'needs_review');
  assert.equal(
    await purgeSessionAudioAfterAttempt(
      { path: manifestPath(dir), dir, manifest: reviewed },
      0,
      new Date('2026-07-10T10:00:00Z'),
    ),
    1,
  );
  await assert.rejects(access(pcm), { code: 'ENOENT' });
});

test('zero retention does not delete audio when processing still promises recovery', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-zero-retry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'failed');
  await mkdir(dir);
  const pcm = path.join(dir, '0000000100-user.pcm');
  await writeFile(pcm, Buffer.alloc(128));
  const manifest = createSessionManifest({ guildId: 'g', channelId: 'c' });
  manifest.stage = 'failed';
  manifest.recoverable = true;
  manifest.segments = [{ userId: 'user', startMs: 100, pcmPath: pcm }];
  await writeJsonAtomic(manifestPath(dir), manifest);

  assert.equal(
    await purgeSessionAudioAfterAttempt(
      { path: manifestPath(dir), dir, manifest },
      0,
    ),
    0,
  );
  await assert.doesNotReject(access(pcm));
});

test('retention backfill uses endedAt before startup expiry sweep', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-retention-backfill-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'captured');
  await mkdir(dir);
  const pcm = path.join(dir, '0000000100-user.pcm');
  await writeFile(pcm, Buffer.alloc(128));
  await utimes(pcm, new Date('2026-07-01T09:00:00Z'), new Date('2026-07-01T09:00:00Z'));
  const manifest = createSessionManifest({
    guildId: 'g',
    channelId: 'c',
    startedAt: new Date('2026-07-01T08:00:00Z'),
  });
  manifest.stage = 'captured';
  manifest.endedAt = '2026-07-01T09:00:00.000Z';
  manifest.rawAudioExpiresAt = '2026-08-01T00:00:00.000Z';
  manifest.segments = [{ userId: 'user', startMs: 100, pcmPath: pcm }];
  await writeJsonAtomic(manifestPath(dir), manifest);

  const [backfilled] = await backfillSessionRetentionDeadlines(root, 2);
  assert.equal(backfilled.manifest.rawAudioExpiresAt, '2026-07-01T11:00:00.000Z');
  assert.equal(await purgeExpiredSessionAudio(root, new Date('2026-07-02T00:00:00Z')), 1);
  await assert.rejects(access(pcm), { code: 'ENOENT' });
});

test('opt-out fence removes capture state synchronously before filesystem cleanup', () => {
  const admission = new ParticipantAdmissionGate(['private-user', 'kept-user']);
  const segments = [
    { userId: 'private-user', startMs: 1, pcmPath: '/private.pcm' },
    { userId: 'kept-user', startMs: 2, pcmPath: '/kept.pcm' },
  ];
  const speakers = new Map([
    ['private-user', 'Private'],
    ['kept-user', 'Kept'],
  ]);
  const removed = fenceParticipantOptOut({
    userId: 'private-user',
    admission,
    segments,
    speakers,
  });
  assert.equal(admission.canCapture('private-user'), false);
  assert.deepEqual(segments.map((segment) => segment.userId), ['kept-user']);
  assert.deepEqual([...speakers.keys()], ['kept-user']);
  assert.deepEqual(removed.map((segment) => segment.userId), ['private-user']);
});
