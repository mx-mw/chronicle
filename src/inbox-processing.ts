import type { ExtractedSource, SourceKind } from './sources/index.js';
import type { SourceSummary } from './summarize.js';
import { sanitizeDiscordMediaSignedUrl } from './discord-media-url.js';

export interface InboxAttachmentInput {
  id: string;
  filename: string;
  contentType?: string;
  size: number;
}

export interface InboxProcessingInput {
  content: string;
  capturedAt: string;
  authorName?: string;
  origin: string;
  urls?: readonly string[];
  attachments?: readonly InboxAttachmentInput[];
}

export interface InboxAnalysis {
  capability: 'processable' | 'link_only' | 'partial';
  title?: string;
  summary?: string;
  kind?: string;
  origin?: string;
  decisions?: string[];
  actionItems?: Array<{ owner: string; task: string }>;
  openQuestions?: string[];
  topics?: Array<{ topic: string; fact: string }>;
  warning?: string;
}

export interface InboxProcessingDependencies {
  extract: (input: string) => Promise<ExtractedSource>;
  summarize: (input: {
    text: string;
    kind: SourceKind;
    date: string;
    attribution?: string[];
    durationMinutes?: number;
    title?: string;
    origin?: string;
  }) => Promise<SourceSummary>;
}

const LINK_ONLY_HOSTS: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/(^|\.)youtube\.com$/i, 'YouTube video', 'video'],
  [/(^|\.)youtube-nocookie\.com$/i, 'YouTube video', 'video'],
  [/(^|\.)youtu\.be$/i, 'YouTube video', 'video'],
  [/(^|\.)instagram\.com$/i, 'Instagram Reel', 'video'],
  [/(^|\.)tiktok\.com$/i, 'TikTok video', 'video'],
  [/(^|\.)threads\.net$/i, 'Threads post', 'article'],
  [/(^|\.)x\.com$/i, 'X post', 'article'],
  [/(^|\.)twitter\.com$/i, 'X post', 'article'],
  [/(^|\.)facebook\.com$/i, 'Facebook post', 'article'],
  [/(^|\.)discord\.com$/i, 'Discord link', 'text'],
  [/(^|\.)discordapp\.com$/i, 'Discord link', 'text'],
  [/(^|\.)discord\.gg$/i, 'Discord link', 'text'],
];

const TRACKING_QUERY_KEYS = new Set([
  'fbclid',
  'gclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  'si',
]);

function trimUrlPunctuation(value: string): string {
  let output = value.trim();
  while (/[.,!?;:]$/.test(output)) output = output.slice(0, -1);
  while (output.endsWith(')')) {
    const opens = [...output].filter((character) => character === '(').length;
    const closes = [...output].filter((character) => character === ')').length;
    if (closes <= opens) break;
    output = output.slice(0, -1);
  }
  return output;
}

export function canonicalInboxUrl(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(trimUrlPunctuation(raw));
  } catch {
    return undefined;
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password) {
    return undefined;
  }
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase().startsWith('utm_') || TRACKING_QUERY_KEYS.has(key.toLowerCase())) {
      url.searchParams.delete(key);
    }
  }
  url = new URL(sanitizeDiscordMediaSignedUrl(url.toString()));
  url.searchParams.sort();
  return url.toString();
}

export function extractInboxUrls(
  content: string,
  additional: readonly string[] = [],
  maximum = 8,
): string[] {
  const candidates = [
    ...(content.match(/https?:\/\/[^\s<>]+/gi) ?? []),
    ...additional,
  ];
  const output: string[] = [];
  for (const candidate of candidates) {
    const canonical = canonicalInboxUrl(candidate);
    if (!canonical || output.includes(canonical)) continue;
    output.push(canonical);
    if (output.length >= maximum) break;
  }
  return output;
}

function linkOnlyProvider(raw: string): { title: string; kind: string } | undefined {
  let hostname: string;
  try {
    hostname = new URL(raw).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return undefined;
  }
  for (const [pattern, title, kind] of LINK_ONLY_HOSTS) {
    if (pattern.test(hostname)) return { title, kind };
  }
  return undefined;
}

function noteWithoutUrls(content: string): string {
  return content
    .replace(/https?:\/\/[^\s<>]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dateFromTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return new Date().toISOString().slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function analysisFromSummary(summary: SourceSummary, source: ExtractedSource): InboxAnalysis {
  return {
    capability: 'processable',
    title: summary.title || source.title,
    summary: summary.summary,
    kind: source.kind,
    origin: source.origin,
    decisions: summary.decisions,
    actionItems: summary.action_items.map(({ owner, task }) => ({ owner, task })),
    openQuestions: summary.open_questions,
    topics: summary.facts.map(({ topic, fact }) => ({ topic, fact })),
  };
}

export async function processInboxSource(
  input: InboxProcessingInput,
  dependencies: InboxProcessingDependencies,
): Promise<InboxAnalysis> {
  const urls = extractInboxUrls(input.content, input.urls);
  const note = noteWithoutUrls(input.content);
  const primaryUrl = urls[0];

  if (primaryUrl) {
    const provider = linkOnlyProvider(primaryUrl);
    if (provider) {
      return {
        capability: 'link_only',
        title: provider.title,
        summary: note || 'Saved link. Chronicle did not access or analyze the provider media.',
        kind: provider.kind,
        origin: primaryUrl,
        warning: 'Provider media was not fetched. Only the submitted link and note were saved.',
      };
    }

    let source: ExtractedSource;
    try {
      source = await dependencies.extract(primaryUrl);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'The source could not be extracted.';
      return {
        capability: 'partial',
        title: new URL(primaryUrl).hostname,
        summary: note || 'The link was saved, but Chronicle could not read its contents.',
        kind: 'article',
        origin: primaryUrl,
        warning: detail,
      };
    }

    const summary = await dependencies.summarize({
      text: source.text,
      kind: source.kind,
      date: dateFromTimestamp(input.capturedAt),
      attribution: source.attribution,
      durationMinutes: source.durationMinutes,
      title: source.title,
      origin: source.origin,
    });
    return analysisFromSummary(summary, source);
  }

  const text = input.content.trim();
  if (text) {
    const source: ExtractedSource = {
      kind: 'text',
      origin: input.origin,
      text,
      attribution: input.authorName ? [input.authorName] : undefined,
    };
    const summary = await dependencies.summarize({
      text,
      kind: 'text',
      date: dateFromTimestamp(input.capturedAt),
      attribution: source.attribution,
      origin: source.origin,
    });
    return analysisFromSummary(summary, source);
  }

  const attachments = input.attachments ?? [];
  if (attachments.length > 0) {
    return {
      capability: 'partial',
      title: attachments[0].filename || 'Discord attachment',
      summary: `${attachments.length} attachment${attachments.length === 1 ? '' : 's'} saved as metadata.`,
      kind: 'attachment',
      origin: input.origin,
      warning: 'Attachment analysis is not enabled in this release.',
    };
  }

  return {
    capability: 'partial',
    title: 'Empty Discord submission',
    summary: 'The message contained no readable text, link, or attachment metadata.',
    kind: 'text',
    origin: input.origin,
    warning: 'Nothing was available to process.',
  };
}
