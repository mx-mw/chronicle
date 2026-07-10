import assert from 'node:assert/strict';
import test from 'node:test';
import { extractJson, validateJsonSchema } from '../src/llm.js';

const schema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    citations: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'citations'],
  additionalProperties: false,
};

test('extractJson recovers fenced local-model output', () => {
  assert.deepEqual(extractJson('```json\n{"title":"A","citations":[]}\n```'), {
    title: 'A',
    citations: [],
  });
});

test('validateJsonSchema accepts the supported object and array subset', () => {
  assert.doesNotThrow(() => validateJsonSchema({ title: 'A', citations: ['records/a'] }, schema));
});

test('validateJsonSchema rejects missing, mistyped, and additional fields', () => {
  assert.throws(() => validateJsonSchema({ title: 'A' }, schema), /citations is required/);
  assert.throws(() => validateJsonSchema({ title: 1, citations: [] }, schema), /title must be a string/);
  assert.throws(
    () => validateJsonSchema({ title: 'A', citations: [], extra: true }, schema),
    /extra is not allowed/,
  );
});
