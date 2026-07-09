/**
 * The search index: a SQLite sidecar over kb/.
 *
 * Markdown stays the source of truth. This file is a derived, disposable cache
 * — delete `kb/.index.db` and `buildIndex()` reconstructs it. That keeps the
 * memory palace greppable, editable in Obsidian, and free of any database you
 * have to run. It also means the storage layer can move to Postgres later
 * without anything above this module noticing.
 *
 * Retrieval is hybrid: BM25 keyword matching (SQLite's FTS5, built into Node)
 * fused with cosine similarity over local embeddings. Neither alone is enough.
 * Keyword search misses "what did we decide about storage?" when the note says
 * "SQLite index"; vector search misses exact identifiers and names.
 *
 * Chunks are facts, not windows. Topic notes are already lists of atomic,
 * self-contained sentences with backlinks — the distillation step did the
 * chunking. Sliding a 512-token window over them would only glue unrelated
 * facts together.
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { embed, embedOne, dot, toBlob, fromBlob } from './embed.js';

export type NoteType = 'topic' | 'meeting' | 'transcript';

export interface Chunk {
  id: number;
  file: string; // kb-relative, e.g. "topics/storage.md"
  noteType: NoteType;
  noteTitle: string;
  text: string;
}

export interface Hit extends Chunk {
  score: number;
}

/**
 * Topic notes carry the durable, cross-meeting knowledge; meeting notes are the
 * record of one conversation. When both match a query, the topic is usually the
 * better answer, so it gets a small edge in fusion.
 */
const TYPE_WEIGHT: Record<NoteType, number> = { topic: 1.15, meeting: 1.0, transcript: 0.6 };

/** Reciprocal-rank-fusion constant. 60 is the value from the original paper. */
const RRF_K = 60;

function openDb(): DatabaseSync {
  const db = new DatabaseSync(config.indexPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS notes (
      file       TEXT PRIMARY KEY,
      note_type  TEXT NOT NULL,
      title      TEXT NOT NULL,
      hash       TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id        INTEGER PRIMARY KEY,
      file      TEXT NOT NULL REFERENCES notes(file) ON DELETE CASCADE,
      text      TEXT NOT NULL,
      embedding BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chunks_file ON chunks(file);
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts
      USING fts5(text, content='chunks', content_rowid='id', tokenize='porter unicode61');
  `);
  return db;
}

function sha(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function titleOf(content: string, fallback: string): string {
  return content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? fallback;
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n/, '');
}

/**
 * Split a note into retrievable units.
 *
 * Topic notes: one chunk per logged fact (already atomic and self-contained).
 * Meeting notes: one chunk per section, so "Decisions" stays whole.
 */
export function chunkNote(content: string, noteType: NoteType): string[] {
  const body = stripFrontmatter(content).trim();
  if (!body) return [];

  if (noteType === 'topic') {
    const facts = body
      .split('\n')
      .filter((line) => line.trimStart().startsWith('- '))
      // Drop the "— [[meetings/...]] (date)" provenance tail; the fact is the unit.
      .map((line) => line.trimStart().slice(2).split(' — [[')[0].trim())
      .filter((fact) => fact.length > 0);
    // A topic with no facts logged yet still deserves to be findable by its blurb.
    return facts.length ? facts : [body.slice(0, 500)];
  }

  const sections = body
    .split(/\n(?=##\s)/)
    .map((section) => section.trim())
    .filter((section) => section.length > 0);
  return sections.length ? sections : [body];
}

async function listNotes(): Promise<{ file: string; noteType: NoteType }[]> {
  const out: { file: string; noteType: NoteType }[] = [];
  // Transcripts are deliberately excluded: they are provenance, not knowledge,
  // and indexing them would drown every query in raw speech.
  for (const noteType of ['topics', 'meetings'] as const) {
    const dir = path.join(config.kbDir, noteType);
    if (!existsSync(dir)) continue;
    for (const name of (await readdir(dir)).filter((f) => f.endsWith('.md'))) {
      out.push({
        file: `${noteType}/${name}`,
        noteType: noteType === 'topics' ? 'topic' : 'meeting',
      });
    }
  }
  return out;
}

export interface IndexStats {
  notesIndexed: number;
  notesSkipped: number;
  notesRemoved: number;
  chunks: number;
}

/**
 * Bring the index in line with kb/. Unchanged notes are skipped by content
 * hash, so re-running after one new meeting embeds only that meeting.
 */
export async function buildIndex(onProgress?: (msg: string) => void): Promise<IndexStats> {
  await mkdir(config.kbDir, { recursive: true });
  const db = openDb();
  try {
    const stats: IndexStats = { notesIndexed: 0, notesSkipped: 0, notesRemoved: 0, chunks: 0 };
    const notes = await listNotes();
    const seen = new Set(notes.map((n) => n.file));

    // Drop notes that no longer exist on disk.
    for (const row of db.prepare('SELECT file FROM notes').all() as { file: string }[]) {
      if (!seen.has(row.file)) {
        db.prepare('DELETE FROM chunks WHERE file = ?').run(row.file);
        db.prepare('DELETE FROM notes WHERE file = ?').run(row.file);
        stats.notesRemoved += 1;
      }
    }

    for (const { file, noteType } of notes) {
      const content = await readFile(path.join(config.kbDir, file), 'utf8');
      const hash = sha(content);
      const existing = db.prepare('SELECT hash FROM notes WHERE file = ?').get(file) as
        | { hash: string }
        | undefined;
      if (existing?.hash === hash) {
        stats.notesSkipped += 1;
        continue;
      }

      const texts = chunkNote(content, noteType);
      if (texts.length === 0) continue;

      onProgress?.(`Embedding ${texts.length} chunk(s) from ${file}`);
      const vectors = await embed(texts);

      db.prepare('DELETE FROM chunks WHERE file = ?').run(file);
      db.prepare(
        'INSERT INTO notes (file, note_type, title, hash) VALUES (?, ?, ?, ?) ' +
          'ON CONFLICT(file) DO UPDATE SET note_type = excluded.note_type, ' +
          'title = excluded.title, hash = excluded.hash',
      ).run(file, noteType, titleOf(content, file), hash);

      const insert = db.prepare('INSERT INTO chunks (file, text, embedding) VALUES (?, ?, ?)');
      const insertFts = db.prepare('INSERT INTO chunks_fts (rowid, text) VALUES (?, ?)');
      for (let i = 0; i < texts.length; i += 1) {
        const { lastInsertRowid } = insert.run(file, texts[i], toBlob(vectors[i]));
        insertFts.run(lastInsertRowid, texts[i]);
        stats.chunks += 1;
      }
      stats.notesIndexed += 1;
    }

    // FTS5 external-content tables don't self-heal after row deletes; rebuild
    // is cheap at this corpus size and keeps bm25 honest.
    db.exec(`INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')`);
    return stats;
  } finally {
    db.close();
  }
}

/** Strip FTS5 operators so a user's question can't become a malformed MATCH query. */
function toMatchQuery(query: string): string {
  const terms = query
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1);
  return terms.length ? terms.map((t) => `"${t}"`).join(' OR ') : '';
}

/**
 * Hybrid retrieval. Runs keyword and vector search independently, then fuses by
 * reciprocal rank — which needs no score calibration between the two, since
 * BM25 scores and cosine similarities live on incomparable scales.
 */
export async function search(query: string, limit = 8): Promise<Hit[]> {
  if (!existsSync(config.indexPath)) {
    throw new Error(`No search index at ${config.indexPath}. Run \`npm run index\` first.`);
  }
  const db = openDb();
  try {
    const pool = 50;
    const ranks = new Map<number, { rrf: number }>();
    const bump = (id: number, rank: number) => {
      const entry = ranks.get(id) ?? { rrf: 0 };
      entry.rrf += 1 / (RRF_K + rank);
      ranks.set(id, entry);
    };

    const match = toMatchQuery(query);
    if (match) {
      const keywordHits = db
        .prepare(
          `SELECT rowid AS id FROM chunks_fts WHERE chunks_fts MATCH ?
           ORDER BY bm25(chunks_fts) LIMIT ?`,
        )
        .all(match, pool) as { id: number }[];
      keywordHits.forEach((row, i) => bump(row.id, i));
    }

    const queryVector = Float32Array.from(await embedOne(query));
    const all = db.prepare('SELECT id, embedding FROM chunks').all() as {
      id: number;
      embedding: Uint8Array;
    }[];
    // Brute-force cosine. At a few thousand facts this is sub-millisecond and
    // costs no native dependency; revisit if the corpus reaches ~100k chunks.
    const vectorHits = all
      .map((row) => ({ id: row.id, score: dot(queryVector, fromBlob(row.embedding)) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, pool);
    vectorHits.forEach((row, i) => bump(row.id, i));

    if (ranks.size === 0) return [];

    const ids = [...ranks.keys()];
    const rows = db
      .prepare(
        `SELECT c.id, c.file, c.text, n.note_type AS noteType, n.title AS noteTitle
         FROM chunks c JOIN notes n ON n.file = c.file
         WHERE c.id IN (${ids.map(() => '?').join(',')})`,
      )
      .all(...ids) as unknown as Chunk[];

    return rows
      .map((row) => ({
        ...row,
        score: ranks.get(row.id)!.rrf * TYPE_WEIGHT[row.noteType],
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  } finally {
    db.close();
  }
}
