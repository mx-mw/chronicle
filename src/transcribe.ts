import { existsSync } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { positiveIntegerEnv, runCommand } from './runtime.js';
import type { Segment } from './recorder.js';

export class TranscriptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptionError';
  }
}

const MIN_PCM_BYTES = 192_000 * 0.4;

export interface TranscriptLine {
  startMs: number;
  speaker: string;
  text: string;
}

export interface TranscriptionResult {
  transcript: string;
  lines: TranscriptLine[];
  warnings: string[];
}

export async function assertParakeetReady(): Promise<void> {
  try {
    await runCommand(config.parakeetBin, ['--help'], { timeoutMs: 15_000 });
  } catch {
    throw new Error(
      `Parakeet binary "${config.parakeetBin}" is unavailable. Install it with: ` +
        'uv tool install parakeet-mlx --with "mlx==0.31.2"',
    );
  }
}

/** Convert Discord's 48kHz stereo s16le PCM into 16kHz mono WAV. */
export async function pcmToWav(pcmPath: string): Promise<string> {
  const wavPath = pcmPath.replace(/\.pcm$/i, '.wav');
  await runCommand(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      's16le',
      '-ar',
      '48000',
      '-ac',
      '2',
      '-i',
      pcmPath,
      '-ar',
      '16000',
      '-ac',
      '1',
      wavPath,
    ],
    { timeoutMs: positiveIntegerEnv('FFMPEG_TIMEOUT_MS', 5 * 60_000) },
  );
  return wavPath;
}

function transcriptPath(wavPath: string): string {
  return path.join(path.dirname(wavPath), `${path.basename(wavPath, path.extname(wavPath))}.txt`);
}

function parakeetFailureDetail(stdout: string, stderr: string): string {
  return `${stderr}\n${stdout}`
    .trim()
    .split(/\r?\n/)
    .slice(0, 8)
    .join('\n');
}

export interface BatchTranscriptionResult {
  texts: Map<string, string>;
  failures: Map<string, string>;
}

/**
 * Transcribe every WAV in one Parakeet invocation so the model loads once per
 * meeting instead of once per utterance.
 */
export async function transcribeWavs(wavPaths: string[]): Promise<BatchTranscriptionResult> {
  const unique = [...new Set(wavPaths.map((file) => path.resolve(file)))];
  if (!unique.length) return { texts: new Map(), failures: new Map() };
  const outDir = path.dirname(unique[0]);
  if (unique.some((file) => path.dirname(file) !== outDir)) {
    throw new TranscriptionError('A Parakeet batch must use WAV files from one session directory.');
  }

  await Promise.all(unique.map((file) => rm(transcriptPath(file), { force: true })));
  let stdout = '';
  let stderr = '';
  let commandFailure: unknown;
  try {
    const result = await runCommand(
      config.parakeetBin,
      [
        ...unique,
        '--model',
        config.parakeetModel,
        '--output-dir',
        outDir,
        '--output-format',
        'txt',
      ],
      {
        timeoutMs: positiveIntegerEnv('PARAKEET_TIMEOUT_MS', 30 * 60_000),
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    commandFailure = error;
    stdout = (error as { stdout?: string }).stdout ?? '';
    stderr = (error as { stderr?: string }).stderr ?? '';
  }

  const texts = new Map<string, string>();
  const failures = new Map<string, string>();
  const detail = parakeetFailureDetail(stdout, stderr);
  const failureMessage =
    detail ||
    (commandFailure instanceof Error ? commandFailure.message : '') ||
    `${config.parakeetBin} failed`;
  for (const wavPath of unique) {
    const output = transcriptPath(wavPath);
    if (!existsSync(output)) {
      failures.set(
        wavPath,
        commandFailure ? failureMessage : `${config.parakeetBin} wrote no transcript`,
      );
      continue;
    }
    try {
      const text = (await readFile(output, 'utf8')).replace(/\s+/g, ' ').trim();
      // Empty output is silence only when the batch command itself succeeded.
      // A failed process can leave an empty placeholder behind; accepting that
      // would misreport an ASR backend failure as quiet audio.
      if (commandFailure && !text) failures.set(wavPath, failureMessage);
      else texts.set(wavPath, text);
    } finally {
      await rm(output, { force: true });
    }
  }

  if (!texts.size && failures.size) {
    const first = failures.values().next().value ?? 'Unknown Parakeet failure';
    throw new TranscriptionError(
      `All ${failures.size} audio file(s) failed to transcribe. ${first}\n\n` +
        'If Metal reports unsupported deferred-static-alloca-size, run: ' +
        'uv tool install --force parakeet-mlx --with "mlx==0.31.2"',
    );
  }
  return { texts, failures };
}

export async function transcribeWav(wavPath: string): Promise<string> {
  const absolute = path.resolve(wavPath);
  const { texts, failures } = await transcribeWavs([absolute]);
  const text = texts.get(absolute);
  if (text !== undefined) return text;
  throw new TranscriptionError(failures.get(absolute) ?? `No transcript was produced for ${wavPath}`);
}

function formatOffset(ms: number): string {
  const totalSeconds = Math.floor(ms / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

async function mapLimited<T, R>(
  values: T[],
  limit: number,
  operation: (value: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(values.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await operation(values[index]) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, limit), values.length) }, () => worker()),
  );
  return results;
}

/** Transcribe and interleave the per-speaker Discord segments for one meeting. */
export async function transcribeSession(
  segments: Segment[],
  speakers: Map<string, string>,
  onProgress?: (done: number, total: number) => void,
): Promise<TranscriptionResult> {
  const lines: TranscriptLine[] = [];
  const warnings: string[] = [];
  const eligible: Segment[] = [];
  let done = 0;
  let attempted = 0;
  let failures = 0;
  let firstFailure: unknown;

  for (const segment of segments) {
    try {
      const { size } = await stat(segment.pcmPath);
      if (size < MIN_PCM_BYTES) {
        done += 1;
        onProgress?.(done, segments.length);
        continue;
      }
      eligible.push(segment);
    } catch (error) {
      attempted += 1;
      failures += 1;
      firstFailure ??= error;
      warnings.push(`Missing or unreadable audio segment: ${path.basename(segment.pcmPath)}`);
      done += 1;
      onProgress?.(done, segments.length);
    }
  }

  attempted += eligible.length;
  const converted = await mapLimited(
    eligible,
    positiveIntegerEnv('FFMPEG_CONCURRENCY', 4),
    async (segment) => ({ segment, wavPath: await pcmToWav(segment.pcmPath) }),
  );
  const ready: { segment: Segment; wavPath: string }[] = [];
  for (let index = 0; index < converted.length; index += 1) {
    const result = converted[index];
    if (result.status === 'fulfilled') {
      ready.push(result.value);
    } else {
      failures += 1;
      firstFailure ??= result.reason;
      warnings.push(`Could not convert ${path.basename(eligible[index].pcmPath)} to WAV.`);
      done += 1;
      onProgress?.(done, segments.length);
    }
  }

  if (ready.length) {
    try {
      const batch = await transcribeWavs(ready.map((item) => item.wavPath));
      for (const item of ready) {
        const absoluteWav = path.resolve(item.wavPath);
        const text = batch.texts.get(absoluteWav);
        if (text) {
          lines.push({
            startMs: item.segment.startMs,
            speaker: speakers.get(item.segment.userId) ?? item.segment.userId,
            text,
          });
        } else if (!batch.texts.has(absoluteWav)) {
          failures += 1;
          const reason = batch.failures.get(absoluteWav) ?? 'No transcript produced';
          firstFailure ??= new Error(reason);
          warnings.push(`Transcription failed for ${path.basename(item.segment.pcmPath)}: ${reason}`);
        }
        await rm(item.wavPath, { force: true });
        done += 1;
        onProgress?.(done, segments.length);
      }
    } catch (error) {
      firstFailure ??= error;
      failures += ready.length;
      warnings.push(error instanceof Error ? error.message : String(error));
      for (const item of ready) {
        await rm(item.wavPath, { force: true });
        done += 1;
        onProgress?.(done, segments.length);
      }
    }
  }

  if (attempted > 0 && failures === attempted) {
    throw new TranscriptionError(
      `All ${attempted} audio segment(s) failed to transcribe. ` +
        `${firstFailure instanceof Error ? firstFailure.message : String(firstFailure)}`,
    );
  }
  if (failures > 0) {
    warnings.unshift(`${failures} of ${attempted} attempted audio segments failed. The transcript is partial.`);
    console.warn(warnings[0]);
  }

  lines.sort((left, right) => left.startMs - right.startMs);
  const transcript = lines
    .map((line) => `[${formatOffset(line.startMs)}] ${line.speaker}: ${line.text}`)
    .join('\n');
  return { transcript, lines, warnings };
}
