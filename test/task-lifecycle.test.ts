import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  listTasks,
  planApprovedActionTask,
  readTask,
  serializeTask,
  taskDirectory,
  taskFilePath,
  taskIdForApprovedAction,
  taskMatchKey,
  updateTask,
  upsertApprovedActionTask,
  type ApprovedActionTaskInput,
  type ChronicleTask,
} from '../src/tasks.js';

function approvedAction(
  workspaceId: string,
  recordId: string,
  now: string,
  overrides: Partial<ApprovedActionTaskInput> = {},
): ApprovedActionTaskInput {
  return {
    workspaceId,
    owner: 'Max',
    task: 'Verify the Chronicle task lifecycle.',
    source: {
      recordId,
      date: now.slice(0, 10),
      meetingPath: `meetings/${recordId}.md`,
      transcriptPath: `transcripts/${recordId}.md`,
    },
    now,
    ...overrides,
  };
}

test('approval planning creates stable tasks and deterministically carries open work forward', () => {
  const firstInput = approvedAction(
    'team:max',
    '00000000-0000-4000-8000-000000000001',
    '2026-07-10T01:00:00.000Z',
  );
  const first = planApprovedActionTask([], firstInput);
  assert.equal(first.outcome, 'created');
  assert.equal(first.task.status, 'open');
  assert.equal(first.task.revision, 1);
  assert.equal(first.task.sources[0].citation, '[[transcripts/00000000-0000-4000-8000-000000000001]]');
  assert.equal(
    first.task.id,
    taskIdForApprovedAction({
      workspaceId: 'team:max',
      recordId: firstInput.source.recordId,
      owner: firstInput.owner,
      task: firstInput.task,
    }),
  );
  assert.equal(
    planApprovedActionTask([], { ...firstInput, now: '2026-07-10T02:00:00.000Z' }).task.id,
    first.task.id,
  );

  const duplicate = planApprovedActionTask([first.task], firstInput);
  assert.equal(duplicate.outcome, 'unchanged');
  assert.equal(duplicate.task.revision, 1);

  const secondInput = approvedAction(
    'team:max',
    '00000000-0000-4000-8000-000000000002',
    '2026-07-11T01:00:00.000Z',
    { owner: '  MAX ', task: ' Verify   the Chronicle task lifecycle. ' },
  );
  const carried = planApprovedActionTask([first.task], secondInput);
  assert.equal(carried.outcome, 'carried_over');
  assert.equal(carried.task.id, first.task.id);
  assert.equal(carried.task.revision, 2);
  assert.equal(carried.task.sources.length, 2);

  const laterDuplicate: ChronicleTask = {
    ...first.task,
    id: taskIdForApprovedAction({
      workspaceId: 'team:max',
      recordId: '00000000-0000-4000-8000-000000000099',
      owner: first.task.owner,
      task: first.task.task,
    }),
    createdAt: '2026-07-10T03:00:00.000Z',
    updatedAt: '2026-07-10T03:00:00.000Z',
  };
  const deterministic = planApprovedActionTask([laterDuplicate, first.task], secondInput);
  assert.equal(deterministic.task.id, first.task.id);
  assert.equal(taskMatchKey(' MAX ', 'Do   it'), taskMatchKey('max', 'Do it'));

  const explicitSemanticCarryover = planApprovedActionTask(
    [first.task],
    approvedAction(
      'team:max',
      '00000000-0000-4000-8000-000000000003',
      '2026-07-12T01:00:00.000Z',
      {
        task: 'Complete verification of task state.',
        carryoverTaskId: first.task.id,
      },
    ),
  );
  assert.equal(explicitSemanticCarryover.outcome, 'carried_over');
  assert.equal(explicitSemanticCarryover.task.id, first.task.id);
});

test('file-backed tasks are private, workspace scoped, filterable, and source-idempotent', async (t) => {
  const previousKb = process.env.KB_DIR;
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-tasks-'));
  process.env.KB_DIR = root;
  t.after(() => {
    if (previousKb === undefined) delete process.env.KB_DIR;
    else process.env.KB_DIR = previousKb;
  });

  const firstInput = approvedAction(
    'alpha',
    '00000000-0000-4000-8000-000000000011',
    '2026-07-10T01:00:00.000Z',
  );
  const created = await upsertApprovedActionTask(firstInput);
  assert.equal(created.outcome, 'created');
  assert.deepEqual(await listTasks({ workspaceId: 'alpha' }), [created.task]);
  assert.deepEqual(await listTasks({ workspaceId: 'beta', status: 'all' }), []);
  await assert.rejects(
    readTask(created.task.id, { workspaceId: 'beta' }),
    /No Chronicle task .* in workspace beta/,
  );
  assert.deepEqual(await readTask(created.task.id, { workspaceId: 'alpha' }), created.task);
  assert.equal((await readFile(taskFilePath(created.task.id, 'alpha'), 'utf8')).endsWith('\n'), true);

  if (process.platform !== 'win32') {
    assert.equal((await stat(taskDirectory('alpha'))).mode & 0o777, 0o700);
    assert.equal((await stat(taskFilePath(created.task.id, 'alpha'))).mode & 0o777, 0o600);
  }

  const repeated = await upsertApprovedActionTask(firstInput);
  assert.equal(repeated.outcome, 'unchanged');
  assert.equal(repeated.task.revision, 1);

  const carried = await upsertApprovedActionTask(
    approvedAction(
      'alpha',
      '00000000-0000-4000-8000-000000000012',
      '2026-07-12T01:00:00.000Z',
    ),
  );
  assert.equal(carried.outcome, 'carried_over');
  assert.equal(carried.task.id, created.task.id);
  assert.equal(carried.task.sources.length, 2);
  assert.equal((await listTasks({ workspaceId: 'alpha', owner: ' max ' })).length, 1);
  assert.deepEqual(await listTasks({ workspaceId: 'alpha', owner: 'Ethan' }), []);
});

test('task updates enforce revisions and done work is not silently reopened by carryover', async (t) => {
  const previousKb = process.env.KB_DIR;
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-task-update-'));
  process.env.KB_DIR = root;
  t.after(() => {
    if (previousKb === undefined) delete process.env.KB_DIR;
    else process.env.KB_DIR = previousKb;
  });

  const created = await upsertApprovedActionTask(
    approvedAction(
      'lifecycle',
      '00000000-0000-4000-8000-000000000021',
      '2026-07-10T01:00:00.000Z',
    ),
  );
  const done = await updateTask(
    created.task.id,
    { status: 'done' },
    {
      workspaceId: 'lifecycle',
      expectedRevision: created.task.revision,
      now: '2026-07-11T01:00:00.000Z',
    },
  );
  assert.equal(done.status, 'done');
  assert.equal(done.revision, 2);
  assert.equal(done.completedAt, '2026-07-11T01:00:00.000Z');
  assert.deepEqual(await listTasks({ workspaceId: 'lifecycle' }), []);
  assert.deepEqual(await listTasks({ workspaceId: 'lifecycle', status: 'done' }), [done]);
  await assert.rejects(
    updateTask(
      done.id,
      { task: 'Stale edit' },
      { workspaceId: 'lifecycle', expectedRevision: 1 },
    ),
    /expected revision 1, found 2/,
  );

  const nextMeeting = await upsertApprovedActionTask(
    approvedAction(
      'lifecycle',
      '00000000-0000-4000-8000-000000000022',
      '2026-07-12T01:00:00.000Z',
    ),
  );
  assert.equal(nextMeeting.outcome, 'created');
  assert.notEqual(nextMeeting.task.id, done.id);
  assert.equal((await listTasks({ workspaceId: 'lifecycle', status: 'all' })).length, 2);

  await assert.rejects(
    updateTask(
      done.id,
      { status: 'open' },
      { workspaceId: 'lifecycle', expectedRevision: done.revision },
    ),
    /cannot become a duplicate of open task/,
  );

  const reopened = await updateTask(
    done.id,
    { status: 'open', owner: 'Ethan' },
    {
      workspaceId: 'lifecycle',
      expectedRevision: done.revision,
      now: '2026-07-13T01:00:00.000Z',
    },
  );
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.owner, 'Ethan');
  assert.equal(reopened.completedAt, undefined);
  assert.equal(reopened.revision, 3);

  await assert.rejects(
    updateTask(
      reopened.id,
      { owner: nextMeeting.task.owner },
      { workspaceId: 'lifecycle', expectedRevision: reopened.revision },
    ),
    /cannot become a duplicate of open task/,
  );

  const current = await readTask(reopened.id, { workspaceId: 'lifecycle' });
  const outcomes = await Promise.allSettled([
    updateTask(
      current.id,
      { task: 'First concurrent edit' },
      { workspaceId: 'lifecycle', expectedRevision: current.revision },
    ),
    updateTask(
      current.id,
      { task: 'Second concurrent edit' },
      { workspaceId: 'lifecycle', expectedRevision: current.revision },
    ),
  ]);
  assert.equal(outcomes.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter((result) => result.status === 'rejected').length, 1);
});

test('task storage rejects unsafe paths, malformed ids, and empty lifecycle patches', async (t) => {
  const previousKb = process.env.KB_DIR;
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-task-safety-'));
  process.env.KB_DIR = root;
  t.after(() => {
    if (previousKb === undefined) delete process.env.KB_DIR;
    else process.env.KB_DIR = previousKb;
  });

  const base = approvedAction(
    'safe',
    '00000000-0000-4000-8000-000000000031',
    '2026-07-10T01:00:00.000Z',
  );
  assert.throws(
    () => planApprovedActionTask([], {
      ...base,
      source: { ...base.source, transcriptPath: '../outside.md' },
    }),
    /workspace-relative Markdown path/,
  );
  assert.throws(
    () => planApprovedActionTask([], {
      ...base,
      source: { ...base.source, meetingPath: '/tmp/outside.md' },
    }),
    /workspace-relative Markdown path/,
  );
  assert.throws(
    () => planApprovedActionTask([], {
      ...base,
      source: { ...base.source, meetingPath: 'C:\\tmp\\outside.md' },
    }),
    /workspace-relative Markdown path/,
  );
  assert.throws(
    () => planApprovedActionTask([], {
      ...base,
      source: { ...base.source, date: '2026-02-31' },
    }),
    /YYYY-MM-DD/,
  );
  assert.throws(
    () => planApprovedActionTask([], {
      ...base,
      source: { ...base.source, citation: '[[transcripts/something-else]]' },
    }),
    /citation must match transcriptPath/,
  );
  assert.throws(() => taskFilePath('../../outside', 'safe'), /Invalid Chronicle task id/);

  const created = await upsertApprovedActionTask(base);
  await assert.rejects(
    updateTask(created.task.id, {}, { workspaceId: 'safe', expectedRevision: 1 }),
    /must change owner, task, or status/,
  );
  await assert.rejects(
    updateTask(created.task.id, { status: 'done' }, { workspaceId: 'safe', expectedRevision: 0 }),
    /positive integer/,
  );
  await assert.rejects(
    listTasks({ workspaceId: 'safe', status: 'later' as 'open' }),
    /status filter must be open, done, or all/,
  );
});

test('task APIs recover a prepared approval journal before exposing task state', async (t) => {
  const previousKb = process.env.KB_DIR;
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-task-recovery-'));
  process.env.KB_DIR = root;
  t.after(() => {
    if (previousKb === undefined) delete process.env.KB_DIR;
    else process.env.KB_DIR = previousKb;
  });

  const plan = planApprovedActionTask(
    [],
    approvedAction(
      'recovery',
      '00000000-0000-4000-8000-000000000041',
      '2026-07-10T01:00:00.000Z',
    ),
  );
  const taskPath = taskFilePath(plan.task.id, 'recovery');
  await mkdir(path.dirname(taskPath), { recursive: true });
  await writeFile(taskPath, serializeTask(plan.task));

  const draftPath = path.join(
    root,
    '.chronicle',
    'inbox',
    'recovery-simulated',
    `${plan.task.sources[0].recordId}.json`,
  );
  const journalDirectory = path.join(root, '.chronicle', 'approval-transactions');
  await mkdir(journalDirectory, { recursive: true });
  await writeFile(
    path.join(journalDirectory, 'task-crash.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      transactionId: 'task-crash',
      recordId: plan.task.sources[0].recordId,
      workspaceId: 'recovery',
      targetRevision: 2,
      state: 'prepared',
      createdAt: '2026-07-10T01:00:00.000Z',
      mutations: [
        {
          kind: 'task',
          relativePath: path.relative(root, taskPath).split(path.sep).join('/'),
          existed: false,
        },
        {
          kind: 'draft',
          relativePath: path.relative(root, draftPath).split(path.sep).join('/'),
          existed: false,
        },
      ],
    }, null, 2)}\n`,
  );

  assert.deepEqual(await listTasks({ workspaceId: 'recovery', status: 'all' }), []);
  assert.deepEqual(await readdir(journalDirectory), []);
});

test('task files fail closed when embedded identity disagrees with their workspace path', async (t) => {
  const previousKb = process.env.KB_DIR;
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-task-identity-'));
  process.env.KB_DIR = root;
  t.after(() => {
    if (previousKb === undefined) delete process.env.KB_DIR;
    else process.env.KB_DIR = previousKb;
  });

  const created = await upsertApprovedActionTask(
    approvedAction(
      'identity-a',
      '00000000-0000-4000-8000-000000000051',
      '2026-07-10T01:00:00.000Z',
    ),
  );
  await writeFile(
    taskFilePath(created.task.id, 'identity-a'),
    `${JSON.stringify({ ...created.task, workspaceId: 'identity-b' }, null, 2)}\n`,
  );
  await assert.rejects(
    listTasks({ workspaceId: 'identity-a', status: 'all' }),
    /Task identity does not match its workspace path/,
  );
});
