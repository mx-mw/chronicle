import { completeJson } from './llm.js';
import type { SourceKind } from './sources/index.js';

export interface MeetingSummary {
  title: string;
  slug: string;
  summary: string;
  decisions: string[];
  action_items: { owner: string; task: string }[];
  open_questions: string[];
  facts: {
    topic: string;
    topic_title: string;
    topic_description: string;
    fact: string;
  }[];
}

/** A summary carries the same shape regardless of source kind — an article just
 *  leaves the meeting-only arrays (action_items, decisions) empty. */
export type SourceSummary = MeetingSummary;

/**
 * The local model's context is finite, and a 50-page PDF will silently blow
 * past it and get truncated by the server. Cap the input ourselves and warn
 * loudly, so a truncated distillation is never a silent surprise. ~48k chars is
 * roughly 12k tokens, well under a small local model's window with room for the
 * schema and output.
 */
const MAX_INPUT_CHARS = 48_000;

function capInput(text: string): string {
  if (text.length <= MAX_INPUT_CHARS) return text;
  const dropped = text.length - MAX_INPUT_CHARS;
  console.error(
    `⚠️  Source is ${text.length} chars; truncating to ${MAX_INPUT_CHARS} (dropping ${dropped}) ` +
      `so it fits the model's context. The distillation covers only the start of the source.`,
  );
  return `${text.slice(0, MAX_INPUT_CHARS)}\n\n[... ${dropped} characters truncated ...]`;
}

// Meetings have owners and decisions; a saved article or PDF does not. The
// prompt adapts so the model never invents an action item with a fake owner.
function buildSystemPrompt(kind: SourceKind): string {
  const isMeeting = kind === 'meeting';
  const sourceNoun =
    kind === 'meeting' ? 'meeting transcript'
    : kind === 'video' ? 'video transcript'
    : kind === 'article' ? 'article'
    : kind === 'pdf' ? 'document'
    : 'text';

  const meetingRules = isMeeting
    ? `- Record decisions verbatim in spirit: what was decided, not the discussion that led there.
- Action items must name an owner (use the speaker names from the transcript) and a concrete task.`
    : `- This is not a meeting: it has no owners and no assigned tasks. Leave "action_items" an empty array — never invent an owner. Leave "decisions" empty unless the ${sourceNoun} itself explicitly states a conclusion or recommendation the author asserts.`;

  return `You are the librarian of a memory-palace style knowledge base: a flat repository of small, densely linked markdown notes. Your job is to distill a ${sourceNoun} into durable knowledge.

Principles:
- Extract ATOMIC facts: each fact is one self-contained sentence that will still make sense read alone in six months, with no pronouns pointing outside itself.
- Group facts under topics. A topic is a durable subject (a project, system, person, policy, recurring theme) — not a one-off point. Reuse broad topic slugs rather than inventing near-duplicates.
${meetingRules}
- open_questions are genuine unresolved questions the ${sourceNoun} raises; leave empty if none.
- Prefer fewer, higher-value facts over exhaustive coverage. Skip filler entirely.

Respond with ONLY a JSON object, no markdown fences, matching this schema:
{
  "title": "Short descriptive title",
  "slug": "kebab-case-slug",
  "summary": "2-3 paragraph prose summary of what the ${sourceNoun} covered and concluded",
  "decisions": ["..."],
  "action_items": [{"owner": "Name", "task": "..."}],
  "open_questions": ["..."],
  "facts": [
    {
      "topic": "kebab-case-topic-slug",
      "topic_title": "Human Topic Title",
      "topic_description": "One-line description of what this topic covers",
      "fact": "One atomic, self-contained fact."
    }
  ]
}`;
}

/**
 * The same shape the system prompt describes, in a form the API can enforce.
 * Local models see only the prose version and are trusted to comply; Claude is
 * held to this one server-side.
 */
const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    slug: { type: 'string' },
    summary: { type: 'string' },
    decisions: { type: 'array', items: { type: 'string' } },
    action_items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { owner: { type: 'string' }, task: { type: 'string' } },
        required: ['owner', 'task'],
        additionalProperties: false,
      },
    },
    open_questions: { type: 'array', items: { type: 'string' } },
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          topic_title: { type: 'string' },
          topic_description: { type: 'string' },
          fact: { type: 'string' },
        },
        required: ['topic', 'topic_title', 'topic_description', 'fact'],
        additionalProperties: false,
      },
    },
  },
  required: ['title', 'slug', 'summary', 'decisions', 'action_items', 'open_questions', 'facts'],
  additionalProperties: false,
} as const;

/**
 * Distil any extracted source into the knowledge-base schema. The prompt and
 * the user-message header adapt to the source kind; the output shape does not.
 */
export async function summarizeSource(input: {
  text: string;
  kind: SourceKind;
  date: string;
  attribution?: string[];
  durationMinutes?: number;
  title?: string;
  origin?: string;
}): Promise<SourceSummary> {
  const header =
    input.kind === 'meeting'
      ? `Meeting date: ${input.date}
Duration: ~${input.durationMinutes ?? '?'} minutes
Participants: ${(input.attribution ?? []).join(', ') || 'unknown'}`
      : `Kind: ${input.kind}
Date: ${input.date}${input.title ? `\nTitle: ${input.title}` : ''}${input.origin ? `\nSource: ${input.origin}` : ''}${
          input.attribution?.length ? `\nAttribution: ${input.attribution.join(', ')}` : ''
        }`;

  const parsed = (await completeJson({
    system: buildSystemPrompt(input.kind),
    user: `${header}

Content:
${capInput(input.text)}`,
    schema: SUMMARY_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 8_000,
  })) as SourceSummary;

  // Claude's schema guarantees this; a local model's compliance is only a
  // strong suggestion, so the check stays.
  if (!parsed.title || !parsed.slug || !Array.isArray(parsed.facts)) {
    throw new Error('Model response missing required summary fields');
  }
  return sanitize(parsed);
}

// Small local models emit placeholder junk the schema can't forbid: literal
// "..." list entries, empty {owner:"",task:""} action items, and facts missing
// a field. Scrub it here so the KB writer downstream never trips on an
// undefined field or files a fact that reads as "...".
function isPlaceholder(s: string | undefined): boolean {
  const t = (s ?? '').trim();
  return t === '' || /^\.{2,}$/.test(t) || t.toLowerCase() === 'n/a';
}

function sanitize(s: SourceSummary): SourceSummary {
  s.decisions = (s.decisions ?? []).filter((d) => !isPlaceholder(d));
  s.open_questions = (s.open_questions ?? []).filter((q) => !isPlaceholder(q));
  s.action_items = (s.action_items ?? []).filter(
    (a) => a && !isPlaceholder(a.task) && !isPlaceholder(a.owner),
  );
  s.facts = (s.facts ?? [])
    .filter((f) => f && !isPlaceholder(f.fact) && !isPlaceholder(f.topic))
    .map((f) => ({
      topic: f.topic.trim(),
      topic_title: isPlaceholder(f.topic_title) ? f.topic : f.topic_title,
      topic_description: isPlaceholder(f.topic_description) ? f.topic_title || f.topic : f.topic_description,
      fact: f.fact.trim(),
    }));
  return s;
}

/** Backwards-compatible wrapper for the Discord/meeting path. */
export async function summarizeMeeting(input: {
  transcript: string;
  participants: string[];
  date: string;
  durationMinutes: number;
}): Promise<MeetingSummary> {
  return summarizeSource({
    text: input.transcript,
    kind: 'meeting',
    date: input.date,
    attribution: input.participants,
    durationMinutes: input.durationMinutes,
  });
}
