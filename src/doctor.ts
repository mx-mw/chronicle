import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, rm, statfs, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { config, environmentFileSecurity } from './config.js';
import { ensurePrivateDirectory } from './fs-safe.js';
import { assertModelEndpointAllowed, isLoopbackUrl } from './runtime.js';
import { getIndexHealth } from './store.js';

const run = promisify(execFile);

export type DoctorStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorStatus;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  ready: boolean;
  generatedAt: string;
  checks: DoctorCheck[];
}

function check(
  id: string,
  label: string,
  status: DoctorStatus,
  detail: string,
  fix?: string,
): DoctorCheck {
  return { id, label, status, detail, ...(fix ? { fix } : {}) };
}

export function parseNodeVersion(version: string): [number, number, number] {
  const match = version.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return [0, 0, 0];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function meetsMinimumVersion(
  current: [number, number, number],
  minimum: [number, number, number],
): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (current[i] > minimum[i]) return true;
    if (current[i] < minimum[i]) return false;
  }
  return true;
}

async function executableCheck(
  id: string,
  label: string,
  binary: string,
  args: string[],
  fix: string,
  optional = false,
): Promise<DoctorCheck> {
  try {
    const { stdout, stderr } = await run(binary, args, {
      timeout: 8_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const firstLine = `${stdout}\n${stderr}`
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    return check(id, label, 'pass', firstLine || `${binary} is available`);
  } catch (error) {
    const timedOut = (error as NodeJS.ErrnoException & { killed?: boolean }).killed;
    return check(
      id,
      label,
      optional ? 'warn' : 'fail',
      timedOut ? `${binary} did not respond within 8 seconds` : `${binary} is not available`,
      fix,
    );
  }
}

function normalizeBaseUrl(raw: string): string {
  return raw.replace(/\/+$/, '');
}

export function advertisedModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((item) =>
      item && typeof item === 'object' ? String((item as { id?: unknown }).id ?? '').trim() : '',
    )
    .filter(Boolean);
}

export function modelIdAvailable(modelIds: readonly string[], expectedModel: string): boolean {
  const normalizeDefaultTag = (model: string) =>
    model.endsWith(':latest') ? model.slice(0, -':latest'.length) : model;
  const expected = normalizeDefaultTag(expectedModel);
  return modelIds.some((model) => normalizeDefaultTag(model) === expected);
}

async function endpointCheck(
  id: string,
  label: string,
  baseUrl: string,
  expectedModel: string,
  fix: string,
): Promise<DoctorCheck> {
  try {
    assertModelEndpointAllowed(baseUrl, label);
  } catch (error) {
    return check(
      id,
      label,
      'fail',
      error instanceof Error ? error.message : String(error),
      'Use a loopback endpoint or explicitly acknowledge it with ALLOW_REMOTE_MODEL_ENDPOINTS=true.',
    );
  }
  const endpoint = `${normalizeBaseUrl(baseUrl)}/models`;
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(4_000) });
    if (!response.ok) {
      return check(id, label, 'fail', `Model server returned HTTP ${response.status}`, fix);
    }
    const payload = await response.json().catch(() => undefined);
    const modelIds = advertisedModelIds(payload);
    if (modelIds.length && !modelIdAvailable(modelIds, expectedModel)) {
      return check(
        id,
        label,
        'fail',
        `Server is reachable but does not advertise ${expectedModel}`,
        fix,
      );
    }
    return check(
      id,
      label,
      modelIds.length ? 'pass' : 'warn',
      modelIds.length
        ? `${expectedModel} is available at ${new URL(baseUrl).host}`
        : `Server responded at ${new URL(baseUrl).host}, but /models did not report model IDs`,
      modelIds.length ? undefined : fix,
    );
  } catch (error) {
    return check(
      id,
      label,
      'fail',
      `Could not reach ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      fix,
    );
  }
}

function policyChecks(discordConfigured = Boolean(process.env.DISCORD_TOKEN)): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const autoRecord = config.autoRecord;
  const recordPolicy = config.recordPolicy;
  const recordRules =
    recordPolicy.guildIds.length +
    recordPolicy.channelIds.length +
    recordPolicy.userIds.length +
    recordPolicy.roleIds.length;
  const recordComplete = Boolean(
    recordPolicy.guildIds.length &&
      recordPolicy.channelIds.length &&
      (recordPolicy.userIds.length || recordPolicy.roleIds.length),
  );

  if (!autoRecord) {
    checks.push(check('auto-record', 'Automatic recording', 'pass', 'Disabled by default'));
  } else if (recordComplete) {
    checks.push(
      check(
        'auto-record',
        'Automatic recording',
        'pass',
        `Enabled with ${recordPolicy.guildIds.length} guild, ${recordPolicy.channelIds.length} channel, and ${recordPolicy.userIds.length + recordPolicy.roleIds.length} identity rule(s)`,
      ),
    );
  } else {
    checks.push(
      check(
        'auto-record',
        'Automatic recording',
        'fail',
        'Enabled without complete guild, channel, and user or role allowlists',
        'Set RECORD_GUILD_IDS, RECORD_CHANNEL_IDS, and RECORD_USER_IDS or RECORD_ROLE_IDS, or disable AUTO_RECORD.',
      ),
    );
  }

  checks.push(
    recordComplete
      ? check('record-policy', 'Recording authorization', 'pass', `${recordRules} allowlist rule(s) configured`)
      : check(
          'record-policy',
          'Recording authorization',
          discordConfigured ? 'fail' : 'warn',
          'The record allowlist is incomplete, so manual recording is denied',
          'Set RECORD_GUILD_IDS, RECORD_CHANNEL_IDS, and RECORD_USER_IDS or RECORD_ROLE_IDS.',
        ),
  );

  const recallPolicy = config.recallPolicy;
  const recallRules =
    recallPolicy.guildIds.length +
    recallPolicy.channelIds.length +
    recallPolicy.userIds.length +
    recallPolicy.roleIds.length;
  const recallComplete = Boolean(
    recallPolicy.guildIds.length &&
      recallPolicy.channelIds.length &&
      (recallPolicy.userIds.length || recallPolicy.roleIds.length),
  );
  checks.push(
    recallComplete
      ? check('recall-policy', 'Recall authorization', 'pass', `${recallRules} allowlist rule(s) configured`)
      : check(
          'recall-policy',
          'Recall authorization',
          discordConfigured ? 'fail' : 'warn',
          'No recall allowlist is configured, so Discord recall is denied',
          'Set RECALL_GUILD_IDS, RECALL_CHANNEL_IDS, and RECALL_USER_IDS or RECALL_ROLE_IDS.',
        ),
  );

  checks.push(
    config.requireReview
      ? check('review', 'Review boundary', 'pass', 'Draft review is required before indexing')
      : check(
          'review',
          'Review boundary',
          'warn',
          'Drafts are configured for automatic approval',
          'Set REQUIRE_REVIEW=true for trustworthy durable memory.',
        ),
  );

  const host = process.env.WEB_HOST || '127.0.0.1';
  const loopback = isLoopbackUrl(`http://${host.includes(':') ? `[${host}]` : host}`);
  checks.push(
    loopback || process.env.WEB_AUTH_TOKEN
      ? check(
          'web-bind',
          'Web access',
          'pass',
          loopback ? `Bound to loopback (${host})` : 'Remote bind protected by WEB_AUTH_TOKEN',
        )
      : check(
          'web-bind',
          'Web access',
          'fail',
          `WEB_HOST=${host} is not loopback and WEB_AUTH_TOKEN is empty`,
          'Set WEB_AUTH_TOKEN or bind WEB_HOST to 127.0.0.1.',
        ),
  );

  return checks;
}

async function storageCheck(): Promise<DoctorCheck> {
  const probe = path.join(config.kbDir, `.doctor-${randomUUID()}`);
  try {
    await mkdir(config.kbDir, { recursive: true });
    await writeFile(probe, 'chronicle doctor\n', { flag: 'wx' });
    await access(config.kbDir, constants.R_OK | constants.W_OK);
    return check('storage', 'Knowledge base', 'pass', `${config.kbDir} is readable and writable`);
  } catch (error) {
    return check(
      'storage',
      'Knowledge base',
      'fail',
      error instanceof Error ? error.message : String(error),
      'Set KB_DIR to a readable and writable directory.',
    );
  } finally {
    await rm(probe, { force: true }).catch(() => {});
  }
}

function gibibytes(bytes: number): string {
  return `${(bytes / (1024 ** 3)).toFixed(1)} GiB`;
}

async function captureStorageCheck(): Promise<DoctorCheck> {
  try {
    await ensurePrivateDirectory(config.sessionsDir);
    await access(config.sessionsDir, constants.R_OK | constants.W_OK);
    const filesystem = await statfs(config.sessionsDir);
    const freeBytes = Math.max(0, Math.floor(filesystem.bavail * filesystem.bsize));
    if (!Number.isSafeInteger(freeBytes)) {
      throw new Error('Filesystem free-space result is outside JavaScript safe-integer range.');
    }
    return freeBytes < config.minFreeDiskBytes
      ? check(
          'capture-storage',
          'Capture storage',
          'fail',
          `${gibibytes(freeBytes)} free is below the ${gibibytes(config.minFreeDiskBytes)} reserve`,
          'Free disk space or lower MIN_FREE_DISK_BYTES deliberately before recording.',
        )
      : check(
          'capture-storage',
          'Capture storage',
          'pass',
          `${gibibytes(freeBytes)} free; ${gibibytes(config.minFreeDiskBytes)} is reserved`,
        );
  } catch (error) {
    return check(
      'capture-storage',
      'Capture storage',
      'fail',
      error instanceof Error ? error.message : String(error),
      'Set SESSIONS_DIR to a writable filesystem with enough free space.',
    );
  }
}

export async function runDoctor(options: { offline?: boolean } = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const current = parseNodeVersion(process.version);
  checks.push(
    meetsMinimumVersion(current, [22, 12, 0])
      ? check('node', 'Node.js', 'pass', process.version)
      : check('node', 'Node.js', 'fail', `${process.version} is unsupported`, 'Install Node.js 22.12 or newer.'),
  );

  checks.push(
    await executableCheck('ffmpeg', 'ffmpeg', 'ffmpeg', ['-version'], 'Install with: brew install ffmpeg'),
    await executableCheck('ffprobe', 'ffprobe', 'ffprobe', ['-version'], 'Install with: brew install ffmpeg'),
    await executableCheck(
      'parakeet',
      'Parakeet MLX',
      config.parakeetBin,
      ['--help'],
      'Install with: uv tool install parakeet-mlx --with "mlx==0.31.2"',
    ),
    await executableCheck(
      'yt-dlp',
      'YouTube ingestion',
      'yt-dlp',
      ['--version'],
      'Install with: brew install yt-dlp',
      true,
    ),
  );

  checks.push(await storageCheck());
  checks.push(await captureStorageCheck());
  checks.push(
    !environmentFileSecurity.present
      ? check(
          'env-permissions',
          'Environment secrets',
          'warn',
          'No .env file is present; Chronicle assumes secrets are injected by the process environment',
        )
      : check(
          'env-permissions',
          'Environment secrets',
          'pass',
          environmentFileSecurity.corrected
            ? 'Corrected the environment file to owner-only permissions (0600)'
            : 'Environment file uses owner-only permissions (0600)',
        ),
  );
  const index = getIndexHealth();
  checks.push(
    !index.exists
      ? check(
          'index',
          'Search index',
          'fail',
          'Not built',
          'Run: npm run index',
        )
      : !index.compatible
        ? check(
            'index',
            'Search index',
            'fail',
            'Schema or embedding metadata is incompatible',
            'Run: npm run index -- --force',
          )
        : !index.fresh
          ? check(
              'index',
              'Search index',
              'fail',
              index.lastError ? `Stale after error: ${index.lastError}` : 'Stale relative to approved memory',
              'Run: npm run index',
            )
          : check(
              'index',
              'Search index',
              'pass',
              `${index.chunks} chunk(s), generation ${index.indexedGeneration}`,
            ),
  );
  checks.push(...policyChecks());

  checks.push(
    process.env.DISCORD_TOKEN
      ? check('discord-token', 'Discord token', 'pass', 'Configured without exposing its value')
      : check(
          'discord-token',
          'Discord token',
          'warn',
          'Not configured; CLI and web workflows still work',
          'Set DISCORD_TOKEN to run the Discord bot.',
        ),
  );

  if (options.offline) {
    checks.push(
      check('llm', 'Distillation model', 'warn', 'Network check skipped with --offline'),
      check('embeddings', 'Embedding model', 'warn', 'Network check skipped with --offline'),
    );
  } else {
    const localProvider = config.llmProvider === 'local';
    const llmCheck = localProvider
      ? await endpointCheck(
          'llm',
          'Distillation model',
          config.llmBaseUrl,
          config.llmModel,
          `Start the configured model server and make ${config.llmModel} available.`,
        )
      : check(
          'llm',
          'Distillation model',
          'pass',
          `Anthropic is explicitly selected (${config.anthropicModel}); no billable test request was sent`,
        );
    checks.push(llmCheck);
    checks.push(
      await endpointCheck(
        'embeddings',
        'Embedding model',
        config.embedBaseUrl,
        config.embedModel,
        `Start the embedding server and make ${config.embedModel} available.`,
      ),
    );
  }

  return {
    ready: checks.every((item) => item.status !== 'fail'),
    generatedAt: new Date().toISOString(),
    checks,
  };
}

function printReport(report: DoctorReport): void {
  for (const item of report.checks) {
    console.log(`${item.status.toUpperCase().padEnd(4)}  ${item.label}: ${item.detail}`);
    if (item.fix) console.log(`      Fix: ${item.fix}`);
  }
  console.log('');
  console.log(report.ready ? 'Chronicle is ready.' : 'Chronicle is not ready. Fix the failed checks above.');
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const report = await runDoctor({ offline: args.has('--offline') });
  if (args.has('--json')) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  if (!report.ready) process.exitCode = 1;
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
