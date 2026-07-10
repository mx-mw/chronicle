import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SESSION_MANIFEST_FILE = 'session.json';

export type SessionStage =
  | 'connecting'
  | 'recording'
  | 'captured'
  | 'queued'
  | 'transcribing'
  | 'distilling'
  | 'needs_review'
  | 'completed'
  | 'empty'
  | 'failed'
  | 'discarded';

export interface ManifestSegment {
  userId: string;
  startMs: number;
  pcmPath: string;
}

export interface SessionWorkspace {
  id: string;
  guildId: string;
  channelId: string;
}

export interface SessionManifest {
  schemaVersion: 1;
  id: string;
  workspace: SessionWorkspace;
  stage: SessionStage;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  speakers: Record<string, string>;
  optedOutUserIds: string[];
  segments: ManifestSegment[];
  warnings: string[];
  attempts: number;
  /** False only when recovery is impossible (for example raw audio expired). */
  recoverable?: boolean;
  error?: string;
  rawAudioExpiresAt?: string;
  rawCaptureId?: string;
  draftId?: string;
  meetingPath?: string;
  topicPaths?: string[];
  discardedAt?: string;
  discardReason?: string;
}

export interface CreateSessionManifestInput {
  id?: string;
  workspaceId?: string;
  guildId: string;
  channelId: string;
  startedAt?: Date;
}

export interface LocatedSessionManifest {
  path: string;
  dir: string;
  manifest: SessionManifest;
}

const updateChains = new Map<string, Promise<unknown>>();

export function createSessionManifest(input: CreateSessionManifestInput): SessionManifest {
  const now = (input.startedAt ?? new Date()).toISOString();
  return {
    schemaVersion: 1,
    id: input.id ?? randomUUID(),
    workspace: {
      id: input.workspaceId ?? 'default',
      guildId: input.guildId,
      channelId: input.channelId,
    },
    stage: 'connecting',
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    speakers: {},
    optedOutUserIds: [],
    segments: [],
    warnings: [],
    attempts: 0,
  };
}

export function manifestPath(sessionDir: string): string {
  return path.join(sessionDir, SESSION_MANIFEST_FILE);
}

function permissionUnsupported(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return process.platform === 'win32' && (code === 'EPERM' || code === 'ENOTSUP');
}

/** Create/harden a directory containing private capture material. */
export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch((error) => {
    if (!permissionUnsupported(error)) throw error;
  });
}

/** Same-directory temp + rename keeps readers from ever seeing half-written JSON. */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    await rename(tempPath, filePath);
    await chmod(filePath, 0o600).catch((error) => {
      if (!permissionUnsupported(error)) throw error;
    });
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function isManifest(value: unknown): value is SessionManifest {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SessionManifest>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.id === 'string' &&
    typeof candidate.workspace === 'object' &&
    candidate.workspace !== null &&
    typeof candidate.stage === 'string' &&
    Array.isArray(candidate.segments) &&
    Array.isArray(candidate.warnings) &&
    typeof candidate.speakers === 'object'
  );
}

export async function readSessionManifest(filePath: string): Promise<SessionManifest> {
  const parsed: unknown = JSON.parse(await readFile(filePath, 'utf8'));
  if (!isManifest(parsed)) {
    throw new Error(`Invalid Chronicle session manifest: ${filePath}`);
  }
  return parsed;
}

/** Serialize read-modify-write updates within this process as well as writing atomically. */
export async function updateSessionManifest(
  filePath: string,
  update: (current: SessionManifest) => SessionManifest | Promise<SessionManifest>,
): Promise<SessionManifest> {
  const previous = updateChains.get(filePath) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    const current = await readSessionManifest(filePath);
    const updated = await update(current);
    const stamped = { ...updated, updatedAt: new Date().toISOString() };
    await writeJsonAtomic(filePath, stamped);
    return stamped;
  });
  updateChains.set(filePath, next);
  try {
    return await next;
  } finally {
    if (updateChains.get(filePath) === next) updateChains.delete(filePath);
  }
}

export async function appendSessionWarning(filePath: string, warning: string): Promise<void> {
  await updateSessionManifest(filePath, (manifest) => ({
    ...manifest,
    warnings: manifest.warnings.includes(warning)
      ? manifest.warnings
      : [...manifest.warnings, warning],
  }));
}

export async function setSessionStage(
  filePath: string,
  stage: SessionStage,
  patch: Partial<Omit<SessionManifest, 'schemaVersion' | 'id' | 'workspace' | 'stage'>> = {},
): Promise<SessionManifest> {
  return updateSessionManifest(filePath, (manifest) => {
    if (
      (manifest.stage === 'discarded' && stage !== 'discarded') ||
      (manifest.stage === 'completed' && stage !== 'completed')
    ) {
      return manifest;
    }
    return { ...manifest, ...patch, stage };
  });
}

export async function listSessionManifests(sessionsRoot: string): Promise<LocatedSessionManifest[]> {
  let entries;
  try {
    entries = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const located = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry): Promise<LocatedSessionManifest | null> => {
        const dir = path.join(sessionsRoot, entry.name);
        const filePath = manifestPath(dir);
        try {
          return { path: filePath, dir, manifest: await readSessionManifest(filePath) };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          console.error(`Skipping unreadable session manifest ${filePath}:`, error);
          return null;
        }
      }),
  );
  return located
    .filter((item): item is LocatedSessionManifest => item !== null)
    .sort((a, b) => a.manifest.createdAt.localeCompare(b.manifest.createdAt));
}

const RECOVERABLE_STAGES = new Set<SessionStage>([
  'captured',
  'queued',
  'transcribing',
  'distilling',
  'failed',
]);

export async function findRecoverableSessions(
  sessionsRoot: string,
): Promise<LocatedSessionManifest[]> {
  return (await listSessionManifests(sessionsRoot)).filter(({ manifest }) =>
    RECOVERABLE_STAGES.has(manifest.stage) && manifest.recoverable !== false,
  );
}

export interface InterruptedSessionRecoveryOptions {
  retentionHours: number;
}

const ACTIVE_STAGES = new Set<SessionStage>(['connecting', 'recording']);

function segmentFromPcmName(filePath: string): ManifestSegment | null {
  const match = path.basename(filePath).match(/^(\d+)-(.+)\.pcm$/);
  if (!match) return null;
  const startMs = Number(match[1]);
  if (!Number.isSafeInteger(startMs) || startMs < 0 || !match[2]) return null;
  return { userId: match[2], startMs, pcmPath: filePath };
}

/**
 * Turn manifests left in connecting/recording by a process crash into either a
 * recoverable captured session or a terminal tombstone. Every interrupted
 * session receives a retention deadline before normal startup recovery runs.
 */
export async function recoverInterruptedActiveSessions(
  sessionsRoot: string,
  options: InterruptedSessionRecoveryOptions,
): Promise<LocatedSessionManifest[]> {
  if (!Number.isFinite(options.retentionHours) || options.retentionHours < 0) {
    throw new Error('retentionHours must be a non-negative number.');
  }
  await ensurePrivateDirectory(sessionsRoot);
  const recovered: LocatedSessionManifest[] = [];

  for (const located of await listSessionManifests(sessionsRoot)) {
    if (!ACTIVE_STAGES.has(located.manifest.stage)) continue;
    await ensurePrivateDirectory(located.dir);

    const entries = await readdir(located.dir, { withFileTypes: true });
    const discovered: ManifestSegment[] = [];
    let latestAudioTime = 0;
    const optedOut = new Set(located.manifest.optedOutUserIds);
    for (const segment of located.manifest.segments) {
      if (
        optedOut.has(segment.userId) &&
        path.dirname(path.resolve(segment.pcmPath)) === path.resolve(located.dir)
      ) {
        await rm(segment.pcmPath, { force: true });
      }
    }
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name) !== '.pcm') continue;
      const pcmPath = path.join(located.dir, entry.name);
      const segment = segmentFromPcmName(pcmPath);
      if (segment && optedOut.has(segment.userId)) {
        await rm(pcmPath, { force: true });
        continue;
      }
      const fileStat = await stat(pcmPath);
      if (fileStat.size === 0) continue;
      await chmod(pcmPath, 0o600).catch((error) => {
        if (!permissionUnsupported(error)) throw error;
      });
      if (segment) discovered.push(segment);
      latestAudioTime = Math.max(latestAudioTime, fileStat.mtimeMs);
    }

    const byPath = new Map<string, ManifestSegment>();
    for (const segment of [
      ...located.manifest.segments.filter((item) => !optedOut.has(item.userId)),
      ...discovered,
    ]) {
      byPath.set(path.resolve(segment.pcmPath), segment);
    }
    const segments = [...byPath.values()].sort((left, right) => left.startMs - right.startMs);
    const endedAtMs = Math.max(
      Date.parse(located.manifest.updatedAt),
      latestAudioTime || 0,
    );
    const computedExpiryMs = endedAtMs + options.retentionHours * 60 * 60_000;
    const existingExpiryMs = located.manifest.rawAudioExpiresAt
      ? Date.parse(located.manifest.rawAudioExpiresAt)
      : Number.NaN;
    const expiry =
      options.retentionHours > 0
        ? new Date(
            Number.isFinite(existingExpiryMs)
              ? Math.min(existingExpiryMs, computedExpiryMs)
              : computedExpiryMs,
          ).toISOString()
        : undefined;
    const warning = `Session was interrupted while ${located.manifest.stage}; Chronicle recovered it on startup.`;
    const endedAt = new Date(endedAtMs).toISOString();
    const speakers = { ...located.manifest.speakers };
    for (const userId of optedOut) delete speakers[userId];

    const manifest = await updateSessionManifest(located.path, (current) =>
      segments.length > 0
        ? {
            ...current,
            stage: 'captured',
            endedAt,
            durationMs: Math.max(
              current.durationMs ?? 0,
              Date.parse(endedAt) - Date.parse(current.startedAt),
              ...segments.map((segment) => segment.startMs),
            ),
            speakers,
            segments,
            warnings: current.warnings.includes(warning)
              ? current.warnings
              : [...current.warnings, warning],
            rawAudioExpiresAt: expiry,
            recoverable: true,
            error: undefined,
          }
        : {
            ...current,
            stage: 'failed',
            endedAt,
            durationMs: Math.max(0, Date.parse(endedAt) - Date.parse(current.startedAt)),
            speakers,
            segments: [],
            warnings: current.warnings.includes(warning)
              ? current.warnings
              : [...current.warnings, warning],
            rawAudioExpiresAt: expiry,
            recoverable: false,
            error: 'Interrupted session contained no recoverable PCM audio.',
          },
    );
    recovered.push({ ...located, manifest });
  }
  return recovered;
}

export interface SessionDiscardResult {
  outcome: 'discarded' | 'already_completed';
  manifest: SessionManifest;
}

/** Durable terminal fence used before cancelling asynchronous processing. */
export async function tombstoneSession(
  filePath: string,
  reason: string,
  now = new Date(),
): Promise<SessionDiscardResult> {
  let outcome: SessionDiscardResult['outcome'] = 'discarded';
  const manifest = await updateSessionManifest(filePath, (current) => {
    if (current.stage === 'completed') {
      outcome = 'already_completed';
      return current;
    }
    return {
      ...current,
      stage: 'discarded',
      discardedAt: current.discardedAt ?? now.toISOString(),
      discardReason: current.discardReason ?? reason,
      recoverable: false,
      error: undefined,
    };
  });
  return { outcome, manifest };
}

const RAW_AUDIO_EXTENSIONS = new Set(['.pcm', '.wav', '.opus']);
const GENERATED_TRANSCRIPT_NAME = /^\d{10,}-.+\.txt$/;

async function captureEndTimeMs(located: LocatedSessionManifest): Promise<number> {
  let latestAudioTime = 0;
  const entries = await readdir(located.dir, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  for (const entry of entries) {
    if (!entry.isFile() || !RAW_AUDIO_EXTENSIONS.has(path.extname(entry.name))) continue;
    latestAudioTime = Math.max(latestAudioTime, (await stat(path.join(located.dir, entry.name))).mtimeMs);
  }
  const endedAt = located.manifest.endedAt ? Date.parse(located.manifest.endedAt) : Number.NaN;
  if (Number.isFinite(endedAt) || latestAudioTime > 0) {
    return Math.max(Number.isFinite(endedAt) ? endedAt : 0, latestAudioTime);
  }
  return Date.parse(located.manifest.updatedAt);
}

/** Backfill old manifests before the startup expiry sweep without extending downtime. */
export async function backfillSessionRetentionDeadlines(
  sessionsRoot: string,
  retentionHours: number,
): Promise<LocatedSessionManifest[]> {
  if (!Number.isFinite(retentionHours) || retentionHours < 0) {
    throw new Error('retentionHours must be a non-negative number.');
  }
  // Zero means "purge after an attempt", so startup must leave recoverable
  // audio intact and must not manufacture an already-expired deadline.
  if (retentionHours === 0) return [];
  const updated: LocatedSessionManifest[] = [];
  for (const located of await listSessionManifests(sessionsRoot)) {
    const computedExpiryMs =
      (await captureEndTimeMs(located)) + retentionHours * 60 * 60_000;
    const existingExpiryMs = located.manifest.rawAudioExpiresAt
      ? Date.parse(located.manifest.rawAudioExpiresAt)
      : Number.NaN;
    const expiry = new Date(
      Number.isFinite(existingExpiryMs)
        ? Math.min(existingExpiryMs, computedExpiryMs)
        : computedExpiryMs,
    ).toISOString();
    if (located.manifest.rawAudioExpiresAt === expiry) continue;
    const manifest = await updateSessionManifest(located.path, (current) => {
      const currentExpiryMs = current.rawAudioExpiresAt
        ? Date.parse(current.rawAudioExpiresAt)
        : Number.NaN;
      const targetExpiry = new Date(
        Number.isFinite(currentExpiryMs)
          ? Math.min(currentExpiryMs, Date.parse(expiry))
          : Date.parse(expiry),
      ).toISOString();
      return { ...current, rawAudioExpiresAt: targetExpiry };
    });
    updated.push({ ...located, manifest });
  }
  return updated;
}

/** Retention hook: remove raw audio while preserving the audit manifest and review artifacts. */
export async function purgeRawSessionAudio(located: LocatedSessionManifest): Promise<number> {
  let removed = 0;
  let entries;
  try {
    entries = await readdir(located.dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  const rawStems = new Set(
    [
      ...located.manifest.segments.map((segment) => path.basename(segment.pcmPath, path.extname(segment.pcmPath))),
      ...entries
        .filter((entry) => entry.isFile() && RAW_AUDIO_EXTENSIONS.has(path.extname(entry.name)))
        .map((entry) => path.basename(entry.name, path.extname(entry.name))),
    ],
  );
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile()) return;
      const extension = path.extname(entry.name);
      const generatedTranscript =
        extension === '.txt' &&
        (rawStems.has(path.basename(entry.name, extension)) || GENERATED_TRANSCRIPT_NAME.test(entry.name));
      if (!RAW_AUDIO_EXTENSIONS.has(extension) && !generatedTranscript) return;
      await rm(path.join(located.dir, entry.name), { force: true });
      removed += 1;
    }),
  );
  return removed;
}

/** RAW_AUDIO_RETENTION_HOURS=0 hook: purge this capture only after its attempt settles. */
export async function purgeSessionAudioAfterAttempt(
  located: LocatedSessionManifest,
  retentionHours: number,
  now = new Date(),
): Promise<number> {
  if (retentionHours !== 0) return 0;
  const terminal =
    located.manifest.recoverable === false ||
    ['needs_review', 'completed', 'empty', 'discarded'].includes(located.manifest.stage);
  if (!terminal) return 0;
  const removed = await purgeRawSessionAudio(located);
  await updateSessionManifest(located.path, (manifest) => ({
    ...manifest,
    segments: [],
    recoverable: false,
    rawAudioExpiresAt: now.toISOString(),
  }));
  return removed;
}

export async function purgeExpiredSessionAudio(
  sessionsRoot: string,
  now = new Date(),
): Promise<number> {
  let removed = 0;
  for (const located of await listSessionManifests(sessionsRoot)) {
    const expiry = located.manifest.rawAudioExpiresAt;
    if (expiry && Date.parse(expiry) <= now.getTime()) {
      const sessionRemoved = await purgeRawSessionAudio(located);
      removed += sessionRemoved;
      if (sessionRemoved > 0 && RECOVERABLE_STAGES.has(located.manifest.stage)) {
        const warning = 'Raw audio expired under the configured retention policy before processing completed.';
        await updateSessionManifest(located.path, (manifest) => ({
          ...manifest,
          recoverable: false,
          warnings: manifest.warnings.includes(warning)
            ? manifest.warnings
            : [...manifest.warnings, warning],
        }));
      }
    }
  }
  return removed;
}
