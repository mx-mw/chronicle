import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { processMeeting } from '../src/pipeline.js';
import {
  createSessionManifest,
  manifestPath,
  readSessionManifest,
  writeJsonAtomic,
} from '../src/session-manifest.js';

test('an empty capture reaches a terminal stage instead of recovering forever', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'chronicle-empty-pipeline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, 'session');
  await mkdir(dir);
  const file = manifestPath(dir);
  await writeJsonAtomic(file, createSessionManifest({ guildId: 'guild-a', channelId: 'channel-a' }));

  const result = await processMeeting([], new Map(), 0, undefined, {
    manifestPath: file,
    workspaceId: 'guild-a',
  });
  assert.equal(result, null);
  const manifest = await readSessionManifest(file);
  assert.equal(manifest.stage, 'empty');
  assert.match(manifest.warnings.join(' '), /No usable speech/);
});
