// Source abstraction: turn any input (URL or file path) into distillable text
// plus provenance metadata, dispatching on what the input actually IS.
import path from 'node:path';
import { extractUrl } from './url.js';
import { extractPdf } from './pdf.js';
import { extractText as extractTextFile } from './text.js';
import { extractYoutube } from './youtube.js';
import { extractAudio } from './audio.js';

export type SourceKind = 'meeting' | 'article' | 'pdf' | 'video' | 'text';

export interface ExtractedSource {
  kind: SourceKind;
  /** Best-effort title from the source itself (page <title>, PDF filename, video title). */
  title?: string;
  /** Where it came from: a URL, a file path, or "discord:<channel>". */
  origin: string;
  /** The full extracted text to distil. */
  text: string;
  /** Speakers (for a meeting/video) or author(s) (for an article/pdf). */
  attribution?: string[];
  durationMinutes?: number;
}

export interface ExtractOptions {
  /** Speaker/author name to attribute the source to (used by audio + as a hint). */
  speaker?: string;
  /**
   * Force the source kind rather than inferring it. Useful when a `.txt` is
   * really a saved article, or a URL should be treated as plain text.
   */
  kindOverride?: SourceKind;
}

const AUDIO_VIDEO_EXTS = new Set([
  '.m4a', '.mp3', '.wav', '.aac', '.flac', '.ogg', '.opus', '.wma',
  '.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi',
]);
const TEXT_EXTS = new Set(['.txt', '.md', '.markdown', '.text']);

function isHttpUrl(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

function isYoutube(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be';
  } catch {
    return false;
  }
}

/**
 * Dispatch on the shape of `input`: a URL is fetched (YouTube specially), a
 * path is read according to its extension. The returned kind is the natural
 * kind of the source unless the caller overrides it.
 */
export async function extract(input: string, opts: ExtractOptions = {}): Promise<ExtractedSource> {
  let result: ExtractedSource;

  if (isHttpUrl(input)) {
    result = isYoutube(input) ? await extractYoutube(input, opts) : await extractUrl(input, opts);
  } else {
    const ext = path.extname(input).toLowerCase();
    if (ext === '.pdf') {
      result = await extractPdf(input, opts);
    } else if (TEXT_EXTS.has(ext)) {
      result = await extractTextFile(input, opts);
    } else if (AUDIO_VIDEO_EXTS.has(ext)) {
      result = await extractAudio(input, opts);
    } else {
      throw new Error(
        `Don't know how to ingest "${input}". Give an http(s) URL, or a file ending in ` +
          `.pdf, .txt/.md, or an audio/video extension (${[...AUDIO_VIDEO_EXTS].join(', ')}).`,
      );
    }
  }

  if (opts.kindOverride) result.kind = opts.kindOverride;
  return result;
}
