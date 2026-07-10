/** Ask or search Chronicle from the terminal. */
import { describeProvider } from './llm.js';
import { recall } from './recall.js';
import { search } from './store.js';

interface RecallCliArgs {
  question: string;
  raw: boolean;
  json: boolean;
  keywordOnly: boolean;
  workspaceId: string;
  limit: number;
}

function parseArgs(argv: string[]): RecallCliArgs {
  const positional: string[] = [];
  let raw = false;
  let json = false;
  let keywordOnly = false;
  let workspaceId = process.env.WORKSPACE_ID || 'default';
  let limit = 8;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--raw') raw = true;
    else if (argument === '--json') json = true;
    else if (argument === '--keyword-only') keywordOnly = true;
    else if (argument === '--workspace' || argument === '--limit') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${argument} needs a value.`);
      if (argument === '--workspace') workspaceId = value;
      else limit = Number(value);
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      console.log(`Usage: npm run recall -- "<question>" [options]

  --raw            Show retrieved excerpts without model synthesis
  --keyword-only   Work without the embedding model
  --workspace <id> Scope retrieval to one workspace
  --limit <n>      Maximum evidence candidates (default: 8)
  --json           Emit machine-readable output`);
      process.exit(0);
    } else if (argument.startsWith('--')) {
      throw new Error(`Unknown flag "${argument}".`);
    } else positional.push(argument);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error('--limit must be an integer from 1 to 50.');
  }
  return { question: positional.join(' ').trim(), raw, json, keywordOnly, workspaceId, limit };
}

const args = parseArgs(process.argv.slice(2));
if (!args.question) {
  console.error('Usage: npm run recall -- "<question>" [--raw] [--workspace <id>]');
  process.exit(1);
}

const searchOptions = {
  workspaceId: args.workspaceId,
  keywordOnly: args.keywordOnly,
};

if (args.raw) {
  const hits = await search(args.question, args.limit, searchOptions);
  if (args.json) {
    console.log(JSON.stringify({ query: args.question, workspaceId: args.workspaceId, hits }, null, 2));
  } else if (!hits.length) {
    console.log('No relevant evidence found.');
  } else {
    for (const hit of hits) {
      const vector = hit.rawVectorScore === null ? 'n/a' : hit.rawVectorScore.toFixed(3);
      console.log(`\n${hit.score.toFixed(4)}  ${hit.file}  vector=${vector}`);
      console.log(`  ${hit.text.replace(/\n/g, '\n  ').slice(0, 500)}`);
    }
  }
} else {
  if (!args.json) console.log(`Answering with ${describeProvider()}.\n`);
  const result = await recall(args.question, args.limit, searchOptions);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else if (result.status === 'insufficient') {
    console.log(result.answer || 'Chronicle does not have enough relevant evidence to answer.');
  } else {
    console.log(result.answer);
    if (result.citations.length) {
      console.log('');
      console.log(`Evidence: ${result.citations.map((citation) => citation.file).join(', ')}`);
    }
  }
}
