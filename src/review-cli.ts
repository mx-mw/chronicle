/** Inspect and resolve Chronicle review drafts from the terminal. */
import {
  approveDraft,
  listDrafts,
  readDraft,
  rejectDraft,
  type ReviewStatus,
} from './kb.js';
import { config } from './config.js';
import { reconcileDiscardedSessions } from './pipeline.js';

const argv = process.argv.slice(2);
const command = argv[0] ?? 'list';
const identifier = command === 'list' ? undefined : argv[1];

function valueAfter(flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

const workspaceId = valueAfter('--workspace') ?? process.env.WORKSPACE_ID ?? 'default';
const revisionValue = valueAfter('--revision');
const expectedRevision = revisionValue === undefined ? undefined : Number(revisionValue);
const json = argv.includes('--json');

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`Usage: npm run review -- <command> [id] [options]

Commands:
  list                    List drafts awaiting review
  show <id>               Show one complete draft
  approve <id>            Promote a reviewed draft into durable memory
  reject <id>             Reject a draft while preserving its audit record

Options:
  --workspace <id>        Select a workspace
  --status <state>        Filter list by needs_review, approved, or rejected
  --revision <n>          Exact revision (required for approve or reject)
  --reason <text>         Record a rejection reason
  --json                  Emit machine-readable output`);
  process.exit(0);
}

if (expectedRevision !== undefined && !Number.isInteger(expectedRevision)) {
  throw new Error('--revision must be an integer.');
}
if ((command === 'approve' || command === 'reject') && expectedRevision === undefined) {
  throw new Error(`${command} requires --revision <n>; run "npm run review -- show <id>" first.`);
}

// Close any interrupted Discord discard transaction before the CLI exposes or
// mutates review state. In particular, approval must never outrun a legacy
// session-first tombstone while the bot and web server are offline.
await reconcileDiscardedSessions(config.sessionsDir);

let output: unknown;
if (command === 'list') {
  const status = valueAfter('--status') as ReviewStatus | undefined;
  output = await listDrafts({ workspaceId, status: status ?? 'needs_review' });
} else if (!identifier) {
  throw new Error(`${command} needs a draft id.`);
} else if (command === 'show') {
  output = await readDraft(identifier, { workspaceId });
} else if (command === 'approve') {
  output = await approveDraft(identifier, { workspaceId, expectedRevision });
} else if (command === 'reject') {
  output = await rejectDraft(identifier, {
    workspaceId,
    expectedRevision,
    reason: valueAfter('--reason'),
  });
} else {
  throw new Error(`Unknown review command "${command}".`);
}

if (json || command !== 'list') {
  console.log(JSON.stringify(output, null, 2));
} else {
  const drafts = output as Awaited<ReturnType<typeof listDrafts>>;
  if (!drafts.length) console.log('No drafts await review.');
  for (const draft of drafts) {
    console.log(`${draft.id}  r${draft.revision}  ${draft.date}  ${draft.kind}  ${draft.title}`);
  }
}
