/**
 * Rebuild the search index from kb/.
 *
 *   npm run index
 *
 * Safe to re-run: unchanged notes are skipped by content hash, so this costs
 * one embedding pass per new or edited note, not per note in the palace.
 */
import { buildIndex } from './store.js';
import { config } from './config.js';

const started = Date.now();
const stats = await buildIndex((msg) => console.log(`  ${msg}`));
const seconds = ((Date.now() - started) / 1000).toFixed(1);

console.log(
  `\nIndexed ${stats.notesIndexed} note(s) into ${stats.chunks} chunk(s) in ${seconds}s.` +
    (stats.notesSkipped ? ` ${stats.notesSkipped} unchanged.` : '') +
    (stats.notesRemoved ? ` ${stats.notesRemoved} removed.` : ''),
);
console.log(`Index: ${config.indexPath}`);
