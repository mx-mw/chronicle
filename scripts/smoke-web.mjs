import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const port = 46_000 + Math.floor(Math.random() * 1_000);
const kbDir = await mkdtemp(path.join(tmpdir(), 'chronicle-smoke-'));

const child = spawn(process.execPath, ['dist/web/server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    KB_DIR: kbDir,
    INDEX_PATH: path.join(kbDir, '.index.db'),
    SESSIONS_DIR: path.join(kbDir, 'sessions'),
    WEB_HOST: '127.0.0.1',
    WEB_PORT: String(port),
    LLM_PROVIDER: 'local',
    LLM_BASE_URL: 'http://127.0.0.1:11434/v1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

async function waitForServer() {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Web server exited early (${child.exitCode}).\n${stderr}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (response.status === 200 || response.status === 503) return response;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Web server did not become healthy within 8 seconds.\n${stderr}`);
}

try {
  const health = await waitForServer();
  const healthBody = await health.json();
  if (typeof healthBody.ok !== 'boolean' || !Array.isArray(healthBody.issues)) {
    throw new Error(`Unexpected health response: ${JSON.stringify(healthBody)}`);
  }

  const trust = await fetch(`http://127.0.0.1:${port}/api/trust`);
  const trustBody = await trust.json();
  if (!trust.ok || typeof trustBody.checkedAt !== 'string') {
    throw new Error(`Trust API failed (${trust.status}): ${JSON.stringify(trustBody)}`);
  }

  const shell = await fetch(`http://127.0.0.1:${port}/`);
  const html = await shell.text();
  if (!shell.ok || !html.includes('<title>Chronicle')) {
    throw new Error(`Production shell failed (${shell.status}): ${html.slice(0, 300)}`);
  }
  console.log(`Production web smoke test passed on port ${port}.`);
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 2_000).unref();
  });
  await rm(kbDir, { recursive: true, force: true });
}
