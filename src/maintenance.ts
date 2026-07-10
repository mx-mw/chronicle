import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { atomicWriteFile } from './fs-safe.js';
import {
  ageInDays,
  jaccard,
  listApprovedDocuments,
  localDate,
  normalizeFact,
  tokenize,
  type ArchiveDocument,
} from './reporting.js';

export type MaintenanceSeverity = 'info' | 'warning' | 'error';

export interface MaintenanceIssue {
  type: 'duplicate_fact' | 'overlapping_topics' | 'broken_link' | 'stale_topic';
  severity: MaintenanceSeverity;
  file: string;
  detail: string;
  suggestion: string;
}

export interface MaintenanceReport {
  generatedAt: string;
  workspaceId: string;
  documentCount: number;
  topicCount: number;
  recordCount: number;
  issues: MaintenanceIssue[];
}

function factLines(document: ArchiveDocument): string[] {
  if (document.type !== 'topic' && !document.file.split('/').includes('topics')) return [];
  return document.body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim());
}

function targetCandidates(target: string, sourceFile: string): string[] {
  const clean = target.split('|')[0].trim().replace(/\.md$/i, '');
  const sourceDirectory = path.posix.dirname(sourceFile);
  return [
    `${clean}.md`,
    `${sourceDirectory}/${clean}.md`,
    clean,
    path.posix.basename(clean),
  ].map((value) => value.replace(/^\.\//, ''));
}

function latestFactDate(lines: string[]): string | undefined {
  return lines
    .flatMap((line) => [...line.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)].map((match) => match[1]))
    .sort()
    .at(-1);
}

export async function runMaintenance(options: {
  workspaceId?: string;
  staleDays?: number;
  now?: Date;
} = {}): Promise<MaintenanceReport> {
  const workspaceId = options.workspaceId ?? process.env.WORKSPACE_ID ?? 'default';
  const staleDays = options.staleDays ?? 90;
  const now = options.now ?? new Date();
  const documents = await listApprovedDocuments({ workspaceId });
  const topics = documents.filter(
    (document) => document.type === 'topic' || document.file.split('/').includes('topics'),
  );
  const issues: MaintenanceIssue[] = [];

  const allPaths = new Set<string>();
  const basenames = new Set<string>();
  for (const document of documents) {
    const noExtension = document.file.replace(/\.md$/i, '');
    allPaths.add(document.file);
    allPaths.add(noExtension);
    basenames.add(path.posix.basename(noExtension));
  }

  for (const document of documents) {
    for (const match of document.body.matchAll(/\[\[([^\]]+)\]\]/g)) {
      const candidates = targetCandidates(match[1], document.file);
      const found = candidates.some(
        (candidate) => allPaths.has(candidate) || basenames.has(path.posix.basename(candidate.replace(/\.md$/, ''))),
      );
      if (!found) {
        issues.push({
          type: 'broken_link',
          severity: 'error',
          file: document.file,
          detail: `Link target "${match[1]}" does not resolve in this workspace.`,
          suggestion: 'Correct the target or approve the missing record before relying on this link.',
        });
      }
    }
  }

  const seenFacts = new Map<string, { file: string; original: string }>();
  for (const topic of topics) {
    const lines = factLines(topic);
    for (const line of lines) {
      const normalized = normalizeFact(line);
      if (!normalized) continue;
      const existing = seenFacts.get(normalized);
      if (existing) {
        issues.push({
          type: 'duplicate_fact',
          severity: 'warning',
          file: topic.file,
          detail: `Duplicates a fact in ${existing.file}: "${line}"`,
          suggestion: 'Review both sources and keep one approved fact with complete provenance.',
        });
      } else {
        seenFacts.set(normalized, { file: topic.file, original: line });
      }
    }

    const lastDate = latestFactDate(lines) ?? topic.date;
    if (lastDate && ageInDays(lastDate, now) > staleDays) {
      issues.push({
        type: 'stale_topic',
        severity: 'info',
        file: topic.file,
        detail: `No dated fact has been added since ${lastDate}.`,
        suggestion: 'Confirm that the topic is still current or mark superseded facts explicitly.',
      });
    }
  }

  for (let i = 0; i < topics.length; i += 1) {
    for (let j = i + 1; j < topics.length; j += 1) {
      const left = topics[i];
      const right = topics[j];
      const similarity = jaccard(
        tokenize(`${left.title} ${left.description}`),
        tokenize(`${right.title} ${right.description}`),
      );
      if (similarity >= 0.6) {
        issues.push({
          type: 'overlapping_topics',
          severity: 'warning',
          file: left.file,
          detail: `${left.title} overlaps ${right.title} (${Math.round(similarity * 100)}% token similarity).`,
          suggestion: 'Review for a merge or document why the topics remain separate.',
        });
      }
    }
  }

  return {
    generatedAt: now.toISOString(),
    workspaceId,
    documentCount: documents.length,
    topicCount: topics.length,
    recordCount: documents.length - topics.length,
    issues,
  };
}

export function maintenanceMarkdown(report: MaintenanceReport): string {
  const counts = ['error', 'warning', 'info'].map((severity) => {
    const count = report.issues.filter((issue) => issue.severity === severity).length;
    return `- ${severity}: ${count}`;
  });
  const issues = report.issues.length
    ? report.issues
        .map(
          (issue) =>
            `### ${issue.type.replace(/_/g, ' ')}\n\n` +
            `- File: \`${issue.file}\`\n` +
            `- Detail: ${issue.detail}\n` +
            `- Suggested review: ${issue.suggestion}\n`,
        )
        .join('\n')
    : 'No maintenance issues were detected.\n';

  return (
    `# Chronicle maintenance report\n\n` +
    `Date: ${report.generatedAt.slice(0, 10)}\n\n` +
    `Workspace: ${report.workspaceId}\n\n` +
    `Documents: ${report.documentCount} (${report.recordCount} records, ${report.topicCount} topics)\n\n` +
    `## Issue counts\n\n${counts.join('\n')}\n\n` +
    `## Review queue\n\n${issues}`
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const valueAfter = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const workspaceId = valueAfter('--workspace') ?? process.env.WORKSPACE_ID ?? 'default';
  const staleDays = Number(valueAfter('--stale-days') ?? '90');
  const report = await runMaintenance({ workspaceId, staleDays });
  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const markdown = maintenanceMarkdown(report);
  if (args.includes('--write')) {
    const destination = path.join(
      config.kbDir,
      'reports',
      workspaceId,
      `maintenance-${localDate()}.md`,
    );
    await atomicWriteFile(destination, markdown);
    console.log(`Maintenance report written to ${destination}`);
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
