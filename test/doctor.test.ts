import assert from 'node:assert/strict';
import test from 'node:test';
import {
  advertisedModelIds,
  discordTokenStatus,
  meetsMinimumVersion,
  modelIdAvailable,
  parseNodeVersion,
  webBindingIssue,
} from '../src/doctor.js';

test('parses semantic Node versions with or without a leading v', () => {
  assert.deepEqual(parseNodeVersion('v24.12.0'), [24, 12, 0]);
  assert.deepEqual(parseNodeVersion('22.12.3'), [22, 12, 3]);
  assert.deepEqual(parseNodeVersion('unknown'), [0, 0, 0]);
});

test('checks the Chronicle Node minimum precisely', () => {
  assert.equal(meetsMinimumVersion([22, 16, 0], [22, 16, 0]), true);
  assert.equal(meetsMinimumVersion([24, 0, 0], [22, 16, 0]), true);
  assert.equal(meetsMinimumVersion([22, 15, 9], [22, 16, 0]), false);
  assert.equal(meetsMinimumVersion([20, 20, 0], [22, 16, 0]), false);
});

test('bot-mode diagnostics fail instead of warning when the token is absent', () => {
  assert.equal(discordTokenStatus(false, false), 'warn');
  assert.equal(discordTokenStatus(false, true), 'fail');
  assert.equal(discordTokenStatus(true, true), 'pass');
});

test('doctor remote-web validation matches the server startup boundary', () => {
  assert.equal(webBindingIssue('127.0.0.1', undefined, undefined), undefined);
  assert.equal(webBindingIssue('::ffff:127.0.0.1', undefined, undefined), undefined);
  assert.match(webBindingIssue('0.0.0.0', undefined, undefined) ?? '', /WEB_AUTH_TOKEN/);
  assert.match(
    webBindingIssue('0.0.0.0', 'strong-token', undefined) ?? '',
    /WEB_ALLOWED_HOSTS/,
  );
  assert.equal(
    webBindingIssue('0.0.0.0', 'strong-token', 'chronicle.example'),
    undefined,
  );
  assert.equal(webBindingIssue('10.0.0.5', 'strong-token', undefined), undefined);
});

test('reads OpenAI-compatible model identifiers without trusting malformed payloads', () => {
  assert.deepEqual(
    advertisedModelIds({ data: [{ id: 'qwen2.5:3b' }, { id: 'nomic-embed-text' }] }),
    ['qwen2.5:3b', 'nomic-embed-text'],
  );
  assert.deepEqual(advertisedModelIds({ data: [{ nope: true }, null, 'bad'] }), []);
  assert.deepEqual(advertisedModelIds(null), []);
});

test('treats Ollama implicit and explicit latest tags as the same model', () => {
  assert.equal(modelIdAvailable(['nomic-embed-text:latest'], 'nomic-embed-text'), true);
  assert.equal(modelIdAvailable(['nomic-embed-text'], 'nomic-embed-text:latest'), true);
  assert.equal(modelIdAvailable(['nomic-embed-text:v1'], 'nomic-embed-text'), false);
});
