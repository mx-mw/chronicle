// Fetch a web page and extract its readable article text (Readability + linkedom).
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { ExtractedSource, ExtractOptions } from './index.js';

// A real UA: many sites serve a stub or a 403 to the default `node` fetch agent.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36 Chronicle/1.0';

// Node's fetch has no default timeout; a hung server would hang the ingest.
const FETCH_TIMEOUT_MS = 20_000;

/**
 * SSRF guard. Chronicle's whole pitch is "paste a link", so the fetcher will
 * one day sit behind a web box where the URL is fully attacker-controlled.
 * Left open, it becomes a proxy into everything the host can reach: cloud
 * metadata (169.254.169.254), the local model server, intranet admin panels.
 *
 * Refuse anything but http(s) to a public IP. This is checked BEFORE the fetch,
 * and every redirect hop is re-checked by resolving the target ourselves — a
 * public URL that 302s to 127.0.0.1 must not slip through, which is why the
 * fetch uses redirect: 'manual'.
 */
function isPrivateIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) || // link-local + cloud metadata
      a === 0 ||
      a >= 224 // multicast / reserved
    );
  }
  const lower = ip.toLowerCase();
  return (
    lower === '::1' ||
    lower === '::' ||
    lower.startsWith('fe80') || // link-local
    lower.startsWith('fc') ||
    lower.startsWith('fd') || // unique-local
    lower.startsWith('::ffff:') // IPv4-mapped — re-check the embedded v4
  );
}

async function assertPublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Refusing to fetch ${url.protocol}// — only http and https are allowed.`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (isIP(host)) {
    if (isPrivateIp(host)) throw new Error(`Refusing to fetch a private/loopback address (${host}).`);
    return url;
  }
  // Resolve the hostname and reject if ANY address is private — a hostile domain
  // can publish an A record pointing at 127.0.0.1.
  const addrs = await lookup(host, { all: true });
  for (const { address } of addrs) {
    const mapped = address.toLowerCase().startsWith('::ffff:') ? address.slice(7) : address;
    if (isPrivateIp(mapped)) {
      throw new Error(`Refusing to fetch ${host}: it resolves to a private address (${address}).`);
    }
  }
  return url;
}

/** Fetch with manual redirect handling, re-validating every hop against the SSRF guard. */
async function safeFetch(startUrl: string): Promise<Response> {
  let current = startUrl;
  for (let hop = 0; hop < 5; hop += 1) {
    await assertPublicUrl(current);
    const res = await fetch(current, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
      redirect: 'manual',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400 && res.headers.has('location')) {
      current = new URL(res.headers.get('location')!, current).href;
      continue;
    }
    return res;
  }
  throw new Error(`Too many redirects fetching ${startUrl}.`);
}

/** Collapse the runs of whitespace a DOM-to-text pass leaves behind. */
function tidy(text: string): string {
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

export async function extractUrl(url: string, opts: ExtractOptions = {}): Promise<ExtractedSource> {
  let res: Response;
  try {
    res = await safeFetch(url);
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(`Fetching ${url} timed out after ${FETCH_TIMEOUT_MS / 1000}s.`);
    }
    throw new Error(`Could not fetch ${url}: ${err instanceof Error ? err.message : err}`);
  }

  if (!res.ok) {
    throw new Error(`Fetching ${url} returned HTTP ${res.status} ${res.statusText}.`);
  }
  const contentType = res.headers.get('content-type') ?? '';

  // Plain text (raw READMEs, plaintext RFCs, .txt articles) needs no parsing —
  // it IS the article text. Only HTML goes through Readability.
  if (/^text\/plain|^text\/markdown/i.test(contentType)) {
    const text = tidy(await res.text());
    if (!text) throw new Error(`No readable text found at ${url}.`);
    return {
      kind: 'article',
      title: opts.speaker ? undefined : new URL(url).pathname.split('/').pop() || url,
      origin: url,
      text,
      attribution: opts.speaker ? [opts.speaker] : undefined,
    };
  }
  if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
    throw new Error(
      `${url} is ${contentType || 'an unknown content-type'} — Chronicle can ingest HTML pages ` +
        `and plain text over the web. For a PDF, download it and ingest the file path instead.`,
    );
  }

  const html = await res.text();
  const { document } = parseHTML(html);
  const docTitle = document.title?.trim() || undefined;

  // Readability mutates the document, so parse a throwaway copy for it and keep
  // the original for the <body> fallback.
  const article = new Readability(parseHTML(html).document).parse();

  let text = article?.textContent?.trim() ?? '';
  let title = article?.title?.trim() || docTitle;

  // Not every page is an article (docs, landing pages, listings). Rather than
  // throw, fall back to the raw <body> text so the source is still ingestable.
  if (!text) {
    text = (document.body?.textContent ?? '').trim();
    title = title || docTitle;
  }
  text = tidy(text);
  if (!text) throw new Error(`No readable text found at ${url}.`);

  return {
    kind: 'article',
    title,
    origin: url,
    text,
    attribution: opts.speaker ? [opts.speaker] : undefined,
  };
}
