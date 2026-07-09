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
