import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const publicRoot = new URL('../src/web/public/', import.meta.url);

async function readAsset(name: string): Promise<string> {
  return readFile(new URL(name, publicRoot), 'utf8');
}

test('frontend shell keeps the task-first information architecture', async () => {
  const html = await readAsset('index.html');

  assert.match(html, /data-view-link="home"[^>]*>[\s\S]*?<span>Home<\/span>/);
  assert.match(html, /data-view-link="inbox"[^>]*>[\s\S]*?<span>Review<\/span>/);
  assert.match(html, /data-view-link="library"[^>]*><span>Library<\/span>/);
  assert.match(html, /data-view-link="trust"[^>]*><span>Settings<\/span>/);
  assert.doesNotMatch(html, /class="nav-item"[^>]*data-command-link/);
  assert.doesNotMatch(html, /class="nav-item"[^>]*data-view-link="(?:digest|records|topics|capture)"/);
});

test('search is an on-demand dialog and the saved theme is restored before paint', async () => {
  const [html, app, theme] = await Promise.all([
    readAsset('index.html'),
    readAsset('app.js'),
    readAsset('theme-init.js'),
  ]);

  const themeScript = html.indexOf('<script src="/theme-init.js"></script>');
  const firstStylesheet = html.indexOf('<link rel="stylesheet"');
  assert.ok(themeScript >= 0 && themeScript < firstStylesheet);
  assert.match(html, /id="command-panel"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*hidden/);
  assert.match(html, /id="search-button"[^>]*data-command-link="find"/);
  assert.match(app, /function openCommand\(mode = 'find'\)/);
  assert.match(app, /event\.key === '\/'/);
  assert.match(theme, /localStorage\.getItem\('chronicle-theme'\)/);
});

test('review and library preserve the new read-first, content-first interaction model', async () => {
  const [app, css] = await Promise.all([
    readAsset('app.js'),
    readAsset('organic.css'),
  ]);

  assert.match(app, /<details class="edit-draft">/);
  assert.match(app, /What Chronicle understood/);
  assert.match(app, /function libraryBoardMarkup/);
  assert.match(app, /async function renderSources/);
  assert.match(app, /api\('\/api\/sources\?limit=24'\)/);
  assert.match(app, /api\(`\/api\/sources\/\$\{encodeURIComponent\(id\)\}`\)/);
  assert.match(app, /data-discard-source/);
  assert.match(app, /data-view-link="library"[^>]*>Sources<\/button>/);
  assert.match(app, /data-source-id=/);
  assert.match(app, /if \(view === 'library'\) return \{ view, id: detail \|\| undefined \}/);
  assert.match(app, /async function renderHome/);
  assert.match(css, /\.library-board\s*\{[\s\S]*column-count:/);
  assert.match(css, /\.source-status-row\s*\{/);
  assert.match(css, /\.library-tabs\s*\{[\s\S]*grid-template-columns: repeat\(3/);
  assert.match(css, /\.home-grid\s*\{[\s\S]*grid-template-columns: repeat\(12/);
  assert.doesNotMatch(css, /transition:\s*all\b/);
});

test('source Library treats deletion and catalog availability as terminal UI state', async () => {
  const app = await readAsset('app.js');

  assert.match(app, /recordType: sourceText\(raw\.recordType\) \|\| \(sourceStatus === 'discarded' \? 'tombstone' : 'source'\)/);
  assert.match(app, /if \(incomingTombstone\) \{\s*merged\.set\(source\.id, source\);\s*return;\s*\}/);
  assert.match(app, /if \(previousTombstone\) return;/);
  assert.match(app, /state\.sourcesAvailable = data\.available !== false;/);
  assert.match(app, /state\.sourcesAvailable === false/);
  assert.match(app, /sequence === state\.renderSequence &&\s*state\.view === 'library' &&\s*state\.selectedSourceId === id/);
});
