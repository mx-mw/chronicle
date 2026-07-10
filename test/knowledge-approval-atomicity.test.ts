import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const listMarkdown = async (directory: string): Promise<string[]> =>
  (await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })).filter((name) => name.endsWith('.md'));

test('approval failpoints roll back records, topics, draft, and index generation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-atomic-'));
  process.env.KB_DIR = root;
  process.env.INDEX_PATH = path.join(root, '.index.db');
  process.env.WORKSPACE_ID = 'atomic-team';
  process.env.EMBED_BASE_URL = 'http://127.0.0.1:11434/v1';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body)) as { input: string[] };
    return Response.json({
      data: body.input.map((_text, index) => ({ index, embedding: [1, index + 1, 0.5] })),
    });
  };

  try {
    const { buildIndex, getIndexHealth, search } = await import('../src/store.js');
    const { approveDraft, readDraft, stageSourceDraft, workspaceRoot } = await import('../src/kb.js');
    await buildIndex();
    assert.equal(getIndexHealth().fresh, true);

    for (const failureKind of ['topic', 'draft'] as const) {
      const rawText = `Raw transcript for ${failureKind} failure.`;
      const draft = await stageSourceDraft(
        {
          title: `Atomic ${failureKind}`,
          slug: `atomic-${failureKind}`,
          summary: 'This must remain review-only after an injected failure.',
          decisions: [],
          action_items: [],
          open_questions: [],
          facts: [
            {
              topic: `atomic-${failureKind}`,
              topic_title: `Atomic ${failureKind}`,
              topic_description: 'Rollback evidence',
              fact: `rollback-marker-${failureKind} must never survive.`,
            },
          ],
        },
        rawText,
        {
          date: '2026-07-10',
          kind: 'meeting',
          origin: `discord:${failureKind}`,
          sourceEventId: `session-${failureKind}`,
        },
        { workspaceId: 'atomic-team', operationId: `session-${failureKind}` },
      );

      await assert.rejects(
        approveDraft(draft.id, {
          workspaceId: 'atomic-team',
          expectedRevision: draft.revision,
          beforeMutation(context) {
            if (context.kind === failureKind) throw new Error(`injected ${failureKind} write failure`);
          },
        }),
        new RegExp(`injected ${failureKind}`),
      );

      const after = await readDraft(draft.id, { workspaceId: 'atomic-team' });
      assert.equal(after.status, 'needs_review');
      assert.equal(after.revision, draft.revision);
      const workspace = workspaceRoot('atomic-team');
      assert.deepEqual(await listMarkdown(path.join(workspace, 'meetings')), []);
      assert.deepEqual(await listMarkdown(path.join(workspace, 'topics')), []);
      assert.deepEqual(
        await readdir(path.join(root, '.chronicle', 'approval-transactions')).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return [];
            throw error;
          },
        ),
        [],
      );
      assert.equal(getIndexHealth().fresh, true);
      assert.equal(getIndexHealth().generation, 0);
      assert.deepEqual(
        await search(`rollback-marker-${failureKind}`, 8, {
          workspaceId: 'atomic-team',
          keywordOnly: true,
        }),
        [],
      );
      assert.doesNotMatch(
        await readFile(path.join(root, '.chronicle', 'index-state.json'), 'utf8'),
        new RegExp(draft.id),
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('restart recovery restores a prepared crash journal before readers expose Markdown', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-recovery-'));
  process.env.KB_DIR = root;
  process.env.INDEX_PATH = path.join(root, '.index.db');
  process.env.WORKSPACE_ID = 'recovery-team';
  const {
    readDraft,
    recoverApprovalTransactions,
    stageSourceDraft,
    withKnowledgeReadLock,
    workspaceRoot,
    workspaceStorageKey,
  } = await import('../src/kb.js');
  const draft = await stageSourceDraft(
    {
      title: 'Interrupted approval',
      slug: 'interrupted-approval',
      summary: 'A simulated process crash occurred before the draft commit point.',
      decisions: [],
      action_items: [],
      open_questions: [],
      facts: [
        {
          topic: 'recovery',
          topic_title: 'Recovery',
          topic_description: 'Approval crash recovery',
          fact: 'Partial approval files must be removed.',
        },
      ],
    },
    'Interrupted raw transcript.',
    { date: '2026-07-10', kind: 'meeting', origin: 'discord:recovery' },
    { workspaceId: 'recovery-team', operationId: 'recovery-session' },
  );
  const workspace = workspaceRoot('recovery-team');
  const recordPath = path.join(workspace, 'meetings', 'partial-record.md');
  const topicPath = path.join(workspace, 'topics', 'partial-topic.md');
  const draftPath = path.join(
    root,
    '.chronicle',
    'inbox',
    workspaceStorageKey('recovery-team'),
    `${draft.id}.json`,
  );
  const previousDraft = await readFile(draftPath, 'utf8');
  await writeFile(recordPath, '# Partial record\n');
  await writeFile(topicPath, '# Partial topic\n\n- leaked crash fact\n');
  const journalDirectory = path.join(root, '.chronicle', 'approval-transactions');
  await mkdir(journalDirectory, { recursive: true });
  await writeFile(
    path.join(journalDirectory, 'simulated-crash.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      transactionId: 'simulated-crash',
      recordId: draft.id,
      workspaceId: 'recovery-team',
      targetRevision: draft.revision + 1,
      state: 'prepared',
      createdAt: new Date().toISOString(),
      mutations: [
        {
          kind: 'record',
          relativePath: path.relative(root, recordPath).split(path.sep).join('/'),
          existed: false,
        },
        {
          kind: 'topic',
          relativePath: path.relative(root, topicPath).split(path.sep).join('/'),
          existed: false,
        },
        {
          kind: 'draft',
          relativePath: path.relative(root, draftPath).split(path.sep).join('/'),
          existed: true,
          previousContent: previousDraft,
        },
      ],
    }, null, 2)}\n`,
  );

  const recovery = await recoverApprovalTransactions();
  assert.deepEqual(recovery, { journalsFound: 1, rolledBack: 1, finalized: 0 });
  const observed = await withKnowledgeReadLock(async () => ({
    records: await listMarkdown(path.join(workspace, 'meetings')),
    topics: await listMarkdown(path.join(workspace, 'topics')),
  }));
  assert.deepEqual(observed, { records: [], topics: [] });
  assert.equal((await readDraft(draft.id, { workspaceId: 'recovery-team' })).status, 'needs_review');
  assert.deepEqual(await readdir(journalDirectory), []);
});

test('knowledge readers wait until every approval mutation reaches its commit point', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-read-lock-'));
  process.env.KB_DIR = root;
  process.env.INDEX_PATH = path.join(root, '.index.db');
  process.env.WORKSPACE_ID = 'reader-team';
  process.env.EMBED_BASE_URL = 'http://127.0.0.1:11434/v1';
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
  const { approveDraft, stageSourceDraft, withKnowledgeReadLock, workspaceRoot } = await import(
    '../src/kb.js'
  );
  const draft = await stageSourceDraft(
    {
      title: 'Serialized reader',
      slug: 'serialized-reader',
      summary: 'The reader must not see the record before the draft commit.',
      decisions: [],
      action_items: [],
      open_questions: [],
      facts: [
        {
          topic: 'serialization',
          topic_title: 'Serialization',
          topic_description: 'Read/write ordering',
          fact: 'Readers wait for the approval commit point.',
        },
      ],
    },
    'Serialized reader transcript.',
    { date: '2026-07-10', kind: 'meeting', origin: 'discord:reader' },
    { workspaceId: 'reader-team', operationId: 'reader-session' },
  );
  let reachedTopic!: () => void;
  const topicReached = new Promise<void>((resolve) => {
    reachedTopic = resolve;
  });
  let releaseTopic!: () => void;
  const topicRelease = new Promise<void>((resolve) => {
    releaseTopic = resolve;
  });
  const approval = approveDraft(draft.id, {
    workspaceId: 'reader-team',
    beforeMutation: async (context) => {
      if (context.kind !== 'topic') return;
      reachedTopic();
      await topicRelease;
    },
  });
  await topicReached;

  let readerCompleted = false;
  const reader = withKnowledgeReadLock(async () => {
    readerCompleted = true;
    return listMarkdown(path.join(workspaceRoot('reader-team'), 'meetings'));
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(readerCompleted, false);
  releaseTopic();
  await approval;
  assert.equal((await reader).length, 1);
});
