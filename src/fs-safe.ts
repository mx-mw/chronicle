import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  chmod,
  link,
  open,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

/** Small, dependency-free filesystem primitives shared by Chronicle's durable stores. */

export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Turn a digest into an RFC-4122-shaped, deterministic UUID. The UUID is an
 * identity, not a secret; SHA-256 remains the separate content-integrity value.
 */
export function stableUuid(namespace: string, digest: string): string {
  const bytes = Buffer.from(sha256(`${namespace}\0${digest}`).slice(0, 32), 'hex');
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // name-based UUID version
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Unicode-aware filename component. It preserves useful non-Latin names. */
export function unicodeSlug(value: string, maxLength = 72): string {
  const slug = value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\p{Z}\s_]+/gu, '-')
    .replace(/[^\p{L}\p{N}.-]+/gu, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '');
  return [...(slug || 'untitled')].slice(0, maxLength).join('').replace(/[.-]+$/g, '') || 'untitled';
}

/** Stable suffixes prevent two equal-looking labels from ever overwriting one another. */
export function collisionSafeBasename(label: string, identity: string, maxLength = 96): string {
  const suffix = sha256(identity).slice(0, 10);
  const available = Math.max(8, maxLength - suffix.length - 1);
  return `${unicodeSlug(label, available)}-${suffix}`;
}

/** JSON string literals are valid YAML scalars and safely escape colons/newlines/quotes. */
export function yamlScalar(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map((item) => yamlScalar(item)).join(', ')}]`;
  return JSON.stringify(value);
}

export function yamlFrontmatter(fields: Record<string, unknown>): string {
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${yamlScalar(value)}`);
  return `---\n${lines.join('\n')}\n---\n\n`;
}

/** Write in the destination directory, fsync, then replace with one rename. */
export async function atomicWriteFile(
  destination: string,
  data: string | Uint8Array,
): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function atomicWriteJson(destination: string, value: unknown): Promise<void> {
  await atomicWriteFile(destination, `${JSON.stringify(value, null, 2)}\n`);
}

/** Atomically hide a file from readers before removing its inode. */
export async function atomicRemoveFile(destination: string): Promise<void> {
  const tombstone = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.deleted`,
  );
  try {
    await rename(destination, tombstone);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await unlink(tombstone).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

export async function readJsonFile<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T;
}

export async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(directory, 0o700);
}

export async function ensurePrivateFile(file: string): Promise<void> {
  if (process.platform === 'win32') return;
  await chmod(file, 0o600).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

export interface FileLockOptions {
  timeoutMs?: number;
  staleMs?: number;
  retryMs?: number;
  /** Integration-test failpoint after a stale lock has been observed. */
  onStaleObserved?: () => Promise<void>;
  /** Integration-test failpoint after release has observed its owner nonce. */
  onReleaseOwnershipObserved?: () => Promise<void>;
}

const pause = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

const PROCESS_INSTANCE_TOKEN = randomUUID();
const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1_000).toISOString();
const OWNER_FILE = 'owner.json';
const TRANSITION_FILE = '.transition';

interface LockOwner {
  token: string;
  pid: number;
  processToken?: string;
  processStartedAt?: string;
  acquiredAt: string;
}

interface LockIdentity {
  dev: number;
  ino: number;
  birthtimeMs: number;
  mtimeMs: number;
}

interface LockSnapshot {
  identity: LockIdentity;
  owner?: LockOwner;
}

interface TransitionOwner {
  token: string;
  pid: number;
  processToken: string;
  createdAt: string;
  kind: 'release' | 'takeover' | 'abort';
}

interface TransitionClaim {
  owner: TransitionOwner;
}

function privateSiblingPath(destination: string, purpose: string): string {
  return path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${purpose}.${process.pid}.${randomUUID()}`,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLockOwner(raw: string): LockOwner | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return undefined;
    if (typeof value.token !== 'string' || value.token.length === 0) return undefined;
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return undefined;
    if (typeof value.acquiredAt !== 'string') return undefined;
    if (value.processToken !== undefined && typeof value.processToken !== 'string') {
      return undefined;
    }
    if (value.processStartedAt !== undefined && typeof value.processStartedAt !== 'string') {
      return undefined;
    }
    return {
      token: value.token,
      pid: value.pid as number,
      processToken: value.processToken,
      processStartedAt: value.processStartedAt,
      acquiredAt: value.acquiredAt,
    };
  } catch {
    return undefined;
  }
}

function parseTransitionOwner(raw: string): TransitionOwner | undefined {
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value)) return undefined;
    if (typeof value.token !== 'string' || value.token.length === 0) return undefined;
    if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) return undefined;
    if (typeof value.processToken !== 'string' || value.processToken.length === 0) {
      return undefined;
    }
    if (typeof value.createdAt !== 'string') return undefined;
    if (value.kind !== 'release' && value.kind !== 'takeover' && value.kind !== 'abort') {
      return undefined;
    }
    return {
      token: value.token,
      pid: value.pid as number,
      processToken: value.processToken,
      createdAt: value.createdAt,
      kind: value.kind,
    };
  } catch {
    return undefined;
  }
}

async function readLockSnapshot(lockDirectory: string): Promise<LockSnapshot | undefined> {
  let entry: Awaited<ReturnType<typeof stat>>;
  try {
    entry = await stat(lockDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!entry.isDirectory()) {
    throw new Error(`Chronicle lock path is not a directory: ${lockDirectory}`);
  }
  const owner = await readFile(path.join(lockDirectory, OWNER_FILE), 'utf8')
    .then(parseLockOwner)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
  return {
    identity: {
      dev: entry.dev,
      ino: entry.ino,
      birthtimeMs: entry.birthtimeMs,
      mtimeMs: entry.mtimeMs,
    },
    owner,
  };
}

function sameLockSnapshot(expected: LockSnapshot, actual: LockSnapshot | undefined): boolean {
  if (!actual) return false;
  const sameIdentity =
    expected.identity.ino !== 0 || actual.identity.ino !== 0
      ? expected.identity.dev === actual.identity.dev && expected.identity.ino === actual.identity.ino
      : expected.identity.birthtimeMs === actual.identity.birthtimeMs;
  if (!sameIdentity) return false;
  return expected.owner?.token === actual.owner?.token;
}

function timestampAge(timestamp: string | undefined, fallbackMs: number): number {
  const parsed = timestamp === undefined ? Number.NaN : Date.parse(timestamp);
  return Date.now() - (Number.isFinite(parsed) ? parsed : fallbackMs);
}

function isProcessAlive(pid: number, processToken?: string): boolean | undefined {
  if (pid === process.pid) {
    // A different per-process nonce with our PID is a lock from a previous
    // process whose PID has since been reused.
    if (processToken && processToken !== PROCESS_INSTANCE_TOKEN) return false;
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return undefined;
  }
}

function isStaleLock(snapshot: LockSnapshot, staleMs: number): boolean {
  const createdAt =
    snapshot.identity.birthtimeMs > 0
      ? snapshot.identity.birthtimeMs
      : snapshot.identity.mtimeMs;
  const age = timestampAge(snapshot.owner?.acquiredAt, createdAt);
  if (age <= staleMs) return false;
  if (!snapshot.owner) return true;
  return isProcessAlive(snapshot.owner.pid, snapshot.owner.processToken) === false;
}

function isContentionError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EEXIST' || code === 'ENOENT' || code === 'ENOTEMPTY';
}

async function readTransitionOwner(file: string): Promise<TransitionOwner | undefined> {
  return readFile(file, 'utf8')
    .then(parseTransitionOwner)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
}

async function transitionIsOwned(lockDirectory: string, claim: TransitionClaim): Promise<boolean> {
  const owner = await readTransitionOwner(path.join(lockDirectory, TRANSITION_FILE));
  return owner?.token === claim.owner.token;
}

async function releaseTransition(lockDirectory: string, claim: TransitionClaim): Promise<void> {
  const transition = path.join(lockDirectory, TRANSITION_FILE);
  if (!(await transitionIsOwned(lockDirectory, claim))) return;
  await unlink(transition).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

async function recoverStaleTransition(
  lockDirectory: string,
  expected: LockSnapshot,
  staleMs: number,
): Promise<void> {
  const transition = path.join(lockDirectory, TRANSITION_FILE);
  const [outer, markerStat, markerOwner] = await Promise.all([
    readLockSnapshot(lockDirectory),
    stat(transition).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }),
    readTransitionOwner(transition),
  ]);
  if (!sameLockSnapshot(expected, outer) || !markerStat) return;
  const markerCreatedAt = markerStat.birthtimeMs > 0 ? markerStat.birthtimeMs : markerStat.mtimeMs;
  const age = timestampAge(markerOwner?.createdAt, markerCreatedAt);
  if (age <= staleMs) return;
  if (
    markerOwner &&
    isProcessAlive(markerOwner.pid, markerOwner.processToken) !== false
  ) {
    return;
  }

  const abandoned = path.join(lockDirectory, `.transition.abandoned.${randomUUID()}`);
  try {
    await rename(transition, abandoned);
  } catch (error) {
    if (isContentionError(error)) return;
    throw error;
  }

  const movedOwner = await readTransitionOwner(abandoned);
  const movedStat = await stat(abandoned).catch(() => undefined);
  const sameMarker = markerOwner?.token
    ? markerOwner.token === movedOwner?.token
    : Boolean(
        movedStat &&
          markerStat.dev === movedStat.dev &&
          markerStat.ino === movedStat.ino,
      );
  if (sameMarker) {
    await unlink(abandoned).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

async function tryClaimTransition(
  lockDirectory: string,
  expected: LockSnapshot,
  kind: TransitionOwner['kind'],
  staleMs: number,
): Promise<TransitionClaim | undefined> {
  const owner: TransitionOwner = {
    token: randomUUID(),
    pid: process.pid,
    processToken: PROCESS_INSTANCE_TOKEN,
    createdAt: new Date().toISOString(),
    kind,
  };
  const prepared = path.join(lockDirectory, `.transition.prepare.${owner.token}`);
  const transition = path.join(lockDirectory, TRANSITION_FILE);
  try {
    await writeFile(prepared, `${JSON.stringify(owner)}\n`, { flag: 'wx', mode: 0o600 });
    try {
      // A hard link publishes the complete marker with no empty-file crash gap.
      await link(prepared, transition);
    } catch (error) {
      if (!isContentionError(error)) throw error;
      await recoverStaleTransition(lockDirectory, expected, staleMs);
      return undefined;
    }
  } catch (error) {
    if (isContentionError(error)) return undefined;
    throw error;
  } finally {
    await unlink(prepared).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  const claim = { owner };
  const current = await readLockSnapshot(lockDirectory);
  if (!sameLockSnapshot(expected, current)) {
    await releaseTransition(lockDirectory, claim);
    return undefined;
  }
  return claim;
}

async function moveObservedLock(
  lockDirectory: string,
  expected: LockSnapshot,
  claim: TransitionClaim,
  purpose: 'released' | 'stale' | 'aborted',
): Promise<boolean> {
  const current = await readLockSnapshot(lockDirectory);
  if (!sameLockSnapshot(expected, current)) {
    await releaseTransition(lockDirectory, claim);
    return false;
  }
  if (!(await transitionIsOwned(lockDirectory, claim))) return false;

  const movedDirectory = privateSiblingPath(lockDirectory, purpose);
  try {
    await rename(lockDirectory, movedDirectory);
  } catch (error) {
    if (isContentionError(error)) return false;
    throw error;
  }

  const moved = await readLockSnapshot(movedDirectory);
  if (!sameLockSnapshot(expected, moved)) {
    throw new Error(
      `Chronicle lock changed identity during ${purpose}; preserved at ${movedDirectory}`,
    );
  }
  await rm(movedDirectory, { recursive: true });
  return true;
}

async function abandonFailedAcquisition(
  lockDirectory: string,
  expected: LockSnapshot,
  staleMs: number,
): Promise<void> {
  const claim = await tryClaimTransition(lockDirectory, expected, 'abort', staleMs);
  if (!claim) return;
  await moveObservedLock(lockDirectory, expected, claim, 'aborted');
}

async function releaseOwnedLock(
  lockDirectory: string,
  owner: LockOwner,
  options: Required<Pick<FileLockOptions, 'timeoutMs' | 'staleMs' | 'retryMs'>> &
    Pick<FileLockOptions, 'onReleaseOwnershipObserved'>,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    const expected = await readLockSnapshot(lockDirectory);
    if (!expected || expected.owner?.token !== owner.token) return;
    await options.onReleaseOwnershipObserved?.();
    const claim = await tryClaimTransition(lockDirectory, expected, 'release', options.staleMs);
    if (claim) {
      const moved = await moveObservedLock(lockDirectory, expected, claim, 'released');
      if (moved) return;
    }
    if (Date.now() - started >= options.timeoutMs) {
      throw new Error(`Timed out releasing Chronicle lock: ${lockDirectory}`);
    }
    await pause(options.retryMs + Math.floor(Math.random() * options.retryMs));
  }
}

/**
 * Cross-process advisory lock implemented as an atomically-created directory.
 * Stale locks are recoverable after a crashed process.
 */
export async function withFileLock<T>(
  lockDirectory: string,
  operation: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? 15_000);
  const staleMs = Math.max(0, options.staleMs ?? 120_000);
  const retryMs = Math.max(1, options.retryMs ?? 25);
  const started = Date.now();
  await mkdir(path.dirname(lockDirectory), { recursive: true });

  let acquiredOwner: LockOwner | undefined;

  for (;;) {
    try {
      const owner: LockOwner = {
        token: randomUUID(),
        pid: process.pid,
        processToken: PROCESS_INSTANCE_TOKEN,
        processStartedAt: PROCESS_STARTED_AT,
        acquiredAt: new Date().toISOString(),
      };
      await mkdir(lockDirectory, { mode: 0o700 });
      const created = await readLockSnapshot(lockDirectory);
      if (!created) continue;
      try {
        await writeFile(path.join(lockDirectory, OWNER_FILE), `${JSON.stringify(owner)}\n`, {
          flag: 'wx',
          mode: 0o600,
        });
      } catch (error) {
        await abandonFailedAcquisition(lockDirectory, created, staleMs);
        throw error;
      }
      const initialized = await readLockSnapshot(lockDirectory);
      if (!initialized || initialized.owner?.token !== owner.token) continue;
      acquiredOwner = owner;
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      const observed = await readLockSnapshot(lockDirectory);
      if (observed && isStaleLock(observed, staleMs)) {
        await options.onStaleObserved?.();
        const claim = await tryClaimTransition(lockDirectory, observed, 'takeover', staleMs);
        if (claim && (await moveObservedLock(lockDirectory, observed, claim, 'stale'))) {
          continue;
        }
      }
      if (Date.now() - started >= timeoutMs) {
        throw new Error(`Timed out waiting for Chronicle lock: ${lockDirectory}`);
      }
      await pause(retryMs + Math.floor(Math.random() * retryMs));
    }
  }

  try {
    return await operation();
  } finally {
    await releaseOwnedLock(lockDirectory, acquiredOwner!, {
      timeoutMs,
      staleMs,
      retryMs,
      onReleaseOwnershipObserved: options.onReleaseOwnershipObserved,
    });
  }
}
