import assert from 'node:assert/strict';
import test from 'node:test';
import { parseIngestArgs } from '../src/ingest.js';

test('parses a batch with explicit review controls', () => {
  const parsed = parseIngestArgs([
    'one.md',
    'https://example.com/article',
    '--author',
    'Max Morrow',
    '--workspace',
    'team',
    '--preview',
    '--json',
  ]);
  assert.deepEqual(parsed.inputs, ['one.md', 'https://example.com/article']);
  assert.equal(parsed.author, 'Max Morrow');
  assert.equal(parsed.workspaceId, 'team');
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.json, true);
});

test('rejects missing flag values and ambiguous attribution', () => {
  assert.throws(() => parseIngestArgs(['file.md', '--speaker']), /needs a value/);
  assert.throws(
    () => parseIngestArgs(['file.md', '--speaker', 'Ethan', '--author', 'Max']),
    /either --speaker or --author/,
  );
});

test('requires a supported source kind', () => {
  assert.throws(() => parseIngestArgs(['file.md', '--kind', 'spreadsheet']), /must be one of/);
});
