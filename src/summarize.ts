import { config } from './config.js';

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

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object in model response');
  return JSON.parse(candidate.slice(start, end + 1));
}

export async function summarizeMeeting(input: {
  transcript: string;
  participants: string[];
  date: string;
  durationMinutes: number;
}): Promise<MeetingSummary> {
  const res = await fetch(`${config.llmBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.llmApiKey ? { Authorization: `Bearer ${config.llmApiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.llmModel,
      max_tokens: 8_000,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Meeting date: ${input.date}
Duration: ~${input.durationMinutes} minutes
Participants: ${input.participants.join(', ') || 'unknown'}

Transcript:
${input.transcript}`,
        },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(
      `Local LLM request failed (${res.status} ${res.statusText}): ${await res.text()}. Is llama-server running at ${config.llmBaseUrl}?`,
    );
  }

  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
  const text = data.choices[0]?.message.content ?? '';

  const parsed = extractJson(text) as MeetingSummary;
  if (!parsed.title || !parsed.slug || !Array.isArray(parsed.facts)) {
    throw new Error('Model response missing required summary fields');
  }
  parsed.decisions ??= [];
  parsed.action_items ??= [];
  parsed.open_questions ??= [];
  return parsed;
}
