import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from './config.js';
import type { Segment } from './recorder.js';

const run = promisify(execFile);

/**
 * Raised when the ASR backend failed to produce a transcript for a segment.
 * Distinct from "the segment contained no speech" — see transcribeSession.
 */
export class TranscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptionError';
  }
}

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
  // parakeet-mlx catches per-file errors internally, prints "transcription
  // complete", and still exits 0 — so a zero exit code proves nothing. The
  // only trustworthy signal that it worked is the output file appearing.
  const { stdout, stderr } = await run(
    config.parakeetBin,
    [
      wavPath,
      '--model', config.parakeetModel,
      '--output-dir', outDir,
      '--output-format', 'txt',
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );

  if (!existsSync(txtPath)) {
    const detail = `${stderr}\n${stdout}`.trim().split('\n').slice(0, 6).join('\n');
    throw new TranscriptionError(
      `${config.parakeetBin} wrote no transcript for ${path.basename(wavPath)} (it exits 0 even when the ` +
        `model fails to run).\n${detail}\n\n` +
        `A Metal "unsupported deferred-static-alloca-size" error here means MLX cannot compile its GPU ` +
        `kernels on this machine. Pin an older MLX: uv tool install --force parakeet-mlx --with "mlx==0.31.2"`,
    );
  }

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
  let attempted = 0;
  let firstFailure: unknown;
  let failures = 0;

  for (const segment of segments) {
    done += 1;
    try {
      const { size } = await stat(segment.pcmPath);
      if (size < MIN_PCM_BYTES) continue;

      attempted += 1;
      const wavPath = await pcmToWav(segment.pcmPath);
      const text = await transcribeWav(wavPath);
      if (!text) continue;

      lines.push({
        startMs: segment.startMs,
        speaker: speakers.get(segment.userId) ?? segment.userId,
        text,
      });
    } catch (err) {
      failures += 1;
      firstFailure ??= err;
      console.error(`Failed to transcribe ${segment.pcmPath}:`, err);
    } finally {
      onProgress?.(done, segments.length);
    }
  }

  // If every segment we actually tried to transcribe blew up, the backend is
  // broken. Surfacing that as an empty transcript would tell the user "no
  // usable speech was captured" — blaming them for a toolchain failure, and
  // silently discarding a real meeting.
  if (attempted > 0 && failures === attempted) {
    throw new TranscriptionError(
      `All ${attempted} audio segment(s) failed to transcribe — the audio was recorded, but the ASR ` +
        `backend is not working. Root cause:\n\n${
          firstFailure instanceof Error ? firstFailure.message : String(firstFailure)
        }`,
    );
  }
  if (failures > 0) {
    console.warn(`${failures}/${attempted} segments failed to transcribe; the transcript is incomplete.`);
  }

  const transcript = lines
    .map((l) => `[${formatOffset(l.startMs)}] ${l.speaker}: ${l.text}`)
    .join('\n');
  return { transcript, lines };
}
