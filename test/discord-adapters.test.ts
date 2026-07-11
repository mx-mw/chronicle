import assert from 'node:assert/strict';
import test from 'node:test';
import {
  discordAttachmentInput,
  discordRecallPresentation,
  publishConsentNotice,
  RECORDING_START_ABORTED_NOTICE,
} from '../src/discord-adapters.js';
import type { RecallResult } from '../src/recall.js';

function recallResult(overrides: Partial<RecallResult> = {}): RecallResult {
  return {
    status: 'answered',
    answer: 'Use SQLite [topics/storage].',
    hits: [],
    citations: [{
      file: 'topics/storage.md',
      sourceId: 'topics/storage',
      noteTitle: 'Storage',
      workspaceId: 'guild-1',
    }],
    citationErrors: [],
    ...overrides,
  };
}

test('Discord attachment mapping preserves audio duration metadata', () => {
  assert.deepEqual(
    discordAttachmentInput({
      id: 'attachment-1',
      name: 'voice-message.ogg',
      url: 'https://cdn.discordapp.com/voice-message.ogg',
      contentType: 'audio/ogg',
      size: 42,
      width: null,
      height: null,
      duration: 7.25,
    }),
    {
      id: 'attachment-1',
      filename: 'voice-message.ogg',
      url: 'https://cdn.discordapp.com/voice-message.ogg',
      contentType: 'audio/ogg',
      sizeBytes: 42,
      width: undefined,
      height: undefined,
      durationSeconds: 7.25,
    },
  );
});

test('Discord recall presentation lists only validated citations', () => {
  const result = recallResult({
    hits: [
      { file: 'topics/storage.md', noteTitle: 'Storage', text: 'Use SQLite.' } as RecallResult['hits'][number],
      { file: 'topics/unrelated.md', noteTitle: 'Unrelated', text: 'Other evidence.' } as RecallResult['hits'][number],
    ],
    citations: [
      {
        file: 'topics/storage.md',
        sourceId: 'topics/storage',
        noteTitle: 'Storage',
        workspaceId: 'guild-1',
      },
      {
        file: 'topics/storage.md',
        sourceId: 'topics/storage',
        noteTitle: 'Storage',
        workspaceId: 'guild-1',
      },
    ],
  });

  assert.deepEqual(discordRecallPresentation('What storage?', result), {
    kind: 'answered',
    title: '🔎 What storage?',
    description: 'Use SQLite [topics/storage].',
    footer: 'Sources: topics/storage',
  });
});

test('Discord recall presentation keeps insufficient evidence out of an answer embed', () => {
  const result = recallResult({
    status: 'insufficient',
    answer: 'Chronicle does not have enough approved evidence to answer "Unknown?".',
    hits: [{
      file: 'topics/near-match.md',
      noteTitle: 'Near match',
      text: 'Related but insufficient.',
    } as RecallResult['hits'][number]],
    citations: [],
  });

  assert.deepEqual(discordRecallPresentation('Unknown?', result), {
    kind: 'insufficient',
    message: 'Chronicle does not have enough approved evidence to answer "Unknown?".',
  });
});

test('consent notice is corrected when command acknowledgement fails', async () => {
  const events: string[] = [];
  const failure = new Error('interaction expired');

  await assert.rejects(
    publishConsentNotice({
      notice: 'Recording starts soon.',
      send: async (notice) => {
        events.push(`send:${notice}`);
        return {
          edit: async (content) => {
            events.push(`edit:${content}`);
          },
        };
      },
      acknowledge: async () => {
        events.push('acknowledge');
        throw failure;
      },
    }),
    failure,
  );
  assert.deepEqual(events, [
    'send:Recording starts soon.',
    'acknowledge',
    `edit:${RECORDING_START_ABORTED_NOTICE}`,
  ]);
});

test('successful consent acknowledgement leaves the public notice unchanged', async () => {
  let edited = false;
  await publishConsentNotice({
    notice: 'Recording starts soon.',
    send: async () => ({
      edit: async () => {
        edited = true;
      },
    }),
    acknowledge: async () => undefined,
  });
  assert.equal(edited, false);
});

test('consent correction falls back to a new public message without masking the failure', async () => {
  const sent: string[] = [];
  const failure = new Error('interaction expired');

  await assert.rejects(
    publishConsentNotice({
      notice: 'Recording starts soon.',
      send: async (content) => {
        sent.push(content);
        return {
          edit: async () => {
            throw new Error('original notice was deleted');
          },
        };
      },
      acknowledge: async () => {
        throw failure;
      },
    }),
    failure,
  );
  assert.deepEqual(sent, ['Recording starts soon.', RECORDING_START_ABORTED_NOTICE]);
});
