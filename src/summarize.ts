import { completeJson } from './llm.js';

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

const SYSTEM_PROMPT = `You are the librarian of a memory-palace style knowledge base: a flat repository of small, densely linked markdown notes. Your job is to distill a meeting transcript into durable knowledge.

Principles:
- Extract ATOMIC facts: each fact is one self-contained sentence that will still make sense read alone in six months, with no pronouns pointing outside itself.
- Group facts under topics. A topic is a durable subject (a project, system, person, policy, recurring theme) — not a one-off agenda item. Reuse broad topic slugs rather than inventing near-duplicates.
- Record decisions verbatim in spirit: what was decided, not the discussion that led there.
- Action items must name an owner (use the speaker names from the transcript) and a concrete task.
- Prefer fewer, higher-value facts over exhaustive coverage. Skip small talk entirely.

Respond with ONLY a JSON object, no markdown fences, matching this schema:
{
  "title": "Short meeting title",
  "slug": "kebab-case-meeting-slug",
  "summary": "2-3 paragraph prose summary of what the meeting covered and concluded",
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

export async function summarizeMeeting(input: {
  transcript: string;
  participants: string[];
  date: string;
  durationMinutes: number;
}): Promise<MeetingSummary> {
  const parsed = (await completeJson({
    system: SYSTEM_PROMPT,
    user: `Meeting date: ${input.date}
Duration: ~${input.durationMinutes} minutes
Participants: ${input.participants.join(', ') || 'unknown'}

Transcript:
${input.transcript}`,
    schema: SUMMARY_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 8_000,
  })) as MeetingSummary;

  // Claude's schema guarantees this; a local model's compliance is only a
  // strong suggestion, so the check stays.
  if (!parsed.title || !parsed.slug || !Array.isArray(parsed.facts)) {
    throw new Error('Model response missing required summary fields');
  }
  parsed.decisions ??= [];
  parsed.action_items ??= [];
  parsed.open_questions ??= [];
  return parsed;
}
