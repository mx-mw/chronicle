/**
 * Embeddings, always local.
 *
 * Anthropic has no embeddings endpoint, so unlike distillation this step has no
 * cloud option to switch to — which is convenient, because it means the corpus
 * never leaves the machine even when Claude is answering questions about it.
 * Only the handful of retrieved snippets are ever sent anywhere.
 *
 * Served by the same OpenAI-compatible server as local distillation, with an
 * embedding model (`nomic-embed-text`) rather than a chat model.
 */
import { config } from './config.js';
import { fetchWithTimeout, isLoopbackUrl, positiveIntegerEnv } from './runtime.js';

export function assertLocalEmbeddingEndpoint(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`EMBED_BASE_URL is not a valid URL: ${baseUrl}`);
  }
  if (!isLoopbackUrl(baseUrl) && process.env.ALLOW_REMOTE_MODEL_ENDPOINTS?.toLowerCase() !== 'true') {
    throw new Error(
      `Refusing remote embedding endpoint ${url.origin}. ` +
        'Use a loopback EMBED_BASE_URL or explicitly set ALLOW_REMOTE_MODEL_ENDPOINTS=true.',
    );
  }
}

/** Cosine similarity is a dot product once both sides are unit vectors. */
function normalize(vector: number[]): number[] {
  if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error('Embedding server returned an empty or non-finite vector');
  }
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;
  const magnitude = Math.sqrt(sumSquares);
  if (magnitude === 0) return vector;
  return vector.map((value) => value / magnitude);
}

export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) {
    throw new Error(`Embedding dimension mismatch: query=${a.length}, indexed=${b.length}`);
  }
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += a[i] * b[i];
  return total;
}

export function toBlob(vector: number[]): Uint8Array {
  if (vector.length === 0 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error('Cannot store an empty or non-finite embedding');
  }
  return new Uint8Array(Float32Array.from(vector).buffer);
}

export function fromBlob(blob: Uint8Array): Float32Array {
  if (blob.byteLength === 0 || blob.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
    throw new Error(`Invalid embedding blob length: ${blob.byteLength}`);
  }
  // Copy rather than view: SQLite's buffer isn't guaranteed 4-byte aligned,
  // and an unaligned Float32Array view throws.
  return new Float32Array(blob.slice().buffer);
}

/**
 * Embed a batch of texts, returning unit vectors in input order.
 * Batched in one request per call — the server handles arrays natively.
 */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  assertLocalEmbeddingEndpoint(config.embedBaseUrl);

  const processingTimeout = positiveIntegerEnv('PROCESSING_TIMEOUT_MS', 30_000);
  const timeoutMs = positiveIntegerEnv('EMBED_TIMEOUT_MS', Math.min(processingTimeout, 60_000));
  const res = await fetchWithTimeout(`${config.embedBaseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.llmApiKey ? { Authorization: `Bearer ${config.llmApiKey}` } : {}),
    },
    body: JSON.stringify({ model: config.embedModel, input: texts }),
  }, timeoutMs);

  if (!res.ok) {
    throw new Error(
      `Embedding request failed (${res.status} ${res.statusText}): ${await res.text()}\n` +
        `Is an embedding model available at ${config.embedBaseUrl}? ` +
        `For Ollama: \`ollama pull ${config.embedModel}\`.`,
    );
  }

  const data = (await res.json()) as { data: { embedding: number[]; index: number }[] };
  // The API may return results out of order; `index` is authoritative.
  const ordered: number[][] = new Array(texts.length);
  for (const item of data.data) {
    if (!Number.isInteger(item.index) || item.index < 0 || item.index >= texts.length) {
      throw new Error(`Embedding server returned invalid input index ${item.index}`);
    }
    ordered[item.index] = normalize(item.embedding);
  }

  const missing = ordered.findIndex((v) => v === undefined);
  if (missing !== -1) throw new Error(`Embedding server returned no vector for input ${missing}`);
  const dimension = ordered[0].length;
  const inconsistent = ordered.findIndex((vector) => vector.length !== dimension);
  if (inconsistent !== -1) {
    throw new Error(
      `Embedding server returned inconsistent dimensions: input 0=${dimension}, input ${inconsistent}=${ordered[inconsistent].length}`,
    );
  }
  return ordered;
}

export async function embedOne(text: string): Promise<number[]> {
  return (await embed([text]))[0];
}
