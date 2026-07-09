// The Chronicle web UI: a single node:http process over kb/. Serves a
// server-rendered shell (palace map baked in for instant load) plus a small
// JSON API for search, recall, and reading notes. No framework, no bundler, no
// external deps — the KB is text, and this loads like text.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { describeProvider } from '../llm.js';
import { search } from '../store.js';
import { recall } from '../recall.js';
import { renderMarkdown, escapeHtml } from './markdown.js';
import { buildPalaceMap, readNote, NoteAccessError, type NoteSummary } from './notes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');

const HOST = process.env.WEB_HOST || '127.0.0.1'; // no auth: localhost only by default
const PORT = Number(process.env.WEB_PORT || process.env.PORT || 4321);
const MAX_BODY = 16 * 1024; // recall questions are a sentence, not a payload

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

/** Chunk count for /healthz. Read-only, best-effort: a missing/locked index is not an error here. */
function indexedChunks(): number | null {
  if (!existsSync(config.indexPath)) return null;
  try {
    const db = new DatabaseSync(config.indexPath, { readOnly: true });
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM chunks').get() as { n: number };
      return row.n;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

function renderMapSection(notes: NoteSummary[], emptyLabel: string): string {
  if (notes.length === 0) return `<li class="empty">${emptyLabel}</li>`;
  return notes
    .map(
      (n) =>
        `<li><a class="note-link" href="#/note/${escapeHtml(n.file)}" data-note="${escapeHtml(
          n.file,
        )}"><span class="note-title">${escapeHtml(n.title)}</span>` +
        (n.description ? `<span class="note-desc">${escapeHtml(n.description)}</span>` : '') +
        `</a></li>`,
    )
    .join('');
}

/** Serve the shell with the palace map and health snapshot rendered in. */
async function serveShell(res: ServerResponse): Promise<void> {
  const template = await readFile(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  let topicsHtml = '<li class="empty">No topics yet.</li>';
  let meetingsHtml = '<li class="empty">No meetings yet.</li>';
  try {
    const map = await buildPalaceMap();
    topicsHtml = renderMapSection(map.topics, 'No topics yet.');
    meetingsHtml = renderMapSection(map.meetings, 'No meetings yet.');
  } catch {
    // kb/ unreadable — ship the shell anyway so the page explains itself.
  }

  const chunks = indexedChunks();
  const health =
    chunks === null
      ? 'index not built — run <code>npm run index</code>'
      : `${chunks} chunk${chunks === 1 ? '' : 's'} indexed`;

  const html = template
    .replace('<!--TOPICS-->', topicsHtml)
    .replace('<!--MEETINGS-->', meetingsHtml)
    .replace('<!--PROVIDER-->', escapeHtml(describeProvider()))
    .replace('<!--HEALTH-->', health);
  sendText(res, 200, 'text/html; charset=utf-8', html);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer) => {
      if (done) return;
      size += chunk.length;
      if (size > MAX_BODY) {
        // Stop buffering and reject, but leave the socket alive so the caller can
        // still write a clean 413 back before we drain the rest of the request.
        done = true;
        req.off('data', onData);
        req.resume();
        reject(new NoteAccessError('Request body too large', 413));
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

/** search() throws a helpful "run npm run index" message when the index is absent — surface that, not a 500. */
function isMissingIndex(err: unknown): boolean {
  return err instanceof Error && /No search index/.test(err.message);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const { pathname } = url;
  const method = req.method ?? 'GET';

  if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    return serveShell(res);
  }

  if (method === 'GET' && pathname === '/healthz') {
    return sendJson(res, 200, {
      ok: true,
      provider: config.llmProvider,
      providerLabel: describeProvider(),
      indexed: indexedChunks(),
    });
  }

  if (method === 'GET' && pathname === '/api/search') {
    const q = (url.searchParams.get('q') ?? '').trim();
    if (!q) return sendJson(res, 200, { hits: [] });
    try {
      const hits = await search(q);
      return sendJson(res, 200, { hits });
    } catch (err) {
      if (isMissingIndex(err)) {
        return sendJson(res, 503, { error: 'index_missing', message: (err as Error).message });
      }
      return sendJson(res, 500, { error: 'search_failed', message: String((err as Error).message) });
    }
  }

  if (method === 'POST' && pathname === '/api/recall') {
    let question = '';
    try {
      const raw = await readBody(req);
      question = (JSON.parse(raw || '{}').question ?? '').toString().trim();
    } catch (err) {
      if (err instanceof NoteAccessError) return sendJson(res, err.status, { error: 'too_large' });
      return sendJson(res, 400, { error: 'bad_request', message: 'Body must be JSON { question }' });
    }
    if (!question) return sendJson(res, 400, { error: 'empty_question' });
    try {
      const { answer, hits } = await recall(question);
      return sendJson(res, 200, { answer, answerHtml: renderMarkdown(answer), hits });
    } catch (err) {
      if (isMissingIndex(err)) {
        return sendJson(res, 503, { error: 'index_missing', message: (err as Error).message });
      }
      return sendJson(res, 500, { error: 'recall_failed', message: String((err as Error).message) });
    }
  }

  if (method === 'GET' && pathname === '/api/notes') {
    try {
      const map = await buildPalaceMap();
      return sendJson(res, 200, map);
    } catch (err) {
      return sendJson(res, 500, { error: 'list_failed', message: String((err as Error).message) });
    }
  }

  if (method === 'GET' && pathname.startsWith('/api/notes/')) {
    const rel = decodeURIComponent(pathname.slice('/api/notes/'.length));
    try {
      const note = await readNote(rel);
      return sendJson(res, 200, { ...note, html: renderMarkdown(note.markdown) });
    } catch (err) {
      if (err instanceof NoteAccessError) {
        return sendJson(res, err.status, { error: 'note_access', message: err.message });
      }
      return sendJson(res, 500, { error: 'read_failed', message: String((err as Error).message) });
    }
  }

  return sendJson(res, 404, { error: 'not_found' });
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!res.headersSent) sendJson(res, 500, { error: 'internal', message: String(err?.message ?? err) });
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Chronicle web UI on http://${HOST}:${PORT}  (${describeProvider()})`);
});
