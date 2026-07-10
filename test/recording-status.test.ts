import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatActionableSessionPage } from '../src/recording-status.js';
import { createSessionManifest, type LocatedSessionManifest } from '../src/session-manifest.js';

function located(id: string, createdAt: string): LocatedSessionManifest {
  const manifest = createSessionManifest({ id, guildId: 'g', channelId: 'c' });
  manifest.createdAt = createdAt;
  manifest.stage = 'needs_review';
  return { path: `/${id}/session.json`, dir: `/${id}`, manifest };
}

test('actionable session pages are newest-first and expose pagination', () => {
  const sessions = [
    located('old', '2026-07-01T00:00:00.000Z'),
    located('new', '2026-07-03T00:00:00.000Z'),
    located('middle', '2026-07-02T00:00:00.000Z'),
  ];
  const first = formatActionableSessionPage(sessions, { pageSize: 2 });
  assert.match(first.text, /^new .*\nmiddle /);
  assert.match(first.text, /Page 1\/2/);
  const second = formatActionableSessionPage(sessions, { page: 2, pageSize: 2 });
  assert.match(second.text, /^old /);
});
