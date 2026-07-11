import { execFile } from 'node:child_process';
import { isIP } from 'node:net';

export interface CommandOptions {
  timeoutMs?: number;
  maxBuffer?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export class TimeoutError extends Error {
  constructor(
    message: string,
    readonly timeoutMs: number,
  ) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function booleanEnv(name: string, fallback = false): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  throw new Error(`${name} must be true or false.`);
}

export function isLoopbackHost(raw: string): boolean {
  const host = raw.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (host === 'localhost' || host === '::1') return true;
  const version = isIP(host);
  if (version === 4) return host.split('.')[0] === '127';
  if (version !== 6) return false;

  // URL canonicalization handles dotted and expanded IPv4-mapped IPv6 forms.
  const canonical = new URL(`http://[${host}]`).hostname.replace(/^\[|\]$/g, '');
  return canonical === '::1' || /^::ffff:7f[0-9a-f]{2}:/i.test(canonical);
}

export function isLoopbackUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return isLoopbackHost(url.hostname);
}

export function assertModelEndpointAllowed(raw: string, label: string): void {
  if (isLoopbackUrl(raw) || booleanEnv('ALLOW_REMOTE_MODEL_ENDPOINTS', false)) return;
  throw new Error(
    `${label} points to a non-loopback endpoint (${new URL(raw).host}). ` +
      'Set ALLOW_REMOTE_MODEL_ENDPOINTS=true only after confirming the data-sharing boundary.',
  );
}

export async function runCommand(
  binary: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? positiveIntegerEnv('COMMAND_TIMEOUT_MS', 10 * 60_000);
  return new Promise<CommandResult>((resolve, reject) => {
    execFile(
      binary,
      args,
      {
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
        cwd: options.cwd,
        env: options.env,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) {
          const killed = (error as NodeJS.ErrnoException & { killed?: boolean }).killed;
          if (killed) {
            reject(new TimeoutError(`${binary} exceeded its ${timeoutMs}ms timeout`, timeoutMs));
            return;
          }
          const detail = `${stderr || ''}\n${stdout || ''}`.trim();
          error.message = detail ? `${error.message}\n${detail}` : error.message;
          reject(error);
          return;
        }
        resolve({ stdout: stdout || '', stderr: stderr || '' });
      },
    );
  });
}

export async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs = positiveIntegerEnv('HTTP_TIMEOUT_MS', 60_000),
): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  try {
    return await fetch(input, { ...init, signal });
  } catch (error) {
    if (timeout.aborted) {
      throw new TimeoutError(`HTTP request exceeded its ${timeoutMs}ms timeout`, timeoutMs);
    }
    throw error;
  }
}

export async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutError(`${label} exceeded its ${timeoutMs}ms timeout`, timeoutMs)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
