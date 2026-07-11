import assert from 'node:assert/strict';
import { test } from 'node:test';
import { authorize, completeDiscordPolicy, type AccessPolicy } from '../src/policy.js';
import {
  admitParticipantAfterNotice,
  modelProcessingNotice,
  ParticipantAdmissionGate,
  recordingOutputChannelId,
  revalidateAdmissionGate,
  shouldAutoStart,
} from '../src/voice-policy.js';

const context = {
  guildId: 'guild-a',
  channelId: 'channel-a',
  userId: 'user-a',
  roleIds: ['role-a'],
};

test('an empty policy fails closed', () => {
  assert.deepEqual(
    authorize({ guildIds: [], channelIds: [], userIds: [], roleIds: [] }, context),
    { allowed: false, reason: 'guild_not_allowed' },
  );
});

test('a complete Discord policy requires location and identity rules', () => {
  assert.equal(
    completeDiscordPolicy({ guildIds: ['guild-a'], channelIds: ['channel-a'], userIds: ['user-a'], roleIds: [] }),
    true,
  );
  assert.equal(
    completeDiscordPolicy({ guildIds: ['guild-a'], channelIds: [], userIds: ['user-a'], roleIds: [] }),
    false,
  );
  assert.equal(
    completeDiscordPolicy({ guildIds: ['guild-a'], channelIds: ['channel-a'], userIds: [], roleIds: [] }),
    false,
  );
});

test('guild, channel, and a user or role identity must all be explicitly allowed', () => {
  const policy: AccessPolicy = {
    guildIds: ['guild-a'],
    channelIds: ['channel-a'],
    userIds: [],
    roleIds: ['role-a'],
  };
  assert.equal(authorize(policy, context).allowed, true);
  assert.deepEqual(authorize(policy, { ...context, channelId: 'channel-b' }), {
    allowed: false,
    reason: 'channel_not_allowed',
  });
  assert.deepEqual(authorize(policy, { ...context, userId: 'other', roleIds: [] }), {
    allowed: false,
    reason: 'identity_not_allowed',
  });
});

test('wildcard access is possible only when * is explicitly configured', () => {
  const wildcard: AccessPolicy = {
    guildIds: ['*'],
    channelIds: ['*'],
    userIds: ['*'],
    roleIds: [],
  };
  assert.equal(authorize(wildcard, context).allowed, true);
});

test('auto-record decision obeys the explicit enable switch', () => {
  assert.equal(
    shouldAutoStart({
      autoRecordEnabled: false,
      joinerIsBot: false,
      channelId: 'channel-a',
      alreadyRecording: false,
      humansInChannel: 1,
    }),
    false,
  );
  assert.equal(
    shouldAutoStart({
      autoRecordEnabled: true,
      joinerIsBot: false,
      channelId: 'channel-a',
      alreadyRecording: false,
      humansInChannel: 1,
    }),
    true,
  );
});

test('late participants are suppressed by default until notice and their own grace complete', async () => {
  const gate = new ParticipantAdmissionGate(['initial-user']);
  assert.equal(gate.canCapture('late-user'), false);
  const events: string[] = [];
  const outcome = await admitParticipantAfterNotice({
    announce: async () => {
      events.push('announced');
      assert.equal(gate.canCapture('late-user'), false);
    },
    graceMs: 5,
    signal: new AbortController().signal,
    stillEligible: () => {
      events.push('grace-complete');
      return true;
    },
    isOptedOut: () => gate.isOptedOut('late-user'),
    admit: () => {
      events.push('admitted');
      return gate.admit('late-user');
    },
  });
  assert.equal(outcome, 'admitted');
  assert.deepEqual(events, ['announced', 'grace-complete', 'admitted']);
  assert.equal(gate.canCapture('late-user'), true);
});

test('late participant opt-out remains terminal during personal grace', async () => {
  const gate = new ParticipantAdmissionGate();
  const outcome = await admitParticipantAfterNotice({
    announce: async () => gate.optOut('late-user'),
    graceMs: 0,
    signal: new AbortController().signal,
    stillEligible: () => true,
    isOptedOut: () => gate.isOptedOut('late-user'),
    admit: () => gate.admit('late-user'),
  });
  assert.equal(outcome, 'opted_out');
  assert.equal(gate.admit('late-user'), false);
  assert.equal(gate.canCapture('late-user'), false);
});

test('pending-to-live handoff preserves opt-outs and never re-admits a leaver', () => {
  const gate = new ParticipantAdmissionGate(['stayed', 'left', 'opted']);
  gate.optOut('opted');
  gate.revoke('left');

  // "left" appears present again, but a rejoin requires a fresh personal
  // notice; handoff must not rebuild admissions from the current member list.
  assert.deepEqual(
    revalidateAdmissionGate(gate, (userId) => ['stayed', 'left', 'opted'].includes(userId)),
    ['stayed'],
  );
  assert.equal(gate.canCapture('left'), false);
  assert.equal(gate.canCapture('opted'), false);
});

test('meeting output follows the recorded room rather than the slash invocation room', () => {
  assert.equal(
    recordingOutputChannelId({
      recordingChannelId: 'recorded-voice-room',
      interactionChannelId: 'unrelated-text-room',
    }),
    'recorded-voice-room',
  );
});

test('processing notice discloses every local and remote model boundary', () => {
  const local = 'http://127.0.0.1:11434/v1';
  const remoteLlm = 'https://models.example.com/v1';
  const remoteEmbed = 'https://embeddings.example.com/v1';

  assert.equal(
    modelProcessingNotice({ llmProvider: 'local', llmBaseUrl: local, embedBaseUrl: local }),
    'Transcription and AI processing stay on this machine.',
  );
  assert.equal(
    modelProcessingNotice({
      llmProvider: 'local',
      llmBaseUrl: local,
      embedBaseUrl: remoteEmbed,
    }),
    'Transcript distillation stays on this machine. If approved, the extracted record will be sent to the configured remote embedding service.',
  );
  assert.equal(
    modelProcessingNotice({
      llmProvider: 'local',
      llmBaseUrl: remoteLlm,
      embedBaseUrl: local,
    }),
    'The transcript will be sent to the configured remote model service for AI distillation. Embeddings stay on this machine.',
  );
  assert.equal(
    modelProcessingNotice({
      llmProvider: 'local',
      llmBaseUrl: remoteLlm,
      embedBaseUrl: remoteEmbed,
    }),
    'The transcript will be sent to the configured remote model service for AI distillation. If approved, the extracted record will also be sent to the configured remote embedding service.',
  );
});

test('Anthropic notice also discloses a separately configured remote embedding service', () => {
  assert.equal(
    modelProcessingNotice({
      llmProvider: 'anthropic',
      llmBaseUrl: 'http://127.0.0.1:11434/v1',
      embedBaseUrl: 'https://embeddings.example.com/v1',
    }),
    'The transcript will be sent to Anthropic for AI distillation. If approved, the extracted record will also be sent to the configured remote embedding service.',
  );
  assert.equal(
    modelProcessingNotice({
      llmProvider: 'anthropic',
      llmBaseUrl: 'http://127.0.0.1:11434/v1',
      embedBaseUrl: 'http://127.0.0.1:11434/v1',
    }),
    'The transcript will be sent to Anthropic for AI distillation. Embeddings stay on this machine.',
  );
});
