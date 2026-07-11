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
      open_questions: ['Should approved reviews expire?'],
      highlights: ['Max: I will review the draft before approval.'],
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
    assert.equal(approved.taskIds?.length, 1);
    assert.equal((await readDraft(draft.id, { workspaceId: 'team:max' })).status, 'approved');
    const approvedNote = await readFile(approved.meetingPath, 'utf8');
    const transcriptName = path.basename(draft.rawCapture.relativePath, '.md');
    const transcriptLink = `[[transcripts/${transcriptName}]]`;
    assert.ok(approvedNote.includes(`A review gate protects durable memory. ${transcriptLink}`));
    assert.ok(approvedNote.includes(`- Add review. ${transcriptLink}`));
    assert.ok(approvedNote.includes(`- [ ] **Max**: Review the draft. ${transcriptLink}`));
    assert.ok(approvedNote.includes(`- Should approved reviews expire? ${transcriptLink}`));
    assert.ok(
      approvedNote.includes(
        `## Source highlights\n> Max: I will review the draft before approval. ${transcriptLink}`,
      ),
    );
    const topic = await readFile(approved.topicPaths[0], 'utf8');
    assert.equal(topic.match(/Approved records alone update topic notes\./g)?.length, 1);
    assert.ok(topic.includes(`Approved records alone update topic notes. - [[meetings/`));
    assert.ok(topic.includes(transcriptLink));
    assert.match(path.basename(approved.topicPaths[0]), /審核-review-[0-9a-f]{10}\.md/);
    const { listTasks } = await import('../src/tasks.js');
    const approvedTasks = await listTasks({ workspaceId: 'team:max', status: 'all' });
    assert.equal(approvedTasks.length, 1);
    assert.equal(approvedTasks[0].id, approved.taskIds?.[0]);
    assert.equal(approvedTasks[0].owner, 'Max');
    assert.equal(approvedTasks[0].task, 'Review the draft.');
    assert.equal(approvedTasks[0].sources[0].recordId, draft.id);
    assert.equal(approvedTasks[0].sources[0].citation, transcriptLink);

    const repeated = await approveDraft(draft.id, { workspaceId: 'team:max' });
    assert.equal(repeated.meetingPath, approved.meetingPath);
    assert.equal((await listTasks({ workspaceId: 'team:max', status: 'all' }))[0].revision, 1);
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

    const carriedDraft = await stageSourceDraft(
      {
        title: 'Chronicle Review Follow-up',
        slug: 'chronicle-review-follow-up',
        summary: 'The prior review task remains open.',
        decisions: [],
        action_items: [{ owner: 'Max', task: 'Review the draft.' }],
        open_questions: [],
        facts: [],
      },
      'A second meeting repeated the review task.',
      { ...meta, date: '2026-07-11' },
      { workspaceId: 'team:max' },
    );
    const carriedApproval = await approveDraft(carriedDraft.id, { workspaceId: 'team:max' });
    assert.deepEqual(carriedApproval.taskIds, approved.taskIds);
    const carriedTask = (await listTasks({ workspaceId: 'team:max', status: 'all' }))[0];
    assert.equal(carriedTask.revision, 2);
    assert.equal(carriedTask.sources.length, 2);

    const semanticCarryoverDraft = await stageSourceDraft(
      {
        title: 'Chronicle Review Completion',
        slug: 'chronicle-review-completion',
        summary: 'The same task was phrased differently.',
        decisions: [],
        action_items: [{
          owner: 'Max',
          task: 'Complete review of the Chronicle draft.',
          carryover_task_id: carriedTask.id,
        }],
        open_questions: [],
        facts: [],
      },
      'A third meeting rephrased the existing review task.',
      { ...meta, date: '2026-07-12' },
      { workspaceId: 'team:max' },
    );
    const semanticApproval = await approveDraft(semanticCarryoverDraft.id, {
      workspaceId: 'team:max',
    });
    assert.deepEqual(semanticApproval.taskIds, approved.taskIds);
    const semanticTask = (await listTasks({ workspaceId: 'team:max', status: 'all' }))[0];
    assert.equal(semanticTask.revision, 3);
    assert.equal(semanticTask.sources.length, 3);

    const thinDraft = await stageSourceDraft(
      {
        title: 'Placeholder capture',
        slug: 'placeholder-capture',
        summary: '',
        decisions: [],
        action_items: [],
        open_questions: [],
        facts: [],
      },
      'Pretend this was an interesting conversation.',
      meta,
      { workspaceId: 'team:max' },
    );
    const thinApproval = await approveDraft(thinDraft.id, { workspaceId: 'team:max' });
    const thinNote = await readFile(thinApproval.meetingPath, 'utf8');
    assert.doesNotMatch(
      thinNote,
      /## Decisions|## Action items|## Open questions|## Source highlights/,
    );
    assert.match(thinNote, /## Provenance\n- \[\[transcripts\//);

    const unknownDurationDraft = await stageSourceDraft(
      {
        title: 'Meeting without duration',
        slug: 'meeting-without-duration',
        summary: 'The capture did not report its duration.',
        decisions: [],
        action_items: [],
        open_questions: [],
        facts: [],
      },
      'A source without duration metadata.',
      { ...meta, date: '2026-07-13', durationMinutes: undefined },
      { workspaceId: 'team:max' },
    );
    const unknownDurationApproval = await approveDraft(unknownDurationDraft.id, {
      workspaceId: 'team:max',
    });
    const unknownDurationNote = await readFile(unknownDurationApproval.meetingPath, 'utf8');
    assert.match(
      unknownDurationNote,
      /\*\*Date:\*\* 2026-07-13 - \*\*Participants:\*\* Ethan, Max/,
    );
    assert.doesNotMatch(unknownDurationNote, /Duration|~\? min/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
