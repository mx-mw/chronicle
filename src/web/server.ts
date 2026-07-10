// Chronicle's local-first web surface. This module deliberately stays on
// node:http so the archive has no frontend build dependency.

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { access, readFile, realpath } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import {
  listTopicCatalog,
  normalizeWorkspaceId,
  persistRawCapture,
  recoverApprovalTransactions,
  stageSourceDraft,
  withKnowledgeReadLock,
  workspaceRoot,
  type SourceMeta,
} from '../kb.js';
import { describeProvider } from '../llm.js';
import { reconcileDiscardedSessions } from '../pipeline.js';
import { recall } from '../recall.js';
import { localDate } from '../reporting.js';
import { extract, type ExtractedSource, type SourceKind } from '../sources/index.js';
import { getIndexHealth, search } from '../store.js';
import {
  EncryptedSourceCatalog,
  type SourceCatalogEntry,
} from '../source-catalog.js';
import { summarizeSource, type SourceSummary } from '../summarize.js';
import {
  listTasks,
  readTask,
  updateTask,
  type TaskPatch,
  type TaskStatus,
} from '../tasks.js';
import { listSessionManifests, type SessionManifest } from '../session-manifest.js';
import { renderMarkdown } from './markdown.js';
import { buildPalaceMap, readNote, NoteAccessError, type NoteSummary } from './notes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COMPILED_PUBLIC_DIR = path.join(HERE, 'public');
const SOURCE_PUBLIC_DIR = path.resolve('src/web/public');
const PUBLIC_DIR = existsSync(COMPILED_PUBLIC_DIR) ? COMPILED_PUBLIC_DIR : SOURCE_PUBLIC_DIR;

export function integerSetting(
  name: string,
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

const HOST = process.env.WEB_HOST || '127.0.0.1';
const PORT = integerSetting('WEB_PORT or PORT', process.env.WEB_PORT || process.env.PORT, 4321, 1, 65_535);
const AUTH_TOKEN = process.env.WEB_AUTH_TOKEN || '';
const DEFAULT_WORKSPACE = process.env.WEB_WORKSPACE_ID || 'default';
const MAX_BODY = 256 * 1024;
const SOURCE_RETENTION_SWEEP_MS = 60 * 60 * 1_000;
const PREVIEW_TTL_MS = integerSetting(
  'WEB_PREVIEW_TTL_MS',
  process.env.WEB_PREVIEW_TTL_MS,
  10 * 60 * 1000,
  60 * 1000,
  30 * 60 * 1000,
);
const PREVIEW_CACHE_LIMIT = integerSetting(
  'WEB_PREVIEW_CACHE_LIMIT',
  process.env.WEB_PREVIEW_CACHE_LIMIT,
  8,
  1,
  32,
);
const SOURCE_KINDS = new Set<SourceKind>(['meeting', 'article', 'pdf', 'video', 'text']);

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'Content-Security-Policy':
    "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), geolocation=(), microphone=()',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

type ReviewApi = {
  listDrafts?: (options?: { workspaceId?: string; status?: string }) => Promise<unknown>;
  readDraft?: (id: string, options?: { workspaceId?: string }) => Promise<unknown>;
  updateDraft?: (
    id: string,
    patch: Record<string, unknown>,
    options?: { workspaceId?: string; expectedRevision?: string | number },
  ) => Promise<unknown>;
  approveDraft?: (
    id: string,
    options?: { workspaceId?: string; expectedRevision?: string | number },
  ) => Promise<unknown>;
  rejectDraft?: (
    id: string,
    options?: { workspaceId?: string; expectedRevision?: string | number; reason?: string },
  ) => Promise<unknown>;
};

let reviewApiPromise: Promise<ReviewApi> | undefined;
let sourceCatalog: EncryptedSourceCatalog | undefined;
let sourceCatalogIdentity = '';

type PreviewEntry = {
  workspaceId: string;
  source: ExtractedSource;
  summary: SourceSummary;
  meta: SourceMeta;
  expiresAt: number;
};

const previewCache = new Map<string, PreviewEntry>();
const previewExpiryTimers = new Map<string, NodeJS.Timeout>();

async function getReviewApi(): Promise<ReviewApi> {
  reviewApiPromise ??= import('../kb.js').then((module) => module as unknown as ReviewApi);
  return reviewApiPromise;
}

function getSourceCatalog(): EncryptedSourceCatalog {
  if (!process.env.SOURCE_ENCRYPTION_KEY?.trim()) {
    throw new NoteAccessError(
      'The encrypted source catalog is unavailable until SOURCE_ENCRYPTION_KEY is configured.',
      503,
    );
  }
  let directory: string;
  let encryptionKey: string;
  try {
    directory = config.sourceCatalogDir;
    encryptionKey = config.sourceEncryptionKey;
  } catch (error) {
    throw new NoteAccessError(
      error instanceof Error ? error.message : 'The encrypted source catalog configuration is invalid.',
      503,
    );
  }
  const identity = `${directory}\0${createHash('sha256').update(encryptionKey).digest('hex')}`;
  if (!sourceCatalog || sourceCatalogIdentity !== identity) {
    try {
      sourceCatalog = new EncryptedSourceCatalog({ directory, encryptionKey });
      sourceCatalogIdentity = identity;
    } catch (error) {
      throw new NoteAccessError(
        error instanceof Error ? error.message : 'The encrypted source catalog could not be opened.',
        503,
      );
    }
  }
  return sourceCatalog;
}

function sourceRetentionDays(): number {
  try {
    return config.inboxRetentionDays;
  } catch (error) {
    throw new NoteAccessError(
      error instanceof Error ? error.message : 'Inbox retention is not configured.',
      503,
    );
  }
}

async function getRetainedSourceCatalog(): Promise<EncryptedSourceCatalog> {
  const catalog = getSourceCatalog();
  await catalog.purgeExpired(sourceRetentionDays());
  return catalog;
}

function sourceWorkspace(entry: SourceCatalogEntry): string {
  return entry.recordType === 'source' ? entry.source.workspaceId : entry.workspaceId;
}

function validSourceId(raw: string): string {
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    throw new NoteAccessError('Invalid source identifier.', 400);
  }
  if (!/^source_[a-f0-9]{64}$/.test(id)) {
    throw new NoteAccessError('Invalid source identifier.', 400);
  }
  return id;
}

async function withKnowledgeRead<T>(operation: () => Promise<T>): Promise<T> {
  return withKnowledgeReadLock(operation);
}

function reviewApiReady(api: ReviewApi): boolean {
  return ['listDrafts', 'readDraft', 'updateDraft', 'approveDraft', 'rejectDraft'].every(
    (name) => typeof api[name as keyof ReviewApi] === 'function',
  );
}

function applySecurityHeaders(res: ServerResponse): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  res.setHeader('Cache-Control', 'no-store');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendText(res: ServerResponse, status: number, type: string, body: string): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function equalSecret(actual: string, expected: string): boolean {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function normaliseHostname(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

export function isLoopbackHost(host: string): boolean {
  const value = normaliseHostname(host);
  if (value === 'localhost' || value === '::1') return true;
  const version = isIP(value);
  if (version === 4) return Number(value.split('.')[0]) === 127;
  if (version === 6) {
    const mapped = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i)?.[1];
    return mapped ? isIP(mapped) === 4 && Number(mapped.split('.')[0]) === 127 : false;
  }
  return false;
}

function hostnameFromHeader(hostHeader: string | undefined): string | null {
  if (!hostHeader || /[\r\n/@\\]/.test(hostHeader)) return null;
  try {
    return normaliseHostname(new URL(`http://${hostHeader}`).hostname);
  } catch {
    return null;
  }
}

function explicitPort(hostHeader: string): string {
  if (hostHeader.startsWith('[')) {
    const close = hostHeader.indexOf(']');
    return close >= 0 && hostHeader[close + 1] === ':' ? hostHeader.slice(close + 2) : '';
  }
  const colon = hostHeader.lastIndexOf(':');
  return colon > -1 && hostHeader.indexOf(':') === colon ? hostHeader.slice(colon + 1) : '';
}

export function mutationRequestAllowed(
  method: string,
  hostHeader: string | undefined,
  originHeader: string | undefined,
  fetchSiteHeader: string | undefined,
): boolean {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method.toUpperCase())) return true;
  if (fetchSiteHeader?.toLowerCase() === 'cross-site') return false;
  if (!originHeader) return true;
  if (!hostHeader || originHeader === 'null') return false;
  try {
    const origin = new URL(originHeader);
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') return false;
    const request = new URL(`http://${hostHeader}`);
    const sameHost = normaliseHostname(origin.hostname) === normaliseHostname(request.hostname);
    const defaultPort = origin.protocol === 'https:' ? '443' : '80';
    const requestPort = explicitPort(hostHeader) || defaultPort;
    const originPort = origin.port || defaultPort;
    return sameHost && requestPort === originPort;
  } catch {
    return false;
  }
}

export function isTrustedHostHeader(hostHeader: string | undefined, bindHost = HOST): boolean {
  const requestHost = hostnameFromHeader(hostHeader);
  if (!requestHost) return false;
  if (isLoopbackHost(bindHost)) return isLoopbackHost(requestHost);

  const configured = (process.env.WEB_ALLOWED_HOSTS || '')
    .split(',')
    .map(normaliseHostname)
    .filter(Boolean);
  const bound = normaliseHostname(bindHost);
  if (bound !== '0.0.0.0' && bound !== '::') configured.push(bound);
  return configured.length === 0 || configured.includes(requestHost);
}

export function authorizationMatches(header: string | undefined, token = AUTH_TOKEN): boolean {
  if (!token || !header) return false;
  const bearer = header.match(/^Bearer\s+(.+)$/i);
  if (bearer) return equalSecret(bearer[1].trim(), token);

  const basic = header.match(/^Basic\s+(.+)$/i);
  if (!basic) return false;
  try {
    const decoded = Buffer.from(basic[1], 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    const password = separator >= 0 ? decoded.slice(separator + 1) : decoded;
    return equalSecret(password, token);
  } catch {
    return false;
  }
}

export function validateWebBinding(host = HOST, token = AUTH_TOKEN): void {
  if (!isLoopbackHost(host) && !token) {
    throw new Error('WEB_AUTH_TOKEN is required when WEB_HOST is not loopback.');
  }
}

function workspaceFromRequest(req: IncomingMessage): string {
  const header = req.headers['x-chronicle-workspace'];
  const requested = (Array.isArray(header) ? header[0] : header) || DEFAULT_WORKSPACE;
  try {
    return normalizeWorkspaceId(requested);
  } catch (error) {
    throw new NoteAccessError(error instanceof Error ? error.message : 'Invalid workspace', 400);
  }
}

/** Remote source access is one fixed operator workspace, never a caller-selected tenant. */
export function sourceWorkspaceForBinding(
  requestedWorkspace: string | undefined,
  bindHost: string,
  configuredWorkspace: string,
): string {
  const selected = isLoopbackHost(bindHost)
    ? requestedWorkspace || configuredWorkspace
    : configuredWorkspace;
  return normalizeWorkspaceId(selected);
}

function sourceWorkspaceFromRequest(req: IncomingMessage): string {
  const header = req.headers['x-chronicle-workspace'];
  const requested = Array.isArray(header) ? header[0] : header;
  try {
    return sourceWorkspaceForBinding(requested, HOST, DEFAULT_WORKSPACE);
  } catch (error) {
    throw new NoteAccessError(error instanceof Error ? error.message : 'Invalid workspace', 400);
  }
}

function isEncryptedSourceRoute(pathname: string): boolean {
  return pathname === '/api/sources' || pathname.startsWith('/api/sources/');
}

function validReviewId(raw: string): string {
  const id = decodeURIComponent(raw);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new NoteAccessError('Invalid draft identifier', 400);
  }
  return id;
}

function validTaskId(raw: string): string {
  const id = decodeURIComponent(raw);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new NoteAccessError('Invalid task identifier', 400);
  }
  return id;
}

function parseRevision(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(/^W\//, '').replace(/^"|"$/g, '').trim();
  if (!cleaned) return undefined;
  return /^\d+$/.test(cleaned) ? Number(cleaned) : cleaned;
}

function expectedRevision(req: IncomingMessage, body?: Record<string, unknown>): string | number | undefined {
  return parseRevision(req.headers['if-match']) ?? parseRevision(body?.expectedRevision);
}

function requiredRevision(
  req: IncomingMessage,
  body?: Record<string, unknown>,
  subject = 'review changes',
): number {
  const revision = expectedRevision(req, body);
  if (revision === undefined) {
    throw new NoteAccessError(`If-Match or expectedRevision is required for ${subject}.`, 428);
  }
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
    throw new NoteAccessError('expectedRevision must be a positive integer.', 400);
  }
  return revision;
}

function cleanPreviewCache(now = Date.now()): void {
  for (const [token, entry] of previewCache) {
    if (entry.expiresAt <= now) removePreviewEntry(token);
  }
  while (previewCache.size >= PREVIEW_CACHE_LIMIT) {
    const oldest = previewCache.keys().next().value as string | undefined;
    if (!oldest) break;
    removePreviewEntry(oldest);
  }
}

function removePreviewEntry(token: string): boolean {
  const timer = previewExpiryTimers.get(token);
  if (timer) clearTimeout(timer);
  previewExpiryTimers.delete(token);
  return previewCache.delete(token);
}

function schedulePreviewExpiry(token: string, expiresAt: number): void {
  const timer = setTimeout(() => removePreviewEntry(token), Math.max(0, expiresAt - Date.now()));
  timer.unref();
  previewExpiryTimers.set(token, timer);
}

function previewSourceSnapshot(source: ExtractedSource): Record<string, unknown> {
  return {
    kind: source.kind,
    title: source.title,
    origin: source.origin,
    attribution: source.attribution,
    durationMinutes: source.durationMinutes,
    characters: source.text.length,
  };
}

function previewAttribution(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const values = raw
    .map((item) => String(item).trim())
    .filter(Boolean)
    .slice(0, 12);
  return values.length ? values : undefined;
}

export async function confineWebIngestInput(input: string): Promise<string> {
  if (/^https?:\/\//i.test(input)) return input;
  const configuredRoot = process.env.WEB_INGEST_ROOT?.trim();
  if (!configuredRoot) {
    throw new NoteAccessError(
      'Local-path web capture is disabled. Set WEB_INGEST_ROOT to an allowed directory.',
      403,
    );
  }
  const root = await realpath(path.resolve(configuredRoot)).catch(() => {
    throw new NoteAccessError('WEB_INGEST_ROOT does not exist or cannot be read.', 503);
  });
  const candidate = path.isAbsolute(input) ? path.resolve(input) : path.resolve(root, input);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  const resolved = await realpath(candidate).catch(() => {
    throw new NoteAccessError('Local source does not exist or cannot be read.', 404);
  });
  if (resolved !== root && !resolved.startsWith(prefix)) {
    throw new NoteAccessError('Local source resolves outside WEB_INGEST_ROOT.', 403);
  }
  return resolved;
}

async function createIngestPreview(
  body: Record<string, unknown>,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  const input = String(body.input || '').trim();
  if (!input || input.length > 4096) {
    throw new NoteAccessError('Enter one URL or local path under 4096 characters.', 400);
  }
  const kind = body.kind ? String(body.kind) : undefined;
  if (kind && !SOURCE_KINDS.has(kind as SourceKind)) {
    throw new NoteAccessError('Kind must be meeting, article, pdf, video, or text.', 400);
  }
  const attribution = previewAttribution(body.attribution);
  const safeInput = await confineWebIngestInput(input);
  const source = await extract(safeInput, {
    kindOverride: kind as SourceKind | undefined,
    speaker: attribution?.join(', '),
  });
  if (attribution?.length) source.attribution = attribution;
  const meta: SourceMeta = {
    date: localDate(),
    kind: source.kind,
    origin: source.origin,
    attribution: source.attribution,
    durationMinutes: source.durationMinutes,
  };
  const topicCatalog = await listTopicCatalog({ workspaceId });
  const summary = await summarizeSource({
    text: source.text,
    kind: source.kind,
    date: meta.date,
    attribution: source.attribution,
    durationMinutes: source.durationMinutes,
    title: source.title,
    origin: source.origin,
    topicCatalog,
  });

  cleanPreviewCache();
  const token = randomUUID();
  const expiresAt = Date.now() + PREVIEW_TTL_MS;
  previewCache.set(token, { workspaceId, source, summary, meta, expiresAt });
  schedulePreviewExpiry(token, expiresAt);
  return {
    token,
    expiresAt: new Date(expiresAt).toISOString(),
    source: previewSourceSnapshot(source),
    summary,
  };
}

async function stageIngestPreview(
  body: Record<string, unknown>,
  workspaceId: string,
): Promise<Record<string, unknown>> {
  cleanPreviewCache();
  const token = String(body.token || '');
  const entry = previewCache.get(token);
  if (!entry || entry.expiresAt <= Date.now()) {
    removePreviewEntry(token);
    throw new NoteAccessError('This preview expired. Create a new preview and try again.', 410);
  }
  if (entry.workspaceId !== workspaceId) {
    throw new NoteAccessError('Preview belongs to a different workspace.', 403);
  }

  const rawCapture = await persistRawCapture({
    rawText: entry.source.text,
    meta: entry.meta,
    workspaceId,
  });
  const draft = await stageSourceDraft(entry.summary, entry.source.text, entry.meta, {
    workspaceId,
    rawCapture,
  });
  removePreviewEntry(token);
  return { draft, staged: true, approved: false };
}

function revokeIngestPreview(token: string, workspaceId: string): boolean {
  const entry = previewCache.get(token);
  if (!entry) return false;
  if (entry.workspaceId !== workspaceId) {
    throw new NoteAccessError('Preview belongs to a different workspace.', 403);
  }
  return removePreviewEntry(token);
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let finished = false;
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      if (finished) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        finished = true;
        req.off('data', onData);
        req.resume();
        reject(new NoteAccessError('Request body too large', 413));
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => {
      if (finished) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const parsed = raw ? JSON.parse(raw) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Body must be a JSON object');
        }
        resolve(parsed as Record<string, unknown>);
      } catch (error) {
        reject(new NoteAccessError(error instanceof Error ? error.message : 'Invalid JSON', 400));
      }
    });
    req.on('error', reject);
  });
}

export function errorStatus(error: unknown): number {
  if (error instanceof NoteAccessError) return error.status;
  if (error && typeof error === 'object') {
    const candidate = Number((error as { status?: unknown; statusCode?: unknown }).status ??
      (error as { statusCode?: unknown }).statusCode);
    if (candidate >= 400 && candidate <= 599) return candidate;
    const code = String((error as { code?: unknown }).code || '');
    const message = error instanceof Error ? error.message : '';
    if (code === 'ENOENT' || /^No Chronicle draft\b/i.test(message)) return 404;
    if (/changed \(expected revision|cannot be edited|revision conflict/i.test(message)) return 409;
    if (/conflict|revision/i.test(code)) return 409;
    if (/not.?found/i.test(code)) return 404;
  }
  return 500;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isMissingIndex(error: unknown): boolean {
  return error instanceof Error && /No search index/i.test(error.message);
}

function collectionFrom(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  for (const key of keys) {
    const candidate = (value as Record<string, unknown>)[key];
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

function revisionFrom(value: unknown): string | number | undefined {
  if (!value || typeof value !== 'object') return undefined;
  return parseRevision((value as Record<string, unknown>).revision);
}

function setRevisionHeader(res: ServerResponse, value: unknown): void {
  const revision = revisionFrom(value);
  if (revision !== undefined) res.setHeader('ETag', `"${revision}"`);
}

function noteDate(note: NoteSummary): number {
  const fromName = note.file.match(/(\d{4}-\d{2}-\d{2})/)?.[1];
  const date = fromName ? Date.parse(`${fromName}T00:00:00Z`) : Date.parse(note.updatedAt);
  return Number.isFinite(date) ? date : 0;
}

function sectionItems(markdown: string, heading: string): string[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const wanted = heading.trim().toLowerCase();
  const start = lines.findIndex((line) => line.match(/^##\s+(.+)$/)?.[1]?.trim().toLowerCase() === wanted);
  if (start < 0) return [];
  const items: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^##\s+/.test(line)) break;
    if (!/^\s*-\s+/.test(line)) continue;
    const text = line.replace(/^\s*-\s*(?:\[[ xX]\]\s*)?/, '').trim();
    if (text) items.push(text);
  }
  return items;
}

async function reviewCount(workspaceId: string): Promise<{ count: number | null; available: boolean }> {
  const api = await getReviewApi();
  if (!reviewApiReady(api) || !api.listDrafts) return { count: null, available: false };
  const value = await api.listDrafts({ workspaceId, status: 'needs_review' });
  return { count: collectionFrom(value, ['drafts', 'items', 'records']).length, available: true };
}

async function workspaceRawCapturePaths(workspaceId: string): Promise<string[]> {
  const api = await getReviewApi();
  if (!api.listDrafts || !api.readDraft) return [];
  const summaries = collectionFrom(await api.listDrafts({ workspaceId }), ['drafts', 'items', 'records']);
  const paths = await Promise.all(summaries.map(async (summary) => {
    if (!summary || typeof summary !== 'object') return '';
    const id = String((summary as Record<string, unknown>).id || '');
    if (!id) return '';
    const draft = await api.readDraft!(id, { workspaceId });
    if (!draft || typeof draft !== 'object') return '';
    const rawCapture = (draft as Record<string, unknown>).rawCapture;
    return rawCapture && typeof rawCapture === 'object'
      ? String((rawCapture as Record<string, unknown>).relativePath || '')
      : '';
  }));
  return paths.filter(Boolean);
}

async function readWorkspaceNote(file: string, workspaceId: string) {
  const rawPaths = /(^|\/)transcripts\//.test(file)
    ? await workspaceRawCapturePaths(workspaceId)
    : [];
  return withKnowledgeRead(() => readNote(file, { workspaceId, allowedRawPaths: rawPaths }));
}

async function buildDigest(workspaceId: string): Promise<Record<string, unknown>> {
  const partial: string[] = [];
  const map = await withKnowledgeRead(() => buildPalaceMap(workspaceId));
  let queue: { count: number | null; available: boolean } = { count: null, available: false };
  try {
    queue = await reviewCount(workspaceId);
  } catch {
    partial.push('Review queue could not be read.');
  }
  if (!queue.available) partial.push('Review workflow is not installed.');

  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const recent = map.records.filter((record) => noteDate(record) >= cutoff);
  const openActions: Array<{ text: string; file: string; title: string }> = [];
  const openQuestions: Array<{ text: string; file: string; title: string }> = [];
  let openTasks: Awaited<ReturnType<typeof listTasks>> = [];
  try {
    openTasks = await listTasks({ workspaceId, status: 'open' });
  } catch {
    partial.push('Task lifecycle could not be read.');
  }

  for (const record of recent.slice(0, 12)) {
    try {
      const note = await withKnowledgeRead(() => readNote(record.file, { workspaceId }));
      for (const text of sectionItems(note.markdown, 'Action items')) {
        if (openActions.length < 8) openActions.push({ text, file: record.file, title: record.title });
      }
      for (const text of sectionItems(note.markdown, 'Open questions')) {
        if (openQuestions.length < 8) openQuestions.push({ text, file: record.file, title: record.title });
      }
    } catch {
      partial.push(`Could not inspect ${record.title}.`);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    periodDays: 7,
    reviewCount: queue.count,
    recentRecords: recent.slice(0, 8),
    topicCount: map.topics.length,
    openActions,
    openTasks,
    openQuestions,
    partial: [...new Set(partial)],
  };
}

function processingItem(manifest: SessionManifest): Record<string, unknown> {
  const terminal = new Set(['completed', 'empty', 'discarded']).has(manifest.stage);
  let recordPath: string | undefined;
  if (manifest.meetingPath) {
    const root = path.resolve(workspaceRoot(manifest.workspace.id));
    const relative = path.relative(root, path.resolve(manifest.meetingPath));
    if (relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      recordPath = relative.split(path.sep).join('/');
    }
  }
  return {
    id: manifest.id,
    stage: manifest.stage,
    terminal,
    attentionRequired: manifest.stage === 'failed' || manifest.stage === 'needs_review',
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    startedAt: manifest.startedAt,
    endedAt: manifest.endedAt,
    durationMs: manifest.durationMs,
    participantCount: Object.keys(manifest.speakers).length,
    optedOutCount: manifest.optedOutUserIds.length,
    warningCount: manifest.warnings.length,
    warnings: manifest.warnings,
    attempts: manifest.attempts,
    recoverable: manifest.recoverable !== false,
    error: manifest.error,
    rawCaptureId: manifest.rawCaptureId,
    draftId: manifest.draftId,
    recordPath,
    discardReason: manifest.discardReason,
  };
}

async function buildProcessingFeed(workspaceId: string, limit: number): Promise<Record<string, unknown>> {
  const matching = (await listSessionManifests(config.sessionsDir))
    .map(({ manifest }) => manifest)
    .filter((manifest) => manifest.workspace.id === workspaceId)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const inProgressCount = matching.filter((manifest) =>
    ['connecting', 'recording', 'captured', 'queued', 'transcribing', 'distilling'].includes(
      manifest.stage,
    )).length;
  const attentionCount = matching.filter(
    (manifest) => manifest.stage === 'failed' || manifest.stage === 'needs_review',
  ).length;
  const sessions = matching
    .slice(0, limit)
    .map(processingItem);
  return {
    workspaceId,
    totalCount: matching.length,
    inProgressCount,
    attentionCount,
    sessions,
  };
}

async function pathAccess(target: string): Promise<{ exists: boolean; readable: boolean; writable: boolean }> {
  if (!existsSync(target)) return { exists: false, readable: false, writable: false };
  const readable = await access(target, constants.R_OK).then(() => true, () => false);
  const writable = await access(target, constants.W_OK).then(() => true, () => false);
  return { exists: true, readable, writable };
}

export function completeDiscordPolicy(policy: {
  guildIds: readonly string[];
  channelIds: readonly string[];
  userIds: readonly string[];
  roleIds: readonly string[];
}): boolean {
  return Boolean(
    policy.guildIds.length &&
      policy.channelIds.length &&
      (policy.userIds.length || policy.roleIds.length),
  );
}

async function buildTrustHealth(workspaceId: string): Promise<Record<string, unknown>> {
  const [storage, api, locatedSessions] = await Promise.all([
    pathAccess(config.kbDir),
    getReviewApi(),
    listSessionManifests(config.sessionsDir),
  ]);
  const indexHealth = getIndexHealth();
  const indexReady = indexHealth.exists && indexHealth.compatible && indexHealth.fresh;
  const review = reviewApiReady(api);
  const recordPolicyConfigured = completeDiscordPolicy(config.recordPolicy);
  const recallPolicyConfigured = completeDiscordPolicy(config.recallPolicy);
  const issues: string[] = [];
  if (!storage.exists) issues.push('Knowledge base has not been created.');
  else if (!storage.readable || !storage.writable) issues.push('Knowledge base permissions need attention.');
  if (!indexHealth.exists) issues.push('Search index has not been built. Run npm run index.');
  else if (!indexHealth.compatible) issues.push('Search index is incompatible. Run npm run index to rebuild it.');
  else if (!indexHealth.fresh) issues.push('Search index is stale. Run npm run index before relying on recall.');
  if (indexHealth.lastError) issues.push(`Last index update failed: ${indexHealth.lastError}`);
  if (!review) issues.push('Review workflow is not available.');
  if (!recordPolicyConfigured) issues.push('Recording policy is not configured.');
  if (!recallPolicyConfigured) issues.push('Recall policy is not configured.');
  const sessions = locatedSessions
    .map(({ manifest }) => manifest)
    .filter((manifest) => manifest.workspace.id === workspaceId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const recoverableStages = new Set(['captured', 'queued', 'transcribing', 'distilling', 'failed']);
  const sessionSummary = {
    active: sessions.filter((session) => session.stage === 'connecting' || session.stage === 'recording').length,
    processing: sessions.filter((session) =>
      ['captured', 'queued', 'transcribing', 'distilling'].includes(session.stage)).length,
    needsReview: sessions.filter((session) => session.stage === 'needs_review').length,
    discarded: sessions.filter((session) => session.stage === 'discarded').length,
    recoverable: sessions.filter((session) =>
      recoverableStages.has(session.stage) && session.recoverable !== false).length,
    latest: sessions.slice(0, 8).map((session) => ({
      stage: session.stage,
      updatedAt: session.updatedAt,
      participantCount: Object.keys(session.speakers).length,
      optedOutCount: session.optedOutUserIds.length,
      warningCount: session.warnings.length,
      recoverable: recoverableStages.has(session.stage) && session.recoverable !== false,
    })),
  };

  return {
    ok: issues.length === 0,
    checkedAt: new Date().toISOString(),
    workspaceId,
    issues,
    storage,
    index: { ...indexHealth, ready: indexReady },
    review: { available: review },
    policy: {
      configured: recordPolicyConfigured,
      recordConfigured: recordPolicyConfigured,
      recallConfigured: recallPolicyConfigured,
      autoRecord: config.autoRecord,
    },
    sessions: sessionSummary,
    runtime: {
      node: process.version,
      bindScope: isLoopbackHost(HOST) ? 'loopback' : 'remote',
      authRequired: !isLoopbackHost(HOST),
      authEnabled: Boolean(AUTH_TOKEN),
      provider: config.llmProvider,
      providerLabel: describeProvider(),
    },
  };
}

type EvidenceItem = {
  file: string;
  title: string;
  excerpt: string;
  score: number | null;
  validated: boolean;
};

function evidenceFrom(value: unknown): EvidenceItem[] {
  const records = collectionFrom(value, ['evidence', 'hits', 'sources']);
  return records
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const record = item as Record<string, unknown>;
      const file = String(record.file || record.path || record.source || '');
      const excerpt = String(record.excerpt || record.text || record.chunk || '');
      if (!file && !excerpt) return null;
      const rawScore = Number(record.score ?? record.similarity);
      return {
        file,
        title: String(record.title || record.noteTitle || file.replace(/\.md$/, '') || 'Evidence'),
        excerpt,
        score: Number.isFinite(rawScore) ? rawScore : null,
        validated: record.validated === true || record.citationValidated === true,
      } satisfies EvidenceItem;
    })
    .filter((item): item is EvidenceItem => Boolean(item));
}

export function normaliseRecallResult(value: unknown): Record<string, unknown> {
  const result = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const citedFiles = new Set(
    collectionFrom(result, ['citations'])
      .map((citation) => citation && typeof citation === 'object'
        ? String((citation as Record<string, unknown>).file || '')
        : '')
      .filter(Boolean),
  );
  const evidence = evidenceFrom(result).map((item) => ({
    ...item,
    validated: item.validated || citedFiles.has(item.file),
  }));
  const answer = String(result.answer || '');
  const statedStatus = String(result.status || result.outcome || '').toLowerCase();
  const insufficient =
    !answer ||
    evidence.length === 0 ||
    result.insufficientEvidence === true ||
    /insufficient|abstain|no_evidence/.test(statedStatus);

  if (insufficient) {
    return {
      status: 'insufficient_evidence',
      answer: '',
      answerHtml: '',
      evidence,
      message: String(
        result.message || 'Chronicle does not have enough relevant approved evidence to answer.',
      ),
    };
  }

  return {
    status: 'answered',
    answer,
    answerHtml: renderMarkdown(answer),
    evidence,
  };
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function servePublic(pathname: string, res: ServerResponse): Promise<boolean> {
  const file = pathname === '/' || pathname === '/index.html' ? 'index.html' : pathname.slice(1);
  if (!/^[a-zA-Z0-9._/-]+$/.test(file) || file.includes('..')) return false;
  const absolute = path.resolve(PUBLIC_DIR, file);
  const prefix = PUBLIC_DIR.endsWith(path.sep) ? PUBLIC_DIR : `${PUBLIC_DIR}${path.sep}`;
  if (absolute !== path.join(PUBLIC_DIR, 'index.html') && !absolute.startsWith(prefix)) return false;
  if (!existsSync(absolute)) return false;
  const body = await readFile(absolute, 'utf8');
  sendText(res, 200, MIME_TYPES[path.extname(absolute)] || 'application/octet-stream', body);
  return true;
}

async function handleReviewRoute(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
  workspaceId: string,
): Promise<boolean> {
  if (!pathname.startsWith('/api/reviews')) return false;
  const api = await getReviewApi();
  if (!reviewApiReady(api)) {
    sendJson(res, 501, {
      error: 'review_unavailable',
      message: 'The review workflow is not available in this Chronicle build.',
    });
    return true;
  }

  if (pathname === '/api/reviews' && method === 'GET' && api.listDrafts) {
    const value = await api.listDrafts({ workspaceId, status: 'needs_review' });
    sendJson(res, 200, { drafts: collectionFrom(value, ['drafts', 'items', 'records']), workspaceId });
    return true;
  }

  const match = pathname.match(/^\/api\/reviews\/([^/]+)(?:\/(approve|reject))?$/);
  if (!match) return false;
  const id = validReviewId(match[1]);
  const action = match[2];

  if (method === 'GET' && !action && api.readDraft) {
    const value = await api.readDraft(id, { workspaceId });
    setRevisionHeader(res, value);
    sendJson(res, 200, { draft: value, workspaceId });
    return true;
  }

  if (method === 'PATCH' && !action && api.updateDraft) {
    const body = await readBody(req);
    const revision = requiredRevision(req, body);
    const patch = body.patch && typeof body.patch === 'object' && !Array.isArray(body.patch)
      ? (body.patch as Record<string, unknown>)
      : body;
    delete patch.expectedRevision;
    const value = await api.updateDraft(id, patch, {
      workspaceId,
      expectedRevision: revision,
    });
    setRevisionHeader(res, value);
    sendJson(res, 200, { draft: value, saved: true });
    return true;
  }

  if (method === 'POST' && action === 'approve' && api.approveDraft) {
    const body = await readBody(req);
    const value = await api.approveDraft(id, {
      workspaceId,
      expectedRevision: requiredRevision(req, body),
    });
    setRevisionHeader(res, value);
    sendJson(res, 200, { draft: value, approved: true });
    return true;
  }

  if (method === 'POST' && action === 'reject' && api.rejectDraft) {
    const body = await readBody(req);
    const value = await api.rejectDraft(id, {
      workspaceId,
      expectedRevision: requiredRevision(req, body),
      reason: typeof body.reason === 'string' ? body.reason.trim() : undefined,
    });
    setRevisionHeader(res, value);
    sendJson(res, 200, { draft: value, rejected: true });
    return true;
  }

  sendJson(res, 405, { error: 'method_not_allowed' });
  return true;
}

function taskPatchFrom(body: Record<string, unknown>): TaskPatch {
  const source = body.patch && typeof body.patch === 'object' && !Array.isArray(body.patch)
    ? (body.patch as Record<string, unknown>)
    : body;
  const allowed = new Set(['owner', 'task', 'status', 'expectedRevision']);
  const unexpected = Object.keys(source).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) {
    throw new NoteAccessError(`Unsupported task field: ${unexpected[0]}`, 400);
  }
  const patch: TaskPatch = {};
  for (const field of ['owner', 'task'] as const) {
    if (!(field in source)) continue;
    if (typeof source[field] !== 'string') {
      throw new NoteAccessError(`Task ${field} must be a string.`, 400);
    }
    const value = source[field].normalize('NFKC').trim();
    const maximum = field === 'owner' ? 200 : 4_000;
    if (!value || value.length > maximum || /[\0-\x1f\x7f]/.test(value)) {
      throw new NoteAccessError(`Task ${field} must be 1-${maximum} printable characters.`, 400);
    }
    patch[field] = value;
  }
  if ('status' in source) {
    if (source.status !== 'open' && source.status !== 'done') {
      throw new NoteAccessError('Task status must be open or done.', 400);
    }
    patch.status = source.status;
  }
  if (Object.keys(patch).length === 0) {
    throw new NoteAccessError('Task patch must change owner, task, or status.', 400);
  }
  return patch;
}

async function handleTaskRoute(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  method: string,
  workspaceId: string,
): Promise<boolean> {
  const { pathname } = url;
  if (!pathname.startsWith('/api/tasks')) return false;
  if (pathname === '/api/tasks' && method === 'GET') {
    const rawStatus = url.searchParams.get('status') ?? 'open';
    if (rawStatus !== 'open' && rawStatus !== 'done' && rawStatus !== 'all') {
      throw new NoteAccessError('Task status filter must be open, done, or all.', 400);
    }
    const status = rawStatus as TaskStatus | 'all';
    const rawOwner = url.searchParams.get('owner');
    const owner = rawOwner?.normalize('NFKC').trim() || undefined;
    if (owner && (owner.length > 200 || /[\0-\x1f\x7f]/.test(owner))) {
      throw new NoteAccessError('Task owner filter must be at most 200 printable characters.', 400);
    }
    const tasks = await listTasks({ workspaceId, status, owner });
    sendJson(res, 200, { tasks, workspaceId, status });
    return true;
  }

  const match = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (!match) return false;
  const id = validTaskId(match[1]);
  if (method === 'GET') {
    const task = await readTask(id, { workspaceId });
    setRevisionHeader(res, task);
    sendJson(res, 200, { task, workspaceId });
    return true;
  }
  if (method === 'PATCH') {
    const body = await readBody(req);
    const task = await updateTask(id, taskPatchFrom(body), {
      workspaceId,
      expectedRevision: requiredRevision(req, body, 'task changes'),
    });
    setRevisionHeader(res, task);
    sendJson(res, 200, { task, saved: true });
    return true;
  }
  sendJson(res, 405, { error: 'method_not_allowed' });
  return true;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!isTrustedHostHeader(req.headers.host)) {
    return sendJson(res, 421, { error: 'untrusted_host', message: 'Untrusted Host header.' });
  }
  if (!isLoopbackHost(HOST) && !authorizationMatches(req.headers.authorization)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="Chronicle", Basic realm="Chronicle"');
    return sendJson(res, 401, { error: 'authentication_required', message: 'Authentication required.' });
  }

  const fetchSite = Array.isArray(req.headers['sec-fetch-site'])
    ? req.headers['sec-fetch-site'][0]
    : req.headers['sec-fetch-site'];
  const origin = Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin;
  if (!mutationRequestAllowed(req.method || 'GET', req.headers.host, origin, fetchSite)) {
    return sendJson(res, 403, {
      error: 'cross_origin_mutation',
      message: 'Cross-origin changes are not allowed.',
    });
  }

  const url = new URL(req.url || '/', 'http://chronicle.local');
  const { pathname } = url;
  const method = req.method || 'GET';
  const workspaceId = isEncryptedSourceRoute(pathname)
    ? sourceWorkspaceFromRequest(req)
    : workspaceFromRequest(req);

  if (method === 'GET' && !pathname.startsWith('/api/') && pathname !== '/healthz') {
    if (await servePublic(pathname, res)) return;
  }

  if (method === 'GET' && pathname === '/healthz') {
    const health = await buildTrustHealth(workspaceId);
    return sendJson(res, health.ok ? 200 : 503, health);
  }

  if (method === 'GET' && (pathname === '/api/trust' || pathname === '/api/trust/health')) {
    return sendJson(res, 200, await buildTrustHealth(workspaceId));
  }

  if (method === 'GET' && pathname === '/api/digest') {
    return sendJson(res, 200, await buildDigest(workspaceId));
  }

  if (method === 'GET' && pathname === '/api/processing') {
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new NoteAccessError('Processing limit must be an integer between 1 and 100.', 400);
    }
    return sendJson(res, 200, await buildProcessingFeed(workspaceId, limit));
  }

  if (method === 'POST' && pathname === '/api/ingest/preview') {
    return sendJson(res, 200, await createIngestPreview(await readBody(req), workspaceId));
  }

  const revokePreviewMatch = pathname.match(/^\/api\/ingest\/preview\/([a-f0-9-]{36})$/i);
  if (method === 'DELETE' && revokePreviewMatch) {
    revokeIngestPreview(revokePreviewMatch[1], workspaceId);
    res.writeHead(204);
    res.end();
    return;
  }

  if (method === 'POST' && pathname === '/api/ingest/stage') {
    return sendJson(res, 201, await stageIngestPreview(await readBody(req), workspaceId));
  }

  if (await handleTaskRoute(req, res, url, method, workspaceId)) return;

  if (await handleReviewRoute(req, res, pathname, method, workspaceId)) return;

  if (method === 'GET' && pathname === '/api/sources') {
    const rawLimit = url.searchParams.get('limit');
    const limit = rawLimit === null ? 24 : Number(rawLimit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new NoteAccessError('Source limit must be an integer between 1 and 100.', 400);
    }
    const cursor = url.searchParams.get('cursor') || undefined;
    if (!process.env.SOURCE_ENCRYPTION_KEY?.trim()) {
      return sendJson(res, 200, {
        sources: [],
        nextCursor: null,
        workspaceId,
        available: false,
      });
    }
    try {
      const page = await (await getRetainedSourceCatalog()).list({ workspaceId, limit, cursor });
      return sendJson(res, 200, {
        sources: page.items,
        nextCursor: page.nextCursor ?? null,
        workspaceId,
      });
    } catch (error) {
      if (/cursor/i.test(error instanceof Error ? error.message : String(error))) {
        throw new NoteAccessError('Invalid or expired source cursor.', 400);
      }
      throw error;
    }
  }

  const sourceMatch = pathname.match(/^\/api\/sources\/([^/]+)$/);
  if (sourceMatch && (method === 'GET' || method === 'DELETE')) {
    const id = validSourceId(sourceMatch[1]);
    // A missing retention setting must fail closed for reads, but must never
    // prevent an operator from erasing an existing source.
    const catalog = method === 'GET' ? await getRetainedSourceCatalog() : getSourceCatalog();
    const source = await catalog.get(id);
    if (!source || sourceWorkspace(source) !== workspaceId) {
      throw new NoteAccessError('Source not found.', 404);
    }
    if (method === 'DELETE') {
      const discarded = await catalog.discard(id, 'user_requested');
      return sendJson(res, 200, { source: discarded, workspaceId, discarded: true });
    }
    return sendJson(res, 200, { source, workspaceId });
  }

  if (method === 'GET' && (pathname === '/api/library' || pathname === '/api/notes')) {
    const map = await withKnowledgeRead(() => buildPalaceMap(workspaceId));
    return sendJson(res, 200, map);
  }

  if (method === 'GET' && pathname === '/api/records') {
    const map = await withKnowledgeRead(() => buildPalaceMap(workspaceId));
    return sendJson(res, 200, { records: map.records, workspaceId });
  }

  if (method === 'GET' && pathname === '/api/topics') {
    const map = await withKnowledgeRead(() => buildPalaceMap(workspaceId));
    return sendJson(res, 200, { topics: map.topics, workspaceId });
  }

  if (method === 'GET' && pathname.startsWith('/api/notes/')) {
    const relative = decodeURIComponent(pathname.slice('/api/notes/'.length));
    const note = await readWorkspaceNote(relative, workspaceId);
    return sendJson(res, 200, { ...note, html: renderMarkdown(note.markdown) });
  }

  if (method === 'GET' && pathname === '/api/search') {
    const query = (url.searchParams.get('q') || '').trim();
    if (!query) return sendJson(res, 200, { hits: [] });
    try {
      const hits = await search(query, 8, { workspaceId });
      return sendJson(res, 200, { hits });
    } catch (error) {
      if (isMissingIndex(error)) {
        return sendJson(res, 503, { error: 'index_missing', message: errorMessage(error, 'Search index is missing.') });
      }
      throw error;
    }
  }

  if (method === 'POST' && pathname === '/api/recall') {
    const body = await readBody(req);
    const question = String(body.question || '').trim();
    if (!question) return sendJson(res, 400, { error: 'empty_question', message: 'Enter a question.' });
    try {
      const result = await recall(question, 8, { workspaceId });
      return sendJson(res, 200, normaliseRecallResult(result));
    } catch (error) {
      if (isMissingIndex(error)) {
        return sendJson(res, 503, { error: 'index_missing', message: errorMessage(error, 'Search index is missing.') });
      }
      throw error;
    }
  }

  return sendJson(res, 404, { error: 'not_found', message: 'That Chronicle route does not exist.' });
}

export function createChronicleWebServer() {
  validateWebBinding();
  const server = createServer((req, res) => {
    applySecurityHeaders(res);
    handle(req, res).catch((error) => {
      if (res.headersSent) return res.end();
      const status = errorStatus(error);
      sendJson(res, status, {
        error: status === 409
          ? 'revision_conflict'
          : status === 404
            ? 'not_found'
            : status === 428
              ? 'precondition_required'
              : 'request_failed',
        message: errorMessage(error, 'Chronicle could not complete the request.'),
      });
    });
  });
  if (
    process.env.SOURCE_ENCRYPTION_KEY?.trim() &&
    process.env.INBOX_RETENTION_DAYS?.trim()
  ) {
    let sweeping = false;
    const sweep = async () => {
      if (sweeping) return;
      sweeping = true;
      try {
        await getRetainedSourceCatalog();
      } catch {
        console.error('Encrypted source retention sweep failed.');
      } finally {
        sweeping = false;
      }
    };
    const retentionTimer = setInterval(() => void sweep(), SOURCE_RETENTION_SWEEP_MS);
    retentionTimer.unref();
    server.once('close', () => clearInterval(retentionTimer));
    void sweep();
  }
  return server;
}

export async function startChronicleWebServer() {
  await recoverApprovalTransactions();
  // A standalone review server must close interrupted discard transactions
  // before it can accept an approval. Otherwise a legacy session-first crash
  // leaves a needs_review draft briefly approvable while the bot is offline.
  await reconcileDiscardedSessions(config.sessionsDir);
  const server = createChronicleWebServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => {
      server.off('error', reject);
      console.log(`Chronicle web UI on http://${HOST}:${PORT}`);
      resolve();
    });
  });
  return server;
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entrypoint && fileURLToPath(import.meta.url) === entrypoint) {
  startChronicleWebServer().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
