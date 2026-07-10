// Exhaustive tests for the auto-record join/leave decisions. Run: npx tsx test/voice-policy.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldAutoStart, shouldAutoStop } from '../src/voice-policy.js';

test('starts when a human joins an uncovered channel', () => {
  assert.equal(
    shouldAutoStart({ joinerIsBot: false, channelId: 'A', alreadyRecording: false, humansInChannel: 1 }),
    true,
  );
});

test('does NOT start when the bot itself joins (no recursion on our own connect)', () => {
  assert.equal(
    shouldAutoStart({ joinerIsBot: true, channelId: 'A', alreadyRecording: false, humansInChannel: 1 }),
    false,
  );
});

test('does NOT start when already recording this guild', () => {
  assert.equal(
    shouldAutoStart({ joinerIsBot: false, channelId: 'A', alreadyRecording: true, humansInChannel: 2 }),
    false,
  );
});

test('does NOT start on a leave-voice event (channelId null)', () => {
  assert.equal(
    shouldAutoStart({ joinerIsBot: false, channelId: null, alreadyRecording: false, humansInChannel: 0 }),
    false,
  );
});

test('does NOT start for a channel that only has bots', () => {
  assert.equal(
    shouldAutoStart({ joinerIsBot: false, channelId: 'A', alreadyRecording: false, humansInChannel: 0 }),
    false,
  );
});

test('stops when the last human leaves the recorded channel', () => {
  assert.equal(
    shouldAutoStop({ leftChannelId: 'A', recordingChannelId: 'A', humansRemaining: 0 }),
    true,
  );
});

test('does NOT stop while humans remain', () => {
  assert.equal(
    shouldAutoStop({ leftChannelId: 'A', recordingChannelId: 'A', humansRemaining: 1 }),
    false,
  );
});

test('does NOT stop when a DIFFERENT channel empties', () => {
  assert.equal(
    shouldAutoStop({ leftChannelId: 'B', recordingChannelId: 'A', humansRemaining: 0 }),
    false,
  );
});

test('does NOT stop when nothing is being recorded', () => {
  assert.equal(
    shouldAutoStop({ leftChannelId: 'A', recordingChannelId: undefined, humansRemaining: 0 }),
    false,
  );
});

test('the last human leaving reads as empty even though the bot is still in the call', () => {
  // humansRemaining is bot-excluded upstream; the bot's own presence must not
  // keep the room "occupied", or recording never ends.
  assert.equal(
    shouldAutoStop({ leftChannelId: 'A', recordingChannelId: 'A', humansRemaining: 0 }),
    true,
  );
});
