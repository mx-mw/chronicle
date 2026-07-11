import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('review CLI rejects malformed flags without exposing an internal stack', (t) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'chronicle-review-cli-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (args: string[]) => spawnSync(
    process.execPath,
    ['--import', 'tsx', 'src/review-cli.ts', ...args],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        KB_DIR: path.join(root, 'kb'),
        SESSIONS_DIR: path.join(root, 'sessions'),
      },
    },
  );

  for (const [args, expected] of [
    [['list', '--workspace', '--json'], /--workspace needs a value/],
    [['list', '--workspace'], /--workspace needs a value/],
    [['list', '--unknown'], /Unknown option/],
    [['show', 'draft-id', '--status', 'approved'], /only with the list command/],
  ] as const) {
    const result = run([...args]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stderr, /\n\s+at\s|review-cli\.ts:\d+/);
  }
});
