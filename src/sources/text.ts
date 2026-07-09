// Read a local .txt/.md file as a text source. The trivial case.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExtractedSource, ExtractOptions } from './index.js';

export async function extractText(filePath: string, opts: ExtractOptions = {}): Promise<ExtractedSource> {
  const abs = path.resolve(filePath);
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
