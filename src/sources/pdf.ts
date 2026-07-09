// Extract text from a local PDF using unpdf (pdf.js under the hood).
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { extractText as extractPdfText, getDocumentProxy } from 'unpdf';
import type { ExtractedSource, ExtractOptions } from './index.js';

export async function extractPdf(filePath: string, opts: ExtractOptions = {}): Promise<ExtractedSource> {
  const abs = path.resolve(filePath);
  const buffer = await readFile(abs);
  // unpdf wants a Uint8Array over the exact bytes; Buffer is a Uint8Array but
  // pdf.js transfers/detaches the backing ArrayBuffer, so hand it a fresh copy.
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text, totalPages } = await extractPdfText(pdf, { mergePages: true });

  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error(
      `No extractable text in ${path.basename(filePath)} (${totalPages} page(s)). ` +
        `It may be a scanned/image-only PDF, which needs OCR that Chronicle doesn't do.`,
    );
  }

  return {
    kind: 'pdf',
    title: path.basename(filePath, '.pdf'),
    origin: abs,
    text: trimmed,
    attribution: opts.speaker ? [opts.speaker] : undefined,
  };
}
