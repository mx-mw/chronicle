import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collisionSafeBasename } from '../src/fs-safe.js';
import { runMaintenance } from '../src/maintenance.js';

test('maintenance resolves workspace transcript links and still reports missing targets', async (t) => {
  const kbDir = await mkdtemp(path.join(os.tmpdir(), 'chronicle-maintenance-'));
  t.after(() => rm(kbDir, { recursive: true, force: true }));
  const workspaceId = 'project-alpha';
  const workspaceKey = collisionSafeBasename(workspaceId, workspaceId, 80);
  const workspaceRoot = path.join(kbDir, 'workspaces', workspaceKey);
  await mkdir(path.join(workspaceRoot, 'meetings'), { recursive: true });
  await mkdir(path.join(workspaceRoot, 'topics'), { recursive: true });
  await mkdir(path.join(workspaceRoot, 'transcripts'), { recursive: true });

  await writeFile(
    path.join(workspaceRoot, 'transcripts', 'capture-123.md'),
    `---\ntype: "transcript"\nworkspace: "${workspaceId}"\n---\n\n# Raw source capture\n`,
  );
  await writeFile(
    path.join(workspaceRoot, 'topics', 'collision.md'),
    `---\ntype: "topic"\nworkspace: "${workspaceId}"\n---\n\n# Collision\n`,
  );
  await writeFile(
    path.join(workspaceRoot, 'meetings', 'record.md'),
      `---\ntype: "meeting"\nworkspace: "${workspaceId}"\ndate: "2026-07-11"\n---\n\n` +
      `# Record\n\n` +
      `## Provenance\n- [[transcripts/capture-123]]\n- [[transcripts/collision]]\n- [[transcripts/missing-capture]]\n\n` +
      `## Topics\n- [[topics/collision]]\n`,
  );

  const report = await runMaintenance({
    kbDir,
    workspaceId,
    now: new Date('2026-07-11T12:00:00.000Z'),
  });
  const brokenLinks = report.issues.filter((issue) => issue.type === 'broken_link');

  assert.equal(report.documentCount, 2);
  assert.equal(report.recordCount, 1);
  assert.deepEqual(
    brokenLinks.map((issue) => issue.detail),
    [
      'Link target "transcripts/collision" does not resolve in this workspace.',
      'Link target "transcripts/missing-capture" does not resolve in this workspace.',
    ],
  );
});
