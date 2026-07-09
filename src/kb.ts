import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import type { MeetingSummary } from './summarize.js';

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

export async function writeMeeting(
  summary: MeetingSummary,
  transcript: string,
  meta: { date: string; participants: string[]; durationMinutes: number },
): Promise<WrittenMeeting> {
  await ensureDirs();
  const meetingName = `${meta.date}-${slugify(summary.slug)}`;

  // 1. Raw transcript, for provenance.
  const transcriptPath = path.join(config.kbDir, 'transcripts', `${meetingName}.md`);
  await writeFile(
    transcriptPath,
    frontmatter(meetingName, `Raw transcript: ${summary.title}`, 'transcript') +
      `# Transcript: ${summary.title}\n\n\`\`\`\n${transcript}\n\`\`\`\n`,
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
      content += `- ${fact.fact} — [[meetings/${meetingName}]] (${meta.date})\n`;
    }
    await writeFile(topicPath, content);
    topicPaths.push(topicPath);
  }

  // 3. The meeting note itself.
  const meetingPath = path.join(config.kbDir, 'meetings', `${meetingName}.md`);
  let note =
    frontmatter(meetingName, summary.title, 'meeting') +
    `# ${summary.title}\n\n` +
    `**Date:** ${meta.date} · **Duration:** ~${meta.durationMinutes} min · ` +
    `**Participants:** ${meta.participants.join(', ') || 'unknown'}\n\n` +
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
  note += `\n## Provenance\n- [[transcripts/${meetingName}]]\n`;
  await writeFile(meetingPath, note);

  await rebuildIndex();
  await refreshSearchIndex();
  return { meetingPath, transcriptPath, topicPaths };
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
