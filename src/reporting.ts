import { existsSync } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

export interface ArchiveDocument {
  file: string;
  absolutePath: string;
  title: string;
  description: string;
  type: string;
  workspaceId: string;
  date?: string;
  frontmatter: Record<string, unknown>;
  body: string;
  content: string;
  modifiedAt: string;
}

const SKIP_DIRECTORIES = new Set([
  '.chronicle',
  'archive',
  'digests',
  'inbox',
  'raw',
  'reports',
  'transcripts',
]);

function decodeYamlValue(raw: string): unknown {
  const value = raw.trim();
  if (!value) return '';
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith('[') && value.endsWith(']')) ||
    (value.startsWith('{') && value.endsWith('}'))
  ) {
    try {
      return JSON.parse(value);
    } catch {
      return value.replace(/^"|"$/g, '');
    }
  }
  return value.replace(/^['"]|['"]$/g, '');
}

export function parseSimpleFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: {}, body: content };
  const frontmatter: Record<string, unknown> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (pair) frontmatter[pair[1]] = decodeYamlValue(pair[2]);
  }
  return { frontmatter, body: content.slice(match[0].length) };
}

function scalar(frontmatter: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = frontmatter[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function titleOf(body: string, fallback: string): string {
  return body.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? fallback;
}

function dateFromFile(file: string): string | undefined {
  return path.basename(file).match(/^(\d{4}-\d{2}-\d{2})/)?.[1];
}

function workspaceFromPath(file: string): string | undefined {
  const parts = file.split('/');
  const index = parts.indexOf('workspaces');
  return index >= 0 ? parts[index + 1] : undefined;
}

function isApprovedMarkdown(file: string): boolean {
  const parts = file.split('/');
  return parts.some((part) => part === 'records' || part === 'meetings' || part === 'topics');
}

async function walkMarkdown(root: string, current = root): Promise<string[]> {
  if (!existsSync(current)) return [];
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.well-known') continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      files.push(...(await walkMarkdown(root, absolute)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      if (isApprovedMarkdown(relative)) files.push(relative);
    }
  }
  return files;
}

export async function listApprovedDocuments(options: {
  kbDir?: string;
  workspaceId?: string;
} = {}): Promise<ArchiveDocument[]> {
  const kbDir = options.kbDir ?? config.kbDir;
  const files = await walkMarkdown(kbDir);
  const documents: ArchiveDocument[] = [];

  for (const file of files.sort()) {
    const absolutePath = path.join(kbDir, file);
    const [content, fileStat] = await Promise.all([readFile(absolutePath, 'utf8'), stat(absolutePath)]);
    const { frontmatter, body } = parseSimpleFrontmatter(content);
    const fallback = path.basename(file, '.md');
    const workspaceId =
      scalar(frontmatter, 'workspace_id', 'workspaceId', 'workspace') ??
      workspaceFromPath(file) ??
      'default';
    if (options.workspaceId && workspaceId !== options.workspaceId) continue;

    documents.push({
      file,
      absolutePath,
      title: titleOf(body, scalar(frontmatter, 'title', 'name') ?? fallback),
      description: scalar(frontmatter, 'description', 'summary') ?? '',
      type:
        scalar(frontmatter, 'type', 'kind') ??
        (file.split('/').includes('topics') ? 'topic' : 'record'),
      workspaceId,
      date:
        scalar(frontmatter, 'occurred_at', 'occurredAt', 'captured_at', 'capturedAt', 'date')?.slice(0, 10) ??
        dateFromFile(file),
      frontmatter,
      body,
      content,
      modifiedAt: fileStat.mtime.toISOString(),
    });
  }

  return documents;
}

export function sectionItems(body: string, heading: string): string[] {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = body.match(
    new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|(?![\\s\\S]))`, 'im'),
  );
  if (!match) return [];
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^-\s+/.test(line))
    .map((line) => line.replace(/^-\s+/, '').replace(/^\[[ xX]\]\s+/, '').trim())
    .filter(Boolean);
}

export function localDate(
  date = new Date(),
  timeZone = process.env.CHRONICLE_TIMEZONE || 'Asia/Hong_Kong',
): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function ageInDays(isoDate: string, now = new Date()): number {
  const timestamp = Date.parse(`${isoDate.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(timestamp)) return Number.POSITIVE_INFINITY;
  return Math.floor((now.getTime() - timestamp) / 86_400_000);
}

export function normalizeFact(value: string): string {
  return value
    .toLowerCase()
    .replace(/\[\[[^\]]+\]\]/g, '')
    .replace(/\([^)]*\d{4}-\d{2}-\d{2}[^)]*\)\s*$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function tokenize(value: string): Set<string> {
  return new Set(
    normalizeFact(value)
      .split(/\s+/)
      .filter((token) => token.length > 2),
  );
}

export function jaccard(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}
