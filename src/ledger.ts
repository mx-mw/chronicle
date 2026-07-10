import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import {
  ensurePrivateDirectory,
  ensurePrivateFile,
  sha256,
  stableUuid,
  withFileLock,
} from './fs-safe.js';

export type LedgerEventType =
  | 'raw.persisted'
  | 'draft.staged'
  | 'draft.updated'
  | 'draft.approved'
  | 'draft.rejected';

export interface LedgerEvent {
  eventId: string;
  type: LedgerEventType;
  recordId: string;
  workspaceId: string;
  contentHash: string;
  revision: number;
  at: string;
  details?: Record<string, unknown>;
}

export function ledgerFile(kbDir: string): string {
  return path.join(kbDir, '.chronicle', 'ledger.db');
}

async function hardenLedgerFiles(kbDir: string): Promise<void> {
  await Promise.all(
    ['', '-wal', '-shm'].map((suffix) => ensurePrivateFile(`${ledgerFile(kbDir)}${suffix}`)),
  );
}

function openLedger(kbDir: string, readOnly = false): DatabaseSync {
  const db = readOnly
    ? new DatabaseSync(ledgerFile(kbDir), { readOnly: true })
    : new DatabaseSync(ledgerFile(kbDir));
  if (!readOnly) {
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (
        event_id     TEXT PRIMARY KEY,
        type         TEXT NOT NULL,
        record_id    TEXT NOT NULL,
        workspace_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        revision     INTEGER NOT NULL,
        at           TEXT NOT NULL,
        details_json TEXT
      );
      CREATE INDEX IF NOT EXISTS events_record ON events(workspace_id, record_id, at);
      CREATE INDEX IF NOT EXISTS events_type ON events(type, at);
    `);
  }
  return db;
}

function rowsToEvents(rows: Record<string, unknown>[]): LedgerEvent[] {
  return rows.map((row) => ({
    eventId: String(row.eventId),
    type: String(row.type) as LedgerEventType,
    recordId: String(row.recordId),
    workspaceId: String(row.workspaceId),
    contentHash: String(row.contentHash),
    revision: Number(row.revision),
    at: String(row.at),
    details: row.detailsJson ? (JSON.parse(String(row.detailsJson)) as Record<string, unknown>) : undefined,
  }));
}

export async function readLedger(kbDir: string): Promise<LedgerEvent[]> {
  if (!existsSync(ledgerFile(kbDir))) return [];
  await hardenLedgerFiles(kbDir);
  const db = openLedger(kbDir, true);
  try {
    return rowsToEvents(
      db
        .prepare(
          `SELECT event_id AS eventId, type, record_id AS recordId,
                  workspace_id AS workspaceId, content_hash AS contentHash,
                  revision, at, details_json AS detailsJson
           FROM events ORDER BY at, rowid`,
        )
        .all() as Record<string, unknown>[],
    );
  } finally {
    db.close();
  }
}

/** Idempotent transactional append keyed by record transition and revision. */
export async function appendLedgerEvent(
  kbDir: string,
  event: Omit<LedgerEvent, 'eventId' | 'at'> & { at?: string },
): Promise<LedgerEvent> {
  const identity = `${event.workspaceId}\0${event.recordId}\0${event.type}\0${event.revision}\0${event.contentHash}`;
  const eventId = stableUuid('chronicle-ledger', sha256(identity));
  const complete: LedgerEvent = {
    ...event,
    eventId,
    at: event.at ?? new Date().toISOString(),
  };
  await ensurePrivateDirectory(path.dirname(ledgerFile(kbDir)));
  await (await open(ledgerFile(kbDir), 'a', 0o600)).close();
  await hardenLedgerFiles(kbDir);
  return withFileLock(path.join(kbDir, '.chronicle', 'ledger.lock'), async () => {
    const db = openLedger(kbDir);
    try {
      await hardenLedgerFiles(kbDir);
      db.exec('BEGIN IMMEDIATE');
      db.prepare(
        `INSERT OR IGNORE INTO events
         (event_id, type, record_id, workspace_id, content_hash, revision, at, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        complete.eventId,
        complete.type,
        complete.recordId,
        complete.workspaceId,
        complete.contentHash,
        complete.revision,
        complete.at,
        complete.details ? JSON.stringify(complete.details) : null,
      );
      const row = db
        .prepare(
          `SELECT event_id AS eventId, type, record_id AS recordId,
                  workspace_id AS workspaceId, content_hash AS contentHash,
                  revision, at, details_json AS detailsJson
           FROM events WHERE event_id = ?`,
        )
        .get(eventId) as Record<string, unknown>;
      db.exec('COMMIT');
      return rowsToEvents([row])[0];
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally {
      db.close();
      await hardenLedgerFiles(kbDir);
    }
  });
}

export async function latestLedgerEvent(
  kbDir: string,
  recordId: string,
  workspaceId: string,
): Promise<LedgerEvent | undefined> {
  if (!existsSync(ledgerFile(kbDir))) return undefined;
  await hardenLedgerFiles(kbDir);
  const db = openLedger(kbDir, true);
  try {
    const row = db
      .prepare(
        `SELECT event_id AS eventId, type, record_id AS recordId,
                workspace_id AS workspaceId, content_hash AS contentHash,
                revision, at, details_json AS detailsJson
         FROM events WHERE record_id = ? AND workspace_id = ?
         ORDER BY at DESC, rowid DESC LIMIT 1`,
      )
      .get(recordId, workspaceId) as Record<string, unknown> | undefined;
    return row ? rowsToEvents([row])[0] : undefined;
  } finally {
    db.close();
  }
}
