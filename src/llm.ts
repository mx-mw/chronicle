/** LLM adapters for local OpenAI-compatible servers and Anthropic. */
import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';
import {
  assertModelEndpointAllowed,
  booleanEnv,
  fetchWithTimeout,
  positiveIntegerEnv,
  withTimeout,
} from './runtime.js';

export interface JsonRequest {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
  normalizeJson?: (value: unknown) => unknown;
}

export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object in model response.');
  return JSON.parse(candidate.slice(start, end + 1));
}

function schemaType(schema: Record<string, unknown>): string | undefined {
  return typeof schema.type === 'string' ? schema.type : undefined;
}

/** Dependency-free validation for the JSON-schema subset Chronicle emits. */
export function validateJsonSchema(
  value: unknown,
  schema: Record<string, unknown>,
  path = '$',
): void {
  const type = schemaType(schema);
  if (type === 'object') {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error(`${path} must be an object.`);
    }
    const record = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const required = Array.isArray(schema.required) ? (schema.required as string[]) : [];
    for (const key of required) {
      if (!(key in record)) throw new Error(`${path}.${key} is required.`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(record)) {
        if (!(key in properties)) throw new Error(`${path}.${key} is not allowed.`);
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (key in record) validateJsonSchema(record[key], childSchema, `${path}.${key}`);
    }
    return;
  }
  if (type === 'array') {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
    const items = schema.items as Record<string, unknown> | undefined;
    if (items) value.forEach((item, index) => validateJsonSchema(item, items, `${path}[${index}]`));
    return;
  }
  if (type === 'string' && typeof value !== 'string') throw new Error(`${path} must be a string.`);
  if (type === 'number' && typeof value !== 'number') throw new Error(`${path} must be a number.`);
  if (type === 'integer' && (typeof value !== 'number' || !Number.isInteger(value))) {
    throw new Error(`${path} must be an integer.`);
  }
  if (type === 'boolean' && typeof value !== 'boolean') throw new Error(`${path} must be a boolean.`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    throw new Error(`${path} must be one of ${schema.enum.join(', ')}.`);
  }
}

function localTimeout(): number {
  return positiveIntegerEnv('LLM_TIMEOUT_MS', positiveIntegerEnv('PROCESSING_TIMEOUT_MS', 30 * 60_000));
}

async function completeJsonLocal(request: JsonRequest): Promise<unknown> {
  assertModelEndpointAllowed(config.llmBaseUrl, 'LLM_BASE_URL');
  let invalidOutput: unknown;
  let repairInstruction: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await fetchWithTimeout(
      `${config.llmBaseUrl.replace(/\/+$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(config.llmApiKey ? { Authorization: `Bearer ${config.llmApiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.llmModel,
          max_tokens: request.maxTokens ?? 8_000,
          temperature: 0,
          ...(booleanEnv('LLM_JSON_MODE', true) ? { response_format: { type: 'json_object' } } : {}),
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
            ...(repairInstruction
              ? [{ role: 'user', content: repairInstruction }]
              : []),
          ],
        }),
      },
      localTimeout(),
    );
    if (!response.ok) {
      throw new Error(
        `Local LLM request failed (${response.status} ${response.statusText}): ${await response.text()}. ` +
          `Confirm that ${config.llmModel} is available.`,
      );
    }
    const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    try {
      const parsed = extractJson(data.choices?.[0]?.message?.content ?? '');
      const normalized = request.normalizeJson ? request.normalizeJson(parsed) : parsed;
      validateJsonSchema(normalized, request.schema);
      return normalized;
    } catch (error) {
      invalidOutput = error;
      repairInstruction =
        `Your previous JSON response failed validation: ${
          error instanceof Error ? error.message : String(error)
        }. Return one corrected JSON object matching the requested schema. ` +
        'Omit optional fields you cannot represent correctly; do not add commentary or Markdown.';
    }
  }
  throw new Error(
    `Local model returned invalid structured output twice: ${
      invalidOutput instanceof Error ? invalidOutput.message : String(invalidOutput)
    }`,
  );
}

async function completeJsonAnthropic(request: JsonRequest): Promise<unknown> {
  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const response = await withTimeout(
    client.messages.create({
      model: config.anthropicModel,
      max_tokens: request.maxTokens ?? 8_000,
      thinking: { type: 'adaptive' },
      system: request.system,
      messages: [{ role: 'user', content: request.user }],
      output_config: { format: { type: 'json_schema', schema: request.schema } },
    }),
    positiveIntegerEnv('ANTHROPIC_TIMEOUT_MS', 30 * 60_000),
    'Anthropic JSON request',
  );
  if (response.stop_reason === 'refusal') throw new Error('Claude declined to process this source.');
  if (response.stop_reason === 'max_tokens') {
    throw new Error(`Claude reached the ${request.maxTokens ?? 8_000}-token output limit.`);
  }
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
  const parsed = JSON.parse(text);
  const normalized = request.normalizeJson ? request.normalizeJson(parsed) : parsed;
  validateJsonSchema(normalized, request.schema);
  return normalized;
}

export async function completeJson(request: JsonRequest): Promise<unknown> {
  return config.llmProvider === 'anthropic'
    ? completeJsonAnthropic(request)
    : completeJsonLocal(request);
}

export async function completeText(request: {
  system: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const maxTokens = request.maxTokens ?? 2_000;
  if (config.llmProvider === 'anthropic') {
    const client = new Anthropic({ apiKey: config.anthropicApiKey });
    const response = await withTimeout(
      client.messages.create({
        model: config.anthropicModel,
        max_tokens: maxTokens,
        thinking: { type: 'adaptive' },
        system: request.system,
        messages: [{ role: 'user', content: request.user }],
      }),
      positiveIntegerEnv('ANTHROPIC_TIMEOUT_MS', 30 * 60_000),
      'Anthropic text request',
    );
    if (response.stop_reason === 'refusal') throw new Error('Claude declined to answer this question.');
    if (response.stop_reason === 'max_tokens') throw new Error('Claude reached the answer token limit.');
    return response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
  }

  assertModelEndpointAllowed(config.llmBaseUrl, 'LLM_BASE_URL');
  const response = await fetchWithTimeout(
    `${config.llmBaseUrl.replace(/\/+$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.llmApiKey ? { Authorization: `Bearer ${config.llmApiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.llmModel,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
      }),
    },
    localTimeout(),
  );
  if (!response.ok) {
    throw new Error(`Local LLM request failed (${response.status}): ${await response.text()}`);
  }
  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  return (data.choices?.[0]?.message?.content ?? '').trim();
}

export function describeProvider(): string {
  return config.llmProvider === 'anthropic'
    ? `Claude (${config.anthropicModel})`
    : `local (${config.llmModel})`;
}
