/** Rebuildable hybrid-search sidecar over Chronicle's approved Markdown. */
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, open, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { embed, embedOne, dot, fromBlob, toBlob } from './embed.js';
import {
  atomicWriteJson,
  ensurePrivateDirectory,
  ensurePrivateFile,
  readJsonFile,
  sha256,
  withFileLock,
} from './fs-safe.js';

export type NoteType = 'topic' | 'meeting' | 'transcript';

export interface Chunk {
  id: number;
  file: string;
  workspaceId: string;
  noteType: NoteType;
  noteTitle: string;
  text: string;
}

export interface Hit extends Chunk {
  /** Rank-fusion score, useful only for ordering this result set. */
  score: number;
  /** Cosine score before fusion; null when vector retrieval was unavailable. */
  rawVectorScore: number | null;
  /** Native FTS5 bm25 score; null for vector-only hits (lower is a stronger match). */
  rawKeywordScore: number | null;
  keywordMatched: boolean;
}

export interface SearchOptions {
  workspaceId?: string;
  relevanceFloor?: number;
  keywordOnly?: boolean;
}

export interface BuildIndexOptions {
  force?: boolean;
}

export interface IndexStats {
  notesIndexed: number;
  notesSkipped: number;
  notesRemoved: number;
  chunks: number;
  keywordOnly: boolean;
  rebuilt: boolean;
}

export interface IndexHealth {
  exists: boolean;
  compatible: boolean;
  schemaVersion?: string;
  chunkerVersion?: string;
  embeddingModel?: string;
  embeddingDimension?: number;
  notes: number;
  chunks: number;
  vectorChunks: number;
  keywordOnlyChunks: number;
  workspaces: { workspaceId: string; notes: number }[];
  fresh: boolean;
  generation: number;
  indexedGeneration: number;
  lastError?: string;
  lastSuccessAt?: string;
}

export interface IndexGenerationState {
  schemaVersion: 1;
  generation: number;
  indexedGeneration: number;
  stale: boolean;
  updatedAt: string;
  lastSuccessAt?: string;
  lastError?: string | null;
  pendingRecordId?: string;
}

const INDEX_SCHEMA_VERSION = '2';
const CHUNKER_VERSION = 'sections-v2';
const RRF_K = 60;
export const DEFAULT_RELEVANCE_FLOOR = 0.35;
const TYPE_WEIGHT: Record<NoteType, number> = { topic: 1.15, meeting: 1.0, transcript: 0.6 };

export function indexGenerationStateFile(): string {
  return path.join(config.kbDir, '.chronicle', 'index-state.json');
}

function defaultIndexGenerationState(): IndexGenerationState {
  return {
    schemaVersion: 1,
    generation: 0,
    indexedGeneration: 0,
    stale: true,
    updatedAt: new Date(0).toISOString(),
  };
}

export async function readIndexGenerationState(): Promise<IndexGenerationState> {
  return readJsonFile<IndexGenerationState>(indexGenerationStateFile()).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return defaultIndexGenerationState();
      throw error;
    },
  );
}

async function withIndexStateLock<T>(operation: () => Promise<T>): Promise<T> {
  const { withKnowledgeReadLock } = await import('./kb.js');
  return withKnowledgeReadLock(operation);
}

async function writeIndexSuccess(capturedGeneration: number): Promise<void> {
  await withIndexStateLock(async () => {
    const current = await readIndexGenerationState();
    const now = new Date().toISOString();
    const caughtUp = current.generation === capturedGeneration;
    await atomicWriteJson(indexGenerationStateFile(), {
      ...current,
      schemaVersion: 1,
      indexedGeneration: capturedGeneration,
      stale: !caughtUp,
      updatedAt: now,
      lastSuccessAt: now,
      lastError: null,
      pendingRecordId: caughtUp ? undefined : current.pendingRecordId,
    } satisfies IndexGenerationState);
  });
}

async function writeIndexFailure(error: unknown): Promise<void> {
  await withIndexStateLock(async () => {
    const current = await readIndexGenerationState();
    await atomicWriteJson(indexGenerationStateFile(), {
      ...current,
      schemaVersion: 1,
      stale: true,
      updatedAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : String(error),
    } satisfies IndexGenerationState);
  });
}

export async function markIndexStale(reason?: string): Promise<IndexGenerationState> {
  await ensurePrivateDirectory(path.dirname(indexGenerationStateFile()));
  return withIndexStateLock(async () => {
    const current = await readIndexGenerationState();
    const next: IndexGenerationState = {
      ...current,
      schemaVersion: 1,
      generation: current.generation + 1,
      stale: true,
      updatedAt: new Date().toISOString(),
      lastError: reason ?? null,
    };
    await atomicWriteJson(indexGenerationStateFile(), next);
    return next;
  });
}

function hardenIndexFilesSync(): void {
  if (process.platform === 'win32') return;
  for (const suffix of ['', '-wal', '-shm']) {
    const file = `${config.indexPath}${suffix}`;
    if (existsSync(file) && statSync(file).isFile()) chmodSync(file, 0o600);
  }
}

async function hardenIndexFiles(): Promise<void> {
  await Promise.all(
    ['', '-wal', '-shm'].map((suffix) => ensurePrivateFile(`${config.indexPath}${suffix}`)),
  );
}

interface NoteDescriptor {
  file: string;
  absolutePath: string;
  workspaceId: string;
  noteType: NoteType;
  content: string;
  hash: string;
  title: string;
  chunks: string[];
}

function openDb(): DatabaseSync {
  const db = new DatabaseSync(config.indexPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS metadata (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  hardenIndexFilesSync();
  return db;
}

function getMetadata(db: DatabaseSync): Record<string, string> {
  return Object.fromEntries(
    (db.prepare('SELECT key, value FROM metadata').all() as { key: string; value: string }[]).map(
      (row) => [row.key, row.value],
    ),
  );
}

function setMetadata(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    'INSERT INTO metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  ).run(key, value);
}

function hasV2Schema(db: DatabaseSync): boolean {
  const notes = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notes'").get();
  if (!notes) return false;
  const columns = db.prepare('PRAGMA table_info(notes)').all() as { name: string }[];
  return columns.some((column) => column.name === 'workspace_id');
}

function createContentSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      file         TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      note_type    TEXT NOT NULL,
      title        TEXT NOT NULL,
      hash         TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notes_workspace ON notes(workspace_id);
    CREATE TABLE IF NOT EXISTS chunks (
      id        INTEGER PRIMARY KEY,
      file      TEXT NOT NULL REFERENCES notes(file) ON DELETE CASCADE,
      text      TEXT NOT NULL,
      embedding BLOB
    );
    CREATE INDEX IF NOT EXISTS chunks_file ON chunks(file);
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
      USING fts5(text, content='chunks', content_rowid='id', tokenize='porter unicode61');
  `);
}

function resetContentSchema(db: DatabaseSync): void {
  db.exec(`
    DROP TABLE IF EXISTS chunks_fts;
    DROP TABLE IF EXISTS chunks;
    DROP TABLE IF EXISTS notes;
  `);
  createContentSchema(db);
}

function metadataMismatch(db: DatabaseSync): boolean {
  const meta = getMetadata(db);
  return (
    !hasV2Schema(db) ||
    meta.schema_version !== INDEX_SCHEMA_VERSION ||
    meta.chunker_version !== CHUNKER_VERSION ||
    meta.embedding_model !== config.embedModel
  );
}

function initializeMetadata(db: DatabaseSync): void {
  setMetadata(db, 'schema_version', INDEX_SCHEMA_VERSION);
  setMetadata(db, 'chunker_version', CHUNKER_VERSION);
  setMetadata(db, 'embedding_model', config.embedModel);
  if (getMetadata(db).embedding_dimension === undefined) setMetadata(db, 'embedding_dimension', '');
}

function titleOf(content: string, fallback: string): string {
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? fallback;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
}

function frontmatterString(content: string, key: string): string | undefined {
  const block = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  const raw = block?.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim();
  if (!raw) return undefined;
  if (raw.startsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw;
    }
  }
  return raw;
}

/** Topic facts stay atomic; other records are indexed one Markdown section at a time. */
export function chunkNote(content: string, noteType: NoteType): string[] {
  const body = stripFrontmatter(content).trim();
  if (!body) return [];
  if (noteType === 'topic') {
    const facts = body
      .split(/\r?\n/)
      .filter((line) => line.trimStart().startsWith('- '))
      .map((line) => line.trimStart().slice(2).split(/\s+(?:—|-)\s+\[\[/)[0].trim())
      .map((line) => line.replace(/\s*<!--\s*chronicle-fact:[^>]+-->\s*$/, '').trim())
      .filter(Boolean);
    return facts.length ? facts : [body.slice(0, 1_000)];
  }
  return body
    .split(/\n(?=##\s)/)
    .map((section) => section.trim())
    .filter(Boolean);
}

async function markdownFiles(directory: string): Promise<string[]> {
  return (await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })).filter((name) => name.endsWith('.md'));
}

async function addWorkspaceNotes(
  output: NoteDescriptor[],
  root: string,
  kbRelativeRoot: string,
  fallbackWorkspace: string,
): Promise<void> {
  for (const [directoryName, noteType] of [
    ['topics', 'topic'],
    ['records', 'meeting'],
    ['meetings', 'meeting'],
  ] as const) {
    const directory = path.join(root, directoryName);
    for (const name of await markdownFiles(directory)) {
      const absolutePath = path.join(directory, name);
      const content = await readFile(absolutePath, 'utf8');
      const relative = path.posix.join(kbRelativeRoot, directoryName, name);
      const workspaceId = frontmatterString(content, 'workspace') ?? fallbackWorkspace;
      output.push({
        file: relative,
        absolutePath,
        workspaceId,
        noteType,
        content,
        hash: sha256(content),
        title: titleOf(content, relative),
        chunks: chunkNote(content, noteType),
      });
    }
  }
}

async function listNotes(): Promise<NoteDescriptor[]> {
  const output: NoteDescriptor[] = [];
  await addWorkspaceNotes(output, config.kbDir, '', 'default');
  const workspaceDirectory = path.join(config.kbDir, 'workspaces');
  const workspaces = await readdir(workspaceDirectory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    },
  );
  for (const entry of workspaces) {
    if (!entry.isDirectory()) continue;
    await addWorkspaceNotes(
      output,
      path.join(workspaceDirectory, entry.name),
      path.posix.join('workspaces', entry.name),
      entry.name,
    );
  }
  return output;
}

async function captureIndexSnapshot(): Promise<{
  notes: NoteDescriptor[];
  generation: number;
}> {
  return withIndexStateLock(async () => {
    const [notes, state] = await Promise.all([listNotes(), readIndexGenerationState()]);
    await atomicWriteJson(indexGenerationStateFile(), {
      ...state,
      schemaVersion: 1,
      stale: true,
      updatedAt: new Date().toISOString(),
    } satisfies IndexGenerationState);
    return { notes, generation: state.generation };
  });
}

function transaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Synchronize the disposable SQLite cache. Every note replacement is one
 * transaction; a failed embedding call still yields a complete keyword index.
 */
export async function buildIndex(
  onProgress?: (message: string) => void,
  options: BuildIndexOptions = {},
): Promise<IndexStats> {
  let snapshot: Awaited<ReturnType<typeof captureIndexSnapshot>>;
  try {
    snapshot = await captureIndexSnapshot();
    await mkdir(path.dirname(config.indexPath), { recursive: true });
    await (await open(config.indexPath, 'a', 0o600)).close();
    await hardenIndexFiles();
    await ensurePrivateDirectory(path.join(config.kbDir, '.chronicle'));
  } catch (error) {
    await writeIndexFailure(error).catch(() => undefined);
    throw error;
  }
  return withFileLock(`${config.indexPath}.lock`, async () => {
    let completedStats!: IndexStats;
    try {
      const db = openDb();
      try {
      const stats: IndexStats = {
        notesIndexed: 0,
        notesSkipped: 0,
        notesRemoved: 0,
        chunks: 0,
        keywordOnly: false,
        rebuilt: false,
      };
      if (options.force || metadataMismatch(db)) {
        resetContentSchema(db);
        stats.rebuilt = true;
      } else {
        createContentSchema(db);
      }
      initializeMetadata(db);

      const notes = snapshot.notes;
      const seen = new Set(notes.map((note) => note.file));
      for (const row of db.prepare('SELECT file FROM notes').all() as { file: string }[]) {
        if (seen.has(row.file)) continue;
        transaction(db, () => db.prepare('DELETE FROM notes WHERE file = ?').run(row.file));
        stats.notesRemoved += 1;
      }

      let pending = notes.filter((note) => {
        const existing = db
          .prepare(
            `SELECT n.hash,
                    EXISTS(SELECT 1 FROM chunks c WHERE c.file=n.file AND c.embedding IS NULL) AS missingVectors
             FROM notes n WHERE n.file = ?`,
          )
          .get(note.file) as
          | { hash: string; missingVectors: number }
          | undefined;
        if (!options.force && existing?.hash === note.hash && !existing.missingVectors) {
          stats.notesSkipped += 1;
          return false;
        }
        return true;
      });

      let vectorDimension = Number(getMetadata(db).embedding_dimension) || 0;
      let embeddingAvailable = true;
      const prefetched = new Map<string, number[][]>();
      const firstNonEmpty = pending.find((note) => note.chunks.length > 0);
      if (firstNonEmpty) {
        try {
          onProgress?.(`Embedding ${firstNonEmpty.chunks.length} chunk(s) from ${firstNonEmpty.file}`);
          const vectors = await embed(firstNonEmpty.chunks);
          const incomingDimension = vectors[0]?.length ?? 0;
          if (vectorDimension && incomingDimension !== vectorDimension) {
            onProgress?.(
              `Embedding dimension changed (${vectorDimension} -> ${incomingDimension}); rebuilding index`,
            );
            resetContentSchema(db);
            initializeMetadata(db);
            stats.rebuilt = true;
            stats.notesSkipped = 0;
            pending = notes;
          }
          vectorDimension = incomingDimension;
          setMetadata(db, 'embedding_dimension', String(vectorDimension));
          prefetched.set(firstNonEmpty.file, vectors);
        } catch (error) {
          embeddingAvailable = false;
          stats.keywordOnly = true;
          onProgress?.(
            `Embedding unavailable; building keyword-only index (${error instanceof Error ? error.message : error})`,
          );
        }
      }

      for (const note of pending) {
        if (note.chunks.length === 0) {
          const removed = transaction(db, () =>
            db.prepare('DELETE FROM notes WHERE file = ?').run(note.file),
          );
          if (Number(removed.changes) > 0) stats.notesRemoved += 1;
          continue;
        }

        let vectors: number[][] | undefined = prefetched.get(note.file);
        if (!vectors && embeddingAvailable) {
          try {
            onProgress?.(`Embedding ${note.chunks.length} chunk(s) from ${note.file}`);
            vectors = await embed(note.chunks);
            if (vectors.some((vector) => vector.length !== vectorDimension)) {
              throw new Error(
                `Embedding dimension mismatch while indexing ${note.file}: expected ${vectorDimension}`,
              );
            }
          } catch (error) {
            embeddingAvailable = false;
            stats.keywordOnly = true;
            onProgress?.(
              `Embedding unavailable; remaining notes are keyword-only (${error instanceof Error ? error.message : error})`,
            );
          }
        }

        transaction(db, () => {
          db.prepare('DELETE FROM notes WHERE file = ?').run(note.file);
          db.prepare(
            'INSERT INTO notes (file, workspace_id, note_type, title, hash) VALUES (?, ?, ?, ?, ?)',
          ).run(note.file, note.workspaceId, note.noteType, note.title, note.hash);
          const insert = db.prepare('INSERT INTO chunks (file, text, embedding) VALUES (?, ?, ?)');
          for (let index = 0; index < note.chunks.length; index += 1) {
            insert.run(note.file, note.chunks[index], vectors ? toBlob(vectors[index]) : null);
            stats.chunks += 1;
          }
        });
        stats.notesIndexed += 1;
      }

      // External-content FTS needs an explicit refresh after replacements/deletes.
      db.exec(`INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')`);
      await hardenIndexFiles();
      completedStats = stats;
      } finally {
        db.close();
        await hardenIndexFiles();
      }
      await writeIndexSuccess(snapshot.generation);
      return completedStats;
    } catch (error) {
      await writeIndexFailure(error);
      throw error;
    }
  });
}

/** Strip FTS operators so arbitrary questions always produce a valid query. */
export function toMatchQuery(query: string): string {
  const terms = query
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((term) => term.length > 1);
  return terms.length ? [...new Set(terms)].map((term) => `"${term}"`).join(' OR ') : '';
}

/** Read-only index diagnostics for Doctor, CLIs, and the web health endpoint. */
export function getIndexHealth(): IndexHealth {
  const empty: IndexHealth = {
    exists: false,
    compatible: false,
    notes: 0,
    chunks: 0,
    vectorChunks: 0,
    keywordOnlyChunks: 0,
    workspaces: [],
    fresh: false,
    generation: 0,
    indexedGeneration: 0,
  };
  let generationState = defaultIndexGenerationState();
  try {
    generationState = JSON.parse(readFileSync(indexGenerationStateFile(), 'utf8')) as IndexGenerationState;
  } catch {
    // A missing/corrupt marker is never interpreted as search-ready.
  }
  const stateHealth = {
    generation: generationState.generation,
    indexedGeneration: generationState.indexedGeneration,
    lastError: generationState.lastError || undefined,
    lastSuccessAt: generationState.lastSuccessAt,
  };
  if (!existsSync(config.indexPath)) return { ...empty, ...stateHealth };
  hardenIndexFilesSync();
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(config.indexPath, { readOnly: true });
    const metadata = getMetadata(db);
    const compatible = !metadataMismatch(db);
    if (!hasV2Schema(db)) {
      return { ...empty, ...stateHealth, exists: true, schemaVersion: metadata.schema_version };
    }
    const counts = db
      .prepare(
        `SELECT
           (SELECT count(*) FROM notes) AS notes,
           count(*) AS chunks,
           sum(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) AS vectorChunks
         FROM chunks`,
      )
      .get() as { notes: number; chunks: number; vectorChunks: number | null };
    const workspaces = db
      .prepare(
        `SELECT workspace_id AS workspaceId, count(*) AS notes
         FROM notes GROUP BY workspace_id ORDER BY workspace_id`,
      )
      .all() as { workspaceId: string; notes: number }[];
    const vectorChunks = counts.vectorChunks ?? 0;
    const fresh =
      compatible &&
      !generationState.stale &&
      generationState.generation === generationState.indexedGeneration;
    return {
      exists: true,
      compatible,
      schemaVersion: metadata.schema_version,
      chunkerVersion: metadata.chunker_version,
      embeddingModel: metadata.embedding_model,
      embeddingDimension: Number(metadata.embedding_dimension) || undefined,
      notes: counts.notes,
      chunks: counts.chunks,
      vectorChunks,
      keywordOnlyChunks: counts.chunks - vectorChunks,
      workspaces,
      fresh,
      generation: generationState.generation,
      indexedGeneration: generationState.indexedGeneration,
      lastError: generationState.lastError || undefined,
      lastSuccessAt: generationState.lastSuccessAt,
    };
  } catch {
    return { ...empty, ...stateHealth, exists: true };
  } finally {
    db?.close();
  }
}

function relevanceFloor(options: SearchOptions): number {
  const configured = Number(process.env.RECALL_RELEVANCE_FLOOR);
  const floor = options.relevanceFloor ?? (Number.isFinite(configured) ? configured : DEFAULT_RELEVANCE_FLOOR);
  if (!Number.isFinite(floor) || floor < -1 || floor > 1) {
    throw new Error('relevanceFloor must be between -1 and 1');
  }
  return floor;
}

async function ensureCompatibleIndex(): Promise<void> {
  const db = openDb();
  const mismatch = metadataMismatch(db);
  db.close();
  const state = await readIndexGenerationState();
  if (mismatch || state.stale || state.generation !== state.indexedGeneration) await buildIndex();
}

/** Hybrid retrieval with an evidence floor and a no-network keyword fallback. */
export async function search(
  query: string,
  limit = 8,
  options: SearchOptions = {},
): Promise<Hit[]> {
  if (!existsSync(config.indexPath)) {
    throw new Error(`No search index at ${config.indexPath}. Run \`npm run index\` first.`);
  }
  if (!query.trim() || limit <= 0) return [];
  await hardenIndexFiles();
  await ensureCompatibleIndex();
  const db = openDb();
  try {
    const pool = Math.max(50, limit * 5);
    const floor = relevanceFloor(options);
    const workspaceId = options.workspaceId?.trim() || config.workspaceId;
    const ranks = new Map<
      number,
      { rrf: number; vector: number | null; keyword: boolean; keywordScore: number | null }
    >();
    const bump = (
      id: number,
      rank: number,
      kind: 'keyword' | 'vector',
      rawScore?: number,
    ) => {
      const entry = ranks.get(id) ?? {
        rrf: 0,
        vector: null,
        keyword: false,
        keywordScore: null,
      };
      entry.rrf += 1 / (RRF_K + rank + 1);
      if (kind === 'keyword') {
        entry.keyword = true;
        entry.keywordScore = rawScore ?? null;
      }
      if (kind === 'vector') entry.vector = rawScore ?? null;
      ranks.set(id, entry);
    };

    const match = toMatchQuery(query);
    if (match) {
      const sql = `SELECT chunks_fts.rowid AS id, bm25(chunks_fts) AS keywordScore FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.rowid JOIN notes n ON n.file = c.file
         WHERE chunks_fts MATCH ? AND n.workspace_id = ?
         ORDER BY bm25(chunks_fts) LIMIT ?`;
      const keywordHits = db.prepare(sql).all(match, workspaceId, pool) as {
        id: number;
        keywordScore: number;
      }[];
      keywordHits.forEach((row, index) => bump(row.id, index, 'keyword', row.keywordScore));
    }

    if (!options.keywordOnly) {
      try {
        const queryVector = Float32Array.from(await embedOne(query));
        const metadataDimension = Number(getMetadata(db).embedding_dimension) || 0;
        if (metadataDimension && queryVector.length !== metadataDimension) {
          db.close();
          await buildIndex(undefined, { force: true });
          return search(query, limit, options);
        }
        const rows = db
          .prepare(
            `SELECT c.id, c.embedding FROM chunks c JOIN notes n ON n.file=c.file
             WHERE c.embedding IS NOT NULL AND n.workspace_id=?`,
          )
          .all(workspaceId) as {
          id: number;
          embedding: Uint8Array;
        }[];
        const scored = rows.map((row) => ({
          id: row.id,
          score: dot(queryVector, fromBlob(row.embedding)),
        }));
        for (const row of scored) {
          const ranked = ranks.get(row.id);
          if (ranked) ranked.vector = row.score;
        }
        scored
          .filter((row) => row.score >= floor)
          .sort((a, b) => b.score - a.score)
          .slice(0, pool)
          .forEach((row, index) => bump(row.id, index, 'vector', row.score));
      } catch (error) {
        // Keyword results remain useful when Ollama/model serving is offline.
        if ((error as Error).message.includes('dimension mismatch')) throw error;
      }
    }

    if (ranks.size === 0) return [];
    const ids = [...ranks.keys()];
    const rows = db
      .prepare(
        `SELECT c.id, c.file, c.text, n.workspace_id AS workspaceId,
                n.note_type AS noteType, n.title AS noteTitle
         FROM chunks c JOIN notes n ON n.file = c.file
         WHERE c.id IN (${ids.map(() => '?').join(',')})`,
      )
      .all(...ids) as unknown as Chunk[];
    return rows
      .map((row) => {
        const rank = ranks.get(row.id)!;
        return {
          ...row,
          score: rank.rrf * TYPE_WEIGHT[row.noteType],
          rawVectorScore: rank.vector,
          rawKeywordScore: rank.keywordScore,
          keywordMatched: rank.keyword,
        };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  } finally {
    try {
      db.close();
    } catch {
      // Search may close before a forced rebuild; DatabaseSync close is not idempotent.
    }
  }
}
