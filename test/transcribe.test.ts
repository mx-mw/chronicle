import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TranscriptionError, transcribeWavs } from '../src/transcribe.js';

async function fakeParakeet(
  directory: string,
  options: { exitCode: number; textByStem?: Record<string, string> },
): Promise<string> {
  const script = path.join(directory, `fake-parakeet-${options.exitCode}.cjs`);
  const source = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const texts = ${JSON.stringify(options.textByStem ?? {})};
for (const value of process.argv.slice(2)) {
  if (!value.endsWith('.wav')) continue;
  const stem = path.basename(value, '.wav');
  fs.writeFileSync(path.join(path.dirname(value), stem + '.txt'), texts[stem] ?? '');
}
process.exit(${options.exitCode});
`;
  await writeFile(script, source);
  await chmod(script, 0o700);
  return script;
}

test('a failed Parakeet process cannot disguise an empty output as silence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'chronicle-asr-failure-'));
  const previous = process.env.PARAKEET_BIN;
  try {
    const wav = path.join(directory, 'speaker.wav');
    await writeFile(wav, 'fake wav');
    process.env.PARAKEET_BIN = await fakeParakeet(directory, { exitCode: 1 });
    await assert.rejects(() => transcribeWavs([wav]), TranscriptionError);
  } finally {
    if (previous === undefined) delete process.env.PARAKEET_BIN;
    else process.env.PARAKEET_BIN = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('an empty output from a successful Parakeet process remains valid silence', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'chronicle-asr-silence-'));
  const previous = process.env.PARAKEET_BIN;
  try {
    const wav = path.join(directory, 'speaker.wav');
    await writeFile(wav, 'fake wav');
    process.env.PARAKEET_BIN = await fakeParakeet(directory, { exitCode: 0 });
    const result = await transcribeWavs([wav]);
    assert.equal(result.texts.get(path.resolve(wav)), '');
    assert.equal(result.failures.size, 0);
  } finally {
    if (previous === undefined) delete process.env.PARAKEET_BIN;
    else process.env.PARAKEET_BIN = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('a failed batch salvages non-empty transcripts but marks empty placeholders failed', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'chronicle-asr-partial-'));
  const previous = process.env.PARAKEET_BIN;
  try {
    const first = path.join(directory, 'first.wav');
    const second = path.join(directory, 'second.wav');
    await Promise.all([writeFile(first, 'fake wav'), writeFile(second, 'fake wav')]);
    process.env.PARAKEET_BIN = await fakeParakeet(directory, {
      exitCode: 1,
      textByStem: { first: 'Recovered words' },
    });
    const result = await transcribeWavs([first, second]);
    assert.equal(result.texts.get(path.resolve(first)), 'Recovered words');
    assert.equal(result.failures.has(path.resolve(second)), true);
  } finally {
    if (previous === undefined) delete process.env.PARAKEET_BIN;
    else process.env.PARAKEET_BIN = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
