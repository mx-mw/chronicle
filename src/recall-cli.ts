/**
 * Ask the knowledge base a question from the terminal.
 *
 *   npm run recall -- "what did we decide about storage?"
 *   npm run recall -- "storage" --raw     # retrieval only, no model
 */
import { recall } from './recall.js';
import { search } from './store.js';
import { describeProvider } from './llm.js';

const args = process.argv.slice(2);
const raw = args.includes('--raw');
const question = args.filter((a) => !a.startsWith('--')).join(' ').trim();

if (!question) {
  console.error('Usage: npm run recall -- "<question>" [--raw]');
  process.exit(1);
}

if (raw) {
  const hits = await search(question);
  if (hits.length === 0) console.log('No matches.');
  for (const hit of hits) {
    console.log(`\n${hit.score.toFixed(4)}  ${hit.file}`);
    console.log(`  ${hit.text.replace(/\n/g, '\n  ').slice(0, 300)}`);
  }
} else {
  console.log(`Answering with ${describeProvider()}…\n`);
  const { answer, hits } = await recall(question);
  console.log(answer);
  console.log(`\nSources: ${[...new Set(hits.map((h) => h.file))].join(', ')}`);
}
