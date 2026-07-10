// Ingest a YouTube video: prefer yt-dlp's own captions (fast), fall back to
// downloading the audio and transcribing it with Parakeet (slow but works when
// a video has no captions). The URL is untrusted, so every yt-dlp/ffmpeg call
// goes through execFile with an argv array — never a shell string.
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { positiveIntegerEnv, runCommand } from '../runtime.js';
import { transcribeMediaFile } from './audio.js';
import type { ExtractedSource, ExtractOptions } from './index.js';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LONG_FORM_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com']);
const YOUTUBE_ERROR =
  'Unsupported YouTube URL. Chronicle accepts one video at a time from ' +
  'youtube.com/watch?v=<11-character-id>, /shorts/<id>, /live/<id>, ' +
  '/embed/<id>, or youtu.be/<id>.';

/** Options that prevent a local yt-dlp config or playlist context expanding scope. */
export const YT_DLP_SINGLE_VIDEO_ARGS = Object.freeze([
  '--ignore-config',
  '--no-playlist',
  '--playlist-end',
  '1',
] as const);

function unsupportedYoutubeUrl(): never {
  throw new Error(YOUTUBE_ERROR);
}

function isYoutubeOwnedHost(hostname: string): boolean {
  return (
    hostname === 'youtube.com' ||
    hostname.endsWith('.youtube.com') ||
    hostname === 'youtu.be' ||
    hostname.endsWith('.youtu.be') ||
    hostname === 'youtube-nocookie.com' ||
    hostname.endsWith('.youtube-nocookie.com')
  );
}

function hasExplicitPort(raw: string): boolean {
  const match = raw.trim().match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/i);
  if (!match) return false;
  const host = match[1].slice(match[1].lastIndexOf('@') + 1);
  return /:\d*$/.test(host);
}

/**
 * Return a query-minimal, HTTPS URL for one canonical YouTube video.
 * Non-YouTube URLs return undefined so the source dispatcher can handle them;
 * YouTube-owned URLs outside the supported single-video shapes fail closed.
 */
export function canonicalizeYoutubeVideoUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }

  // A trailing DNS root dot is equivalent to the same host without it. Strip
  // it before ownership checks so it cannot fall through to generic fetching.
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (!isYoutubeOwnedHost(hostname)) return undefined;

  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.port ||
    hasExplicitPort(raw)
  ) {
    return unsupportedYoutubeUrl();
  }

  let videoId: string | undefined;
  if (LONG_FORM_HOSTS.has(hostname)) {
    if (url.pathname === '/watch') {
      const candidates = url.searchParams.getAll('v');
      if (candidates.length === 1) videoId = candidates[0];
    } else {
      const match = url.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)$/);
      videoId = match?.[1];
    }
  } else if (hostname === 'youtu.be') {
    const match = url.pathname.match(/^\/([^/]+)$/);
    videoId = match?.[1];
  } else {
    return unsupportedYoutubeUrl();
  }

  if (!videoId || !VIDEO_ID.test(videoId)) return unsupportedYoutubeUrl();
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function ytDlpArgs(...args: string[]): string[] {
  return [...YT_DLP_SINGLE_VIDEO_ARGS, ...args];
}

async function fetchTitle(url: string): Promise<string | undefined> {
  try {
    const { stdout } = await runCommand(
      'yt-dlp',
      ytDlpArgs('--skip-download', '--print', '%(title)s', url),
      {
        timeoutMs: 60_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
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
    await runCommand(
      'yt-dlp',
      ytDlpArgs(
        '--skip-download',
        '--write-subs',
        '--write-auto-subs',
        '--sub-langs', 'en.*,en',
        '--sub-format', 'vtt',
        '-o', template,
        url,
      ),
      { timeoutMs: 2 * 60_000, maxBuffer: 8 * 1024 * 1024 },
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
  await runCommand(
    'yt-dlp',
    ytDlpArgs(
      '-f',
      'bestaudio/best',
      '-x',
      '--audio-format',
      'm4a',
      '--max-filesize',
      String(positiveIntegerEnv('MAX_SOURCE_BYTES', 2 * 1024 * 1024 * 1024)),
      '--match-filter',
      `duration <= ${positiveIntegerEnv('MAX_MEDIA_MINUTES', 240) * 60}`,
      '-o',
      template,
      url,
    ),
    {
      timeoutMs: positiveIntegerEnv('YOUTUBE_TIMEOUT_MS', 30 * 60_000),
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  const files = (await readdir(workDir)).filter((f) => f.startsWith('audio.'));
  if (files.length === 0) throw new Error('yt-dlp did not produce an audio file to transcribe.');
  return path.join(workDir, files[0]);
}

export async function extractYoutube(url: string, opts: ExtractOptions = {}): Promise<ExtractedSource> {
  const canonicalUrl = canonicalizeYoutubeVideoUrl(url);
  if (!canonicalUrl) return unsupportedYoutubeUrl();

  await mkdir(config.sessionsDir, { recursive: true });
  const workDir = await mkdtemp(path.join(config.sessionsDir, 'youtube-'));

  try {
    const title = await fetchTitle(canonicalUrl);

    console.error('Looking for captions.');
    const captions = await tryCaptions(canonicalUrl, workDir);
    if (captions) {
      return {
        kind: 'video',
        title,
        origin: canonicalUrl,
        text: captions,
        attribution: opts.speaker ? [opts.speaker] : undefined,
      };
    }

    console.error('No captions available. Downloading audio to transcribe.');
    const audioPath = await downloadAudio(canonicalUrl, workDir);
    const { text, durationMinutes } = await transcribeMediaFile(audioPath, workDir);
    if (!text) throw new Error(`No captions and no transcribable speech for ${canonicalUrl}.`);

    return {
      kind: 'video',
      title,
      origin: canonicalUrl,
      text,
      durationMinutes,
      attribution: opts.speaker ? [opts.speaker] : undefined,
    };
  } finally {
    if (!['1', 'true', 'yes', 'on'].includes((process.env.KEEP_INGEST_ARTIFACTS ?? '').toLowerCase())) {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}
