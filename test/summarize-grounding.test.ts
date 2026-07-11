import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  groundModelSummary,
  mergeSourceSummaries,
  normalizeModelSourceSummary,
  summarizeSource,
  type ModelSourceSummary,
  type SourceSummary,
} from '../src/summarize.js';

test('drops unsupported inventions from a thin meeting', () => {
  const source = `[00:05] Ethan: Why did you call it Chronicle?
[00:10] Max: I do not know what Chronicle means, to be honest.`;
  const model: ModelSourceSummary = {
    title: 'Chronicle naming',
    slug: 'chronicle-naming',
    summary: {
      text: 'Ethan and Max finalized the Chronicle name.',
      evidence_quotes: ['They finalized the Chronicle name.'],
    },
    decisions: [
      {
        text: 'Keep the Chronicle name.',
        evidence_quote: 'Max: We decided to keep the Chronicle name.',
      },
    ],
    action_items: [
      {
        owner: 'Max',
        task: 'Document the product naming rationale.',
        evidence_quote: 'Max: I will document the product naming rationale.',
      },
    ],
    open_questions: [
      {
        text: 'What should Chronicle mean?',
        evidence_quote: 'What should Chronicle mean?',
      },
    ],
    facts: [
      {
        topic: 'chronicle',
        topic_title: 'Chronicle',
        topic_description: 'Product direction',
        fact: 'Chronicle has a finalized naming rationale.',
        evidence_quote: 'Chronicle has a finalized naming rationale.',
      },
    ],
  };

  assert.deepEqual(
    groundModelSummary(model, source, { kind: 'meeting', attribution: ['Ethan', 'Max'] }),
    {
      title: 'Chronicle naming',
      slug: 'chronicle-naming',
      summary: '',
      decisions: [],
      action_items: [],
      open_questions: [],
      facts: [],
    },
  );
});

test('keeps explicitly supported meeting signal', () => {
  const source = `[00:07] Max: I will commit the Chronicle changes tonight.
[00:15] Ethan: We decided to ship the review inbox first.
[00:20] Ethan: Should raw audio be deleted after approval?`;
  const model: ModelSourceSummary = {
    title: 'Chronicle review delivery',
    slug: 'chronicle-review-delivery',
    summary: {
      text: 'The review inbox will ship first, and Max will commit the changes.',
      evidence_quotes: [
        '[00:07] Max: I will commit the Chronicle changes tonight.',
        '[00:15] Ethan: We decided to ship the review inbox first.',
      ],
    },
    decisions: [
      {
        text: 'Ship the review inbox first.',
        evidence_quote: '[00:15] Ethan: We decided to ship the review inbox first.',
      },
    ],
    action_items: [
      {
        owner: 'Max',
        task: 'Commit the Chronicle changes tonight.',
        evidence_quote: '[00:07] Max: I will commit the Chronicle changes tonight.',
      },
    ],
    open_questions: [
      {
        text: 'Should raw audio be deleted after approval?',
        evidence_quote: '[00:20] Ethan: Should raw audio be deleted after approval?',
      },
    ],
    facts: [
      {
        topic: 'review-inbox',
        topic_title: 'Review Inbox',
        topic_description: 'Human review before durable memory',
        fact: 'The review inbox is the first Chronicle surface selected for delivery.',
        evidence_quote: '[00:15] Ethan: We decided to ship the review inbox first.',
      },
    ],
  };

  assert.deepEqual(
    groundModelSummary(model, source, { kind: 'meeting', attribution: ['Ethan', 'Max'] }),
    {
      title: 'Chronicle review delivery',
      slug: 'chronicle-review-delivery',
      summary: 'The review inbox will ship first, and Max will commit the changes.',
      decisions: ['Ship the review inbox first.'],
      action_items: [{ owner: 'Max', task: 'Commit the Chronicle changes tonight.' }],
      open_questions: ['Should raw audio be deleted after approval?'],
      highlights: [
        'Max: I will commit the Chronicle changes tonight.',
        'Ethan: We decided to ship the review inbox first.',
        'Ethan: Should raw audio be deleted after approval?',
      ],
      facts: [
        {
          topic: 'review-inbox',
          topic_title: 'Review Inbox',
          topic_description: 'Human review before durable memory',
          fact: 'The review inbox is the first Chronicle surface selected for delivery.',
        },
      ],
    },
  );
});

test('drops an action whose owner is not a meeting participant', () => {
  const source = '[00:07] Max: I will commit the Chronicle changes tonight.';
  const model: ModelSourceSummary = {
    title: 'Chronicle commit',
    slug: 'chronicle-commit',
    action_items: [
      {
        owner: 'Smoke Tester',
        task: 'Commit the Chronicle changes tonight.',
        evidence_quote: source,
      },
    ],
  };

  const grounded = groundModelSummary(model, source, {
    kind: 'meeting',
    attribution: ['Max'],
  });

  assert.deepEqual(grounded.action_items, []);
});

test('binds first-person commitments to the cited speaker', () => {
  const source = '[00:07] Ethan: I will commit the Chronicle changes tonight.';
  const grounded = groundModelSummary(
    {
      title: 'Chronicle commit',
      slug: 'chronicle-commit',
      action_items: [
        {
          owner: 'Max',
          task: 'Commit the Chronicle changes tonight.',
          evidence_quote: source,
        },
      ],
    },
    source,
    { kind: 'meeting', attribution: ['Ethan', 'Max'] },
  );

  assert.deepEqual(grounded.action_items, []);
});

test('rejects polarity inversions in decisions and actions', () => {
  const source = `[00:07] Max: We decided not to ship the cloud version.
[00:12] Max: I will not deploy the cloud version.`;
  const grounded = groundModelSummary(
    {
      title: 'Cloud version',
      slug: 'cloud-version',
      decisions: [
        { text: 'Ship the cloud version.', evidence_quote: '[00:07] Max: We decided not to ship the cloud version.' },
      ],
      action_items: [
        { owner: 'Max', task: 'Deploy the cloud version.', evidence_quote: '[00:12] Max: I will not deploy the cloud version.' },
      ],
    },
    source,
    { kind: 'meeting', attribution: ['Max'] },
  );

  assert.deepEqual(grounded.decisions, []);
  assert.deepEqual(grounded.action_items, []);
});

test('keeps short explicit tasks', () => {
  const source = '[00:07] Max: I will fix ASR.';
  const grounded = groundModelSummary(
    {
      title: 'ASR fix',
      slug: 'asr-fix',
      action_items: [{ owner: 'Max', task: 'Fix ASR.', evidence_quote: source }],
    },
    source,
    { kind: 'meeting', attribution: ['Max'] },
  );

  assert.deepEqual(grounded.action_items, [{ owner: 'Max', task: 'Fix ASR.' }]);
});

test('matches evidence and owners after Unicode and whitespace normalization', () => {
  const source = '[00:00] Ｍａｘ:\tI WILL   ship\n Chronicle tonight.';
  const model: ModelSourceSummary = {
    title: 'Chronicle shipment',
    slug: 'chronicle-shipment',
    action_items: [
      {
        owner: 'Max',
        task: 'Ship Chronicle tonight.',
        evidence_quote: '[00:00] Max: I will ship Chronicle tonight.',
      },
    ],
  };

  const grounded = groundModelSummary(model, source, {
    kind: 'meeting',
    attribution: ['Ｍａｘ'],
  });

  assert.deepEqual(grounded.action_items, [
    { owner: 'Max', task: 'Ship Chronicle tonight.' },
  ]);
});

test('canonicalizes missing optional model sections to the persisted shape', () => {
  const grounded = groundModelSummary(
    { title: 'Placeholder capture', slug: 'placeholder-capture' },
    '[00:07] Max: Pretend we had an interesting conversation and file it away.',
    { kind: 'meeting', attribution: ['Max'] },
  );

  assert.deepEqual(grounded, {
    title: 'Placeholder capture',
    slug: 'placeholder-capture',
    summary: '',
    decisions: [],
    action_items: [],
    open_questions: [],
    facts: [],
  });
});

test('normalizer omits malformed optional local-model fields instead of emitting undefined keys', () => {
  const normalized = normalizeModelSourceSummary({
    title: 'Malformed optional fields',
    slug: 'malformed-optional-fields',
    summary: { text: 'Missing string evidence.', evidence_quotes: [42] },
    decisions: ['Ship it.'],
    action_items: [{ owner: 'Max', task: 'Ship it.' }],
    open_questions: ['When?'],
    facts: [{ topic: 'shipping', fact: 'Ship it.' }],
    highlights: [42, { text: 'not a quote' }],
  });

  assert.deepEqual(normalized, {
    title: 'Malformed optional fields',
    slug: 'malformed-optional-fields',
  });
  for (const key of ['summary', 'decisions', 'action_items', 'open_questions', 'facts', 'highlights']) {
    assert.equal(Object.hasOwn(normalized, key), false);
  }
  assert.deepEqual(normalizeModelSourceSummary({ title: 42, slug: '   ' }), {});
});

test('keeps exact material highlights and merges them without optional empty fields', () => {
  const source =
    '[01:44] Max: My phone can send reels, share photos, and add songs to Chronicle';
  const grounded = groundModelSummary(
    normalizeModelSourceSummary({
      title: 'Mobile capture',
      slug: 'mobile-capture',
      highlights: [source, { quote: source }, { quote: 'This quote is not in the source.' }],
    }) as ModelSourceSummary,
    source,
    { kind: 'meeting', attribution: ['Max'] },
  );

  assert.deepEqual(grounded.highlights, [
    'Max: My phone can send reels, share photos, and add songs to Chronicle',
  ]);

  const empty: SourceSummary = {
    title: 'Empty section',
    slug: 'empty-section',
    summary: '',
    decisions: [],
    action_items: [],
    open_questions: [],
    facts: [],
  };
  const merged = mergeSourceSummaries([
    grounded,
    { ...empty, highlights: [' max: my phone can send reels, share photos, and add songs to chronicle '] },
  ]);
  assert.deepEqual(merged.highlights, grounded.highlights);
  assert.equal(Object.hasOwn(mergeSourceSummaries([empty]), 'highlights'), false);
});

test('does not promote highlights from an explicit low-signal placeholder', () => {
  const source =
    "[00:07] Max: Pretend that we had an interesting conversation and file it away.";
  const grounded = groundModelSummary(
    {
      title: 'Placeholder capture',
      slug: 'placeholder-capture',
      highlights: [{ quote: source }],
    },
    source,
    { kind: 'meeting', attribution: ['Max'] },
  );

  assert.equal(Object.hasOwn(grounded, 'highlights'), false);
});

test('rejects overlong highlights rather than changing the quoted source text', () => {
  const source = `[00:07] Max: ${'material source words '.repeat(40)}complete`;
  const grounded = groundModelSummary(
    {
      title: 'Long source line',
      slug: 'long-source-line',
      highlights: [{ quote: source }],
    },
    source,
    { kind: 'meeting', attribution: ['Max'] },
  );

  assert.equal(source.length > 700, true);
  assert.equal(Object.hasOwn(grounded, 'highlights'), false);
});

test('drops malformed optional arrays from a local response without retrying or aborting', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({
      choices: [{
        message: {
          content: JSON.stringify({
            title: 'Malformed local response',
            slug: 'malformed-local-response',
            decisions: ['Ship it.'],
            action_items: ['Max will ship it.'],
            open_questions: ['When?'],
            facts: ['A fact.'],
            highlights: [42],
          }),
        },
      }],
    });
  };

  try {
    const summary = await summarizeSource({
      text: '[00:01] Max: This capture contains enough ordinary source words for processing.',
      kind: 'meeting',
      date: '2026-07-10',
      attribution: ['Max'],
    });
    assert.equal(calls, 1);
    assert.deepEqual(summary, {
      title: 'Malformed local response',
      slug: 'malformed-local-response',
      summary: '',
      decisions: [],
      action_items: [],
      open_questions: [],
      facts: [],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('drops exact but misleading claims from thin test chatter', () => {
  const source =
    "[00:07] Max morrow: And write some interesting stuff down and pretend that we've had an interesting conversation here and file it away.";
  const grounded = groundModelSummary(
    {
      title: 'Writing interesting content',
      slug: 'writing-interesting-content',
      summary: {
        text: 'Participants are encouraged to document interesting conversations.',
        evidence_quotes: [source],
      },
      decisions: [{ text: 'Write interesting content.', evidence_quote: source }],
      facts: [
        {
          topic: 'writing',
          topic_title: 'Writing',
          topic_description: 'Writing practices',
          fact: 'Participants should file interesting conversations.',
          evidence_quote: source,
        },
      ],
    },
    source,
    { kind: 'meeting', attribution: ['Max morrow'] },
  );

  assert.equal(grounded.summary, '');
  assert.deepEqual(grounded.decisions, []);
  assert.deepEqual(grounded.facts, []);
});

test('does not suppress a real decision just because a short meeting mentions transcription testing', () => {
  const source = `[00:01] Ethan: Let us test the transcription pipeline.
[00:08] Max: We decided to ship the review inbox.`;
  const grounded = groundModelSummary(
    {
      title: 'Review inbox decision',
      slug: 'review-inbox-decision',
      decisions: [
        {
          text: 'Ship the review inbox.',
          evidence_quote: '[00:08] Max: We decided to ship the review inbox.',
        },
      ],
    },
    source,
    { kind: 'meeting', attribution: ['Ethan', 'Max'] },
  );

  assert.deepEqual(grounded.decisions, ['Ship the review inbox.']);
});

test('drops a mismatched durable fact instead of promoting its evidence as knowledge', () => {
  const source = '[04:58] Ethan: You try and use a local model as much as possible.';
  const grounded = groundModelSummary(
    {
      title: 'Local model preference',
      slug: 'local-model-preference',
      facts: [
        {
          topic: 'privacy',
          fact: 'Participants agreed on different privacy levels.',
          evidence_quote: source,
        },
      ],
    },
    source,
    { kind: 'meeting', attribution: ['Ethan'] },
  );

  assert.deepEqual(grounded.facts, []);
});

test('topic catalog cannot replace source entities or identifiers', () => {
  const evidence =
    '[00:00] Ethan: We decided to use the Juniper 7 code name. I will verify the backup checklist by July 20th. Project Juniper uses port 4303.';
  const grounded = groundModelSummary(
    {
      title: 'Juniper acceptance meeting',
      slug: 'juniper-acceptance-meeting',
      summary: {
        text: 'Ethan selected Project Atlas and port 4242, then committed to the backup checklist.',
        evidence_quotes: [evidence],
      },
      decisions: [
        { text: 'Use the Atlas 4242 code name.', evidence_quote: evidence },
        { text: 'Use the Juniper 7 code name.', evidence_quote: evidence },
      ],
      action_items: [
        {
          owner: 'Ethan',
          task: 'Verify the Project Atlas backup checklist by July 20th.',
          evidence_quote: evidence,
        },
        {
          owner: 'Ethan',
          task: 'Verify the backup checklist by July 20th.',
          evidence_quote: evidence,
        },
      ],
      facts: [
        {
          topic: 'atlas',
          topic_title: 'Project Atlas',
          fact: 'Ethan will verify the backup checklist by July 20th.',
          evidence_quote: evidence,
        },
        {
          topic: 'project-juniper',
          topic_title: 'Project Juniper',
          topic_description: 'Project Juniper local sync settings',
          fact: 'Project Juniper uses port 4303.',
          evidence_quote: evidence,
        },
      ],
    },
    evidence,
    {
      kind: 'meeting',
      attribution: ['Ethan'],
      topicCatalog: [{
        slug: 'atlas',
        title: 'Project Atlas',
        description: 'Project Atlas uses port 4242 for local sync.',
      }],
    },
  );

  assert.equal(grounded.summary, '');
  assert.deepEqual(grounded.decisions, ['Use the Juniper 7 code name.']);
  assert.deepEqual(grounded.action_items, [
    { owner: 'Ethan', task: 'Verify the backup checklist by July 20th.' },
  ]);
  assert.deepEqual(grounded.facts, [
    {
      topic: 'project-juniper',
      topic_title: 'Project Juniper',
      topic_description: 'Project Juniper local sync settings',
      fact: 'Project Juniper uses port 4303.',
    },
  ]);
});

test('rejects a lowercase entity supplied only by a catalog description', () => {
  const source = '[00:00] Ethan: We decided to use sqlite for the offline index.';
  const grounded = groundModelSummary(
    {
      title: 'Offline index storage',
      slug: 'offline-index-storage',
      decisions: [{
        text: 'Use postgres for the offline index.',
        evidence_quote: source,
      }],
    },
    source,
    {
      kind: 'meeting',
      attribution: ['Ethan'],
      topicCatalog: [{
        slug: 'database',
        title: 'Database',
        description: 'postgres storage',
      }],
    },
  );

  assert.deepEqual(grounded.decisions, []);
});

test('rejects a title-only catalog entity behind a generic slug', () => {
  const source = '[00:00] Ethan: We decided to use SQLite storage.';
  const grounded = groundModelSummary(
    {
      title: 'Storage decision',
      slug: 'storage-decision',
      decisions: [{
        text: 'Use Atlas storage.',
        evidence_quote: source,
      }],
    },
    source,
    {
      kind: 'meeting',
      attribution: ['Ethan'],
      topicCatalog: [{ slug: 'storage', title: 'Project Atlas Storage' }],
    },
  );

  assert.deepEqual(grounded.decisions, []);
});

test('rejects a changed identifier without relying on topic catalog context', () => {
  const source = '[00:04] Ethan: Project Juniper uses port 4303.';
  const grounded = groundModelSummary(
    {
      title: 'Juniper port',
      slug: 'juniper-port',
      facts: [{
        topic: 'project-juniper',
        fact: 'Project Juniper uses port 4242.',
        evidence_quote: source,
      }],
    },
    source,
    { kind: 'meeting', attribution: ['Ethan'] },
  );

  assert.deepEqual(grounded.facts, []);
});

test('summarizeSource applies topic evidence checks to model output', async () => {
  const originalFetch = globalThis.fetch;
  const source = '[00:04] Ethan: Project Juniper uses port 4303.';
  globalThis.fetch = async () => Response.json({
    choices: [{
      message: {
        content: JSON.stringify({
          title: 'Juniper port',
          slug: 'juniper-port',
          facts: [{
            topic: 'atlas',
            fact: 'Project Juniper uses port 4303.',
            evidence_quote: source,
          }],
        }),
      },
    }],
  });

  try {
    const summary = await summarizeSource({
      text: source,
      kind: 'meeting',
      date: '2026-07-11',
      attribution: ['Ethan'],
      topicCatalog: [{ slug: 'atlas', title: 'Project Atlas' }],
    });
    assert.deepEqual(summary.facts, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('summarizeSource enforces the evidence schema and chunks realistic meetings', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_input, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    const sourcePart = body.messages.find((message) => message.role === 'user')?.content ?? '';
    const evidence = sourcePart.includes('SECOND-SECTION')
      ? '[00:08] Max: We decided to ship the review inbox.'
      : '[00:01] Max: I will fix ASR.';
    const content = sourcePart.includes('SECOND-SECTION')
      ? {
          title: 'Chunked meeting',
          slug: 'chunked-meeting',
          decisions: [{ text: 'Ship the review inbox.', evidence_quote: evidence }],
        }
      : {
          title: 'Chunked meeting',
          slug: 'chunked-meeting',
          action_items: [{ owner: 'Max', task: 'Fix ASR.', evidence_quote: evidence }],
        };
    return Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] });
  };

  try {
    const source = `[00:01] Max: I will fix ASR.\n${'context '.repeat(900)}\nSECOND-SECTION\n[00:08] Max: We decided to ship the review inbox.`;
    const summary = await summarizeSource({
      text: source,
      kind: 'meeting',
      date: '2026-07-10',
      attribution: ['Max'],
    });
    assert.equal(calls, 2);
    assert.deepEqual(summary.action_items, [{ owner: 'Max', task: 'Fix ASR.' }]);
    assert.deepEqual(summary.decisions, ['Ship the review inbox.']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
