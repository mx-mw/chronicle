/**
 * Ingest one or more sources into Chronicle's review inbox.
 *
 *   npm run ingest -- <url|path> [more sources] [options]
 *
 * Raw source material is persisted before model inference. Model output remains
 * a draft until a human approves it, unless --approve is supplied explicitly.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  approveDraft,
  listTopicCatalog,
  persistRawCapture,
  stageSourceDraft,
  type ApprovalResult,
  type ReviewDraft,
} from './kb.js';
import { localDate } from './reporting.js';
import { extract, type ExtractedSource, type SourceKind } from './sources/index.js';
import { summarizeSource, type SourceSummary } from './summarize.js';

const VALID_KINDS: SourceKind[] = ['meeting', 'article', 'pdf', 'video', 'text'];

export interface IngestArgs {
  inputs: string[];
  speaker?: string;
  author?: string;
  kind?: SourceKind;
  workspaceId: string;
  approve: boolean;
  dryRun: boolean;
  json: boolean;
  help: boolean;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${flag} needs a value.`);
  }
  return value;
}

export function parseIngestArgs(argv: string[]): IngestArgs {
  const output: IngestArgs = {
    inputs: [],
    workspaceId: process.env.WORKSPACE_ID || 'default',
    approve: false,
    dryRun: false,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--speaker') {
      output.speaker = requireValue(argv, index, argument);
      index += 1;
    } else if (argument === '--author') {
      output.author = requireValue(argv, index, argument);
      index += 1;
    } else if (argument === '--kind') {
      const value = requireValue(argv, index, argument);
      if (!VALID_KINDS.includes(value as SourceKind)) {
        throw new Error(`--kind must be one of: ${VALID_KINDS.join(', ')}.`);
      }
      output.kind = value as SourceKind;
      index += 1;
    } else if (argument === '--workspace') {
      output.workspaceId = requireValue(argv, index, argument);
      index += 1;
    } else if (argument === '--approve') {
      output.approve = true;
    } else if (argument === '--dry-run' || argument === '--preview') {
      output.dryRun = true;
    } else if (argument === '--json') {
      output.json = true;
    } else if (argument === '--help' || argument === '-h') {
      output.help = true;
    } else if (argument.startsWith('--')) {
      throw new Error(`Unknown flag "${argument}".`);
    } else {
      output.inputs.push(argument);
    }
  }

  if (output.speaker && output.author) {
    throw new Error('Use either --speaker or --author for one ingest batch, not both.');
  }
  return output;
}

function usage(): string {
  return `Usage: npm run ingest -- <url|path> [more sources] [options]

Options:
  --speaker "Name"      Attribute meeting audio to one speaker
  --author "Name"       Attribute an article, PDF, video, or text source
  --kind <kind>         meeting, article, pdf, video, or text
  --workspace <id>      Target workspace (default: WORKSPACE_ID or default)
  --preview             Extract and distill without persisting source or draft
  --approve             Approve and index immediately instead of review
  --json                Emit machine-readable results
  --help                Show this help

Without --approve, every source lands in Chronicle's review inbox.`;
}

export interface IngestResult {
  input: string;
  source: {
    kind: SourceKind;
    title?: string;
    origin: string;
    attribution?: string[];
    durationMinutes?: number;
    characters: number;
  };
  summary: SourceSummary;
  draft?: ReviewDraft;
  approval?: ApprovalResult;
  dryRun: boolean;
}

function sourceSnapshot(source: ExtractedSource): IngestResult['source'] {
  return {
    kind: source.kind,
    title: source.title,
    origin: source.origin,
    attribution: source.attribution,
    durationMinutes: source.durationMinutes,
    characters: source.text.length,
  };
}

async function ingestOne(input: string, args: IngestArgs): Promise<IngestResult> {
  console.error(`Extracting ${input}`);
  const attribution = args.speaker ?? args.author;
  const source = await extract(input, {
    speaker: attribution,
    kindOverride: args.kind,
  });
  console.error(
    `Detected ${source.kind}${source.title ? `: ${source.title}` : ''} (${source.text.length} characters)`,
  );

  const date = localDate();
  const meta = {
    date,
    kind: source.kind,
    origin: source.origin,
    attribution: source.attribution,
    durationMinutes: source.durationMinutes,
  };

  const rawCapture = args.dryRun
    ? undefined
    : await persistRawCapture({
        rawText: source.text,
        meta,
        workspaceId: args.workspaceId,
      });

  console.error('Distilling into a reviewable draft');
  const topicCatalog = await listTopicCatalog({ workspaceId: args.workspaceId });
  const summary = await summarizeSource({
    text: source.text,
    kind: source.kind,
    date,
    attribution: source.attribution,
    durationMinutes: source.durationMinutes,
    title: source.title,
    origin: source.origin,
    topicCatalog,
  });

  if (args.dryRun) {
    return { input, source: sourceSnapshot(source), summary, dryRun: true };
  }

  const draft = await stageSourceDraft(summary, source.text, meta, {
    workspaceId: args.workspaceId,
    rawCapture,
  });
  const autoApproveByPolicy = ['0', 'false', 'no', 'off'].includes(
    (process.env.REQUIRE_REVIEW ?? 'true').toLowerCase(),
  );
  const approval = args.approve || autoApproveByPolicy
    ? await approveDraft(draft.id, {
        workspaceId: args.workspaceId,
        expectedRevision: draft.revision,
      })
    : undefined;

  return {
    input,
    source: sourceSnapshot(source),
    summary,
    draft,
    approval,
    dryRun: false,
  };
}

function printHumanResult(result: IngestResult): void {
  console.log('');
  console.log(result.summary.title);
  console.log(`  Source: ${result.source.kind} from ${result.source.origin}`);
  console.log(`  Workspace: ${result.draft?.workspaceId ?? 'preview only'}`);
  if (result.dryRun) {
    console.log('  Result: preview only; no source or draft was persisted');
  } else if (result.approval) {
    console.log(`  Result: approved and indexed at ${result.approval.meetingPath}`);
  } else {
    console.log(`  Result: awaiting review (${result.draft?.id})`);
    console.log('  Next: open the web UI or approve the draft through the review API');
  }
}

export async function runIngest(args: IngestArgs): Promise<IngestResult[]> {
  const results: IngestResult[] = [];
  for (const input of args.inputs) {
    try {
      results.push(await ingestOne(input, args));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (args.inputs.length === 1) throw error;
      console.error(`Ingest failed for ${input}: ${message}`);
      process.exitCode = 1;
    }
  }
  return results;
}

async function main(): Promise<void> {
  const args = parseIngestArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.inputs.length) {
    console.error(usage());
    process.exitCode = 1;
    return;
  }
  const results = await runIngest(args);
  if (args.json) console.log(JSON.stringify(results, null, 2));
  else results.forEach(printHumanResult);
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((error) => {
    console.error(`Ingest failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
