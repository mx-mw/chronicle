/**
 * Ingest CLI: pull any source — a URL, a PDF, a YouTube video, an article, an
 * audio/video file, a text file — into the knowledge base.
 *
 *   npm run ingest -- <url|path> [--speaker "Name"] [--kind article]
 *
 * The source type is inferred from the input (URL host, file extension). Pass
 * --kind to override the inferred kind; --speaker attributes an audio file (or
 * an article's author).
 */
import { extract, type SourceKind } from './sources/index.js';
import { summarizeSource } from './summarize.js';
import { writeSource } from './kb.js';

const VALID_KINDS: SourceKind[] = ['meeting', 'article', 'pdf', 'video', 'text'];

interface Args {
  input?: string;
  speaker?: string;
  kind?: SourceKind;
}

/**
 * A real parser: consume `--flag value` pairs explicitly so the positional
 * input is never confused with a flag's value (the old `.find()` parser broke
 * when the speaker name equalled the filename, or `--speaker` was last with no
 * value).
 */
function parseArgs(argv: string[]): Args {
  const out: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--speaker') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--speaker needs a value, e.g. --speaker "Ada Lovelace".');
      }
      out.speaker = value;
      i += 1;
    } else if (arg === '--kind') {
      const value = argv[i + 1];
      if (value === undefined || !VALID_KINDS.includes(value as SourceKind)) {
        throw new Error(`--kind must be one of: ${VALID_KINDS.join(', ')}.`);
      }
      out.kind = value as SourceKind;
      i += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown flag "${arg}".`);
    } else if (out.input === undefined) {
      out.input = arg;
    } else {
      throw new Error(`Unexpected extra argument "${arg}". Only one source at a time.`);
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error('Usage: npm run ingest -- <url|path> [--speaker "Name"] [--kind article]');
    process.exit(1);
  }

  console.error(`Extracting: ${args.input}`);
  const source = await extract(args.input, { speaker: args.speaker, kindOverride: args.kind });
  console.error(
    `→ kind=${source.kind}` +
      (source.title ? `, title="${source.title}"` : '') +
      `, ${source.text.length} chars` +
      (source.durationMinutes ? `, ~${source.durationMinutes} min` : ''),
  );

  console.error('Distilling…');
  const date = new Date().toISOString().slice(0, 10);
  const summary = await summarizeSource({
    text: source.text,
    kind: source.kind,
    date,
    attribution: source.attribution,
    durationMinutes: source.durationMinutes,
    title: source.title,
    origin: source.origin,
  });

  const written = await writeSource(summary, source.text, {
    date,
    kind: source.kind,
    origin: source.origin,
    attribution: source.attribution,
    durationMinutes: source.durationMinutes,
  });

  console.log(`\nFiled: ${written.meetingPath}`);
  console.log(`Provenance: ${written.transcriptPath}`);
  if (written.topicPaths.length) {
    console.log(`Topics updated: ${written.topicPaths.join(', ')}`);
  }
}

main().catch((err) => {
  console.error(`\nIngest failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
