import assert from 'node:assert/strict';
import test from 'node:test';
import { assertConfiguredRecordingReady } from '../src/discord-startup.js';

test('recording preflight is skipped when the record policy is incomplete', async () => {
  let calls = 0;
  await assertConfiguredRecordingReady(
    { guildIds: [], channelIds: [], userIds: [], roleIds: [] },
    async () => {
      calls += 1;
    },
  );
  assert.equal(calls, 0);
});

test('recording preflight runs and propagates failures for a complete policy', async () => {
  let calls = 0;
  const failure = new Error('Parakeet unavailable');
  await assert.rejects(
    assertConfiguredRecordingReady(
      { guildIds: ['guild-1'], channelIds: ['voice-1'], userIds: [], roleIds: ['recorder'] },
      async () => {
        calls += 1;
        throw failure;
      },
    ),
    failure,
  );
  assert.equal(calls, 1);
});
