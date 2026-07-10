/** Rebuild or inspect Chronicle's derived hybrid-search index. */
import { buildIndex, getIndexHealth } from './store.js';
import { config } from './config.js';

const args = new Set(process.argv.slice(2));
if (args.has('--help') || args.has('-h')) {
  console.log(`Usage: npm run index -- [--force] [--health] [--json]

  --force   Re-embed and rebuild every approved note
  --health  Inspect compatibility without rebuilding
  --json    Emit machine-readable output`);
  process.exit(0);
}

if (args.has('--health')) {
  const health = getIndexHealth();
  if (args.has('--json')) console.log(JSON.stringify(health, null, 2));
  else console.dir(health, { depth: null, colors: process.stdout.isTTY });
} else {
  const started = Date.now();
  const stats = await buildIndex(
    args.has('--json') ? undefined : (message) => console.log(`  ${message}`),
    { force: args.has('--force') },
  );
  const output = {
    ...stats,
    seconds: Number(((Date.now() - started) / 1_000).toFixed(2)),
    indexPath: config.indexPath,
    health: getIndexHealth(),
  };
  if (args.has('--json')) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log('');
    console.log(
      `Indexed ${stats.notesIndexed} note(s) and ${stats.chunks} chunk(s) in ${output.seconds}s.`,
    );
    if (stats.notesSkipped) console.log(`${stats.notesSkipped} unchanged note(s) skipped.`);
    if (stats.notesRemoved) console.log(`${stats.notesRemoved} deleted note(s) removed.`);
    if (stats.rebuilt) console.log('The index was rebuilt because its model or schema changed.');
    if (stats.keywordOnly) console.log('Embeddings were unavailable. Keyword search remains ready.');
    console.log(`Index: ${config.indexPath}`);
  }
}
