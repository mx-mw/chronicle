import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { atomicWriteFile } from './fs-safe.js';
import { listDrafts } from './kb.js';
import { runMaintenance } from './maintenance.js';
import { ageInDays, listApprovedDocuments, localDate, sectionItems } from './reporting.js';

export interface ChronicleDigest {
  generatedAt: string;
  workspaceId: string;
  days: number;
  records: { file: string; title: string; date?: string }[];
  decisions: { text: string; file: string }[];
  actionItems: { text: string; file: string }[];
  openQuestions: { text: string; file: string }[];
  draftsAwaitingReview: number;
  maintenanceSuggestions: number;
}

export async function generateDigest(options: {
  workspaceId?: string;
  days?: number;
  now?: Date;
} = {}): Promise<ChronicleDigest> {
  const workspaceId = options.workspaceId ?? process.env.WORKSPACE_ID ?? 'default';
  const days = options.days ?? 7;
  const now = options.now ?? new Date();
  const documents = await listApprovedDocuments({ workspaceId });
  const records = documents.filter(
    (document) =>
      document.type !== 'topic' &&
      !document.file.split('/').includes('topics') &&
      ageInDays(document.date ?? document.modifiedAt.slice(0, 10), now) <= days,
  );
  const collect = (heading: string) =>
    records.flatMap((document) =>
      sectionItems(document.body, heading).map((text) => ({ text, file: document.file })),
    );

  const [drafts, maintenance] = await Promise.all([
    listDrafts({ workspaceId, status: 'needs_review' }),
    runMaintenance({ workspaceId, now }),
  ]);

  return {
    generatedAt: now.toISOString(),
    workspaceId,
    days,
    records: records.map((record) => ({ file: record.file, title: record.title, date: record.date })),
    decisions: collect('Decisions'),
    actionItems: collect('Action items'),
    openQuestions: collect('Open questions'),
    draftsAwaitingReview: drafts.length,
    maintenanceSuggestions: maintenance.issues.length,
  };
}

function linkedItems(items: { text: string; file: string }[], empty: string): string {
  if (!items.length) return `${empty}\n`;
  return `${items.map((item) => `- ${item.text} ([[${item.file.replace(/\.md$/, '')}]])`).join('\n')}\n`;
}

export function digestMarkdown(digest: ChronicleDigest): string {
  const records = digest.records.length
    ? digest.records
        .map(
          (record) =>
            `- ${record.date ? `${record.date}: ` : ''}[[${record.file.replace(/\.md$/, '')}|${record.title}]]`,
        )
        .join('\n')
    : 'No approved records in this period.';

  return (
    `# Weekly Chronicle\n\n` +
    `Date: ${digest.generatedAt.slice(0, 10)}\n\n` +
    `Workspace: ${digest.workspaceId}\n\n` +
    `Period: ${digest.days} days\n\n` +
    `## Review first\n\n` +
    `- Drafts awaiting review: ${digest.draftsAwaitingReview}\n` +
    `- Maintenance suggestions: ${digest.maintenanceSuggestions}\n\n` +
    `## Recent records\n\n${records}\n\n` +
    `## Decisions\n\n${linkedItems(digest.decisions, 'No new decisions.')}\n` +
    `## Action items\n\n${linkedItems(digest.actionItems, 'No new action items.')}\n` +
    `## Open questions\n\n${linkedItems(digest.openQuestions, 'No new open questions.')}`
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const valueAfter = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const workspaceId = valueAfter('--workspace') ?? process.env.WORKSPACE_ID ?? 'default';
  const days = Number(valueAfter('--days') ?? '7');
  const digest = await generateDigest({ workspaceId, days });
  if (args.includes('--json')) {
    console.log(JSON.stringify(digest, null, 2));
    return;
  }
  const markdown = digestMarkdown(digest);
  if (args.includes('--write')) {
    const destination = path.join(config.kbDir, 'digests', workspaceId, `${localDate()}.md`);
    await atomicWriteFile(destination, markdown);
    console.log(`Digest written to ${destination}`);
  } else {
    console.log(markdown);
  }
}

const isDirect = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirect) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
