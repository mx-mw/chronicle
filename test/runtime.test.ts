import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TimeoutError,
  assertModelEndpointAllowed,
  isLoopbackHost,
  isLoopbackUrl,
  positiveIntegerEnv,
  withTimeout,
} from '../src/runtime.js';

test('positiveIntegerEnv uses positive integer values only', () => {
  const previous = process.env.CHRONICLE_TEST_TIMEOUT;
  process.env.CHRONICLE_TEST_TIMEOUT = '2500.9';
  assert.equal(positiveIntegerEnv('CHRONICLE_TEST_TIMEOUT', 10), 2500);
  process.env.CHRONICLE_TEST_TIMEOUT = '-1';
  assert.equal(positiveIntegerEnv('CHRONICLE_TEST_TIMEOUT', 10), 10);
  if (previous === undefined) delete process.env.CHRONICLE_TEST_TIMEOUT;
  else process.env.CHRONICLE_TEST_TIMEOUT = previous;
});

test('withTimeout resolves completed work and rejects stalled work', async () => {
  await assert.doesNotReject(withTimeout(Promise.resolve('done'), 50, 'quick operation'));
  await assert.rejects(
    withTimeout(new Promise(() => {}), 5, 'stalled operation'),
    (error: unknown) => error instanceof TimeoutError,
  );
});

test('model endpoints are local unless explicitly acknowledged', () => {
  assert.equal(isLoopbackUrl('http://127.0.0.1:11434/v1'), true);
  assert.equal(isLoopbackUrl('http://localhost:8080/v1'), true);
  assert.equal(isLoopbackUrl('http://[::ffff:127.8.4.2]:8080/v1'), true);
  assert.equal(isLoopbackHost('0:0:0:0:0:ffff:7f00:1'), true);
  assert.equal(isLoopbackHost('::ffff:10.0.0.1'), false);
  assert.equal(isLoopbackUrl('https://models.example.com/v1'), false);
  assert.equal(isLoopbackUrl('http://127.attacker.example/v1'), false);
  assert.equal(isLoopbackUrl('http://127.0.0.1.evil.example/v1'), false);
  const previous = process.env.ALLOW_REMOTE_MODEL_ENDPOINTS;
  delete process.env.ALLOW_REMOTE_MODEL_ENDPOINTS;
  assert.throws(
    () => assertModelEndpointAllowed('https://models.example.com/v1', 'test endpoint'),
    /non-loopback endpoint/,
  );
  assert.throws(
    () => assertModelEndpointAllowed('http://127.attacker.example/v1', 'test endpoint'),
    /non-loopback endpoint/,
  );
  if (previous === undefined) delete process.env.ALLOW_REMOTE_MODEL_ENDPOINTS;
  else process.env.ALLOW_REMOTE_MODEL_ENDPOINTS = previous;
});
