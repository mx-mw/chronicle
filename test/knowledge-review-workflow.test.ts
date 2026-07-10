import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('review workflow gates approved notes and is idempotent', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-review-'));
  process.env.KB_DIR = root;
  process.env.INDEX_PATH = path.join(root, '.index.db');
  process.env.EMBED_BASE_URL = 'http://127.0.0.1:11434/v1';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { input: string[] };
    return Response.json({
      data: request.input.map((_text, index) => ({ index, embedding: [1, index + 1, 0.5] })),
    });
  };

  try {
    const {
      approveDraft,
      listDrafts,
      readDraft,
      stageSourceDraft,
      updateDraft,
      workspaceRoot,
    } = await import('../src/kb.js');
    const summary = {
      title: 'Chronicle Review',
      slug: 'chronicle-review',
      summary: 'A review gate protects durable memory.',
      decisions: ['Add review.'],
      action_items: [{ owner: 'Max', task: 'Review the draft.' }],
      open_questions: [],
      facts: [
        {
          topic: 'review',
          topic_title: '審核 Review',
          topic_description: 'Human review workflow',
          fact: 'Approved records alone update topic notes.',
        },
        {
          topic: 'review',
          topic_title: '審核 Review',
          topic_description: 'Human review workflow',
          fact: 'Approved records alone update topic notes.',
        },
      ],
    };
    const meta = {
      date: '2026-07-10',
      kind: 'meeting' as const,
      origin: 'discord:test',
      attribution: ['Ethan', 'Max'],
      durationMinutes: 12,
    };

    const draft = await stageSourceDraft(summary, 'Exact raw transcript.', meta, {
      workspaceId: 'team:max',
      warnings: ['Speaker uncertain'],
    });
    assert.equal(draft.status, 'needs_review');
    assert.equal((await listDrafts({ workspaceId: 'team:max', status: 'needs_review' })).length, 1);
    assert.deepEqual(await readdir(path.join(workspaceRoot('team:max'), 'meetings')), []);
    assert.equal((await readFile(draft.rawCapture.path, 'utf8')).includes('Exact raw transcript.'), true);

    const updated = await updateDraft(
      draft.id,
      { summary: { title: 'Chronicle Review: approved' } },
      { workspaceId: 'team:max', expectedRevision: 1 },
    );
    assert.equal(updated.revision, 2);
    await assert.rejects(
      updateDraft(draft.id, {}, { workspaceId: 'team:max', expectedRevision: 1 }),
      /changed/,
    );

    const approved = await approveDraft(draft.id, {
      workspaceId: 'team:max',
      expectedRevision: 2,
    });
    assert.equal(approved.status, 'approved');
    assert.equal((await readDraft(draft.id, { workspaceId: 'team:max' })).status, 'approved');
    const topic = await readFile(approved.topicPaths[0], 'utf8');
    assert.equal(topic.match(/Approved records alone update topic notes\./g)?.length, 1);
    assert.match(path.basename(approved.topicPaths[0]), /審核-review-[0-9a-f]{10}\.md/);

    const repeated = await approveDraft(draft.id, { workspaceId: 'team:max' });
    assert.equal(repeated.meetingPath, approved.meetingPath);
    assert.equal(
      (await readFile(approved.topicPaths[0], 'utf8')).match(/Approved records alone update topic notes\./g)
        ?.length,
      1,
    );
    const { ledgerFile, readLedger } = await import('../src/ledger.js');
    assert.equal(path.basename(ledgerFile(root)), 'ledger.db');
    const events = (await readLedger(root)).filter((event) => event.recordId === draft.id);
    assert.deepEqual(events.map((event) => event.type), [
      'raw.persisted',
      'draft.staged',
      'draft.updated',
      'draft.approved',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
