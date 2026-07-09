// Ingest a local audio/video file: transcode to 16kHz mono WAV, transcribe with
// Parakeet, and return the transcript. The ffmpeg/ffprobe/Parakeet logic lifted
// out of the old ingest.ts so both the CLI and the YouTube source share it.
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { assertParakeetReady, transcribeWav } from '../transcribe.js';
import type { ExtractedSource, ExtractOptions } from './index.js';

const run = promisify(execFile);

/** Transcode any ffmpeg-readable media at `inputPath` to the WAV Parakeet wants. */
export async function toWav(inputPath: string, workDir: string): Promise<string> {
  const wavPath = path.join(workDir, 'audio.wav');
  await run('ffmpeg', ['-y', '-i', path.resolve(inputPath), '-ar', '16000', '-ac', '1', wavPath]);
  return wavPath;
}

async function durationMinutes(wavPath: string): Promise<number> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    wavPath,
  ]);
  const seconds = parseFloat(stdout.trim());
  return Number.isFinite(seconds) ? Math.max(1, Math.round(seconds / 60)) : 1;
}

/**
 * Transcribe a media file already on disk. Shared by the audio source and the
 * YouTube ASR fallback. Returns the raw transcript text (not speaker-prefixed).
 */
export async function transcribeMediaFile(
  inputPath: string,
  workDir: string,
): Promise<{ text: string; durationMinutes: number }> {
  await assertParakeetReady();
  const wavPath = await toWav(inputPath, workDir);
  const minutes = await durationMinutes(wavPath);
  const text = await transcribeWav(wavPath);
  return { text, durationMinutes: minutes };
}

export async function extractAudio(filePath: string, opts: ExtractOptions = {}): Promise<ExtractedSource> {
  const speaker = opts.speaker || 'Speaker';
  const workDir = path.join(config.sessionsDir, `ingest-${Date.now()}`);
  await mkdir(workDir, { recursive: true });

  console.error('Transcribing audio (this can take a while)…');
  const { text, durationMinutes: minutes } = await transcribeMediaFile(filePath, workDir);
  if (!text) throw new Error('No speech found in the audio.');

  // Prefix with the speaker so the distiller can attribute action items, matching
  // the original single-speaker ingest behaviour.
  return {
    kind: 'meeting',
    title: path.basename(filePath, path.extname(filePath)),
    origin: path.resolve(filePath),
    text: `${speaker}: ${text}`,
    attribution: [speaker],
    durationMinutes: minutes,
  };
}
