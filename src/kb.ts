import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import type { MeetingSummary } from './summarize.js';
import type { SourceKind } from './sources/index.js';

/**
 * The knowledge base is a memory-palace style markdown repository:
 *
 *   kb/
 *     INDEX.md          — the palace map: one line per note, regenerated on every write
 *     meetings/         — one distilled note per meeting
 *     topics/           — durable topic notes that accumulate atomic facts over time
 *     transcripts/      — raw speaker-attributed transcripts (provenance)
 *
 * Every note carries `name:` and `description:` frontmatter; notes link to each
 * other with [[wiki-links]]. INDEX.md is deterministic: it is rebuilt from the
 * files on disk, never edited incrementally.
 */

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'untitled';
}

async function ensureDirs(): Promise<void> {
  for (const sub of ['meetings', 'topics', 'transcripts']) {
    await mkdir(path.join(config.kbDir, sub), { recursive: true });
  }
}

function frontmatter(name: string, description: string, type: string): string {
  return `---\nname: ${name}\ndescription: ${description.replace(/\n/g, ' ')}\ntype: ${type}\n---\n\n`;
}

function readFrontmatter(content: string): { name?: string; description?: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const get = (key: string) =>
    match[1].match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim();
  return { name: get('name'), description: get('description') };
}

export interface WrittenMeeting {
  meetingPath: string;
  transcriptPath: string;
  topicPaths: string[];
}

export interface SourceMeta {
  date: string;
  kind: SourceKind;
  /** URL, file path, or "discord:<channel>" — where the source came from. */
  origin: string;
  /** Speakers (meeting) or author(s) (article/pdf). */
  attribution?: string[];
  durationMinutes?: number;
}

/**
 * Build the one-line metadata banner under a note's title. A meeting shows
 * participants and duration; an article has neither, so it shows author and
 * source instead. Only render the facts that exist for this kind.
 */
function metaLine(meta: SourceMeta): string {
  if (meta.kind === 'meeting') {
    return (
      `**Date:** ${meta.date} · **Duration:** ~${meta.durationMinutes ?? '?'} min · ` +
      `**Participants:** ${(meta.attribution ?? []).join(', ') || 'unknown'}`
    );
  }
  const parts = [`**Date:** ${meta.date}`];
  if (meta.attribution?.length) parts.push(`**By:** ${meta.attribution.join(', ')}`);
  if (meta.durationMinutes) parts.push(`**Duration:** ~${meta.durationMinutes} min`);
  parts.push(`**Source:** ${meta.origin}`);
  return parts.join(' · ');
}

/**
 * File a distilled source into the knowledge base.
 *
 * KB-layout choice: every distilled note — meeting or article or PDF — goes into
 * kb/meetings/, and the real kind is recorded in the `type:` frontmatter, not in
 * the directory name. The reason is a hard constraint, not aesthetics: store.ts
 * (which indexes the KB for `/recall`) only walks kb/topics/ and kb/meetings/. A
 * new kb/sources/ directory would be invisible to search, and an unsearchable
 * note defeats the whole point of the topics spine. So the directory name is a
 * historical label; `type:` is the source of truth for what a note actually is.
 */
export async function writeSource(
  summary: MeetingSummary,
  rawText: string,
  meta: SourceMeta,
): Promise<WrittenMeeting> {
  await ensureDirs();
  const noteName = `${meta.date}-${slugify(summary.slug)}`;

  // 1. Raw source text, for provenance.
  const transcriptPath = path.join(config.kbDir, 'transcripts', `${noteName}.md`);
  await writeFile(
    transcriptPath,
    frontmatter(noteName, `Raw source: ${summary.title}`, 'transcript') +
      `# Source text: ${summary.title}\n\n\`\`\`\n${rawText}\n\`\`\`\n`,
  );

  // 2. Topic notes accumulate facts append-style, newest last, each with a backlink.
  const factsByTopic = new Map<string, MeetingSummary['facts']>();
  for (const fact of summary.facts) {
    const slug = slugify(fact.topic);
    if (!factsByTopic.has(slug)) factsByTopic.set(slug, []);
    factsByTopic.get(slug)!.push(fact);
  }

  const topicPaths: string[] = [];
  for (const [slug, facts] of factsByTopic) {
    const topicPath = path.join(config.kbDir, 'topics', `${slug}.md`);
    let content: string;
    if (existsSync(topicPath)) {
      content = await readFile(topicPath, 'utf8');
      if (!content.endsWith('\n')) content += '\n';
    } else {
      content =
        frontmatter(slug, facts[0].topic_description || facts[0].topic_title, 'topic') +
        `# ${facts[0].topic_title}\n\n${facts[0].topic_description}\n\n## Log\n`;
    }
    for (const fact of facts) {
      content += `- ${fact.fact} — [[meetings/${noteName}]] (${meta.date})\n`;
    }
    await writeFile(topicPath, content);
    topicPaths.push(topicPath);
  }

  // 3. The source note itself.
  const notePath = path.join(config.kbDir, 'meetings', `${noteName}.md`);
  let note =
    frontmatter(noteName, summary.title, meta.kind) +
    `# ${summary.title}\n\n` +
    `${metaLine(meta)}\n\n` +
    `${summary.summary}\n`;

  if (summary.decisions.length) {
    note += `\n## Decisions\n${summary.decisions.map((d) => `- ${d}`).join('\n')}\n`;
  }
  if (summary.action_items.length) {
    note += `\n## Action items\n${summary.action_items
      .map((a) => `- [ ] **${a.owner}**: ${a.task}`)
      .join('\n')}\n`;
  }
  if (summary.open_questions.length) {
    note += `\n## Open questions\n${summary.open_questions.map((q) => `- ${q}`).join('\n')}\n`;
  }
  note += `\n## Topics touched\n${[...factsByTopic.keys()]
    .map((slug) => `- [[topics/${slug}]]`)
    .join('\n')}\n`;
  note += `\n## Provenance\n- [[transcripts/${noteName}]]\n`;
  await writeFile(notePath, note);

  await rebuildIndex();
  await refreshSearchIndex();
  return { meetingPath: notePath, transcriptPath, topicPaths };
}

/** Backwards-compatible wrapper for the Discord/meeting path. */
export async function writeMeeting(
  summary: MeetingSummary,
  transcript: string,
  meta: { date: string; participants: string[]; durationMinutes: number },
): Promise<WrittenMeeting> {
  return writeSource(summary, transcript, {
    date: meta.date,
    kind: 'meeting',
    origin: 'discord',
    attribution: meta.participants,
    durationMinutes: meta.durationMinutes,
  });
}

/**
 * Keep the search index in step with the notes we just wrote — a meeting that
 * isn't indexed can't be recalled.
 *
 * Best-effort on purpose: the markdown is already safely on disk, and the index
 * is a derived cache that `npm run index` can rebuild. A down embedding server
 * must not lose a recorded meeting.
 */
async function refreshSearchIndex(): Promise<void> {
  try {
    const { buildIndex } = await import('./store.js');
    await buildIndex();
  } catch (err) {
    console.error(
      'Notes were filed, but indexing them for search failed. They will not appear in ' +
        '`/recall` until you run `npm run index`.\n',
      err instanceof Error ? err.message : err,
    );
  }
}

/** Rebuild INDEX.md — the palace map — from what's actually on disk. */
export async function rebuildIndex(): Promise<void> {
  const section = async (sub: string): Promise<string[]> => {
    const dir = path.join(config.kbDir, sub);
    if (!existsSync(dir)) return [];
    const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
    const lines: string[] = [];
    for (const file of files) {
      const { name, description } = readFrontmatter(
        await readFile(path.join(dir, file), 'utf8'),
      );
      lines.push(`- [[${sub}/${name ?? file.replace(/\.md$/, '')}]] — ${description ?? ''}`);
    }
    return lines;
  };

  const topics = await section('topics');
  const meetings = (await section('meetings')).reverse(); // newest first (date-prefixed names)

  const index =
    `# Knowledge Base Index\n\n` +
    `The map of the palace. One line per note; open the note for the full story.\n\n` +
    `## Topics\n${topics.join('\n') || '_none yet_'}\n\n` +
    `## Meetings\n${meetings.join('\n') || '_none yet_'}\n`;
  await writeFile(path.join(config.kbDir, 'INDEX.md'), index);
}

// Search moved to store.ts: substring matching couldn't answer "what did we
// decide about storage?" when the note says "SQLite index". See search() there.
