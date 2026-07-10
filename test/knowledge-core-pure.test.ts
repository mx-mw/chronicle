import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  collisionSafeBasename,
  stableUuid,
  unicodeSlug,
  yamlFrontmatter,
} from '../src/fs-safe.js';
import { assertLocalEmbeddingEndpoint } from '../src/embed.js';
import {
  chunkSourceText,
  mergeSourceSummaries,
  renderTopicCatalog,
  type SourceSummary,
} from '../src/summarize.js';
import { extractCitationIds, sourceIdForFile } from '../src/recall.js';

test('filesystem identities and Unicode-safe names are stable', () => {
  assert.equal(
    stableUuid('workspace', 'digest'),
    stableUuid('workspace', 'digest'),
  );
  assert.match(stableUuid('workspace', 'digest'), /^[0-9a-f]{8}-[0-9a-f-]{27}$/);
  assert.equal(unicodeSlug('  Max 的 Chronicle / Notes  '), 'max-的-chronicle-notes');
  assert.notEqual(collisionSafeBasename('same', 'one'), collisionSafeBasename('same', 'two'));
});

test('embedding endpoint privacy defaults to loopback', () => {
  const previous = process.env.ALLOW_REMOTE_MODEL_ENDPOINTS;
  delete process.env.ALLOW_REMOTE_MODEL_ENDPOINTS;
  assert.doesNotThrow(() => assertLocalEmbeddingEndpoint('http://127.0.0.1:11434/v1'));
  assert.throws(() => assertLocalEmbeddingEndpoint('https://models.example.com/v1'), /Refusing remote/);
  process.env.ALLOW_REMOTE_MODEL_ENDPOINTS = 'true';
  assert.doesNotThrow(() => assertLocalEmbeddingEndpoint('https://models.example.com/v1'));
  if (previous === undefined) delete process.env.ALLOW_REMOTE_MODEL_ENDPOINTS;
  else process.env.ALLOW_REMOTE_MODEL_ENDPOINTS = previous;
});

test('frontmatter uses YAML-safe JSON scalars', () => {
  const yaml = yamlFrontmatter({
    title: 'A: title\nwith "quotes"',
    tags: ['one', 'two:three'],
  });
  assert.match(yaml, /title: "A: title\\nwith \\"quotes\\""/);
  assert.match(yaml, /tags: \["one", "two:three"\]/);
});

test('section-aware source chunks cover the end of long sources', () => {
  const source = [
    '# Beginning',
    'alpha '.repeat(120),
    '## Middle',
    'beta '.repeat(120),
    '## Final section',
    `omega-marker ${'gamma '.repeat(120)}`,
  ].join('\n\n');
  const chunks = chunkSourceText(source, 512);
  assert.ok(chunks.length > 3);
  assert.ok(chunks.every((chunk) => chunk.length <= 512));
  assert.ok(chunks.some((chunk) => chunk.includes('omega-marker')));
  assert.equal(chunks.join('\n').match(/omega-marker/g)?.length, 1);
});

test('summary merge deduplicates facts and assignments without dropping sections', () => {
  const base: SourceSummary = {
    title: 'Chronicle',
    slug: 'chronicle',
    summary: 'First section.',
    decisions: ['Use SQLite.'],
    action_items: [{ owner: 'Max', task: 'Review it.' }],
    open_questions: [],
    facts: [
      {
        topic: 'storage',
        topic_title: 'Storage',
        topic_description: 'Persistence choices',
        fact: 'Chronicle uses SQLite.',
      },
    ],
  };
  const merged = mergeSourceSummaries([
    base,
    {
      ...structuredClone(base),
      summary: 'Final section.',
      decisions: ['use sqlite.', 'Ship review inbox.'],
      facts: [
        ...base.facts,
        { ...base.facts[0], fact: 'Approved notes are searchable.' },
      ],
    },
  ]);
  assert.equal(merged.decisions.length, 2);
  assert.equal(merged.action_items.length, 1);
  assert.equal(merged.facts.length, 2);
  assert.match(merged.summary, /First section[\s\S]*Final section/);
});

test('topic catalog prompt is compact and identifies reusable slugs', () => {
  assert.equal(
    renderTopicCatalog([
      { slug: 'storage', title: 'Storage', description: 'Persistence choices' },
      { slug: 'review', title: 'Review' },
    ]),
    '- review: Review\n- storage: Storage (Persistence choices)',
  );
});

test('citation helpers retain only exact source ids', () => {
  assert.equal(sourceIdForFile('workspaces/acme/topics/storage.md'), 'workspaces/acme/topics/storage');
  assert.deepEqual(
    extractCitationIds('One [topics/storage]. Two [meetings/2026-01-01]. Again [topics/storage].'),
    ['topics/storage', 'meetings/2026-01-01'],
  );
});
