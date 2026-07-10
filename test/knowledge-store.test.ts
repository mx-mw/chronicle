import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

test('index remains searchable without embeddings and removes empty/deleted notes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-store-'));
  process.env.KB_DIR = root;
  process.env.INDEX_PATH = path.join(root, '.index.db');
  process.env.EMBED_BASE_URL = 'http://127.0.0.1:11434/v1';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('embedding server offline');
  };

  try {
    await mkdir(path.join(root, 'topics'), { recursive: true });
    await mkdir(path.join(root, 'meetings'), { recursive: true });
    await writeFile(
      path.join(root, 'topics', 'legacy-storage.md'),
      '---\nname: legacy-storage\ndescription: Legacy note\ntype: topic\n---\n\n# Storage\n\n## Log\n- Chronicle uses SQLite. - [[meetings/example]] (2026-07-10)\n',
    );
    await writeFile(path.join(root, 'meetings', 'empty.md'), '---\ntype: meeting\n---\n');

    const { buildIndex, getIndexHealth, search } = await import('../src/store.js');
    const first = await buildIndex();
    assert.equal(first.keywordOnly, true);
    assert.equal(first.notesIndexed, 1);
    assert.equal(first.notesRemoved, 0);
    const hits = await search('SQLite', 8, { keywordOnly: true, workspaceId: 'default' });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].workspaceId, 'default');
    assert.equal(hits[0].keywordMatched, true);
    assert.equal(hits[0].rawVectorScore, null);
    assert.equal(typeof hits[0].rawKeywordScore, 'number');
    const health = getIndexHealth();
    assert.equal(health.compatible, true);
    assert.equal(health.notes, 1);
    assert.equal(health.keywordOnlyChunks, 1);

    await rm(path.join(root, 'topics', 'legacy-storage.md'));
    const second = await buildIndex();
    assert.equal(second.notesRemoved, 1);
    assert.deepEqual(await search('SQLite', 8, { keywordOnly: true }), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('vector search enforces workspace, relevance floor, and dimension metadata', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-vector-'));
  process.env.KB_DIR = root;
  process.env.INDEX_PATH = path.join(root, '.index.db');
  process.env.WORKSPACE_ID = 'default';
  process.env.EMBED_BASE_URL = 'http://127.0.0.1:11434/v1';
  const originalFetch = globalThis.fetch;
  let dimension = 2;
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { input: string[] };
    const vector = (text: string) => {
      const relevant = text.includes('private-guild-fact') || text === 'semantic question';
      return dimension === 2
        ? (relevant ? [1, 0] : [0, 1])
        : (relevant ? [1, 0, 0] : [0, 1, 0]);
    };
    return Response.json({
      data: request.input.map((text, index) => ({ index, embedding: vector(text) })),
    });
  };

  try {
    await mkdir(path.join(root, 'meetings'), { recursive: true });
    await mkdir(path.join(root, 'topics'), { recursive: true });
    await mkdir(path.join(root, 'workspaces', 'guild-folder', 'meetings'), { recursive: true });
    await mkdir(path.join(root, 'workspaces', 'guild-folder', 'topics'), { recursive: true });
    await writeFile(
      path.join(root, 'meetings', 'default.md'),
      '---\nworkspace: "default"\ntype: meeting\n---\n\n# Default\n\nUnrelated public text.',
    );
    await writeFile(
      path.join(root, 'workspaces', 'guild-folder', 'meetings', 'private.md'),
      '---\nworkspace: "guild-2"\ntype: meeting\n---\n\n# Private\n\nprivate-guild-fact',
    );

    const { buildIndex, getIndexHealth, search } = await import('../src/store.js');
    await buildIndex();
    assert.deepEqual(
      await search('semantic question', 8, { workspaceId: 'default', relevanceFloor: 0.8 }),
      [],
    );
    const hits = await search('semantic question', 8, {
      workspaceId: 'guild-2',
      relevanceFloor: 0.8,
    });
    assert.equal(hits.length, 1);
    assert.equal(hits[0].workspaceId, 'guild-2');
    assert.equal(hits[0].rawVectorScore, 1);
    assert.equal(getIndexHealth().embeddingDimension, 2);

    dimension = 3;
    const rebuiltHits = await search('semantic question', 8, {
      workspaceId: 'guild-2',
      relevanceFloor: 0.8,
    });
    assert.equal(rebuiltHits.length, 1);
    assert.equal(getIndexHealth().embeddingDimension, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('index generation stays stale after failure and becomes fresh only after repair', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-freshness-'));
  const goodIndex = path.join(root, '.index.db');
  process.env.KB_DIR = root;
  process.env.INDEX_PATH = goodIndex;
  process.env.WORKSPACE_ID = 'default';
  process.env.EMBED_BASE_URL = 'http://127.0.0.1:11434/v1';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { input: string[] };
    return Response.json({
      data: request.input.map((_text, index) => ({ index, embedding: [1, index + 1] })),
    });
  };

  try {
    await mkdir(path.join(root, 'meetings'), { recursive: true });
    await mkdir(path.join(root, 'topics'), { recursive: true });
    await writeFile(
      path.join(root, 'meetings', 'approved.md'),
      '---\nworkspace: "default"\nstatus: "approved"\n---\n\n# Approved\n\nFreshness evidence.',
    );
    const { buildIndex, getIndexHealth, markIndexStale } = await import('../src/store.js');
    await buildIndex();
    assert.equal(getIndexHealth().fresh, true);
    await markIndexStale('new approved generation');
    let health = getIndexHealth();
    assert.equal(health.fresh, false);
    assert.equal(health.generation, 1);
    assert.equal(health.indexedGeneration, 0);

    const brokenIndex = path.join(root, 'index-is-a-directory');
    await mkdir(brokenIndex);
    process.env.INDEX_PATH = brokenIndex;
    await assert.rejects(buildIndex(), /EISDIR|directory/i);
    health = getIndexHealth();
    assert.equal(health.fresh, false);
    assert.match(health.lastError ?? '', /EISDIR|directory/i);

    process.env.INDEX_PATH = goodIndex;
    await buildIndex();
    health = getIndexHealth();
    assert.equal(health.fresh, true);
    assert.equal(health.generation, health.indexedGeneration);
    assert.equal(health.lastError, undefined);
    if (process.platform !== 'win32') {
      assert.equal((await stat(goodIndex)).mode & 0o777, 0o600);
      for (const suffix of ['-wal', '-shm']) {
        const mode = await stat(`${goodIndex}${suffix}`)
          .then((entry) => entry.mode & 0o777)
          .catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? undefined : Promise.reject(error)));
        if (mode !== undefined) assert.equal(mode, 0o600);
      }
    }
  } finally {
    process.env.INDEX_PATH = goodIndex;
    globalThis.fetch = originalFetch;
  }
});

test('embedding work releases the knowledge lock and cannot mark a newer generation fresh', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-index-snapshot-'));
  process.env.KB_DIR = root;
  process.env.INDEX_PATH = path.join(root, '.index.db');
  process.env.WORKSPACE_ID = 'default';
  process.env.EMBED_BASE_URL = 'http://127.0.0.1:11434/v1';
  await mkdir(path.join(root, 'meetings'), { recursive: true });
  await mkdir(path.join(root, 'topics'), { recursive: true });
  await writeFile(
    path.join(root, 'meetings', 'snapshot.md'),
    '---\nworkspace: "default"\nstatus: "approved"\n---\n\n# Snapshot\n\nSlow embedding evidence.',
  );
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let embeddingStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    embeddingStarted = resolve;
  });
  let releaseEmbedding!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseEmbedding = resolve;
  });
  globalThis.fetch = async (_input, init) => {
    embeddingStarted();
    await released;
    const request = JSON.parse(String(init?.body)) as { input: string[] };
    return Response.json({
      data: request.input.map((_text, index) => ({ index, embedding: [1, index + 1] })),
    });
  };

  const { buildIndex, getIndexHealth, markIndexStale } = await import('../src/store.js');
  const { withKnowledgeReadLock } = await import('../src/kb.js');
  const building = buildIndex();
  await started;
  const readerWon = await Promise.race([
    withKnowledgeReadLock(async () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 200)),
  ]);
  assert.equal(readerWon, true);
  await markIndexStale('approval committed during captured generation');
  releaseEmbedding();
  await building;
  let health = getIndexHealth();
  assert.equal(health.generation, 1);
  assert.equal(health.indexedGeneration, 0);
  assert.equal(health.fresh, false);

  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { input: string[] };
    return Response.json({
      data: request.input.map((_text, index) => ({ index, embedding: [1, index + 1] })),
    });
  };
  await buildIndex();
  health = getIndexHealth();
  assert.equal(health.generation, 1);
  assert.equal(health.indexedGeneration, 1);
  assert.equal(health.fresh, true);
});
