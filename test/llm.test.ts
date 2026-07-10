import assert from 'node:assert/strict';
import test from 'node:test';
import { completeJson, extractJson, validateJsonSchema } from '../src/llm.js';

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

test('completeJson retries invalid local structured output once with correction context', async () => {
  const originalFetch = globalThis.fetch;
  const previousProvider = process.env.LLM_PROVIDER;
  const previousBaseUrl = process.env.LLM_BASE_URL;
  process.env.LLM_PROVIDER = 'local';
  process.env.LLM_BASE_URL = 'http://127.0.0.1:11434/v1';
  const requests: Array<{
    temperature?: number;
    messages?: Array<{ role: string; content: string }>;
  }> = [];
  globalThis.fetch = async (_input, init) => {
    requests.push(JSON.parse(String(init?.body)));
    const content = requests.length === 1
      ? { title: 'Retry me' }
      : { title: 'Recovered', citations: [] };
    return Response.json({
      choices: [{ message: { content: JSON.stringify(content) } }],
    });
  };

  try {
    assert.deepEqual(
      await completeJson({ system: 'Return JSON.', user: 'Summarize.', schema }),
      { title: 'Recovered', citations: [] },
    );
    assert.equal(requests.length, 2);
    assert.equal(requests[0].temperature, 0);
    assert.match(requests[1].messages?.at(-1)?.content ?? '', /failed validation/i);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousProvider === undefined) delete process.env.LLM_PROVIDER;
    else process.env.LLM_PROVIDER = previousProvider;
    if (previousBaseUrl === undefined) delete process.env.LLM_BASE_URL;
    else process.env.LLM_BASE_URL = previousBaseUrl;
  }
});
