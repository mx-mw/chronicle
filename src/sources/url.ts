// Fetch a web page and extract its readable article text (Readability + linkedom).
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { Agent } from 'undici';
import { fetchWithTimeout, positiveIntegerEnv, TimeoutError, withTimeout } from '../runtime.js';
import type { ExtractedSource, ExtractOptions } from './index.js';

// A real UA: many sites serve a stub or a 403 to the default `node` fetch agent.
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0 Safari/537.36 Chronicle/1.0';

// Node's fetch has no default timeout; a hung server would hang the ingest.
const FETCH_TIMEOUT_MS = positiveIntegerEnv('WEB_FETCH_TIMEOUT_MS', 20_000);
const MAX_RESPONSE_BYTES = positiveIntegerEnv('MAX_WEB_SOURCE_BYTES', 10 * 1024 * 1024);
const DNS_LOOKUP_TIMEOUT_MS = positiveIntegerEnv(
  'DNS_LOOKUP_TIMEOUT_MS',
  Math.min(5_000, FETCH_TIMEOUT_MS),
);
const DNS_LOOKUP_CONCURRENCY = Math.min(
  32,
  positiveIntegerEnv('DNS_LOOKUP_CONCURRENCY', 8),
);
const DNS_LOOKUP_QUEUE_LIMIT = Math.min(
  128,
  positiveIntegerEnv('DNS_LOOKUP_QUEUE_LIMIT', 32),
);
const CONNECTION_CLEANUP_TIMEOUT_MS = 1_000;

type AddressFamily = 4 | 6;

export interface ResolvedAddress {
  address: string;
  family: AddressFamily;
}

type AddressResolver = (
  hostname: string,
  signal?: AbortSignal,
) => Promise<readonly ResolvedAddress[]>;

export interface PublicTarget {
  url: URL;
  address: ResolvedAddress;
}

// Keep the families in separate lists. Node represents IPv4 entries internally
// as IPv4-mapped IPv6 addresses, so one mixed list would make the intentional
// `::ffff:0:0/96` rule also match every ordinary IPv4 address.
const BLOCKED_IPV4 = new BlockList();
const BLOCKED_IPV6 = new BlockList();
const GLOBAL_UNICAST_IPV6 = new BlockList();

// Exact ALLOCATED prefixes from IANA's global-unicast registry (2025-10-10).
// Unlisted space inside the broader 2000::/3 envelope is reserved, so treating
// the entire envelope as public would allow locally routed legacy/reserved
// ranges. Future global allocations intentionally require an explicit update.
// https://www.iana.org/assignments/ipv6-unicast-address-assignments/
const ALLOCATED_GLOBAL_IPV6_SUBNETS: ReadonlyArray<readonly [string, number]> = [
  ['2001:200::', 23],
  ['2001:400::', 23],
  ['2001:600::', 23],
  ['2001:800::', 22],
  ['2001:c00::', 23],
  ['2001:e00::', 23],
  ['2001:1200::', 23],
  ['2001:1400::', 22],
  ['2001:1800::', 23],
  ['2001:1a00::', 23],
  ['2001:1c00::', 22],
  ['2001:2000::', 19],
  ['2001:4000::', 23],
  ['2001:4200::', 23],
  ['2001:4400::', 23],
  ['2001:4600::', 23],
  ['2001:4800::', 23],
  ['2001:4a00::', 23],
  ['2001:4c00::', 23],
  ['2001:5000::', 20],
  ['2001:8000::', 19],
  ['2001:a000::', 20],
  ['2001:b000::', 20],
  ['2003::', 18],
  ['2400::', 12],
  ['2410::', 12],
  ['2600::', 12],
  ['2610::', 23],
  ['2620::', 23],
  ['2630::', 12],
  ['2800::', 12],
  ['2a00::', 12],
  ['2a10::', 12],
  ['2c00::', 12],
];

for (const [network, prefix] of ALLOCATED_GLOBAL_IPV6_SUBNETS) {
  GLOBAL_UNICAST_IPV6.addSubnet(network, prefix, 'ipv6');
}

// IANA special-purpose, non-routable, documentation, multicast, and reserved
// ranges. Blocking transition ranges too prevents an apparently public IPv6
// literal from tunnelling a connection to an embedded private IPv4 address.
const BLOCKED_IPV4_SUBNETS: ReadonlyArray<readonly [string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

const BLOCKED_IPV6_SUBNETS: ReadonlyArray<readonly [string, number]> = [
  ['::', 96], // unspecified, loopback, and deprecated IPv4-compatible forms
  ['::ffff:0:0', 96], // IPv4-mapped forms
  ['64:ff9b::', 96], // well-known NAT64 prefix
  ['64:ff9b:1::', 48], // local-use NAT64 prefix
  ['100::', 64], // discard-only
  ['100:0:0:1::', 64], // dummy IPv6 prefix
  ['2001::', 23], // IETF protocol assignments, including transition mechanisms
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['3fff::', 20], // documentation
  ['5f00::', 16], // non-global SRv6 SIDs
  ['fc00::', 7], // unique-local
  ['fe80::', 10], // link-local (fe80:: through febf::)
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8], // multicast
];

for (const [network, prefix] of BLOCKED_IPV4_SUBNETS) {
  BLOCKED_IPV4.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of BLOCKED_IPV6_SUBNETS) {
  BLOCKED_IPV6.addSubnet(network, prefix, 'ipv6');
}

/** Fail closed for malformed addresses; callers only proceed with public IPs. */
export function isBlockedIpAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return BLOCKED_IPV4.check(address, 'ipv4');
  if (family === 6) {
    return (
      !GLOBAL_UNICAST_IPV6.check(address, 'ipv6') ||
      BLOCKED_IPV6.check(address, 'ipv6')
    );
  }
  return true;
}

interface DnsWaiter {
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

let activeDnsLookups = 0;
const dnsWaiters: DnsWaiter[] = [];

function dnsReleaseHandle(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeDnsLookups -= 1;
    for (;;) {
      const next = dnsWaiters.shift();
      if (!next) return;
      if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort);
      if (next.signal?.aborted) {
        next.reject(next.signal.reason);
        continue;
      }
      activeDnsLookups += 1;
      next.resolve(dnsReleaseHandle());
      return;
    }
  };
}

async function acquireDnsSlot(signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) throw signal.reason;
  if (activeDnsLookups < DNS_LOOKUP_CONCURRENCY) {
    activeDnsLookups += 1;
    return dnsReleaseHandle();
  }
  if (dnsWaiters.length >= DNS_LOOKUP_QUEUE_LIMIT) {
    throw new Error('DNS lookup capacity is busy; try the capture again shortly.');
  }
  return new Promise<() => void>((resolve, reject) => {
    const waiter: DnsWaiter = { resolve, reject, signal };
    if (signal) {
      waiter.onAbort = () => {
        const index = dnsWaiters.indexOf(waiter);
        if (index >= 0) dnsWaiters.splice(index, 1);
        reject(signal.reason);
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    }
    dnsWaiters.push(waiter);
  });
}

const systemResolver: AddressResolver = async (hostname, signal) => {
  const release = await acquireDnsSlot(signal);
  try {
    if (signal?.aborted) throw signal.reason;
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (signal?.aborted) throw signal.reason;
    return addresses.map(({ address, family }) => ({
      address,
      family: family as AddressFamily,
    }));
  } finally {
    release();
  }
};

async function resolveWithDeadline(
  hostname: string,
  resolver: AddressResolver,
  timeoutMs: number,
): Promise<readonly ResolvedAddress[]> {
  const controller = new AbortController();
  const timeoutError = new TimeoutError(
    `DNS lookup for ${hostname} exceeded ${timeoutMs}ms`,
    timeoutMs,
  );
  const timer = setTimeout(() => controller.abort(timeoutError), timeoutMs);
  timer.unref();
  let removeAbortListener = () => {};
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(controller.signal.reason ?? timeoutError);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => controller.signal.removeEventListener('abort', onAbort);
    });
    return await Promise.race([resolver(hostname, controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    removeAbortListener();
  }
}

/** Resolve and validate one hop, returning the exact address the socket must use. */
export async function resolvePublicTarget(
  raw: string,
  resolver: AddressResolver = systemResolver,
  dnsTimeoutMs = DNS_LOOKUP_TIMEOUT_MS,
): Promise<PublicTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('The supplied value is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Refusing to fetch ${url.protocol}// — only http and https are allowed.`);
  }
  if (url.username || url.password) {
    throw new Error('Refusing to fetch a URL containing embedded credentials.');
  }

  const host = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  const literalFamily = isIP(host);
  if (literalFamily) {
    if (isBlockedIpAddress(host)) {
      throw new Error(`Refusing to fetch a private, reserved, or special-purpose address (${host}).`);
    }
    return { url, address: { address: host, family: literalFamily as AddressFamily } };
  }

  // Reject the whole hostname when any answer is unsafe. Selecting only a safe
  // answer would still let an attacker steer clients through DNS ordering.
  const addresses = await resolveWithDeadline(host, resolver, dnsTimeoutMs);
  if (addresses.length === 0) {
    throw new Error(`Refusing to fetch ${host}: it did not resolve to an address.`);
  }
  for (const candidate of addresses) {
    const actualFamily = isIP(candidate.address);
    if (actualFamily !== candidate.family || isBlockedIpAddress(candidate.address)) {
      throw new Error(
        `Refusing to fetch ${host}: it resolves to a private, reserved, or special-purpose ` +
          `address (${candidate.address}).`,
      );
    }
  }
  return { url, address: addresses[0] };
}

/**
 * A socket resolver that never performs DNS. Undici still receives the
 * original URL, so HTTP Host and TLS SNI remain the requested hostname while
 * the TCP connection uses the address validated above.
 */
export function createPinnedLookup(address: ResolvedAddress): LookupFunction {
  return (_hostname, options, callback) => {
    queueMicrotask(() => {
      if (options.all) {
        callback(null, [address]);
      } else {
        callback(null, address.address, address.family);
      }
    });
  };
}

function createPinnedAgent(address: ResolvedAddress): Agent {
  return new Agent({
    connect: {
      lookup: createPinnedLookup(address),
    },
  });
}

async function closeAgent(agent: Agent): Promise<void> {
  try {
    await withTimeout(
      agent.close(),
      CONNECTION_CLEANUP_TIMEOUT_MS,
      'URL connection cleanup',
    );
  } catch {
    await withTimeout(
      agent.destroy(),
      CONNECTION_CLEANUP_TIMEOUT_MS,
      'URL connection destruction',
    ).catch(() => undefined);
  }
}

function responseLease(response: Response, agent: Agent): () => Promise<void> {
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      if (response.body && !response.bodyUsed) {
        await withTimeout(
          response.body.cancel('Chronicle finished with this URL response'),
          CONNECTION_CLEANUP_TIMEOUT_MS,
          'URL response cancellation',
        ).catch(() => undefined);
      }
    } finally {
      await closeAgent(agent);
    }
  };
}

export interface LeasedResponse {
  response: Response;
  release: () => Promise<void>;
}

export type ResolvedTargetResolver = (raw: string) => Promise<PublicTarget>;

/**
 * Fetch with manual redirects. Every hop is independently resolved, checked,
 * and then connected through a per-hop agent pinned to that checked answer.
 */
/** @internal Exported only so the pin-and-redirect integration can be tested. */
export async function safeFetchResolved(
  startUrl: string,
  resolveTarget: ResolvedTargetResolver,
): Promise<LeasedResponse> {
  let current = startUrl;
  for (let hop = 0; hop < 5; hop += 1) {
    const target = await resolveTarget(current);
    const agent = createPinnedAgent(target.address);
    let response: Response;
    try {
      // `dispatcher` is an Undici extension to RequestInit. fetchWithTimeout
      // preserves unknown runtime properties when it adds the timeout signal.
      const init = {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
        redirect: 'manual',
        dispatcher: agent,
      } as RequestInit & { dispatcher: Agent };
      response = await fetchWithTimeout(target.url, init, FETCH_TIMEOUT_MS);
    } catch (error) {
      await closeAgent(agent);
      throw error;
    }

    const release = responseLease(response, agent);
    if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
      try {
        current = new URL(response.headers.get('location')!, target.url).href;
      } finally {
        await release();
      }
      continue;
    }
    return { response, release };
  }
  throw new Error('Too many redirects while fetching the supplied URL.');
}

/** Production wrapper intentionally exposes no resolver override. */
async function safeFetch(startUrl: string): Promise<LeasedResponse> {
  return safeFetchResolved(startUrl, resolvePublicTarget);
}

async function readResponseText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error(
      `Response is ${declared} bytes; the configured maximum is ${MAX_RESPONSE_BYTES}.`,
    );
  }
  if (!response.body) return '';

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel('Chronicle source-size limit exceeded');
        throw new Error(`Response exceeded the configured ${MAX_RESPONSE_BYTES}-byte maximum.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8');
}

/** Collapse the runs of whitespace a DOM-to-text pass leaves behind. */
function tidy(text: string): string {
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

function safeUrlLabel(raw: string): string {
  try {
    const value = new URL(raw);
    value.username = '';
    value.password = '';
    value.search = '';
    value.hash = '';
    return value.href;
  } catch {
    return 'the supplied URL';
  }
}

export async function extractUrl(url: string, opts: ExtractOptions = {}): Promise<ExtractedSource> {
  const urlLabel = safeUrlLabel(url);
  let leased: LeasedResponse;
  try {
    leased = await safeFetch(url);
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(`Fetching ${urlLabel} timed out: ${err.message}.`);
    }
    throw new Error(`Could not fetch ${urlLabel}: ${err instanceof Error ? err.message : err}`);
  }

  const res = leased.response;
  try {
    if (!res.ok) {
      throw new Error(`Fetching ${urlLabel} returned HTTP ${res.status} ${res.statusText}.`);
    }
    const contentType = res.headers.get('content-type') ?? '';

    // Plain text (raw READMEs, plaintext RFCs, .txt articles) needs no parsing —
    // it IS the article text. Only HTML goes through Readability.
    if (/^text\/plain|^text\/markdown/i.test(contentType)) {
      const text = tidy(await readResponseText(res));
      if (!text) throw new Error(`No readable text found at ${urlLabel}.`);
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
        `${urlLabel} is ${contentType || 'an unknown content-type'} — Chronicle can ingest HTML pages ` +
          `and plain text over the web. For a PDF, download it and ingest the file path instead.`,
      );
    }

    const html = await readResponseText(res);
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
    if (!text) throw new Error(`No readable text found at ${urlLabel}.`);

    return {
      kind: 'article',
      title,
      origin: url,
      text,
      attribution: opts.speaker ? [opts.speaker] : undefined,
    };
  } finally {
    await leased.release();
  }
}
