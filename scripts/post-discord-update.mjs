import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DISCORD_MESSAGE_LIMIT = 1_900;
const NOTIFICATION_STATUS_CONTEXT = 'chronicle/discord-main-notified';
const REQUEST_TIMEOUT_MS = 15_000;

function cleanInline(value, maximum = 280) {
  const cleaned = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length <= maximum) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maximum - 3)).trimEnd()}...`;
}

export function discordWebhookUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('Discord update webhook must be a valid HTTPS Discord webhook URL.');
  }
  const hostname = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !['discord.com', 'discordapp.com'].includes(hostname) ||
    !/^\/api\/webhooks\/\d+\/[A-Za-z0-9._-]+\/?$/.test(url.pathname)
  ) {
    throw new Error('Discord update webhook must be a valid HTTPS Discord webhook URL.');
  }
  for (const key of url.searchParams.keys()) {
    if (key !== 'thread_id') {
      throw new Error('Discord update webhook contains an unsupported query parameter.');
    }
  }
  url.searchParams.set('wait', 'true');
  return url;
}

export function extractSummaryBullets(body, maximum = 4) {
  const lines = String(body ?? '').split(/\r?\n/);
  let inSummary = false;
  const bullets = [];
  for (const line of lines) {
    if (/^##\s+summary\s*$/i.test(line.trim())) {
      inSummary = true;
      continue;
    }
    if (inSummary && /^##\s+/.test(line.trim())) break;
    if (!inSummary) continue;
    const match = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (!match) continue;
    const bullet = cleanInline(match[1]);
    if (bullet && !bullets.includes(bullet)) bullets.push(bullet);
    if (bullets.length >= maximum) break;
  }
  return bullets;
}

function commitSubjects(event, maximum = 4) {
  const commits = Array.isArray(event?.commits) ? event.commits : [];
  const subjects = [];
  for (const commit of commits) {
    const subject = cleanInline(String(commit?.message ?? '').split(/\r?\n/, 1)[0]);
    if (!subject || /^Merge pull request #\d+/i.test(subject) || subjects.includes(subject)) continue;
    subjects.push(subject);
    if (subjects.length >= maximum) break;
  }
  return subjects;
}

function truncateWithFooter(body, footer) {
  const available = DISCORD_MESSAGE_LIMIT - footer.length - 5;
  const shortened = body.length > available
    ? `${body.slice(0, Math.max(0, available)).trimEnd()}...`
    : body;
  return `${shortened}${footer}`;
}

export function buildDiscordUpdateMessage({
  event = {},
  pullRequest,
  repository,
  sha,
  serverUrl = 'https://github.com',
}) {
  const shortSha = String(sha).slice(0, 7);
  const pullTitle = cleanInline(pullRequest?.title);
  const headTitle = cleanInline(String(event?.head_commit?.message ?? '').split(/\r?\n/, 1)[0]);
  const title = pullTitle || headTitle || `Update ${shortSha}`;
  const bullets = pullRequest
    ? extractSummaryBullets(pullRequest.body)
    : commitSubjects(event);
  const body = [
    '**Chronicle main updated**',
    '',
    `**${title}**`,
    ...bullets.map((bullet) => `- ${bullet}`),
    '',
    'Automated checks passed: Node 22.16, Node 24, full Chronicle check, and npm audit.',
    'Live Discord smoke test: not run by CI; this remains a manual gate.',
  ].join('\n');
  const changeUrl = pullRequest?.html_url || `${serverUrl}/${repository}/commit/${sha}`;
  const label = pullRequest?.number ? `View PR #${pullRequest.number}` : `View commit ${shortSha}`;
  return truncateWithFooter(body, `\n\n[${label}](${changeUrl})`);
}

function requireRepository(value) {
  const repository = String(value ?? '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('GITHUB_REPOSITORY is missing or invalid.');
  }
  return repository;
}

async function githubRequest(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...options.headers,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return response;
}

async function notificationAlreadySent({ apiUrl, repository, sha, token }) {
  const response = await githubRequest(
    `${apiUrl}/repos/${repository}/commits/${encodeURIComponent(sha)}/statuses?per_page=100`,
    token,
  );
  if (!response.ok) throw new Error(`GitHub notification status lookup failed (${response.status}).`);
  const statuses = await response.json();
  return Array.isArray(statuses) && statuses.some(
    (status) => status?.context === NOTIFICATION_STATUS_CONTEXT && status?.state === 'success',
  );
}

async function associatedPullRequest({ apiUrl, repository, sha, token }) {
  const response = await githubRequest(
    `${apiUrl}/repos/${repository}/commits/${encodeURIComponent(sha)}/pulls?per_page=20`,
    token,
  );
  if (!response.ok) return undefined;
  const pulls = await response.json();
  if (!Array.isArray(pulls)) return undefined;
  return pulls.find((pull) => pull?.merge_commit_sha === sha)
    ?? pulls.find((pull) => pull?.merged_at)
    ?? pulls[0];
}

async function markNotificationSent({ apiUrl, repository, sha, token, targetUrl }) {
  const response = await githubRequest(
    `${apiUrl}/repos/${repository}/statuses/${encodeURIComponent(sha)}`,
    token,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state: 'success',
        context: NOTIFICATION_STATUS_CONTEXT,
        description: 'Chronicle update posted to Discord',
        target_url: targetUrl,
      }),
    },
  );
  if (!response.ok) throw new Error(`GitHub notification status write failed (${response.status}).`);
}

async function postDiscordUpdate(webhook, content) {
  const response = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'Chronicle updates',
      content,
      allowed_mentions: { parse: [] },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Discord update webhook returned HTTP ${response.status}.`);
}

export async function main(environment = process.env) {
  const rawWebhook = environment.DISCORD_MAIN_UPDATES_WEBHOOK_URL?.trim();
  if (!rawWebhook) {
    console.log('DISCORD_MAIN_UPDATES_WEBHOOK_URL is not configured; skipping Discord update.');
    return;
  }
  const webhook = discordWebhookUrl(rawWebhook);
  const token = environment.GITHUB_TOKEN?.trim();
  if (!token) throw new Error('GITHUB_TOKEN is required to prevent duplicate Discord updates.');
  const repository = requireRepository(environment.GITHUB_REPOSITORY);
  const sha = environment.GITHUB_SHA?.trim();
  if (!/^[a-f0-9]{40}$/i.test(sha ?? '')) throw new Error('GITHUB_SHA is missing or invalid.');
  const event = JSON.parse(await readFile(environment.GITHUB_EVENT_PATH, 'utf8'));
  const apiUrl = (environment.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');

  if (await notificationAlreadySent({ apiUrl, repository, sha, token })) {
    console.log(`Discord update already recorded for ${sha.slice(0, 7)}; skipping.`);
    return;
  }

  const pullRequest = await associatedPullRequest({ apiUrl, repository, sha, token });
  const serverUrl = (environment.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '');
  const content = buildDiscordUpdateMessage({ event, pullRequest, repository, sha, serverUrl });
  await postDiscordUpdate(webhook, content);

  const runUrl = environment.GITHUB_RUN_ID
    ? `${serverUrl}/${repository}/actions/runs/${environment.GITHUB_RUN_ID}`
    : `${serverUrl}/${repository}/commit/${sha}`;
  await markNotificationSent({ apiUrl, repository, sha, token, targetUrl: runUrl });
  console.log(`Posted Chronicle Discord update for ${sha.slice(0, 7)}.`);
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (entrypoint && fileURLToPath(import.meta.url) === entrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
