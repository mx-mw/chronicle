import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

interface ReviewLineCodec {
  formatFactTopicLabel: (item: { topic?: string; topic_title?: string }) => string;
  formatPairLine: (left: string, right: string) => string;
  parseFactTopicLabel: (value: string) => { title: string; topic: string };
  parsePairText: (value: string) => { pairs: [string, string][]; invalidLines: number[] };
}

async function loadCodec(): Promise<ReviewLineCodec> {
  const source = await readFile(new URL('./public/review-lines.js', import.meta.url), 'utf8');
  const context: { ChronicleReviewLines?: ReviewLineCodec } = {};
  runInNewContext(source, context);
  assert.ok(context.ChronicleReviewLines);
  return context.ChronicleReviewLines;
}

function local<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

test('review lines preserve stable topics and escaped delimiters', async () => {
  const codec = await loadCodec();
  const topic = 'Design | Development\nPhase \\ 2';
  const fact = 'Keep A | B on separate lines.\nOwner uses C:\\work.';
  const label = codec.formatFactTopicLabel({ topic, topic_title: 'Shared title' });
  const line = codec.formatPairLine(label, fact);
  const parsed = local(codec.parsePairText(line));

  assert.deepEqual(parsed, { pairs: [[label, fact]], invalidLines: [] });
  assert.deepEqual(local(codec.parseFactTopicLabel(parsed.pairs[0][0])), {
    title: topic,
    topic,
  });
});

test('duplicate display titles remain distinct after line reordering', async () => {
  const codec = await loadCodec();
  const alpha = codec.formatFactTopicLabel({ topic: 'alpha', topic_title: 'Shared Topic' });
  const beta = codec.formatFactTopicLabel({ topic: 'beta', topic_title: 'Shared Topic' });
  const text = [
    codec.formatPairLine(beta, 'Beta fact'),
    codec.formatPairLine(alpha, 'Alpha fact'),
  ].join('\n');

  assert.deepEqual(local(codec.parsePairText(text)), {
    pairs: [[beta, 'Beta fact'], [alpha, 'Alpha fact']],
    invalidLines: [],
  });
});

test('human labels can escape pipes, backslashes, and newlines', async () => {
  const codec = await loadCodec();
  const line = codec.formatPairLine('Design | Development\nTeam', 'Review C:\\plan | Friday');
  assert.deepEqual(local(codec.parsePairText(line)), {
    pairs: [['Design | Development\nTeam', 'Review C:\\plan | Friday']],
    invalidLines: [],
  });
  assert.deepEqual(local(codec.parsePairText('missing delimiter')), {
    pairs: [],
    invalidLines: [1],
  });
});

test('ill-formed UTF-16 topic keys use a lossless fallback instead of breaking Review', async () => {
  const codec = await loadCodec();
  const malformedTopic = `before-${String.fromCharCode(0xd800)}-after`;
  const label = codec.formatFactTopicLabel({ topic: malformedTopic });

  assert.match(label, /^topic16:[0-9a-f]+$/);
  assert.deepEqual(local(codec.parseFactTopicLabel(label)), {
    title: malformedTopic,
    topic: malformedTopic,
  });
});
