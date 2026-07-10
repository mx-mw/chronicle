// Ingest a local audio/video file: transcode to 16kHz mono WAV, transcribe with
// Parakeet, and return the transcript. The ffmpeg/ffprobe/Parakeet logic lifted
// out of the old ingest.ts so both the CLI and the YouTube source share it.
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { positiveIntegerEnv, runCommand } from '../runtime.js';
import { assertParakeetReady, transcribeWav } from '../transcribe.js';
import type { ExtractedSource, ExtractOptions } from './index.js';

/** Transcode any ffmpeg-readable media at `inputPath` to the WAV Parakeet wants. */
export async function toWav(inputPath: string, workDir: string): Promise<string> {
  const wavPath = path.join(workDir, 'audio.wav');
  await runCommand(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      path.resolve(inputPath),
      '-ar',
      '16000',
      '-ac',
      '1',
      wavPath,
    ],
    { timeoutMs: positiveIntegerEnv('FFMPEG_TIMEOUT_MS', 30 * 60_000) },
  );
  return wavPath;
}

async function durationMinutes(wavPath: string): Promise<number> {
  const { stdout } = await runCommand('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    wavPath,
  ], { timeoutMs: 30_000 });
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
  try {
    const minutes = await durationMinutes(wavPath);
    const maximum = positiveIntegerEnv('MAX_MEDIA_MINUTES', 240);
    if (minutes > maximum) {
      throw new Error(`Media is about ${minutes} minutes; the configured maximum is ${maximum}.`);
    }
    const text = await transcribeWav(wavPath);
    return { text, durationMinutes: minutes };
  } finally {
    await rm(wavPath, { force: true });
  }
}

export async function extractAudio(filePath: string, opts: ExtractOptions = {}): Promise<ExtractedSource> {
  const speaker = opts.speaker || 'Speaker';
  const absolute = path.resolve(filePath);
  const fileSize = (await stat(absolute)).size;
  const maximumBytes = positiveIntegerEnv('MAX_SOURCE_BYTES', 2 * 1024 * 1024 * 1024);
  if (fileSize > maximumBytes) {
    throw new Error(`${filePath} is ${fileSize} bytes; the configured maximum is ${maximumBytes}.`);
  }
  await mkdir(config.sessionsDir, { recursive: true });
  const workDir = await mkdtemp(path.join(config.sessionsDir, 'ingest-'));

  try {
    console.error('Transcribing audio. This can take a while.');
    const { text, durationMinutes: minutes } = await transcribeMediaFile(absolute, workDir);
    if (!text) throw new Error('No speech found in the audio.');

    return {
      kind: 'meeting',
      title: path.basename(filePath, path.extname(filePath)),
      origin: absolute,
      text: `${speaker}: ${text}`,
      attribution: [speaker],
      durationMinutes: minutes,
    };
  } finally {
    if (!['1', 'true', 'yes', 'on'].includes((process.env.KEEP_INGEST_ARTIFACTS ?? '').toLowerCase())) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
