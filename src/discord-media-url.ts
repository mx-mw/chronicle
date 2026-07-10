const DISCORD_MEDIA_HOSTS = new Set([
  'cdn.discordapp.com',
  'media.discordapp.net',
]);

// Discord attachment signatures currently use these short-lived query fields.
// Other query fields can control legitimate media transformations and are kept.
const DISCORD_SIGNATURE_KEYS = new Set(['ex', 'is', 'hm']);

function withoutTrailingUrlPunctuation(value: string): { core: string; suffix: string } {
  let core = value;
  let suffix = '';
  while (/[.,!?;:]$/.test(core)) {
    suffix = core.at(-1)! + suffix;
    core = core.slice(0, -1);
  }
  while (core.endsWith(')')) {
    const opens = [...core].filter((character) => character === '(').length;
    const closes = [...core].filter((character) => character === ')').length;
    if (closes <= opens) break;
    suffix = `)${suffix}`;
    core = core.slice(0, -1);
  }
  return { core, suffix };
}

/** Remove only ephemeral Discord CDN/media signatures; preserve all other URLs and query fields. */
export function sanitizeDiscordMediaSignedUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return raw;
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (!DISCORD_MEDIA_HOSTS.has(hostname)) return raw;

  let changed = false;
  for (const key of [...url.searchParams.keys()]) {
    if (!DISCORD_SIGNATURE_KEYS.has(key.toLowerCase())) continue;
    url.searchParams.delete(key);
    changed = true;
  }
  return changed ? url.toString() : raw;
}

/** Redact signed Discord media URLs embedded in otherwise user-authored message text. */
export function redactDiscordMediaSignedUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s<>]+/gi, (candidate) => {
    const { core, suffix } = withoutTrailingUrlPunctuation(candidate);
    return `${sanitizeDiscordMediaSignedUrl(core)}${suffix}`;
  });
}
