// Ingest a YouTube video: prefer yt-dlp's own captions (fast), fall back to
// downloading the audio and transcribing it with Parakeet (slow but works when
// a video has no captions). The URL is untrusted, so every yt-dlp/ffmpeg call
// goes through execFile with an argv array — never a shell string.
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { transcribeMediaFile } from './audio.js';
import type { ExtractedSource, ExtractOptions } from './index.js';

const run = promisify(execFile);

async function fetchTitle(url: string): Promise<string | undefined> {
  try {
    const { stdout } = await run('yt-dlp', ['--skip-download', '--print', '%(title)s', url], {
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Turn a WebVTT caption file into plain prose. Auto-generated captions repeat
 * each rolling line and carry inline word-timing tags; strip both so we get one
 * clean copy of the spoken text.
 */
function vttToText(vtt: string): string {
  const out: string[] = [];
  let last = '';
  for (let raw of vtt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line === 'WEBVTT' || line.startsWith('NOTE') || line.startsWith('Kind:') || line.startsWith('Language:')) continue;
    if (line.includes('-->')) continue;
    if (/^\d+$/.test(line)) continue; // cue number
    const clean = line.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
    if (!clean || clean === last) continue;
    out.push(clean);
    last = clean;
  }
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

async function tryCaptions(url: string, workDir: string): Promise<string | undefined> {
  const template = path.join(workDir, 'subs.%(ext)s');
  try {
    await run(
      'yt-dlp',
      [
        '--skip-download',
        '--write-subs',
        '--write-auto-subs',
        '--sub-langs', 'en.*,en',
        '--sub-format', 'vtt',
        '-o', template,
        url,
      ],
      { maxBuffer: 8 * 1024 * 1024 },
    );
  } catch {
    return undefined;
  }
  const vttFiles = (await readdir(workDir)).filter((f) => f.endsWith('.vtt'));
  if (vttFiles.length === 0) return undefined;
  const text = vttToText(await readFile(path.join(workDir, vttFiles[0]), 'utf8'));
  return text || undefined;
}

async function downloadAudio(url: string, workDir: string): Promise<string> {
  const template = path.join(workDir, 'audio.%(ext)s');
  await run(
    'yt-dlp',
    ['-f', 'bestaudio/best', '-x', '--audio-format', 'm4a', '-o', template, url],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  const files = (await readdir(workDir)).filter((f) => f.startsWith('audio.'));
  if (files.length === 0) throw new Error('yt-dlp did not produce an audio file to transcribe.');
  return path.join(workDir, files[0]);
}

export async function extractYoutube(url: string, _opts: ExtractOptions = {}): Promise<ExtractedSource> {
  const workDir = path.join(config.sessionsDir, `youtube-${Date.now()}`);
  await mkdir(workDir, { recursive: true });

  const title = await fetchTitle(url);

  console.error('Looking for captions…');
  const captions = await tryCaptions(url, workDir);
  if (captions) {
    return { kind: 'video', title, origin: url, text: captions };
  }

  console.error('No captions available; downloading audio to transcribe (slower)…');
  const audioPath = await downloadAudio(url, workDir);
  const { text, durationMinutes } = await transcribeMediaFile(audioPath, workDir);
  if (!text) throw new Error(`No captions and no transcribable speech for ${url}.`);

  return { kind: 'video', title, origin: url, text, durationMinutes };
}
