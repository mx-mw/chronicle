// Read a local .txt/.md file as a text source. The trivial case.
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { positiveIntegerEnv } from '../runtime.js';
import type { ExtractedSource, ExtractOptions } from './index.js';

export async function extractText(filePath: string, opts: ExtractOptions = {}): Promise<ExtractedSource> {
  const abs = path.resolve(filePath);
  const size = (await stat(abs)).size;
  const maximum = positiveIntegerEnv('MAX_TEXT_SOURCE_BYTES', 25 * 1024 * 1024);
  if (size > maximum) {
    throw new Error(`${filePath} is ${size} bytes; the configured text maximum is ${maximum}.`);
  }
  const text = (await readFile(abs, 'utf8')).trim();
  if (!text) throw new Error(`${filePath} is empty — nothing to distil.`);
  return {
    kind: 'text',
    title: path.basename(filePath, path.extname(filePath)),
    origin: abs,
    text,
    attribution: opts.speaker ? [opts.speaker] : undefined,
  };
}
