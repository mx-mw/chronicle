import { execFile } from 'node:child_process';
import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';
import type { Segment } from './recorder.js';

const run = promisify(execFile);

// 48kHz * 2ch * 2 bytes = 192,000 bytes/sec of raw PCM. Segments shorter than
// ~0.4s are keyboard taps and breaths that produce garbage transcriptions.
const MIN_PCM_BYTES = 192_000 * 0.4;

export interface TranscriptLine {
  startMs: number;
  speaker: string;
  text: string;
}

export async function assertParakeetReady(): Promise<void> {
  try {
    await run(config.parakeetBin, ['--help']);
  } catch {
    throw new Error(
      `parakeet binary "${config.parakeetBin}" not found. Install with: uv tool install parakeet-mlx`,
    );
  }
}

/** Convert raw 48kHz stereo s16le PCM to the 16kHz mono WAV parakeet expects. */
async function pcmToWav(pcmPath: string): Promise<string> {
  const wavPath = pcmPath.replace(/\.pcm$/, '.wav');
  await run('ffmpeg', [
    '-y',
    '-f', 's16le',
    '-ar', '48000',
    '-ac', '2',
    '-i', pcmPath,
    '-ar', '16000',
    '-ac', '1',
    wavPath,
  ]);
  return wavPath;
}

export async function transcribeWav(wavPath: string): Promise<string> {
  const outDir = path.dirname(wavPath);
  const txtPath = path.join(outDir, `${path.basename(wavPath, path.extname(wavPath))}.txt`);
  await run(
    config.parakeetBin,
    [
      wavPath,
      '--model', config.parakeetModel,
      '--output-dir', outDir,
      '--output-format', 'txt',
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  try {
    const text = await readFile(txtPath, 'utf8');
    return text.replace(/\s+/g, ' ').trim();
  } finally {
    await rm(txtPath, { force: true });
  }
}

function formatOffset(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Transcribe every per-utterance PCM segment and weave them into a single
 * speaker-attributed transcript, ordered by when each utterance started.
 */
export async function transcribeSession(
  segments: Segment[],
  speakers: Map<string, string>,
  onProgress?: (done: number, total: number) => void,
): Promise<{ transcript: string; lines: TranscriptLine[] }> {
  const lines: TranscriptLine[] = [];
  let done = 0;

  for (const segment of segments) {
    done += 1;
    try {
      const { size } = await stat(segment.pcmPath);
      if (size < MIN_PCM_BYTES) continue;

      const wavPath = await pcmToWav(segment.pcmPath);
      const text = await transcribeWav(wavPath);
      if (!text) continue;

      lines.push({
        startMs: segment.startMs,
        speaker: speakers.get(segment.userId) ?? segment.userId,
        text,
      });
    } catch (err) {
      console.error(`Failed to transcribe ${segment.pcmPath}:`, err);
    } finally {
      onProgress?.(done, segments.length);
    }
  }

  const transcript = lines
    .map((l) => `[${formatOffset(l.startMs)}] ${l.speaker}: ${l.text}`)
    .join('\n');
  return { transcript, lines };
}
