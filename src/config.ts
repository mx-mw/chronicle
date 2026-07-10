import 'dotenv/config';
import { chmodSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AccessPolicy } from './policy.js';
import {
  DEFAULT_MAX_RECORDING_MINUTES,
  DEFAULT_MAX_SESSION_SEGMENTS,
  DEFAULT_MAX_SESSION_AUDIO_BYTES,
  DEFAULT_MIN_FREE_DISK_BYTES,
} from './recording-limits.js';

export interface EnvironmentFileSecurity {
  path: string;
  present: boolean;
  corrected: boolean;
}

function enforcePrivateEnvironmentFile(): EnvironmentFileSecurity {
  const file = path.resolve(process.env.DOTENV_CONFIG_PATH?.trim() || '.env');
  if (process.platform === 'win32') {
    try {
      return { path: file, present: statSync(file).isFile(), corrected: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { path: file, present: false, corrected: false };
      }
      throw error;
    }
  }
  try {
    const before = statSync(file);
    if (!before.isFile()) throw new Error(`Chronicle environment path is not a file: ${file}`);
    const exposed = (before.mode & 0o077) !== 0;
    if (exposed) chmodSync(file, 0o600);
    const after = statSync(file);
    if ((after.mode & 0o077) !== 0) {
      throw new Error(`Chronicle could not secure ${file}; it must use owner-only permissions (0600).`);
    }
    return { path: file, present: true, corrected: exposed };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path: file, present: false, corrected: false };
    }
    throw error;
  }
}

/** Every CLI/server entry point imports config, so secret-file mode is enforced centrally. */
export const environmentFileSecurity = enforcePrivateEnvironmentFile();

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${key}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

function firstEnv(...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = process.env[key];
    if (value?.trim()) return value;
  }
  return undefined;
}

/** Parse a comma-separated allowlist. Empty means "allow nobody", never "allow everybody". */
function idList(...keys: string[]): string[] {
  const raw = firstEnv(...keys);
  if (!raw) return [];
  return [...new Set(raw.split(',').map((value) => value.trim()).filter(Boolean))];
}

function boolEnv(key: string, fallback: boolean): boolean {
  const raw = process.env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${key} must be true or false, got "${process.env[key]}".`);
}

function numberEnv(key: string, fallback: number, minimum = 0): number {
  const raw = process.env[key]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < minimum) {
    throw new Error(`${key} must be a number greater than or equal to ${minimum}, got "${raw}".`);
  }
  return parsed;
}

function positiveSafeIntegerEnv(key: string, fallback: number): number {
  const value = numberEnv(key, fallback, 1);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${key} must be a positive whole number, got "${process.env[key]}".`);
  }
  return value;
}

function accessPolicy(scope: 'RECORD' | 'RECALL'): AccessPolicy {
  return {
    guildIds: idList(`${scope}_GUILD_IDS`, `${scope}_ALLOWED_GUILD_IDS`),
    channelIds: idList(`${scope}_CHANNEL_IDS`, `${scope}_ALLOWED_CHANNEL_IDS`),
    userIds: idList(`${scope}_USER_IDS`, `${scope}_ALLOWED_USER_IDS`),
    roleIds: idList(`${scope}_ROLE_IDS`, `${scope}_ALLOWED_ROLE_IDS`),
  };
}

export const config = {
  get discordToken(): string {
    return required('DISCORD_TOKEN');
  },
  /** Optional: register slash commands to a single guild for instant availability. */
  get guildId(): string | undefined {
    return process.env.GUILD_ID || undefined;
  },
  /**
   * Which backend distils meetings. `local` keeps everything offline; `anthropic`
   * sends transcripts to Claude. Defaults to local — going off-machine should be
   * a deliberate choice, never something you get by forgetting to set a variable.
   */
  get llmProvider(): 'local' | 'anthropic' {
    const raw = (process.env.LLM_PROVIDER || 'local').toLowerCase();
    if (raw !== 'local' && raw !== 'anthropic') {
      throw new Error(`LLM_PROVIDER must be "local" or "anthropic", got "${raw}".`);
    }
    if (raw === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
      throw new Error('LLM_PROVIDER=anthropic requires ANTHROPIC_API_KEY to be set.');
    }
    return raw;
  },
  get anthropicApiKey(): string {
    return required('ANTHROPIC_API_KEY');
  },
  get anthropicModel(): string {
    return process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
  },
  /** Base URL of the local OpenAI-compatible server (e.g. llama.cpp's `llama-server`). */
  get llmBaseUrl(): string {
    return process.env.LLM_BASE_URL || 'http://127.0.0.1:11434/v1';
  },
  /** Model name to send in the request; llama-server ignores this when serving a single GGUF. */
  get llmModel(): string {
    return process.env.CHRONICLE_MODEL || 'local';
  },
  /** Optional: only needed if llama-server was started with --api-key. */
  get llmApiKey(): string | undefined {
    return process.env.LLM_API_KEY || undefined;
  },
  /**
   * Embeddings default to the local distillation server. A remote endpoint is
   * supported only behind the explicit ALLOW_REMOTE_MODEL_ENDPOINTS boundary.
   */
  get embedBaseUrl(): string {
    return process.env.EMBED_BASE_URL || process.env.LLM_BASE_URL || 'http://127.0.0.1:11434/v1';
  },
  get embedModel(): string {
    return process.env.EMBED_MODEL || 'nomic-embed-text';
  },
  /** Where the SQLite search index lives. Always rebuildable from kb/. */
  get indexPath(): string {
    return process.env.INDEX_PATH || path.join(config.kbDir, '.index.db');
  },
  get parakeetBin(): string {
    return process.env.PARAKEET_BIN || 'parakeet-mlx';
  },
  get parakeetModel(): string {
    return process.env.PARAKEET_MODEL || 'mlx-community/parakeet-tdt-0.6b-v3';
  },
  get kbDir(): string {
    return path.resolve(process.env.KB_DIR || 'kb');
  },
  get sessionsDir(): string {
    return path.resolve(process.env.SESSIONS_DIR || 'sessions');
  },
  get workspaceId(): string {
    return process.env.WORKSPACE_ID?.trim() || 'default';
  },
  /**
   * Recording is opt-in even when Chronicle can see voice-state events. Turning
   * this on does not bypass the record allowlists below.
   */
  get autoRecord(): boolean {
    return boolEnv('AUTO_RECORD', false);
  },
  /** Time between a successful public notice and the first captured packet. */
  get consentGraceMs(): number {
    return numberEnv('CONSENT_GRACE_MS', 10_000);
  },
  /** Recording and recall deliberately have independent, deny-by-default policies. */
  get recordPolicy(): AccessPolicy {
    return accessPolicy('RECORD');
  },
  get recallPolicy(): AccessPolicy {
    return accessPolicy('RECALL');
  },
  /** New captures wait for a human review before durable KB promotion by default. */
  get requireReview(): boolean {
    return boolEnv('REQUIRE_REVIEW', true);
  },
  get processingTimeoutMs(): number {
    return numberEnv('PROCESSING_TIMEOUT_MS', 30 * 60_000, 1_000);
  },
  /** Number of retries after the initial processing attempt. */
  get processingRetries(): number {
    return Math.floor(numberEnv('PROCESSING_RETRIES', 2));
  },
  get processingQueueLimit(): number {
    return Math.floor(numberEnv('PROCESSING_QUEUE_LIMIT', 25, 1));
  },
  /** Raw PCM retention after capture. Set to 0 to purge immediately after processing. */
  get rawAudioRetentionHours(): number {
    return numberEnv('RAW_AUDIO_RETENTION_HOURS', 72);
  },
  /** Hard capture bounds prevent forgotten voice sessions from exhausting disk. */
  get maxRecordingMinutes(): number {
    return positiveSafeIntegerEnv('MAX_RECORDING_MINUTES', DEFAULT_MAX_RECORDING_MINUTES);
  },
  get maxSessionAudioBytes(): number {
    return positiveSafeIntegerEnv('MAX_SESSION_AUDIO_BYTES', DEFAULT_MAX_SESSION_AUDIO_BYTES);
  },
  get minFreeDiskBytes(): number {
    return positiveSafeIntegerEnv('MIN_FREE_DISK_BYTES', DEFAULT_MIN_FREE_DISK_BYTES);
  },
  get maxSessionSegments(): number {
    return positiveSafeIntegerEnv('MAX_SESSION_SEGMENTS', DEFAULT_MAX_SESSION_SEGMENTS);
  },
  get shutdownTimeoutMs(): number {
    return numberEnv('SHUTDOWN_TIMEOUT_MS', 30_000, 1_000);
  },
};
