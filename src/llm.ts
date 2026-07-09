/**
 * One interface, two backends: a local OpenAI-compatible server (Ollama,
 * llama.cpp) and Claude via Anthropic's Messages API.
 *
 * These are not the same shape and cannot be unified by swapping a base URL.
 * Anthropic's API is `POST /v1/messages` — `system` is a top-level parameter
 * rather than a message, and it enforces a JSON schema server-side instead of
 * being asked nicely in the prompt. So each backend gets a real adapter, and
 * `completeJson()` is the seam the rest of Chronicle codes against.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

export interface JsonRequest {
  system: string;
  user: string;
  /** JSON Schema the response must satisfy. Enforced by the API on Claude. */
  schema: Record<string, unknown>;
  maxTokens?: number;
}

/**
 * Pull a JSON object out of prose. Only needed for local models, which are
 * asked for JSON and mostly comply — sometimes wrapped in a code fence, or
 * trailed by a cheerful sentence. Claude's structured outputs make this
 * unnecessary, which is the point of having a schema at all.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object in model response');
  return JSON.parse(candidate.slice(start, end + 1));
}

async function completeJsonLocal(req: JsonRequest): Promise<unknown> {
  const res = await fetch(`${config.llmBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.llmApiKey ? { Authorization: `Bearer ${config.llmApiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.llmModel,
      max_tokens: req.maxTokens ?? 8_000,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
    }),
  });

  if (!res.ok) {
    throw new Error(
      `Local LLM request failed (${res.status} ${res.statusText}): ${await res.text()}. ` +
        `Is a server running at ${config.llmBaseUrl}? For Ollama: \`ollama serve\`.`,
    );
  }

  // Deliberately ignore `.reasoning` — that keeps reasoning models working
  // here without code changes, at the cost of their latency.
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return extractJson(data.choices[0]?.message.content ?? '');
}

async function completeJsonAnthropic(req: JsonRequest): Promise<unknown> {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });

  const response = await client.messages.create({
    model: config.anthropicModel,
    max_tokens: req.maxTokens ?? 8_000,
    thinking: { type: 'adaptive' },
    system: req.system,
    messages: [{ role: 'user', content: req.user }],
    output_config: { format: { type: 'json_schema', schema: req.schema } },
  });

  if (response.stop_reason === 'refusal') {
    throw new Error('Claude declined to process this transcript.');
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error(
      `Claude hit the ${req.maxTokens ?? 8_000}-token output cap before finishing the JSON. ` +
        `Raise maxTokens, or distil a shorter transcript.`,
    );
  }

  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');

  // The schema is enforced server-side, so this is a plain parse, not a rescue.
  return JSON.parse(text);
}

/** Ask the configured model for a JSON object matching `schema`. */
export async function completeJson(req: JsonRequest): Promise<unknown> {
  return config.llmProvider === 'anthropic'
    ? completeJsonAnthropic(req)
    : completeJsonLocal(req);
}

/** Ask the configured model for prose. Used by `/recall` to answer over the KB. */
export async function completeText(req: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const maxTokens = req.maxTokens ?? 2_000;

  if (config.llmProvider === 'anthropic') {
    const client = new Anthropic({ apiKey: config.anthropicApiKey });
    const response = await client.messages.create({
      model: config.anthropicModel,
      max_tokens: maxTokens,
      thinking: { type: 'adaptive' },
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
    });
    if (response.stop_reason === 'refusal') {
      throw new Error('Claude declined to answer this question.');
    }
    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
  }

  const res = await fetch(`${config.llmBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.llmApiKey ? { Authorization: `Bearer ${config.llmApiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.llmModel,
      max_tokens: maxTokens,
      messages: [
        { role: 'system', content: req.system },
        { role: 'user', content: req.user },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`Local LLM request failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { choices: { message: { content: string } }[] };
  return (data.choices[0]?.message.content ?? '').trim();
}

/** Human-readable description of the active backend, for startup logs. */
export function describeProvider(): string {
  return config.llmProvider === 'anthropic'
    ? `Claude (${config.anthropicModel})`
    : `local (${config.llmModel} at ${config.llmBaseUrl})`;
}
