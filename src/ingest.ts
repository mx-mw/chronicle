/**
 * Ingest an existing audio file (m4a, mp3, wav, …) into the knowledge base
 * without Discord — useful for meetings recorded elsewhere, and for testing
 * the pipeline end-to-end.
 *
 *   npm run ingest -- path/to/meeting.m4a [--speaker "Name"]
 */
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';
import { summarizeMeeting } from './summarize.js';
import { writeMeeting } from './kb.js';
import { assertParakeetReady, transcribeWav } from './transcribe.js';

const run = promisify(execFile);

const args = process.argv.slice(2);
const speakerFlag = args.indexOf('--speaker');
const speaker = speakerFlag !== -1 ? args[speakerFlag + 1] : 'Speaker';
const input = args.find((a) => !a.startsWith('--') && a !== speaker);

if (!input) {
  console.error('Usage: npm run ingest -- <audio-file> [--speaker "Name"]');
  process.exit(1);
}

await assertParakeetReady();

const workDir = path.join(config.sessionsDir, `ingest-${Date.now()}`);
await mkdir(workDir, { recursive: true });
const wavPath = path.join(workDir, 'audio.wav');

console.log('Converting audio…');
await run('ffmpeg', ['-y', '-i', path.resolve(input), '-ar', '16000', '-ac', '1', wavPath]);

const { stdout: probe } = await run('ffprobe', [
  '-v', 'error',
  '-show_entries', 'format=duration',
  '-of', 'csv=p=0',
  wavPath,
]);
const durationMinutes = Math.max(1, Math.round(parseFloat(probe.trim()) / 60));

console.log('Transcribing (this can take a while)…');
const text = await transcribeWav(wavPath);
if (!text) {
  console.error('No speech found in the audio.');
  process.exit(1);
}
const transcript = `${speaker}: ${text}`;

console.log('Distilling…');
const date = new Date().toISOString().slice(0, 10);
const summary = await summarizeMeeting({
  transcript,
  participants: [speaker],
  date,
  durationMinutes,
});

const written = await writeMeeting(summary, transcript, {
  date,
  participants: [speaker],
  durationMinutes,
});

console.log(`\nFiled: ${written.meetingPath}`);
console.log(`Topics updated: ${written.topicPaths.join(', ')}`);
