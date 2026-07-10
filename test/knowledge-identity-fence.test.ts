import assert from 'node:assert/strict';
import { mkdtemp, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('record identity preserves event provenance and discard tombstones fence promotion', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-identity-'));
  process.env.KB_DIR = root;
  process.env.INDEX_PATH = path.join(root, '.index.db');
  process.env.WORKSPACE_ID = 'identity-team';
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    return Response.json({
      data: body.input.map((_text, index) => ({ index, embedding: [1, index + 1] })),
    });
  };
  const {
    approveDraft,
    persistRawCapture,
    stageSourceDraft,
    tombstoneOperation,
    workspaceRoot,
  } = await import('../src/kb.js');
  const baseMeta = {
    date: '2026-07-10',
    kind: 'meeting' as const,
    origin: 'discord:one',
  };
  const first = await persistRawCapture({
    rawText: 'Identical words.',
    meta: baseMeta,
    workspaceId: 'identity-team',
    operationId: 'session-one',
  });
  const retry = await persistRawCapture({
    rawText: 'Identical words.',
    meta: baseMeta,
    workspaceId: 'identity-team',
    operationId: 'session-one',
  });
  const distinct = await persistRawCapture({
    rawText: 'Identical words.',
    meta: { ...baseMeta, origin: 'discord:two' },
    workspaceId: 'identity-team',
    operationId: 'session-two',
  });
  assert.equal(first.id, retry.id);
  assert.equal(first.path, retry.path);
  await assert.rejects(
    persistRawCapture({
      rawText: 'Different words for the same immutable session.',
      meta: baseMeta,
      workspaceId: 'identity-team',
      operationId: 'session-one',
    }),
    /identity collision/,
  );
  assert.equal(first.contentHash, distinct.contentHash);
  assert.notEqual(first.id, distinct.id);
  const originOnlyA = await persistRawCapture({
    rawText: 'Same text without an adapter event id.',
    meta: baseMeta,
    workspaceId: 'identity-team',
  });
  const originOnlyRetry = await persistRawCapture({
    rawText: 'Same text without an adapter event id.',
    meta: baseMeta,
    workspaceId: 'identity-team',
  });
  const originOnlyB = await persistRawCapture({
    rawText: 'Same text without an adapter event id.',
    meta: { ...baseMeta, origin: 'discord:other-origin' },
    workspaceId: 'identity-team',
  });
  assert.equal(originOnlyA.id, originOnlyRetry.id);
  assert.notEqual(originOnlyA.id, originOnlyB.id);

  const summary = {
    title: 'Discarded capture',
    slug: 'discarded-capture',
    summary: 'This must not be promoted.',
    decisions: [],
    action_items: [],
    open_questions: [],
    facts: [
      {
        topic: 'discard',
        topic_title: 'Discard',
        topic_description: 'Discard fencing',
        fact: 'This fact must not be approved.',
      },
    ],
  };

  await tombstoneOperation('discard-before-stage', {
    workspaceId: 'identity-team',
    reason: 'Participant opted out',
  });
  await assert.rejects(
    stageSourceDraft(summary, 'discarded before stage', baseMeta, {
      workspaceId: 'identity-team',
      operationId: 'discard-before-stage',
    }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === 'operation_tombstoned',
  );

  const staged = await stageSourceDraft(summary, 'discarded after stage', baseMeta, {
    workspaceId: 'identity-team',
    operationId: 'discard-after-stage',
  });
  await tombstoneOperation('discard-after-stage', { workspaceId: 'identity-team' });
  await assert.rejects(
    approveDraft(staged.id, { workspaceId: 'identity-team' }),
    (error: unknown) =>
      error instanceof Error &&
      (error as Error & { code?: string }).code === 'operation_tombstoned',
  );
  assert.deepEqual(await readdir(path.join(workspaceRoot('identity-team'), 'meetings')), []);

  const approvalWinner = await stageSourceDraft(summary, 'approval wins the lock', baseMeta, {
    workspaceId: 'identity-team',
    operationId: 'approval-wins',
  });
  await approveDraft(approvalWinner.id, { workspaceId: 'identity-team' });
  const tooLate = await tombstoneOperation('approval-wins', { workspaceId: 'identity-team' });
  assert.equal(tooLate.outcome, 'already_approved');
  if (tooLate.outcome === 'already_approved') assert.equal(tooLate.recordId, approvalWinner.id);

  if (process.platform !== 'win32') {
    assert.equal((await stat(path.join(root, '.chronicle'))).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(root, '.chronicle', 'ledger.db'))).mode & 0o777, 0o600);
    const workspace = workspaceRoot('identity-team');
    assert.equal((await stat(workspace)).mode & 0o777, 0o700);
    for (const directory of ['meetings', 'topics', 'transcripts']) {
      assert.equal((await stat(path.join(workspace, directory))).mode & 0o777, 0o700);
    }
  }
});
