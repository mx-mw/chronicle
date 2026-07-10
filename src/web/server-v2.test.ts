import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { persistRawCapture, stageSourceDraft, workspaceRoot } from '../kb.js';
import {
  createSessionManifest,
  ensurePrivateDirectory as ensureSessionDirectory,
  manifestPath,
  writeJsonAtomic,
} from '../session-manifest.js';
import { upsertApprovedActionTask } from '../tasks.js';
import {
  authorizationMatches,
  completeDiscordPolicy,
  confineWebIngestInput,
  createChronicleWebServer,
  errorStatus,
  integerSetting,
  isLoopbackHost,
  isTrustedHostHeader,
  mutationRequestAllowed,
  normaliseRecallResult,
  sourceWorkspaceForBinding,
  validateWebBinding,
} from './server.js';

test('loopback recognition covers local IPv4 and IPv6 without trusting arbitrary hosts', () => {
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('127.8.4.2'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('chronicle.example'), false);
  assert.equal(isLoopbackHost('127.attacker.example'), false);
  assert.equal(isLoopbackHost('127.0.0.1.evil'), false);
});

test('loopback binding rejects DNS rebinding Host headers', () => {
  assert.equal(isTrustedHostHeader('localhost:4321', '127.0.0.1'), true);
  assert.equal(isTrustedHostHeader('127.0.0.1:4321', 'localhost'), true);
  assert.equal(isTrustedHostHeader('attacker.example:4321', '127.0.0.1'), false);
  assert.equal(isTrustedHostHeader('127.0.0.1.evil:4321', '127.0.0.1'), false);
  assert.equal(isTrustedHostHeader('localhost@attacker.example', '127.0.0.1'), false);
});

test('remote binding requires a token', () => {
  assert.throws(() => validateWebBinding('0.0.0.0', ''), /WEB_AUTH_TOKEN/);
  assert.doesNotThrow(() => validateWebBinding('0.0.0.0', 'long-random-token'));
  assert.doesNotThrow(() => validateWebBinding('127.0.0.1', ''));
});

test('numeric web settings reject invalid, NaN, and out-of-range values', () => {
  assert.equal(integerSetting('WEB_PORT', undefined, 4321, 1, 65_535), 4321);
  assert.equal(integerSetting('WEB_PORT', '8080', 4321, 1, 65_535), 8080);
  assert.throws(() => integerSetting('WEB_PORT', 'NaN', 4321, 1, 65_535), /WEB_PORT must be an integer/);
  assert.throws(() => integerSetting('WEB_PORT', '70000', 4321, 1, 65_535), /between 1 and 65535/);
  assert.throws(() => integerSetting('WEB_PREVIEW_CACHE_LIMIT', '1.5', 8, 1, 32), /must be an integer/);
});

test('remote authentication accepts Bearer and Basic password forms', () => {
  const token = 'correct-horse-battery-staple';
  assert.equal(authorizationMatches(`Bearer ${token}`, token), true);
  assert.equal(authorizationMatches('Bearer incorrect', token), false);
  assert.equal(
    authorizationMatches(`Basic ${Buffer.from(`chronicle:${token}`).toString('base64')}`, token),
    true,
  );
  assert.equal(authorizationMatches(undefined, token), false);
});

test('encrypted source workspace switching is local-only', () => {
  assert.equal(sourceWorkspaceForBinding('guild-b', '127.0.0.1', 'guild-a'), 'guild-b');
  assert.equal(sourceWorkspaceForBinding('guild-b', 'localhost', 'guild-a'), 'guild-b');
  assert.equal(sourceWorkspaceForBinding('guild-b', '0.0.0.0', 'guild-a'), 'guild-a');
  assert.equal(sourceWorkspaceForBinding('guild-b', 'chronicle.example', 'guild-a'), 'guild-a');
  assert.equal(sourceWorkspaceForBinding(undefined, '127.0.0.1', 'guild-a'), 'guild-a');
});

test('mutation origin checks reject browser cross-site requests and permit API clients', () => {
  assert.equal(mutationRequestAllowed('GET', '127.0.0.1:4321', 'https://evil.example', 'cross-site'), true);
  assert.equal(mutationRequestAllowed('POST', '127.0.0.1:4321', 'https://evil.example', 'cross-site'), false);
  assert.equal(mutationRequestAllowed('PATCH', '127.0.0.1:4321', 'http://127.0.0.1:4321', 'same-origin'), true);
  assert.equal(mutationRequestAllowed('DELETE', 'chronicle.example:443', 'https://chronicle.example', 'same-origin'), true);
  assert.equal(mutationRequestAllowed('POST', '127.0.0.1:4321', undefined, undefined), true);
  assert.equal(mutationRequestAllowed('POST', '127.0.0.1:4321', 'null', 'same-origin'), false);
});

test('review errors map missing drafts to 404 and stale revisions to 409', () => {
  assert.equal(errorStatus(new Error('No Chronicle draft 000 in workspace alpha')), 404);
  assert.equal(errorStatus(new Error('Draft 000 changed (expected revision 1, found 2)')), 409);
  assert.equal(errorStatus(new Error('Draft 000 is approved and cannot be edited')), 409);
});

test('local web ingest stays inside WEB_INGEST_ROOT and rejects symlink escapes', async () => {
  const previous = process.env.WEB_INGEST_ROOT;
  const root = await mkdtemp(path.join(tmpdir(), 'chronicle-web-ingest-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'chronicle-web-outside-'));
  try {
    const insideFile = path.join(root, 'inside.txt');
    const outsideFile = path.join(outside, 'outside.txt');
    await writeFile(insideFile, 'inside');
    await writeFile(outsideFile, 'outside');
    process.env.WEB_INGEST_ROOT = root;
    assert.equal(await confineWebIngestInput(insideFile), await realpath(insideFile));
    await assert.rejects(() => confineWebIngestInput(outsideFile), /outside WEB_INGEST_ROOT/);
    if (process.platform !== 'win32') {
      const link = path.join(root, 'escape.txt');
      await symlink(outsideFile, link);
      await assert.rejects(() => confineWebIngestInput(link), /resolves outside WEB_INGEST_ROOT/);
    }
    delete process.env.WEB_INGEST_ROOT;
    await assert.rejects(() => confineWebIngestInput(insideFile), /disabled/);
    assert.equal(await confineWebIngestInput('https://example.com/article'), 'https://example.com/article');
  } finally {
    if (previous === undefined) delete process.env.WEB_INGEST_ROOT;
    else process.env.WEB_INGEST_ROOT = previous;
    await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
  }
});

test('HTTP review and note endpoints enforce conflicts and workspace containment', async () => {
  const previousKb = process.env.KB_DIR;
  const previousIndex = process.env.INDEX_PATH;
  const previousSessions = process.env.SESSIONS_DIR;
  const kbDir = await mkdtemp(path.join(tmpdir(), 'chronicle-web-http-'));
  process.env.KB_DIR = kbDir;
  process.env.INDEX_PATH = path.join(kbDir, '.index.db');
  const sessionsDir = path.join(kbDir, 'sessions');
  process.env.SESSIONS_DIR = sessionsDir;
  const workspaceId = 'alpha';
  const otherWorkspace = 'beta';
  const meta = {
    date: '2026-07-10',
    kind: 'text' as const,
    origin: 'synthetic:test',
    attribution: ['Tester'],
  };
  const summary = {
    title: 'Synthetic review draft',
    slug: 'synthetic-review-draft',
    summary: 'A synthetic draft used only by the web endpoint test.',
    decisions: [],
    action_items: [],
    open_questions: [],
    facts: [
      {
        topic: 'testing',
        topic_title: 'Testing',
        topic_description: 'Synthetic test facts.',
        fact: 'Workspace note reads are scoped.',
      },
    ],
  };
  const raw = await persistRawCapture({ rawText: 'Synthetic raw capture.', meta, workspaceId });
  const draft = await stageSourceDraft(summary, 'Synthetic raw capture.', meta, { workspaceId, rawCapture: raw });
  const seededTask = await upsertApprovedActionTask({
    workspaceId,
    owner: 'Max',
    task: 'Review the synthetic Chronicle draft.',
    source: {
      recordId: draft.id,
      date: meta.date,
      meetingPath: 'meetings/synthetic-review.md',
      transcriptPath: raw.relativePath,
    },
  });
  const session = {
    ...createSessionManifest({
      workspaceId,
      guildId: 'guild-alpha',
      channelId: 'channel-alpha',
    }),
    stage: 'transcribing' as const,
    attempts: 1,
    warnings: ['One speaker segment needs review.'],
    meetingPath: path.join(workspaceRoot(workspaceId), 'meetings', 'session-record.md'),
  };
  const sessionDirectory = path.join(sessionsDir, session.id);
  await ensureSessionDirectory(sessionDirectory);
  await writeJsonAtomic(manifestPath(sessionDirectory), session);
  const attentionSession = {
    ...createSessionManifest({
      workspaceId,
      guildId: 'guild-alpha',
      channelId: 'channel-alpha',
      startedAt: new Date('2026-07-09T08:00:00.000Z'),
    }),
    stage: 'failed' as const,
    recoverable: false,
    error: 'Synthetic processing failure.',
  };
  const attentionSessionDirectory = path.join(sessionsDir, attentionSession.id);
  await ensureSessionDirectory(attentionSessionDirectory);
  await writeJsonAtomic(manifestPath(attentionSessionDirectory), attentionSession);
  await mkdir(path.join(workspaceRoot(otherWorkspace), 'meetings'), { recursive: true });
  const approvedFile = path.join(workspaceRoot(workspaceId), 'meetings', '2026-07-10-approved.md');
  await writeFile(
    approvedFile,
    '---\nname: approved\ndescription: Synthetic approved note\ntype: text\n---\n\n# Approved note\n\nScoped content.\n',
  );
  const unattachedRaw = path.join(workspaceRoot(workspaceId), 'transcripts', 'unattached.md');
  await writeFile(unattachedRaw, '# Unattached raw capture\n');

  const server = createChronicleWebServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { 'X-Chronicle-Workspace': workspaceId };
  try {
    const longWorkspace = await fetch(`${base}/api/reviews`, {
      headers: { 'X-Chronicle-Workspace': `team-${'x'.repeat(80)}` },
    });
    assert.equal(longWorkspace.status, 200);

    const missing = await fetch(`${base}/api/reviews/00000000-0000-4000-8000-000000000001`, { headers });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json() as { error: string }).error, 'not_found');

    const crossSiteMutation = await fetch(`${base}/api/reviews/${draft.id}`, {
      method: 'PATCH',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        Origin: 'https://evil.example',
        'Sec-Fetch-Site': 'cross-site',
      },
      body: JSON.stringify({ patch: { summary: { summary: 'Cross-site edit.' } } }),
    });
    assert.equal(crossSiteMutation.status, 403);
    assert.equal((await crossSiteMutation.json() as { error: string }).error, 'cross_origin_mutation');

    const mismatchedOrigin = await fetch(`${base}/api/reviews/${draft.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json', Origin: 'http://localhost:9' },
      body: JSON.stringify({ patch: { summary: { summary: 'Mismatched edit.' } } }),
    });
    assert.equal(mismatchedOrigin.status, 403);

    const missingPrecondition = await fetch(`${base}/api/reviews/${draft.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ patch: { summary: { summary: 'Unversioned edit.' } } }),
    });
    assert.equal(missingPrecondition.status, 428);
    assert.equal((await missingPrecondition.json() as { error: string }).error, 'precondition_required');
    for (const action of ['approve', 'reject']) {
      const unversionedAction = await fetch(`${base}/api/reviews/${draft.id}/${action}`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', Origin: base },
        body: '{}',
      });
      assert.equal(unversionedAction.status, 428);
    }

    const conflict = await fetch(`${base}/api/reviews/${draft.id}`, {
      method: 'PATCH',
      headers: {
        ...headers,
        'Content-Type': 'application/json',
        'If-Match': String(draft.revision + 1),
        Origin: base,
      },
      body: JSON.stringify({ patch: { summary: { summary: 'Conflicting edit.' } } }),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json() as { error: string }).error, 'revision_conflict');

    const approvedRelative = path.relative(kbDir, approvedFile).split(path.sep).join('/');
    const allowed = await fetch(`${base}/api/notes/${approvedRelative}`, { headers });
    assert.equal(allowed.status, 200);

    const crossWorkspace = await fetch(`${base}/api/notes/${approvedRelative}`, {
      headers: { 'X-Chronicle-Workspace': otherWorkspace },
    });
    assert.equal(crossWorkspace.status, 403);

    const attachedRaw = await fetch(`${base}/api/notes/${raw.relativePath}`, { headers });
    assert.equal(attachedRaw.status, 200);
    const attachedBody = await attachedRaw.json() as { file: string };
    assert.match(attachedBody.file, /workspaces\/.+\/transcripts\//);

    const deniedRaw = await fetch(`${base}/api/notes/transcripts/unattached.md`, { headers });
    assert.equal(deniedRaw.status, 403);

    const trust = await fetch(`${base}/api/trust`, { headers });
    assert.equal(trust.status, 200);
    const trustBody = await trust.json() as { index: { exists: boolean; fresh: boolean; ready: boolean } };
    assert.equal(trustBody.index.exists, false);
    assert.equal(trustBody.index.fresh, false);
    assert.equal(trustBody.index.ready, false);

    const taskList = await fetch(`${base}/api/tasks`, { headers });
    assert.equal(taskList.status, 200);
    const taskListBody = await taskList.json() as { tasks: Array<{ id: string; status: string }> };
    assert.deepEqual(taskListBody.tasks.map((task) => task.id), [seededTask.task.id]);
    const invalidOwnerFilter = await fetch(`${base}/api/tasks?owner=${'x'.repeat(201)}`, { headers });
    assert.equal(invalidOwnerFilter.status, 400);

    const digest = await fetch(`${base}/api/digest`, { headers });
    assert.equal(digest.status, 200);
    const digestBody = await digest.json() as { openTasks: Array<{ id: string }> };
    assert.deepEqual(digestBody.openTasks.map((task) => task.id), [seededTask.task.id]);

    const processing = await fetch(`${base}/api/processing?limit=1`, { headers });
    assert.equal(processing.status, 200);
    const processingBody = await processing.json() as {
      totalCount: number;
      inProgressCount: number;
      attentionCount: number;
      sessions: Array<{ id: string; stage: string; warningCount: number; recordPath?: string }>;
    };
    assert.equal(processingBody.totalCount, 2);
    assert.equal(processingBody.inProgressCount, 1);
    assert.equal(processingBody.attentionCount, 1);
    assert.equal(processingBody.sessions.length, 1);
    assert.equal(processingBody.sessions[0].id, session.id);
    assert.equal(processingBody.sessions[0].stage, 'transcribing');
    assert.equal(processingBody.sessions[0].warningCount, 1);
    assert.equal(processingBody.sessions[0].recordPath, 'meetings/session-record.md');

    const invalidProcessingLimit = await fetch(`${base}/api/processing?limit=0`, { headers });
    assert.equal(invalidProcessingLimit.status, 400);

    const taskDetail = await fetch(`${base}/api/tasks/${seededTask.task.id}`, { headers });
    assert.equal(taskDetail.status, 200);
    assert.equal(taskDetail.headers.get('etag'), '"1"');

    const unversionedTask = await fetch(`${base}/api/tasks/${seededTask.task.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ status: 'done' }),
    });
    assert.equal(unversionedTask.status, 428);

    const emptyTaskPatch = await fetch(`${base}/api/tasks/${seededTask.task.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json', 'If-Match': '1', Origin: base },
      body: '{}',
    });
    assert.equal(emptyTaskPatch.status, 400);

    const staleTask = await fetch(`${base}/api/tasks/${seededTask.task.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json', 'If-Match': '2', Origin: base },
      body: JSON.stringify({ status: 'done' }),
    });
    assert.equal(staleTask.status, 409);

    const completedTask = await fetch(`${base}/api/tasks/${seededTask.task.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json', 'If-Match': '1', Origin: base },
      body: JSON.stringify({ status: 'done' }),
    });
    assert.equal(completedTask.status, 200);
    assert.equal(completedTask.headers.get('etag'), '"2"');
    const completedTaskBody = await completedTask.json() as { task: { status: string } };
    assert.equal(completedTaskBody.task.status, 'done');

    const openTasks = await fetch(`${base}/api/tasks?status=open`, { headers });
    assert.deepEqual((await openTasks.json() as { tasks: unknown[] }).tasks, []);
    const doneTasks = await fetch(`${base}/api/tasks?status=done`, { headers });
    assert.equal((await doneTasks.json() as { tasks: unknown[] }).tasks.length, 1);

    const createdTask = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ task: 'Draft the kanban view.', owner: 'Max' }),
    });
    assert.equal(createdTask.status, 201);
    assert.equal(createdTask.headers.get('etag'), '"1"');
    const createdTaskBody = await createdTask.json() as {
      task: { id: string; status: string; origin?: string; owner: string; sources: unknown[] };
    };
    assert.equal(createdTaskBody.task.status, 'open');
    assert.equal(createdTaskBody.task.origin, 'web');
    assert.equal(createdTaskBody.task.owner, 'Max');
    assert.deepEqual(createdTaskBody.task.sources, []);

    const duplicateTask = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ task: 'Draft the kanban view.', owner: 'Max' }),
    });
    assert.equal(duplicateTask.status, 409);

    const emptyCreate = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ task: '   ' }),
    });
    assert.equal(emptyCreate.status, 400);

    const strayFieldCreate = await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ task: 'Valid text.', origin: 'spoofed' }),
    });
    assert.equal(strayFieldCreate.status, 400);

    const openAfterCreate = await fetch(`${base}/api/tasks?status=open`, { headers });
    const openAfterCreateBody = await openAfterCreate.json() as { tasks: Array<{ id: string }> };
    assert.deepEqual(openAfterCreateBody.tasks.map((task) => task.id), [createdTaskBody.task.id]);

    const crossWorkspaceTask = await fetch(`${base}/api/tasks/${seededTask.task.id}`, {
      headers: { 'X-Chronicle-Workspace': otherWorkspace },
    });
    assert.equal(crossWorkspaceTask.status, 404);

    const revokedMissing = await fetch(
      `${base}/api/ingest/preview/00000000-0000-4000-8000-000000000001`,
      { method: 'DELETE', headers },
    );
    assert.equal(revokedMissing.status, 204);
    assert.equal(revokedMissing.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    server.close();
    await once(server, 'close');
    if (previousKb === undefined) delete process.env.KB_DIR;
    else process.env.KB_DIR = previousKb;
    if (previousIndex === undefined) delete process.env.INDEX_PATH;
    else process.env.INDEX_PATH = previousIndex;
    if (previousSessions === undefined) delete process.env.SESSIONS_DIR;
    else process.env.SESSIONS_DIR = previousSessions;
    await rm(kbDir, { recursive: true, force: true });
  }
});

test('Trust health requires a complete Discord policy instead of a phantom policy file', () => {
  assert.equal(
    completeDiscordPolicy({ guildIds: ['g'], channelIds: ['c'], userIds: ['u'], roleIds: [] }),
    true,
  );
  assert.equal(
    completeDiscordPolicy({ guildIds: ['g'], channelIds: [], userIds: ['u'], roleIds: [] }),
    false,
  );
  assert.equal(
    completeDiscordPolicy({ guildIds: ['*'], channelIds: ['*'], userIds: [], roleIds: ['r'] }),
    true,
  );
});

test('recall abstains without retrieved evidence', () => {
  const result = normaliseRecallResult({ status: 'answered', answer: 'Unsupported answer', hits: [] });
  assert.equal(result.status, 'insufficient_evidence');
  assert.equal(result.answer, '');
});

test('recall marks evidence cited by the core as validated', () => {
  const result = normaliseRecallResult({
    status: 'answered',
    answer: 'Use SQLite [topics/storage].',
    hits: [{ file: 'topics/storage.md', noteTitle: 'Storage', text: 'Use SQLite for the index.' }],
    citations: [{ file: 'topics/storage.md', sourceId: 'topics/storage' }],
  });
  assert.equal(result.status, 'answered');
  assert.deepEqual(result.evidence, [
    {
      file: 'topics/storage.md',
      title: 'Storage',
      excerpt: 'Use SQLite for the index.',
      score: null,
      validated: true,
    },
  ]);
});
