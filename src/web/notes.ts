// Filesystem access to kb/ for the web UI: listing the palace map and reading a
// single note. Every read is confined to kb/ by resolve + realpath containment
// checks, because :file comes straight from an untrusted URL.

import { existsSync, realpathSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { normalizeWorkspaceId, workspaceRoot } from '../kb.js';
import { parseFrontmatter } from './markdown.js';

export interface NoteSummary {
  file: string; // kb-relative, e.g. "meetings/2026-07-09-foo.md"
  name: string;
  title: string;
  description: string;
  type: string;
  updatedAt: string;
}

export interface PalaceMap {
  topics: NoteSummary[];
  records: NoteSummary[];
  /** Compatibility alias for the v1 reading-room API. */
  meetings: NoteSummary[];
}

function titleOf(content: string, fallback: string): string {
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? fallback;
}

async function summarize(file: string): Promise<NoteSummary> {
  const absolute = path.join(config.kbDir, file);
  const [content, info] = await Promise.all([readFile(absolute, 'utf8'), stat(absolute)]);
  const { meta } = parseFrontmatter(content);
  const base = path.basename(file).replace(/\.md$/, '');
  return {
    file,
    name: meta.name ?? base,
    title: titleOf(content, meta.name ?? base),
    description: meta.description ?? '',
    type: meta.type ?? '',
    updatedAt: info.mtime.toISOString(),
  };
}

async function listDir(sub: string): Promise<NoteSummary[]> {
  const dir = path.join(config.kbDir, sub);
  if (!existsSync(dir)) return [];
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  return Promise.all(files.map((f) => summarize(path.posix.join(sub, f))));
}

function validWorkspaceSegment(workspaceId: string): string {
  try {
    return normalizeWorkspaceId(workspaceId);
  } catch (error) {
    throw new NoteAccessError(error instanceof Error ? error.message : 'Invalid workspace', 400);
  }
}

function uniqueNotes(notes: NoteSummary[]): NoteSummary[] {
  const seen = new Set<string>();
  return notes.filter((note) => {
    if (seen.has(note.file)) return false;
    seen.add(note.file);
    return true;
  });
}

/**
 * The archive map. V2 workspace-scoped records are preferred, while v1
 * meetings and root topics remain readable during migration.
 */
export async function buildPalaceMap(workspaceId = 'default'): Promise<PalaceMap> {
  const workspace = validWorkspaceSegment(workspaceId);
  const root = workspaceRoot(workspace);
  const relativeRoot = path.relative(config.kbDir, root).split(path.sep).join('/');
  const scoped = (sub: string) => relativeRoot ? path.posix.join(relativeRoot, sub) : sub;
  const [topics, records, meetings] = await Promise.all([
    listDir(scoped('topics')),
    listDir(scoped('records')),
    listDir(scoped('meetings')),
  ]);

  const sortedTopics = uniqueNotes(topics).sort((a, b) =>
    a.title.localeCompare(b.title),
  );
  const approvedRecords = uniqueNotes([...records, ...meetings]).sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  return { topics: sortedTopics, records: approvedRecords, meetings: approvedRecords };
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

export interface ReadNoteOptions {
  workspaceId?: string;
  /** Workspace-relative transcript paths attached to review drafts. */
  allowedRawPaths?: readonly string[];
}

function relativeToWorkspace(absolute: string, workspaceId: string): string {
  let root: string;
  try {
    root = realpathSync(workspaceRoot(workspaceId));
  } catch {
    throw new NoteAccessError('Workspace not found', 404);
  }
  const file = realpathSync(absolute);
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new NoteAccessError('Note belongs to a different workspace', 403);
  }
  return relative.split(path.sep).join('/');
}

function workspaceRequestPath(relPath: string, workspaceId: string): string {
  const clean = relPath.replace(/^\/+/, '').split(path.sep).join('/');
  if (workspaceId === 'default' || !/^(?:meetings|records|topics|transcripts)\//.test(clean)) {
    return clean;
  }
  const workspacePrefix = path.relative(config.kbDir, workspaceRoot(workspaceId)).split(path.sep).join('/');
  return path.posix.join(workspacePrefix, clean);
}

function workspaceRawPath(rawPath: string, workspaceId: string): string {
  const clean = rawPath.replace(/^\/+/, '').split(path.sep).join('/');
  const workspacePrefix = path.relative(config.kbDir, workspaceRoot(workspaceId)).split(path.sep).join('/');
  return workspacePrefix && clean.startsWith(`${workspacePrefix}/`)
    ? clean.slice(workspacePrefix.length + 1)
    : clean;
}

/**
 * Read one approved note in the requested workspace, or a raw capture that is
 * explicitly attached to one of that workspace's review drafts.
 */
export async function readNote(relPath: string, options: ReadNoteOptions = {}): Promise<NoteContent> {
  const workspaceId = validWorkspaceSegment(options.workspaceId ?? 'default');
  const requested = workspaceRequestPath(relPath, workspaceId);
  const abs = safeResolve(requested);
  const workspaceRelative = relativeToWorkspace(abs, workspaceId);
  const topLevel = workspaceRelative.split('/')[0];
  const approved = topLevel === 'meetings' || topLevel === 'records' || topLevel === 'topics';
  const allowedRaw = new Set(
    (options.allowedRawPaths ?? []).map((rawPath) => workspaceRawPath(rawPath, workspaceId)),
  );
  if (!approved && !(topLevel === 'transcripts' && allowedRaw.has(workspaceRelative))) {
    throw new NoteAccessError('Note is not available in this workspace', 403);
  }

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
