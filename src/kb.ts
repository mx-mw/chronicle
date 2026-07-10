import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import {
  atomicWriteFile,
  atomicWriteJson,
  atomicRemoveFile,
  collisionSafeBasename,
  ensurePrivateDirectory,
  readJsonFile,
  sha256,
  stableUuid,
  unicodeSlug,
  withFileLock,
  yamlFrontmatter,
} from './fs-safe.js';
import { appendLedgerEvent } from './ledger.js';
import type { MeetingSummary, SourceSummary } from './summarize.js';
import type { SourceKind } from './sources/index.js';

export const DEFAULT_WORKSPACE_ID = 'default';
const DRAFT_SCHEMA_VERSION = 2;

export type ReviewStatus = 'needs_review' | 'approved' | 'rejected';

export interface SourceMeta {
  date: string;
  kind: SourceKind;
  /** URL, file path, or "discord:<channel>" — where the source came from. */
  origin: string;
  /** Speakers (meeting) or author(s) (article/pdf). */
  attribution?: string[];
  durationMinutes?: number;
  /** Stable capture/session/source-event identity when the adapter has one. */
  sourceEventId?: string;
}

export interface RawCapture {
  id: string;
  workspaceId: string;
  contentHash: string;
  path: string;
  relativePath: string;
  createdAt: string;
  warnings: string[];
  operationId?: string;
}

export interface WrittenMeeting {
  meetingPath: string;
  transcriptPath: string;
  topicPaths: string[];
}

export interface ApprovalResult extends WrittenMeeting {
  id: string;
  workspaceId: string;
  contentHash: string;
  revision: number;
  status: 'approved';
}

export interface ReviewDraft {
  schemaVersion: 2;
  id: string;
  workspaceId: string;
  contentHash: string;
  revision: number;
  status: ReviewStatus;
  createdAt: string;
  updatedAt: string;
  summary: SourceSummary;
  meta: SourceMeta;
  rawCapture: RawCapture;
  warnings: string[];
  operationId?: string;
  rejectionReason?: string;
  approval?: ApprovalResult;
}

export type ReviewDraftSummary = Pick<
  ReviewDraft,
  | 'id'
  | 'workspaceId'
  | 'contentHash'
  | 'revision'
  | 'status'
  | 'createdAt'
  | 'updatedAt'
  | 'warnings'
> & { title: string; date: string; kind: SourceKind };

export interface DraftOptions {
  workspaceId?: string;
  warnings?: string[];
  rawCapture?: RawCapture;
  /** Session/operation fence used by discard and as stable event provenance. */
  operationId?: string;
}

export interface DraftLookupOptions {
  workspaceId?: string;
  expectedRevision?: number;
}

export interface DraftPatch {
  summary?: Partial<SourceSummary>;
  meta?: Partial<SourceMeta>;
  warnings?: string[];
}

export interface ListDraftOptions {
  workspaceId?: string;
  status?: ReviewStatus | ReviewStatus[];
}

export interface RejectOptions extends DraftLookupOptions {
  reason?: string;
}

export interface ApprovalMutationContext {
  index: number;
  kind: 'index_state' | 'record' | 'topic' | 'draft';
  path: string;
}

export interface ApproveDraftOptions extends DraftLookupOptions {
  /** Integration-test failpoint. It runs under the write lock before each atomic rename. */
  beforeMutation?: (context: ApprovalMutationContext) => void | Promise<void>;
}

export interface ApprovalRecoveryResult {
  journalsFound: number;
  rolledBack: number;
  finalized: number;
}

export class DraftNotFoundError extends Error {
  readonly status = 404;
  readonly code = 'draft_not_found';

  constructor(id: string, workspaceId: string) {
    super(`No Chronicle draft ${id} in workspace ${workspaceId}`);
    this.name = 'DraftNotFoundError';
  }
}

export class DraftRevisionConflictError extends Error {
  readonly status = 409;
  readonly code = 'draft_revision_conflict';

  constructor(id: string, expected: number, actual: number) {
    super(`Draft ${id} changed (expected revision ${expected}, found ${actual})`);
    this.name = 'DraftRevisionConflictError';
  }
}

export class DraftStateConflictError extends Error {
  readonly status = 409;
  readonly code = 'draft_state_conflict';

  constructor(id: string, status: ReviewStatus) {
    super(`Draft ${id} is ${status} and cannot be edited`);
    this.name = 'DraftStateConflictError';
  }
}

export class OperationTombstonedError extends Error {
  readonly status = 409;
  readonly code = 'operation_tombstoned';

  constructor(operationId: string, workspaceId: string) {
    super(`Operation ${operationId} was discarded in workspace ${workspaceId}`);
    this.name = 'OperationTombstonedError';
  }
}

export interface OperationTombstone {
  schemaVersion: 1;
  operationId: string;
  workspaceId: string;
  reason?: string;
  createdAt: string;
}

export type TombstoneOperationResult =
  | { outcome: 'tombstoned'; tombstone: OperationTombstone }
  | { outcome: 'already_approved'; recordId: string; revision: number; approvedAt: string };

export interface TopicCatalogEntry {
  slug: string;
  title: string;
  description: string;
  file: string;
  workspaceId: string;
}

export function normalizeWorkspaceId(value?: string): string {
  const workspaceId = (value ?? config.workspaceId).normalize('NFKC').trim();
  if (!workspaceId || workspaceId.length > 200 || /[\0-\x1f\x7f]/.test(workspaceId)) {
    throw new Error('workspaceId must be 1-200 printable characters');
  }
  return workspaceId;
}

export function workspaceStorageKey(workspaceId: string): string {
  const normalized = normalizeWorkspaceId(workspaceId);
  return collisionSafeBasename(normalized, normalized, 80);
}

export function workspaceRoot(workspaceId = DEFAULT_WORKSPACE_ID): string {
  const normalized = normalizeWorkspaceId(workspaceId);
  return normalized === DEFAULT_WORKSPACE_ID
    ? config.kbDir
    : path.join(config.kbDir, 'workspaces', workspaceStorageKey(normalized));
}

function reviewRoot(workspaceId: string): string {
  return path.join(config.kbDir, '.chronicle', 'inbox', workspaceStorageKey(workspaceId));
}

function draftFile(id: string, workspaceId: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`Invalid Chronicle record id: ${id}`);
  return path.join(reviewRoot(workspaceId), `${id}.json`);
}

function kbLock(): string {
  return path.join(config.kbDir, '.chronicle', 'write.lock');
}

async function ensureChroniclePrivateDirectory(directory = path.join(config.kbDir, '.chronicle')): Promise<void> {
  await ensurePrivateDirectory(path.join(config.kbDir, '.chronicle'));
  if (directory !== path.join(config.kbDir, '.chronicle')) await ensurePrivateDirectory(directory);
}

interface ApprovalJournalMutation {
  kind: ApprovalMutationContext['kind'];
  relativePath: string;
  existed: boolean;
  previousContent?: string;
}

interface ApprovalJournal {
  schemaVersion: 1;
  transactionId: string;
  recordId: string;
  workspaceId: string;
  targetRevision: number;
  state: 'prepared' | 'committed';
  createdAt: string;
  mutations: ApprovalJournalMutation[];
}

function approvalJournalDirectory(): string {
  return path.join(config.kbDir, '.chronicle', 'approval-transactions');
}

function approvalJournalFile(transactionId: string): string {
  return path.join(approvalJournalDirectory(), `${transactionId}.json`);
}

function operationTombstoneFile(operationId: string, workspaceId: string): string {
  return path.join(
    config.kbDir,
    '.chronicle',
    'tombstones',
    workspaceStorageKey(workspaceId),
    `${sha256(operationId).slice(0, 32)}.json`,
  );
}

async function readOperationTombstoneUnlocked(
  operationId: string,
  workspaceId: string,
): Promise<OperationTombstone | undefined> {
  return readJsonFile<OperationTombstone>(operationTombstoneFile(operationId, workspaceId)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );
}

/** Read-only startup/recovery probe for the durable discard fence. */
export async function readOperationTombstone(
  operationId: string,
  options: { workspaceId?: string } = {},
): Promise<OperationTombstone | undefined> {
  const normalizedOperationId = operationId.normalize('NFKC').trim();
  if (!normalizedOperationId || normalizedOperationId.length > 300) {
    throw new Error('operationId must be 1-300 characters');
  }
  const workspaceId = normalizeWorkspaceId(options.workspaceId);
  return withKnowledgeReadLock(() =>
    readOperationTombstoneUnlocked(normalizedOperationId, workspaceId),
  );
}

/** Durable discard fence. Stage/approval check it while holding the same write lock. */
export async function tombstoneOperation(
  operationId: string,
  options: { workspaceId?: string; reason?: string } = {},
): Promise<TombstoneOperationResult> {
  const normalizedOperationId = operationId.normalize('NFKC').trim();
  if (!normalizedOperationId || normalizedOperationId.length > 300) {
    throw new Error('operationId must be 1-300 characters');
  }
  const workspaceId = normalizeWorkspaceId(options.workspaceId);
  return withKnowledgeWriteLock(async () => {
    const existing = await readOperationTombstoneUnlocked(normalizedOperationId, workspaceId);
    if (existing) return { outcome: 'tombstoned', tombstone: existing };
    const drafts = await Promise.all(
      (await draftFiles({ workspaceId })).map((file) =>
        readJsonFile<ReviewDraft>(file).then(normalizeLoadedDraft),
      ),
    );
    const approved = drafts.find(
      (draft) => draft.operationId === normalizedOperationId && draft.status === 'approved',
    );
    if (approved) {
      return {
        outcome: 'already_approved',
        recordId: approved.id,
        revision: approved.revision,
        approvedAt: approved.updatedAt,
      };
    }
    const tombstone: OperationTombstone = {
      schemaVersion: 1,
      operationId: normalizedOperationId,
      workspaceId,
      reason: options.reason?.trim() || undefined,
      createdAt: new Date().toISOString(),
    };
    const file = operationTombstoneFile(normalizedOperationId, workspaceId);
    await ensureChroniclePrivateDirectory(path.dirname(file));
    await atomicWriteJson(file, tombstone);
    return { outcome: 'tombstoned', tombstone };
  });
}

function kbRelativePath(absolutePath: string): string {
  const root = path.resolve(config.kbDir);
  const target = path.resolve(absolutePath);
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Approval mutation escapes the knowledge base: ${absolutePath}`);
  }
  return relative.split(path.sep).join('/');
}

function resolveJournalTarget(relativePath: string): string {
  if (!relativePath || relativePath.includes('\0') || path.isAbsolute(relativePath)) {
    throw new Error(`Invalid approval journal path: ${relativePath}`);
  }
  const root = path.resolve(config.kbDir);
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Approval journal path escapes the knowledge base: ${relativePath}`);
  }
  return target;
}

async function rollbackApprovalJournalUnlocked(journal: ApprovalJournal): Promise<void> {
  const failures: unknown[] = [];
  for (const mutation of [...journal.mutations].reverse()) {
    const target = resolveJournalTarget(mutation.relativePath);
    try {
      if (mutation.existed) {
        if (typeof mutation.previousContent !== 'string') {
          throw new Error(`Approval journal lacks a snapshot for ${mutation.relativePath}`);
        }
        await atomicWriteFile(target, mutation.previousContent);
      } else {
        await atomicRemoveFile(target);
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    throw new AggregateError(failures, `Could not fully roll back approval ${journal.transactionId}`);
  }
}

async function journalReachedCommitPoint(journal: ApprovalJournal): Promise<boolean> {
  const draftMutation = journal.mutations.find((mutation) => mutation.kind === 'draft');
  if (!draftMutation) throw new Error(`Approval journal ${journal.transactionId} has no draft mutation`);
  const current = await readJsonFile<ReviewDraft>(resolveJournalTarget(draftMutation.relativePath)).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return undefined;
      throw error;
    },
  );
  return Boolean(
    current?.status === 'approved' &&
      current.id === journal.recordId &&
      current.workspaceId === journal.workspaceId &&
      current.revision === journal.targetRevision,
  );
}

async function recoverApprovalTransactionsUnlocked(): Promise<ApprovalRecoveryResult> {
  const result: ApprovalRecoveryResult = { journalsFound: 0, rolledBack: 0, finalized: 0 };
  const names = await readdir(approvalJournalDirectory()).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    result.journalsFound += 1;
    const file = path.join(approvalJournalDirectory(), name);
    const journal = await readJsonFile<ApprovalJournal>(file);
    if (journal.schemaVersion !== 1 || !journal.transactionId || !Array.isArray(journal.mutations)) {
      throw new Error(`Invalid approval recovery journal: ${file}`);
    }
    if (journal.state === 'committed' || (await journalReachedCommitPoint(journal))) {
      await atomicRemoveFile(file);
      result.finalized += 1;
      continue;
    }
    await rollbackApprovalJournalUnlocked(journal);
    await atomicRemoveFile(file);
    result.rolledBack += 1;
  }
  return result;
}

/** Recover interrupted approvals before the process begins serving filesystem readers. */
export async function recoverApprovalTransactions(): Promise<ApprovalRecoveryResult> {
  await ensureChroniclePrivateDirectory();
  return withFileLock(kbLock(), recoverApprovalTransactionsUnlocked);
}

/** Serialize a knowledge read against approval commits and run crash recovery first. */
export async function withKnowledgeReadLock<T>(operation: () => Promise<T>): Promise<T> {
  await ensureChroniclePrivateDirectory();
  return withFileLock(kbLock(), async () => {
    await recoverApprovalTransactionsUnlocked();
    return operation();
  });
}

async function withKnowledgeWriteLock<T>(operation: () => Promise<T>): Promise<T> {
  await ensureChroniclePrivateDirectory();
  return withFileLock(kbLock(), async () => {
    await recoverApprovalTransactionsUnlocked();
    return operation();
  });
}

async function ensureWorkspaceDirs(workspaceId: string): Promise<void> {
  const root = workspaceRoot(workspaceId);
  await ensurePrivateDirectory(root);
  for (const sub of ['meetings', 'topics', 'transcripts']) {
    await ensurePrivateDirectory(path.join(root, sub));
  }
  await ensureChroniclePrivateDirectory(reviewRoot(workspaceId));
}

/** Kept for call sites and legacy filenames; new records add an identity suffix. */
export function slugify(text: string): string {
  return unicodeSlug(text, 60);
}

function uniqueStrings(values: string[] | undefined): string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}

function sourceIdentity(rawText: string): string {
  return sha256(rawText);
}

function recordIdentity(
  workspaceId: string,
  contentHash: string,
  meta: SourceMeta,
  operationId?: string,
): string {
  const explicitEventIdentity =
    operationId?.normalize('NFKC').trim() || meta.sourceEventId?.normalize('NFKC').trim();
  const identity = explicitEventIdentity
    ? `event\0${explicitEventIdentity}`
    : `fallback\0${meta.kind}\0${meta.origin.normalize('NFC')}\0${meta.date}\0${contentHash}`;
  return stableUuid(`chronicle-record:${workspaceId}`, sha256(identity));
}

function safeDate(date: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : unicodeSlug(date, 20);
}

function parseFrontmatterValue(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

export function readFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = parseFrontmatterValue(line.slice(separator + 1));
    if (value !== undefined) result[key] = value;
  }
  return result;
}

function metaLine(meta: SourceMeta): string {
  if (meta.kind === 'meeting') {
    return (
      `**Date:** ${meta.date} - **Duration:** ~${meta.durationMinutes ?? '?'} min - ` +
      `**Participants:** ${(meta.attribution ?? []).join(', ') || 'unknown'}`
    );
  }
  const parts = [`**Date:** ${meta.date}`];
  if (meta.attribution?.length) parts.push(`**By:** ${meta.attribution.join(', ')}`);
  if (meta.durationMinutes) parts.push(`**Duration:** ~${meta.durationMinutes} min`);
  parts.push(`**Source:** ${meta.origin}`);
  return parts.join(' - ');
}

/** Existing approved topics, suitable for supplying to summarizeSource. */
export async function listTopicCatalog(options: {
  workspaceId?: string;
} = {}): Promise<TopicCatalogEntry[]> {
  return withKnowledgeReadLock(async () => {
    const workspaceId = normalizeWorkspaceId(options.workspaceId);
    const root = workspaceRoot(workspaceId);
    const directory = path.join(root, 'topics');
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const relativeRoot = path.relative(config.kbDir, root).split(path.sep).join('/');
    const entries = await Promise.all(
      names
        .filter((name) => name.endsWith('.md'))
        .map(async (name): Promise<TopicCatalogEntry> => {
          const content = await readFile(path.join(directory, name), 'utf8');
          const fields = readFrontmatter(content);
          const fallback = path.basename(name, '.md');
          return {
            slug: fields.topic_key ?? fields.name ?? fallback,
            title: content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? fields.name ?? fallback,
            description: fields.description ?? '',
            file: path.posix.join(relativeRoot, 'topics', name).replace(/^\//, ''),
            workspaceId,
          };
        }),
    );
    return entries.sort((left, right) => left.title.localeCompare(right.title));
  });
}

function rawMarkdown(capture: Omit<RawCapture, 'path' | 'relativePath'>, meta: SourceMeta, raw: string): string {
  return (
    yamlFrontmatter({
      name: capture.id,
      description: `Raw ${meta.kind} capture from ${meta.origin}`,
      type: 'transcript',
      chronicle_id: capture.id,
      workspace: capture.workspaceId,
      content_hash: capture.contentHash,
      status: 'captured',
      date: meta.date,
      source_kind: meta.kind,
      origin: meta.origin,
      attribution: meta.attribution ?? [],
      duration_minutes: meta.durationMinutes,
      created_at: capture.createdAt,
      operation_id: capture.operationId,
    }) +
    `# Raw source capture\n\n` +
    `${raw.endsWith('\n') ? raw : `${raw}\n`}`
  );
}

/**
 * Durable first step for pipelines: persist the exact capture before any model
 * is called. Repeating the same capture in a workspace returns the same UUID/path.
 */
export async function persistRawCapture(input: {
  rawText: string;
  meta: SourceMeta;
  workspaceId?: string;
  warnings?: string[];
  operationId?: string;
}): Promise<RawCapture> {
  const workspaceId = normalizeWorkspaceId(input.workspaceId);
  const contentHash = sourceIdentity(input.rawText);
  const operationId = input.operationId?.normalize('NFKC').trim() || input.meta.sourceEventId?.trim();
  const id = recordIdentity(workspaceId, contentHash, input.meta, operationId);
  const root = workspaceRoot(workspaceId);
  const basename = id;
  const relativePath = `transcripts/${basename}.md`;
  const absolutePath = path.join(root, relativePath);
  let capture!: RawCapture;

  await withKnowledgeWriteLock(async () => {
    // Discard and raw persistence share this lock. Once the operation fence is
    // durable, a late or non-cooperative worker must not create a transcript
    // and only discover the discard at draft staging time.
    if (operationId && (await readOperationTombstoneUnlocked(operationId, workspaceId))) {
      throw new OperationTombstonedError(operationId, workspaceId);
    }
    await ensureWorkspaceDirs(workspaceId);
    const existing = await readFile(absolutePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing !== undefined) {
      const fields = readFrontmatter(existing);
      if (fields.content_hash && fields.content_hash !== contentHash) {
        throw new Error(`Raw capture identity collision at ${absolutePath}`);
      }
      capture = {
        id,
        workspaceId,
        contentHash,
        path: absolutePath,
        relativePath,
        createdAt: fields.created_at ?? new Date().toISOString(),
        warnings: uniqueStrings(input.warnings),
        operationId: fields.operation_id ?? operationId,
      };
      return;
    }

    capture = {
      id,
      workspaceId,
      contentHash,
      path: absolutePath,
      relativePath,
      createdAt: new Date().toISOString(),
      warnings: uniqueStrings(input.warnings),
      operationId,
    };
    await atomicWriteFile(absolutePath, rawMarkdown(capture, input.meta, input.rawText));
  });

  await appendLedgerEvent(config.kbDir, {
    type: 'raw.persisted',
    recordId: id,
    workspaceId,
    contentHash,
    revision: 0,
    at: capture.createdAt,
    details: {
      relativePath,
      sourceKind: input.meta.kind,
      origin: input.meta.origin,
      warnings: capture.warnings,
      stage: 'captured',
      operationId,
    },
  });
  return capture;
}

function validateSummary(summary: SourceSummary): SourceSummary {
  if (!summary?.title?.trim() || !summary.slug?.trim() || !Array.isArray(summary.facts)) {
    throw new Error('Draft summary is missing title, slug, or facts');
  }
  return {
    title: summary.title.trim(),
    slug: summary.slug.trim(),
    summary: (summary.summary ?? '').trim(),
    decisions: uniqueStrings(summary.decisions),
    action_items: (summary.action_items ?? [])
      .filter((item) => item?.owner?.trim() && item?.task?.trim())
      .map((item) => ({ owner: item.owner.trim(), task: item.task.trim() })),
    open_questions: uniqueStrings(summary.open_questions),
    facts: (summary.facts ?? [])
      .filter((fact) => fact?.topic?.trim() && fact?.fact?.trim())
      .map((fact) => ({
        topic: fact.topic.trim(),
        topic_title: (fact.topic_title || fact.topic).trim(),
        topic_description: (fact.topic_description || fact.topic_title || fact.topic).trim(),
        fact: fact.fact.trim(),
      })),
  };
}

export async function stageSourceDraft(
  summary: SourceSummary,
  rawText: string,
  meta: SourceMeta,
  options: DraftOptions = {},
): Promise<ReviewDraft> {
  const workspaceId = normalizeWorkspaceId(options.workspaceId ?? options.rawCapture?.workspaceId);
  const rawCapture =
    options.rawCapture ??
    (await persistRawCapture({
      rawText,
      meta,
      workspaceId,
      warnings: options.warnings,
      operationId: options.operationId,
    }));
  if (rawCapture.workspaceId !== workspaceId || rawCapture.contentHash !== sourceIdentity(rawText)) {
    throw new Error('The supplied raw capture does not match this workspace/source');
  }
  const file = draftFile(rawCapture.id, workspaceId);
  let draft!: ReviewDraft;

  await withKnowledgeWriteLock(async () => {
    const operationId = options.operationId ?? rawCapture.operationId ?? meta.sourceEventId;
    if (operationId && (await readOperationTombstoneUnlocked(operationId, workspaceId))) {
      throw new OperationTombstonedError(operationId, workspaceId);
    }
    await ensureWorkspaceDirs(workspaceId);
    const existing = await readJsonFile<ReviewDraft>(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (existing) {
      draft = normalizeLoadedDraft(existing);
      return;
    }
    const now = new Date().toISOString();
    draft = {
      schemaVersion: DRAFT_SCHEMA_VERSION,
      id: rawCapture.id,
      workspaceId,
      contentHash: rawCapture.contentHash,
      revision: 1,
      status: 'needs_review',
      createdAt: now,
      updatedAt: now,
      summary: validateSummary(summary),
      meta: { ...meta, attribution: uniqueStrings(meta.attribution) },
      rawCapture,
      warnings: uniqueStrings([...(rawCapture.warnings ?? []), ...(options.warnings ?? [])]),
      operationId,
    };
    await atomicWriteJson(file, draft);
  });

  await appendLedgerEvent(config.kbDir, {
    type: 'draft.staged',
    recordId: draft.id,
    workspaceId,
    contentHash: draft.contentHash,
    revision: draft.revision,
    details: {
      status: draft.status,
      sourceKind: draft.meta.kind,
      origin: draft.meta.origin,
      warnings: draft.warnings,
    },
  });
  return draft;
}

async function draftFiles(options: ListDraftOptions): Promise<string[]> {
  const root = reviewRoot(normalizeWorkspaceId(options.workspaceId));
  return (await readdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  }))
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(root, name));
}

async function listDraftsUnlocked(options: ListDraftOptions): Promise<ReviewDraftSummary[]> {
  const statuses = options.status
    ? new Set(Array.isArray(options.status) ? options.status : [options.status])
    : undefined;
  const drafts = await Promise.all(
    (await draftFiles(options)).map(async (file) => normalizeLoadedDraft(await readJsonFile<ReviewDraft>(file))),
  );
  return drafts
    .filter((draft) => !statuses || statuses.has(draft.status))
    .map((draft) => ({
      id: draft.id,
      workspaceId: draft.workspaceId,
      contentHash: draft.contentHash,
      revision: draft.revision,
      status: draft.status,
      createdAt: draft.createdAt,
      updatedAt: draft.updatedAt,
      warnings: draft.warnings,
      title: draft.summary.title,
      date: draft.meta.date,
      kind: draft.meta.kind,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function listDrafts(options: ListDraftOptions = {}): Promise<ReviewDraftSummary[]> {
  return withKnowledgeReadLock(() => listDraftsUnlocked(options));
}

async function readDraftUnlocked(
  id: string,
  options: Pick<DraftLookupOptions, 'workspaceId'> = {},
): Promise<ReviewDraft> {
  const workspaceId = normalizeWorkspaceId(options.workspaceId);
  return readJsonFile<ReviewDraft>(draftFile(id, workspaceId)).then(normalizeLoadedDraft).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        throw new DraftNotFoundError(id, workspaceId);
      }
      throw error;
    },
  );
}

export async function readDraft(
  id: string,
  options: Pick<DraftLookupOptions, 'workspaceId'> = {},
): Promise<ReviewDraft> {
  return withKnowledgeReadLock(() => readDraftUnlocked(id, options));
}

/** Read-only migration for v2 previews that used the temporary state name "draft". */
function normalizeLoadedDraft(draft: ReviewDraft): ReviewDraft {
  if ((draft.status as string) === 'draft') {
    return { ...draft, status: 'needs_review' };
  }
  return draft;
}

function assertMutable(draft: ReviewDraft, expectedRevision?: number): void {
  if (expectedRevision !== undefined && draft.revision !== expectedRevision) {
    throw new DraftRevisionConflictError(draft.id, expectedRevision, draft.revision);
  }
  if (draft.status !== 'needs_review') {
    throw new DraftStateConflictError(draft.id, draft.status);
  }
}

export async function updateDraft(
  id: string,
  patch: DraftPatch,
  options: DraftLookupOptions = {},
): Promise<ReviewDraft> {
  const workspaceId = normalizeWorkspaceId(options.workspaceId);
  let updated!: ReviewDraft;
  await withKnowledgeWriteLock(async () => {
    const current = await readDraftUnlocked(id, { workspaceId });
    assertMutable(current, options.expectedRevision);
    updated = {
      ...current,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
      summary: validateSummary({ ...current.summary, ...patch.summary }),
      meta: {
        ...current.meta,
        ...patch.meta,
        attribution: uniqueStrings(patch.meta?.attribution ?? current.meta.attribution),
      },
      warnings: patch.warnings ? uniqueStrings(patch.warnings) : current.warnings,
    };
    await atomicWriteJson(draftFile(id, workspaceId), updated);
  });
  await appendLedgerEvent(config.kbDir, {
    type: 'draft.updated',
    recordId: id,
    workspaceId,
    contentHash: updated.contentHash,
    revision: updated.revision,
    details: { status: updated.status, warnings: updated.warnings },
  });
  return updated;
}

function normalizeKey(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
}

function normalizeFact(value: string): string {
  return normalizeKey(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function existingFacts(content: string): Set<string> {
  return new Set(
    content
      .split(/\r?\n/)
      .filter((line) => line.trimStart().startsWith('- '))
      .map((line) => line.trimStart().slice(2).split(/\s+(?:—|-)\s+\[\[/)[0])
      .map((line) => line.replace(/\s*<!--\s*chronicle-fact:[^>]+-->\s*$/, ''))
      .map(normalizeFact),
  );
}

async function findTopicPath(root: string, topicKey: string, title: string): Promise<string> {
  const directory = path.join(root, 'topics');
  const legacy = path.join(directory, `${slugify(topicKey)}.md`);
  if (existsSync(legacy)) {
    const content = await readFile(legacy, 'utf8');
    const fields = readFrontmatter(content);
    const existingKey = fields.topic_key ?? fields.name ?? path.basename(legacy, '.md');
    if (normalizeKey(existingKey) === normalizeKey(topicKey)) return legacy;
  }
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.md')) continue;
    const file = path.join(directory, name);
    const fields = readFrontmatter(await readFile(file, 'utf8'));
    if (fields.topic_key && normalizeKey(fields.topic_key) === normalizeKey(topicKey)) return file;
  }
  return path.join(
    directory,
    `${collisionSafeBasename(title || topicKey, `topic:${normalizeKey(topicKey)}`)}.md`,
  );
}

function renderApprovedNote(
  draft: ReviewDraft,
  noteName: string,
  topics: { path: string; name: string }[],
): string {
  const { summary, meta } = draft;
  let note =
    yamlFrontmatter({
      name: noteName,
      description: summary.title,
      type: meta.kind,
      chronicle_id: draft.id,
      workspace: draft.workspaceId,
      content_hash: draft.contentHash,
      revision: draft.revision + 1,
      status: 'approved',
      date: meta.date,
      origin: meta.origin,
      attribution: meta.attribution ?? [],
      duration_minutes: meta.durationMinutes,
    }) +
    `# ${summary.title}\n\n${metaLine(meta)}\n\n${summary.summary}\n`;
  if (summary.decisions.length) {
    note += `\n## Decisions\n${summary.decisions.map((decision) => `- ${decision}`).join('\n')}\n`;
  }
  if (summary.action_items.length) {
    note += `\n## Action items\n${summary.action_items
      .map((item) => `- [ ] **${item.owner}**: ${item.task}`)
      .join('\n')}\n`;
  }
  if (summary.open_questions.length) {
    note += `\n## Open questions\n${summary.open_questions.map((question) => `- ${question}`).join('\n')}\n`;
  }
  note += `\n## Topics touched\n${topics.map((topic) => `- [[topics/${topic.name}]]`).join('\n') || '_none_'}\n`;
  const rawName = path.basename(draft.rawCapture.relativePath, '.md');
  note += `\n## Provenance\n- [[transcripts/${rawName}]]\n`;
  return note;
}

interface PlannedApprovalMutation {
  kind: ApprovalMutationContext['kind'];
  path: string;
  content: string;
}

interface ApprovalPlan {
  result: ApprovalResult;
  approvedDraft: ReviewDraft;
  mutations: PlannedApprovalMutation[];
}

interface SearchIndexState {
  schemaVersion: 1;
  generation: number;
  indexedGeneration: number;
  stale: boolean;
  updatedAt: string;
  lastSuccessAt?: string;
  lastError?: string | null;
  pendingRecordId?: string;
}

function searchIndexStateFile(): string {
  return path.join(config.kbDir, '.chronicle', 'index-state.json');
}

async function staleIndexStateContent(recordId: string): Promise<string> {
  const current = await readJsonFile<SearchIndexState>(searchIndexStateFile()).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    },
  );
  const next: SearchIndexState = {
    schemaVersion: 1,
    generation: (current?.generation ?? 0) + 1,
    indexedGeneration: current?.indexedGeneration ?? 0,
    stale: true,
    updatedAt: new Date().toISOString(),
    lastSuccessAt: current?.lastSuccessAt,
    lastError: null,
    pendingRecordId: recordId,
  };
  return `${JSON.stringify(next, null, 2)}\n`;
}

async function planApprovalUnlocked(draft: ReviewDraft): Promise<ApprovalPlan> {
  const root = workspaceRoot(draft.workspaceId);
  await ensureWorkspaceDirs(draft.workspaceId);
  const noteName = `${safeDate(draft.meta.date)}-${unicodeSlug(
    draft.summary.slug || draft.summary.title,
    60,
  )}-${draft.id.replaceAll('-', '').slice(0, 12)}`;
  const meetingPath = path.join(root, 'meetings', `${noteName}.md`);
  const grouped = new Map<
    string,
    { title: string; description: string; facts: { text: string; hash: string }[] }
  >();
  for (const fact of draft.summary.facts) {
    const key = normalizeKey(fact.topic);
    const entry = grouped.get(key) ?? {
      title: fact.topic_title,
      description: fact.topic_description,
      facts: [],
    };
    const hash = sha256(`${key}\0${normalizeFact(fact.fact)}`);
    if (!entry.facts.some((item) => item.hash === hash)) entry.facts.push({ text: fact.fact, hash });
    grouped.set(key, entry);
  }

  const topicTargets = new Map<string, { path: string; name: string }>();
  for (const [topicKey, entry] of grouped) {
    const topicPath = await findTopicPath(root, topicKey, entry.title);
    topicTargets.set(topicKey, { path: topicPath, name: path.basename(topicPath, '.md') });
  }
  const result: ApprovalResult = {
    id: draft.id,
    workspaceId: draft.workspaceId,
    contentHash: draft.contentHash,
    revision: draft.revision + 1,
    status: 'approved',
    meetingPath,
    transcriptPath: draft.rawCapture.path,
    topicPaths: [...topicTargets.values()].map((target) => target.path),
  };
  const mutations: PlannedApprovalMutation[] = [
    {
      kind: 'index_state',
      path: searchIndexStateFile(),
      content: await staleIndexStateContent(draft.id),
    },
    {
      kind: 'record',
      path: meetingPath,
      content: renderApprovedNote(draft, noteName, [...topicTargets.values()]),
    },
  ];
  const topicPaths: string[] = [];
  for (const [topicKey, entry] of grouped) {
    const target = topicTargets.get(topicKey)!;
    const existing = await readFile(target.path, 'utf8').catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    let content =
      existing ??
      (yamlFrontmatter({
        name: path.basename(target.path, '.md'),
        description: entry.description || entry.title,
        type: 'topic',
        workspace: draft.workspaceId,
        topic_key: topicKey,
      }) + `# ${entry.title}\n\n${entry.description}\n\n## Log\n`);
    if (!content.endsWith('\n')) content += '\n';
    const known = existingFacts(content);
    for (const fact of entry.facts) {
      if (known.has(normalizeFact(fact.text))) continue;
      content += `- ${fact.text} - [[meetings/${noteName}]] (${draft.meta.date}) <!-- chronicle-fact:${fact.hash} -->\n`;
      known.add(normalizeFact(fact.text));
    }
    mutations.push({ kind: 'topic', path: target.path, content });
    topicPaths.push(target.path);
  }
  result.topicPaths = topicPaths;
  const approvedDraft: ReviewDraft = {
    ...draft,
    revision: result.revision,
    status: 'approved',
    updatedAt: new Date().toISOString(),
    approval: result,
  };
  mutations.push({
    kind: 'draft',
    path: draftFile(draft.id, draft.workspaceId),
    content: `${JSON.stringify(approvedDraft, null, 2)}\n`,
  });
  return { result, approvedDraft, mutations };
}

async function applyApprovalPlanUnlocked(
  plan: ApprovalPlan,
  options: ApproveDraftOptions,
): Promise<void> {
  const transactionId = stableUuid(
    'chronicle-approval-transaction',
    `${plan.result.workspaceId}\0${plan.result.id}\0${plan.result.revision}`,
  );
  const journal: ApprovalJournal = {
    schemaVersion: 1,
    transactionId,
    recordId: plan.result.id,
    workspaceId: plan.result.workspaceId,
    targetRevision: plan.result.revision,
    state: 'prepared',
    createdAt: new Date().toISOString(),
    mutations: await Promise.all(
      plan.mutations.map(async (mutation): Promise<ApprovalJournalMutation> => {
        const previousContent = await readFile(mutation.path, 'utf8').catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return undefined;
            throw error;
          },
        );
        return {
          kind: mutation.kind,
          relativePath: kbRelativePath(mutation.path),
          existed: previousContent !== undefined,
          previousContent,
        };
      }),
    ),
  };
  const journalPath = approvalJournalFile(transactionId);
  await ensureChroniclePrivateDirectory(path.dirname(journalPath));
  await atomicWriteJson(journalPath, journal);

  try {
    for (let index = 0; index < plan.mutations.length; index += 1) {
      const mutation = plan.mutations[index];
      await options.beforeMutation?.({ index, kind: mutation.kind, path: mutation.path });
      await atomicWriteFile(mutation.path, mutation.content);
    }
    journal.state = 'committed';
    await atomicWriteJson(journalPath, journal);
  } catch (approvalError) {
    try {
      await rollbackApprovalJournalUnlocked(journal);
      await atomicRemoveFile(journalPath);
    } catch (rollbackError) {
      throw new AggregateError(
        [approvalError, rollbackError],
        `Approval ${plan.result.id} failed and requires journal recovery`,
      );
    }
    throw approvalError;
  }

  // A committed journal is harmless if cleanup itself is interrupted; startup
  // recovery recognizes the approved draft commit point and removes it.
  await atomicRemoveFile(journalPath).catch((error) => {
    console.error(`Approval committed, but journal cleanup was deferred: ${String(error)}`);
  });
}

export async function approveDraft(
  id: string,
  options: ApproveDraftOptions = {},
): Promise<ApprovalResult> {
  const workspaceId = normalizeWorkspaceId(options.workspaceId);
  let result!: ApprovalResult;
  await withKnowledgeWriteLock(async () => {
    const current = await readDraftUnlocked(id, { workspaceId });
    if (current.status === 'approved' && current.approval) {
      result = current.approval;
      return;
    }
    if (
      current.operationId &&
      (await readOperationTombstoneUnlocked(current.operationId, workspaceId))
    ) {
      throw new OperationTombstonedError(current.operationId, workspaceId);
    }
    assertMutable(current, options.expectedRevision);
    const plan = await planApprovalUnlocked(current);
    await applyApprovalPlanUnlocked(plan, options);
    result = plan.result;
  });

  await appendLedgerEvent(config.kbDir, {
    type: 'draft.approved',
    recordId: id,
    workspaceId,
    contentHash: result.contentHash,
    revision: result.revision,
    details: {
      status: result.status,
      meetingPath: result.meetingPath,
      transcriptPath: result.transcriptPath,
      topicPaths: result.topicPaths,
    },
  });
  await rebuildIndex(workspaceId).catch((error) => {
    console.error(
      'Approval committed, but the Markdown index could not be refreshed:',
      error instanceof Error ? error.message : error,
    );
  });
  await refreshSearchIndex();
  return result;
}

export async function rejectDraft(id: string, options: RejectOptions = {}): Promise<ReviewDraft> {
  const workspaceId = normalizeWorkspaceId(options.workspaceId);
  let rejected!: ReviewDraft;
  await withKnowledgeWriteLock(async () => {
    const current = await readDraftUnlocked(id, { workspaceId });
    if (current.status === 'rejected') {
      rejected = current;
      return;
    }
    assertMutable(current, options.expectedRevision);
    rejected = {
      ...current,
      revision: current.revision + 1,
      status: 'rejected',
      updatedAt: new Date().toISOString(),
      rejectionReason: options.reason?.trim() || undefined,
    };
    await atomicWriteJson(draftFile(id, workspaceId), rejected);
  });
  await appendLedgerEvent(config.kbDir, {
    type: 'draft.rejected',
    recordId: id,
    workspaceId,
    contentHash: rejected.contentHash,
    revision: rejected.revision,
    details: {
      status: rejected.status,
      ...(rejected.rejectionReason ? { reason: rejected.rejectionReason } : {}),
    },
  });
  return rejected;
}

/**
 * Compatibility path for older callers. New interactive pipelines should use
 * persistRawCapture -> stageSourceDraft and wait for a human approval action.
 */
export async function writeSource(
  summary: MeetingSummary,
  rawText: string,
  meta: SourceMeta,
  options: DraftOptions = {},
): Promise<WrittenMeeting> {
  const draft = await stageSourceDraft(summary, rawText, meta, options);
  return approveDraft(draft.id, { workspaceId: draft.workspaceId });
}

/** Backwards-compatible wrapper for the Discord/meeting path. */
export async function writeMeeting(
  summary: MeetingSummary,
  transcript: string,
  meta: { date: string; participants: string[]; durationMinutes: number; workspaceId?: string },
): Promise<WrittenMeeting> {
  return writeSource(
    summary,
    transcript,
    {
      date: meta.date,
      kind: 'meeting',
      origin: 'discord',
      attribution: meta.participants,
      durationMinutes: meta.durationMinutes,
    },
    { workspaceId: meta.workspaceId },
  );
}

async function refreshSearchIndex(): Promise<void> {
  try {
    const { buildIndex } = await import('./store.js');
    await buildIndex();
  } catch (error) {
    console.error(
      'Notes were approved, but search indexing failed. Run `npm run index` to retry.\n',
      error instanceof Error ? error.message : error,
    );
  }
}

async function indexSection(root: string, sub: string): Promise<string[]> {
  const directory = path.join(root, sub);
  if (!existsSync(directory)) return [];
  const files = (await readdir(directory)).filter((file) => file.endsWith('.md')).sort();
  const lines: string[] = [];
  for (const file of files) {
    const fields = readFrontmatter(await readFile(path.join(directory, file), 'utf8'));
    lines.push(
      `- [[${sub}/${fields.name ?? file.replace(/\.md$/, '')}]] - ${fields.description ?? ''}`,
    );
  }
  return lines;
}

async function rebuildIndexUnlocked(workspaceId: string): Promise<void> {
  const root = workspaceRoot(workspaceId);
  const topics = await indexSection(root, 'topics');
  const meetings = (await indexSection(root, 'meetings')).reverse();
  const content =
    yamlFrontmatter({ type: 'index', workspace: workspaceId }) +
    `# Knowledge Base Index\n\n` +
    `The map of the palace. One line per approved note.\n\n` +
    `## Topics\n${topics.join('\n') || '_none yet_'}\n\n` +
    `## Records\n${meetings.join('\n') || '_none yet_'}\n`;
  await atomicWriteFile(path.join(root, 'INDEX.md'), content);
}

/** Rebuild one workspace's derived Markdown index. */
export async function rebuildIndex(workspaceId = DEFAULT_WORKSPACE_ID): Promise<void> {
  const normalized = normalizeWorkspaceId(workspaceId);
  await withKnowledgeWriteLock(async () => rebuildIndexUnlocked(normalized));
}
