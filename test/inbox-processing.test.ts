import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalInboxUrl,
  extractInboxUrls,
  processInboxSource,
  type InboxProcessingDependencies,
} from '../src/inbox-processing.js';
import type { SourceSummary } from '../src/summarize.js';

function summary(title = 'Saved thought'): SourceSummary {
  return {
    title,
    slug: 'saved-thought',
    summary: 'A grounded summary.',
    decisions: ['Keep the explicit inbox.'],
    action_items: [{ owner: 'Ethan', task: 'Test the inbox.' }],
    open_questions: ['What comes next?'],
    facts: [{
      topic: 'capture',
      topic_title: 'Capture',
      topic_description: 'Capture workflow',
      fact: 'The inbox is explicit.',
    }],
  };
}

function dependencies(overrides: Partial<InboxProcessingDependencies> = {}): InboxProcessingDependencies {
  return {
    extract: async (input) => ({
      kind: 'article',
      title: 'Example article',
      origin: input,
      text: 'Useful source evidence.',
    }),
    summarize: async () => summary(),
    ...overrides,
  };
}

test('inbox URL parsing canonicalizes supported URLs and rejects credentials', () => {
  assert.equal(canonicalInboxUrl('https://example.com/read#section'), 'https://example.com/read');
  assert.equal(
    canonicalInboxUrl('https://youtube.com/watch?utm_source=test&v=dQw4w9WgXcQ'),
    'https://youtube.com/watch?v=dQw4w9WgXcQ',
  );
  assert.equal(
    canonicalInboxUrl(
      'https://cdn.discordapp.com/attachments/1/2/reference.png?ex=aaa&is=bbb&hm=secret&width=800',
    ),
    'https://cdn.discordapp.com/attachments/1/2/reference.png?width=800',
  );
  assert.equal(
    canonicalInboxUrl('https://example.com/read?ex=functional&hm=also-functional'),
    'https://example.com/read?ex=functional&hm=also-functional',
  );
  assert.equal(canonicalInboxUrl('https://user:secret@example.com/read'), undefined);
  assert.deepEqual(
    extractInboxUrls('Read https://example.com/a). Then https://example.com/a#copy'),
    ['https://example.com/a'],
  );
});

test('provider media is retained as an honest link-only source without extraction', async () => {
  let extracted = false;
  const result = await processInboxSource(
    {
      content: 'Strong editing reference https://www.instagram.com/reel/ABC123/',
      capturedAt: '2026-07-10T10:00:00.000Z',
      origin: 'discord:channel-a/message-a',
    },
    dependencies({
      extract: async () => {
        extracted = true;
        throw new Error('must not run');
      },
    }),
  );

  assert.equal(extracted, false);
  assert.equal(result.capability, 'link_only');
  assert.equal(result.title, 'Instagram Reel');
  assert.equal(result.summary, 'Strong editing reference');
  assert.match(result.warning ?? '', /not fetched/i);

  const youtube = await processInboxSource(
    {
      content: 'Watch later https://youtu.be/dQw4w9WgXcQ',
      capturedAt: '2026-07-10T10:00:00.000Z',
      origin: 'discord:channel-a/message-b',
    },
    dependencies({
      extract: async () => {
        extracted = true;
        throw new Error('must not run');
      },
    }),
  );
  assert.equal(extracted, false);
  assert.equal(youtube.capability, 'link_only');
  assert.equal(youtube.title, 'YouTube video');
});

test('ordinary links are extracted and summarized into encrypted catalog analysis', async () => {
  const result = await processInboxSource(
    {
      content: 'https://example.com/article',
      capturedAt: '2026-07-10T10:00:00.000Z',
      origin: 'discord:channel-a/message-a',
    },
    dependencies(),
  );

  assert.equal(result.capability, 'processable');
  assert.equal(result.title, 'Saved thought');
  assert.deepEqual(result.actionItems, [{ owner: 'Ethan', task: 'Test the inbox.' }]);
  assert.deepEqual(result.topics, [{ topic: 'capture', fact: 'The inbox is explicit.' }]);
});

test('blocked or unavailable links remain useful partial records', async () => {
  const result = await processInboxSource(
    {
      content: 'Useful reference https://example.com/private',
      capturedAt: '2026-07-10T10:00:00.000Z',
      origin: 'discord:channel-a/message-a',
    },
    dependencies({ extract: async () => { throw new Error('Provider refused access.'); } }),
  );

  assert.equal(result.capability, 'partial');
  assert.equal(result.summary, 'Useful reference');
  assert.match(result.warning ?? '', /refused access/i);
});

test('plain text is summarized and attachment-only messages are metadata-only', async () => {
  const text = await processInboxSource(
    {
      content: 'Remember this product decision.',
      capturedAt: '2026-07-10T10:00:00.000Z',
      authorName: 'Ethan',
      origin: 'discord:channel-a/message-a',
    },
    dependencies(),
  );
  assert.equal(text.capability, 'processable');

  const attachment = await processInboxSource(
    {
      content: '',
      capturedAt: '2026-07-10T10:00:00.000Z',
      origin: 'discord:channel-a/message-a',
      attachments: [{ id: 'file-a', filename: 'voice.ogg', size: 42 }],
    },
    dependencies(),
  );
  assert.equal(attachment.capability, 'partial');
  assert.match(attachment.warning ?? '', /not enabled/i);
});

test('model failures stay retryable instead of being mislabeled as partial extraction', async () => {
  await assert.rejects(
    processInboxSource(
      {
        content: 'A thought that needs AI processing.',
        capturedAt: '2026-07-10T10:00:00.000Z',
        origin: 'discord:channel-a/message-a',
      },
      dependencies({ summarize: async () => { throw new Error('Local model offline.'); } }),
    ),
    /Local model offline/,
  );
});
