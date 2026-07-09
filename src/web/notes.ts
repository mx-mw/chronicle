// Filesystem access to kb/ for the web UI: listing the palace map and reading a
// single note. Every read is confined to kb/ by resolve + realpath containment
// checks, because :file comes straight from an untrusted URL.

import { existsSync, realpathSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { parseFrontmatter } from './markdown.js';

export interface NoteSummary {
  file: string; // kb-relative, e.g. "meetings/2026-07-09-foo.md"
  name: string;
  title: string;
  description: string;
  type: string;
}

export interface PalaceMap {
  topics: NoteSummary[];
  meetings: NoteSummary[];
}

function titleOf(content: string, fallback: string): string {
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? fallback;
}

async function summarize(file: string): Promise<NoteSummary> {
  const content = await readFile(path.join(config.kbDir, file), 'utf8');
  const { meta } = parseFrontmatter(content);
  const base = path.basename(file).replace(/\.md$/, '');
  return {
    file,
    name: meta.name ?? base,
    title: titleOf(content, meta.name ?? base),
    description: meta.description ?? '',
    type: meta.type ?? '',
  };
}

async function listDir(sub: string): Promise<NoteSummary[]> {
  const dir = path.join(config.kbDir, sub);
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  return Promise.all(files.map((f) => summarize(`${sub}/${f}`)));
}

/** The palace map: durable topics and the meeting record, newest meetings first. */
export async function buildPalaceMap(): Promise<PalaceMap> {
  const [topics, meetings] = await Promise.all([listDir('topics'), listDir('meetings')]);
  return { topics, meetings: meetings.reverse() };
}

export class NoteAccessError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Turn an untrusted kb-relative path into a real, verified path inside kb/.
 *
 * Three gates, each independent: reject shape (absolute, "..", non-.md, nul),
 * confine the resolved path to kbDir with a trailing-separator prefix check
 * (bare startsWith would let "/kb-evil" pass "/kb"), then realpath both sides so
 * a symlink inside kb/ can't point the read outside it.
 */
function safeResolve(relPath: string): string {
  const rel = relPath.replace(/^\/+/, '');
  if (!rel || rel.includes('\0') || rel.includes('..')) {
    throw new NoteAccessError('Invalid note path', 400);
  }
  if (path.isAbsolute(relPath) || !rel.toLowerCase().endsWith('.md')) {
    throw new NoteAccessError('Invalid note path', 400);
  }

  const kbRoot = config.kbDir; // config.kbDir is already path.resolve'd
  const resolved = path.resolve(kbRoot, rel);
  const withSep = kbRoot.endsWith(path.sep) ? kbRoot : kbRoot + path.sep;
  if (!resolved.startsWith(withSep)) {
    throw new NoteAccessError('Path escapes knowledge base', 403);
  }

  if (!existsSync(resolved)) {
    throw new NoteAccessError('Note not found', 404);
  }

  // Symlink escape: the resolved string is inside kb/, but the inode it names
  // might live elsewhere. Compare real paths.
  const realRoot = realpathSync(kbRoot);
  const realFile = realpathSync(resolved);
  const realWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (!realFile.startsWith(realWithSep)) {
    throw new NoteAccessError('Path escapes knowledge base', 403);
  }
  return resolved;
}

export interface NoteContent {
  file: string;
  name: string;
  title: string;
  description: string;
  type: string;
  markdown: string;
}

/** Read one note by kb-relative path. Throws NoteAccessError with an HTTP status on any breach. */
export async function readNote(relPath: string): Promise<NoteContent> {
  const abs = safeResolve(relPath);
  const markdown = await readFile(abs, 'utf8');
  const { meta } = parseFrontmatter(markdown);
  const rel = path.relative(config.kbDir, abs);
  const base = path.basename(rel).replace(/\.md$/, '');
  return {
    file: rel,
    name: meta.name ?? base,
    title: titleOf(markdown, meta.name ?? base),
    description: meta.description ?? '',
    type: meta.type ?? '',
    markdown,
  };
}
