import 'dotenv/config';
import path from 'node:path';

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${key}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
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
    return process.env.LLM_BASE_URL || 'http://127.0.0.1:8080/v1';
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
   * Embeddings are always local — Anthropic has no embeddings endpoint, so
   * there is no cloud variant of this setting. Defaults to the same server
   * that serves local distillation.
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
};
