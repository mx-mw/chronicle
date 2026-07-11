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

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const valueFlags = new Set(['--workspace', '--status', '--revision', '--reason']);
  const booleanFlags = new Set(['--json', '--help', '-h']);
  const positionals: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (valueFlags.has(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('-')) throw new Error(`${argument} needs a value.`);
      index += 1;
    } else if (booleanFlags.has(argument)) {
      continue;
    } else if (argument.startsWith('-')) {
      throw new Error(`Unknown option "${argument}".`);
    } else {
      positionals.push(argument);
    }
  }

  const command = positionals[0] ?? 'list';
  const identifier = command === 'list' ? undefined : positionals[1];
  const maximumPositionals = command === 'list' ? 1 : 2;
  if (positionals.length > maximumPositionals) {
    throw new Error(`Unexpected argument "${positionals[maximumPositionals]}".`);
  }
  const valueAfter = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };

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
    return;
  }

  if (expectedRevision !== undefined && !Number.isInteger(expectedRevision)) {
    throw new Error('--revision must be an integer.');
  }
  if ((command === 'approve' || command === 'reject') && expectedRevision === undefined) {
    throw new Error(`${command} requires --revision <n>; run "npm run review -- show <id>" first.`);
  }
  if (command !== 'list' && valueAfter('--status') !== undefined) {
    throw new Error('--status is available only with the list command.');
  }
  if (command !== 'reject' && valueAfter('--reason') !== undefined) {
    throw new Error('--reason is available only with the reject command.');
  }
  if (command !== 'approve' && command !== 'reject' && revisionValue !== undefined) {
    throw new Error('--revision is available only with approve or reject.');
  }

  // Close interrupted Discord discard transactions before exposing review state.
  await reconcileDiscardedSessions(config.sessionsDir);

  let output: unknown;
  if (command === 'list') {
    const status = valueAfter('--status') ?? 'needs_review';
    const statuses: ReviewStatus[] = ['needs_review', 'approved', 'rejected'];
    if (!statuses.includes(status as ReviewStatus)) {
      throw new Error(`--status must be one of: ${statuses.join(', ')}.`);
    }
    output = await listDrafts({ workspaceId, status: status as ReviewStatus });
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
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
