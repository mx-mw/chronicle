import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import {
  atomicWriteJson,
  collisionSafeBasename,
  ensurePrivateDirectory,
  readJsonFile,
  sha256,
  stableUuid,
} from './fs-safe.js';

export const TASK_SCHEMA_VERSION = 1 as const;

export type TaskStatus = 'open' | 'done';

export interface TaskSource {
  recordId: string;
  date: string;
  meetingPath: string;
  transcriptPath: string;
  citation: string;
  addedAt: string;
}

export interface ChronicleTask {
  schemaVersion: typeof TASK_SCHEMA_VERSION;
  id: string;
  workspaceId: string;
  revision: number;
  status: TaskStatus;
  owner: string;
  task: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  sources: TaskSource[];
}

export interface TaskSourceInput {
  recordId: string;
  date: string;
  meetingPath: string;
  transcriptPath: string;
  citation?: string;
  addedAt?: string;
}

export interface ApprovedActionTaskInput {
  workspaceId?: string;
  owner: string;
  task: string;
  source: TaskSourceInput;
  /** Explicit human-reviewed link when wording changed across meetings. */
  carryoverTaskId?: string;
  now?: Date | string;
}

export type ApprovedActionTaskPlan =
  | { outcome: 'created'; task: ChronicleTask }
  | { outcome: 'carried_over'; task: ChronicleTask }
  | { outcome: 'unchanged'; task: ChronicleTask };

export interface ListTaskOptions {
  workspaceId?: string;
  status?: TaskStatus | 'all';
  owner?: string;
}

export interface TaskLookupOptions {
  workspaceId?: string;
}

export interface UpdateTaskOptions extends TaskLookupOptions {
  expectedRevision: number;
  now?: Date | string;
}

export interface TaskPatch {
  owner?: string;
  task?: string;
  status?: TaskStatus;
}

export class TaskNotFoundError extends Error {
  readonly status = 404;
  readonly code = 'task_not_found';

  constructor(id: string, workspaceId: string) {
    super(`No Chronicle task ${id} in workspace ${workspaceId}`);
    this.name = 'TaskNotFoundError';
  }
}

export class TaskRevisionConflictError extends Error {
  readonly status = 409;
  readonly code = 'task_revision_conflict';

  constructor(id: string, expected: number, actual: number) {
    super(`Task ${id} changed (expected revision ${expected}, found ${actual})`);
    this.name = 'TaskRevisionConflictError';
  }
}

export class TaskStateConflictError extends Error {
  readonly status = 409;
  readonly code = 'task_state_conflict';

  constructor(message: string) {
    super(message);
    this.name = 'TaskStateConflictError';
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_DIRECTORY = path.join('.chronicle', 'tasks');

function printableValue(value: string, label: string, maximum: number): string {
  const normalized = value.normalize('NFKC').trim();
  if (!normalized || normalized.length > maximum || /[\0-\x1f\x7f]/.test(normalized)) {
    throw new Error(`${label} must be 1-${maximum} printable characters`);
  }
  return normalized;
}

function timestamp(value: Date | string | undefined, label = 'timestamp'): string {
  const date = value instanceof Date ? value : value === undefined ? new Date() : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`${label} must be a valid date`);
  return date.toISOString();
}

function taskStatus(value: unknown): TaskStatus {
  if (value !== 'open' && value !== 'done') throw new Error('Task status must be open or done');
  return value;
}

function taskUuid(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID_PATTERN.test(normalized)) throw new Error(`Invalid Chronicle task id: ${value}`);
  return normalized;
}

function relativeMarkdownPath(value: string, label: string): string {
  const normalized = printableValue(value, label, 1_000).replaceAll('\\', '/');
  const clean = path.posix.normalize(normalized).replace(/^\.\//, '');
  if (
    path.posix.isAbsolute(clean) ||
    /^[a-z]:\//i.test(clean) ||
    clean === '..' ||
    clean.startsWith('../') ||
    !clean.toLowerCase().endsWith('.md')
  ) {
    throw new Error(`${label} must be a workspace-relative Markdown path`);
  }
  return clean;
}

export function normalizeTaskWorkspaceId(value?: string): string {
  return printableValue(value ?? config.workspaceId, 'workspaceId', 200);
}

export function taskWorkspaceStorageKey(workspaceId: string): string {
  const normalized = normalizeTaskWorkspaceId(workspaceId);
  return collisionSafeBasename(normalized, normalized, 80);
}

export function taskDirectory(workspaceId?: string): string {
  const normalized = normalizeTaskWorkspaceId(workspaceId);
  return path.join(config.kbDir, TASK_DIRECTORY, taskWorkspaceStorageKey(normalized));
}

export function taskFilePath(id: string, workspaceId?: string): string {
  return path.join(taskDirectory(workspaceId), `${taskUuid(id)}.json`);
}

async function withTaskStoreLock<T>(operation: () => Promise<T>): Promise<T> {
  // Dynamic import avoids a module cycle when kb.ts imports the pure task
  // planning helpers for approval. This lock also recovers prepared approval
  // journals before task state can be observed or changed.
  const { withKnowledgeReadLock } = await import('./kb.js');
  return withKnowledgeReadLock(operation);
}

export function normalizeTaskMatchPart(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
}

export function taskMatchKey(owner: string, task: string): string {
  return `${normalizeTaskMatchPart(owner)}\0${normalizeTaskMatchPart(task)}`;
}

export function taskIdForApprovedAction(input: {
  workspaceId: string;
  recordId: string;
  owner: string;
  task: string;
}): string {
  const workspaceId = normalizeTaskWorkspaceId(input.workspaceId);
  const recordId = printableValue(input.recordId, 'source recordId', 300);
  const matchKey = taskMatchKey(
    printableValue(input.owner, 'Task owner', 200),
    printableValue(input.task, 'Task text', 4_000),
  );
  return stableUuid('chronicle-task', sha256(`${workspaceId}\0${recordId}\0${matchKey}`));
}

function normalizeTaskSource(input: TaskSourceInput, defaultAddedAt: string): TaskSource {
  const transcriptPath = relativeMarkdownPath(input.transcriptPath, 'Task transcriptPath');
  const defaultCitation = `[[${transcriptPath.replace(/\.md$/i, '')}]]`;
  if (input.citation !== undefined && input.citation.normalize('NFKC').trim() !== defaultCitation) {
    throw new Error('Task source citation must match transcriptPath');
  }
  return {
    recordId: printableValue(input.recordId, 'Task source recordId', 300),
    date: (() => {
      const date = printableValue(input.date, 'Task source date', 40);
      const parsed = /^\d{4}-\d{2}-\d{2}$/.test(date)
        ? new Date(`${date}T00:00:00.000Z`)
        : undefined;
      if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
        throw new Error('Task source date must use YYYY-MM-DD');
      }
      return date;
    })(),
    meetingPath: relativeMarkdownPath(input.meetingPath, 'Task meetingPath'),
    transcriptPath,
    citation: defaultCitation,
    addedAt: timestamp(input.addedAt ?? defaultAddedAt, 'Task source addedAt'),
  };
}

function normalizeLoadedTask(value: ChronicleTask): ChronicleTask {
  if (!value || typeof value !== 'object' || value.schemaVersion !== TASK_SCHEMA_VERSION) {
    throw new Error('Unsupported Chronicle task schema');
  }
  const workspaceId = normalizeTaskWorkspaceId(value.workspaceId);
  const createdAt = timestamp(value.createdAt, 'Task createdAt');
  const updatedAt = timestamp(value.updatedAt, 'Task updatedAt');
  if (!Number.isSafeInteger(value.revision) || value.revision < 1) {
    throw new Error('Task revision must be a positive integer');
  }
  if (!Array.isArray(value.sources) || value.sources.length === 0) {
    throw new Error('Task must retain at least one source');
  }
  const status = taskStatus(value.status);
  const completedAt = value.completedAt === undefined
    ? undefined
    : timestamp(value.completedAt, 'Task completedAt');
  if (status === 'done' && !completedAt) throw new Error('Done task must include completedAt');
  return {
    schemaVersion: TASK_SCHEMA_VERSION,
    id: taskUuid(value.id),
    workspaceId,
    revision: value.revision,
    status,
    owner: printableValue(value.owner, 'Task owner', 200),
    task: printableValue(value.task, 'Task text', 4_000),
    createdAt,
    updatedAt,
    ...(status === 'done' ? { completedAt } : {}),
    sources: value.sources
      .map((source) => normalizeTaskSource(source, source.addedAt))
      .sort(
        (left, right) =>
          left.date.localeCompare(right.date) ||
          left.addedAt.localeCompare(right.addedAt) ||
          left.recordId.localeCompare(right.recordId),
      ),
  };
}

function sourceAlreadyAttached(task: ChronicleTask, source: TaskSource): boolean {
  return task.sources.some((existing) => existing.recordId === source.recordId);
}

/**
 * Pure approval helper. Callers can serialize its result into Chronicle's
 * approval journal so the meeting, draft, and task reach their commit point together.
 */
export function planApprovedActionTask(
  existingTasks: readonly ChronicleTask[],
  input: ApprovedActionTaskInput,
): ApprovedActionTaskPlan {
  const workspaceId = normalizeTaskWorkspaceId(input.workspaceId);
  const owner = printableValue(input.owner, 'Task owner', 200);
  const taskText = printableValue(input.task, 'Task text', 4_000);
  const now = timestamp(input.now);
  const source = normalizeTaskSource(input.source, now);
  const matchKey = taskMatchKey(owner, taskText);
  const candidates = existingTasks
    .map((task) => normalizeLoadedTask(structuredClone(task)))
    .filter((task) => task.workspaceId === workspaceId);
  const explicitId = input.carryoverTaskId === undefined
    ? undefined
    : taskUuid(input.carryoverTaskId);
  const explicitMatch = explicitId === undefined
    ? undefined
    : candidates.find((task) => task.id === explicitId);
  if (explicitId && !explicitMatch) {
    throw new TaskNotFoundError(explicitId, workspaceId);
  }
  if (explicitMatch?.status === 'done') {
    throw new TaskStateConflictError(`Task ${explicitMatch.id} is done and cannot be carried over`);
  }
  const match = explicitMatch ?? candidates
    .filter(
      (task) => task.status === 'open' && taskMatchKey(task.owner, task.task) === matchKey,
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))[0];

  if (match) {
    if (sourceAlreadyAttached(match, source)) return { outcome: 'unchanged', task: match };
    return {
      outcome: 'carried_over',
      task: {
        ...match,
        revision: match.revision + 1,
        updatedAt: now.localeCompare(match.updatedAt) >= 0 ? now : match.updatedAt,
        sources: [...match.sources, source].sort(
          (left, right) =>
            left.date.localeCompare(right.date) ||
            left.addedAt.localeCompare(right.addedAt) ||
            left.recordId.localeCompare(right.recordId),
        ),
      },
    };
  }

  return {
    outcome: 'created',
    task: {
      schemaVersion: TASK_SCHEMA_VERSION,
      id: taskIdForApprovedAction({
        workspaceId,
        recordId: source.recordId,
        owner,
        task: taskText,
      }),
      workspaceId,
      revision: 1,
      status: 'open',
      owner,
      task: taskText,
      createdAt: now,
      updatedAt: now,
      sources: [source],
    },
  };
}

export function serializeTask(task: ChronicleTask): string {
  return `${JSON.stringify(normalizeLoadedTask(structuredClone(task)), null, 2)}\n`;
}

async function taskFiles(workspaceId: string): Promise<string[]> {
  return (await readdir(taskDirectory(workspaceId)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  }))
    .filter((name) => UUID_PATTERN.test(name.replace(/\.json$/i, '')) && name.endsWith('.json'))
    .sort()
    .map((name) => path.join(taskDirectory(workspaceId), name));
}

async function readTaskFile(file: string, workspaceId: string): Promise<ChronicleTask> {
  const task = normalizeLoadedTask(await readJsonFile<ChronicleTask>(file));
  const fileId = path.basename(file, '.json').toLowerCase();
  if (task.workspaceId !== workspaceId || task.id !== fileId) {
    throw new Error(`Task identity does not match its workspace path: ${file}`);
  }
  return task;
}

/** Caller must already hold Chronicle's knowledge write lock. */
export async function listTasksUnlocked(options: ListTaskOptions = {}): Promise<ChronicleTask[]> {
  const workspaceId = normalizeTaskWorkspaceId(options.workspaceId);
  const wantedStatus = options.status ?? 'open';
  if (wantedStatus !== 'open' && wantedStatus !== 'done' && wantedStatus !== 'all') {
    throw new Error('Task status filter must be open, done, or all');
  }
  const wantedOwner = options.owner === undefined
    ? undefined
    : normalizeTaskMatchPart(printableValue(options.owner, 'Task owner filter', 200));
  const tasks = await Promise.all(
    (await taskFiles(workspaceId)).map((file) => readTaskFile(file, workspaceId)),
  );
  return tasks
    .filter((task) => wantedStatus === 'all' || task.status === wantedStatus)
    .filter((task) => wantedOwner === undefined || normalizeTaskMatchPart(task.owner) === wantedOwner)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
}

async function readTaskUnlocked(id: string, workspaceId: string): Promise<ChronicleTask> {
  const file = taskFilePath(id, workspaceId);
  return readTaskFile(file, workspaceId)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new TaskNotFoundError(id, workspaceId);
      throw error;
    });
}

export async function listTasks(options: ListTaskOptions = {}): Promise<ChronicleTask[]> {
  return withTaskStoreLock(() => listTasksUnlocked(options));
}

export async function readTask(
  id: string,
  options: TaskLookupOptions = {},
): Promise<ChronicleTask> {
  const workspaceId = normalizeTaskWorkspaceId(options.workspaceId);
  return withTaskStoreLock(() => readTaskUnlocked(id, workspaceId));
}

/** Standalone materializer for imports/backfills. Approval should use the pure plan helper. */
export async function upsertApprovedActionTask(
  input: ApprovedActionTaskInput,
): Promise<ApprovedActionTaskPlan> {
  const workspaceId = normalizeTaskWorkspaceId(input.workspaceId);
  return withTaskStoreLock(async () => {
    const plan = planApprovedActionTask(
      await listTasksUnlocked({ workspaceId, status: 'all' }),
      { ...input, workspaceId },
    );
    if (plan.outcome !== 'unchanged') {
      await ensurePrivateDirectory(taskDirectory(workspaceId));
      await atomicWriteJson(taskFilePath(plan.task.id, workspaceId), plan.task);
    }
    return plan;
  });
}

export async function updateTask(
  id: string,
  patch: TaskPatch,
  options: UpdateTaskOptions,
): Promise<ChronicleTask> {
  const workspaceId = normalizeTaskWorkspaceId(options.workspaceId);
  if (!Number.isSafeInteger(options.expectedRevision) || options.expectedRevision < 1) {
    throw new Error('expectedRevision must be a positive integer');
  }
  if (
    patch.owner === undefined &&
    patch.task === undefined &&
    patch.status === undefined
  ) {
    throw new Error('Task patch must change owner, task, or status');
  }
  return withTaskStoreLock(async () => {
    const current = await readTaskUnlocked(id, workspaceId);
    if (current.revision !== options.expectedRevision) {
      throw new TaskRevisionConflictError(current.id, options.expectedRevision, current.revision);
    }
    const owner = patch.owner === undefined
      ? current.owner
      : printableValue(patch.owner, 'Task owner', 200);
    const taskText = patch.task === undefined
      ? current.task
      : printableValue(patch.task, 'Task text', 4_000);
    const status = patch.status === undefined ? current.status : taskStatus(patch.status);
    if (owner === current.owner && taskText === current.task && status === current.status) return current;

    if (status === 'open') {
      const collision = (await listTasksUnlocked({ workspaceId, status: 'open' })).find(
        (candidate) =>
          candidate.id !== current.id &&
          taskMatchKey(candidate.owner, candidate.task) === taskMatchKey(owner, taskText),
      );
      if (collision) {
        throw new TaskStateConflictError(
          `Task ${current.id} cannot become a duplicate of open task ${collision.id}`,
        );
      }
    }

    const requestedNow = timestamp(options.now);
    const now = requestedNow.localeCompare(current.updatedAt) >= 0
      ? requestedNow
      : current.updatedAt;
    const updated: ChronicleTask = {
      ...current,
      owner,
      task: taskText,
      status,
      revision: current.revision + 1,
      updatedAt: now,
      ...(status === 'done'
        ? { completedAt: current.status === 'done' ? current.completedAt ?? now : now }
        : { completedAt: undefined }),
    };
    await ensurePrivateDirectory(taskDirectory(workspaceId));
    await atomicWriteJson(taskFilePath(updated.id, workspaceId), updated);
    return normalizeLoadedTask(updated);
  });
}
