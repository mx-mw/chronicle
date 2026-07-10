import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildDiscordUpdateMessage,
  discordWebhookUrl,
  extractSummaryBullets,
  main,
} from '../scripts/post-discord-update.mjs';

test('Discord update webhook validation accepts only official webhook endpoints', () => {
  assert.equal(
    discordWebhookUrl('https://discord.com/api/webhooks/123/token_value').hostname,
    'discord.com',
  );
  assert.equal(
    discordWebhookUrl('https://discord.com/api/webhooks/123/token_value?thread_id=456')
      .searchParams.get('wait'),
    'true',
  );
  for (const value of [
    'http://discord.com/api/webhooks/123/token',
    'https://discord.com.evil.example/api/webhooks/123/token',
    'https://user:password@discord.com/api/webhooks/123/token',
    'https://discord.com/channels/123/456',
    'https://discord.com/api/webhooks/123/token?redirect=https://evil.example',
  ]) {
    assert.throws(() => discordWebhookUrl(value), /valid HTTPS Discord webhook|unsupported query/);
  }
});

test('Discord update summaries use only bounded bullets from the PR Summary section', () => {
  assert.deepEqual(
    extractSummaryBullets(`
## Summary
- Add encrypted Inbox capture.
- Show sources in Library.
- Retry failed work.
- Respect deletions.
- This fifth item is omitted.

## Internal notes
- This must not be sent.
`),
    [
      'Add encrypted Inbox capture.',
      'Show sources in Library.',
      'Retry failed work.',
      'Respect deletions.',
    ],
  );
});

test('PR notifications are concise, linked, mention-safe payload text', () => {
  const message = buildDiscordUpdateMessage({
    repository: 'mx-mw/chronicle',
    sha: 'a'.repeat(40),
    event: { head_commit: { message: 'Merge pull request #5' } },
    pullRequest: {
      number: 5,
      title: 'Add encrypted Discord Inbox capture',
      html_url: 'https://github.com/mx-mw/chronicle/pull/5',
      body: '## Summary\n- Capture approved messages.\n- Add the encrypted Library.\n\n## Notes\n- private',
    },
  });

  assert.match(message, /Chronicle main updated/);
  assert.match(message, /Capture approved messages/);
  assert.doesNotMatch(message, /private/);
  assert.match(message, /Node 22\.16, Node 24/);
  assert.match(message, /View PR #5/);
  assert.ok(message.length <= 1_900);
});

test('direct main pushes fall back to unique commit subjects', () => {
  const message = buildDiscordUpdateMessage({
    repository: 'mx-mw/chronicle',
    sha: 'b'.repeat(40),
    event: {
      head_commit: { message: 'Document notification setup\n\nDetails' },
      commits: [
        { message: 'Merge pull request #6 from branch' },
        { message: 'Document notification setup' },
        { message: 'Document notification setup' },
      ],
    },
  });

  assert.equal(message.match(/- Document notification setup/g)?.length, 1);
  assert.match(message, /View commit bbbbbbb/);
});

test('notification workflow posts once and records a commit status marker', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chronicle-discord-update-'));
  const eventPath = path.join(directory, 'event.json');
  await writeFile(eventPath, JSON.stringify({
    head_commit: { message: 'Merge pull request #6' },
    commits: [],
  }));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const requests: Array<{ url: string; method: string; body?: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || 'GET';
    requests.push({ url, method, body: typeof init.body === 'string' ? init.body : undefined });
    if (url.endsWith('/statuses?per_page=100')) {
      return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.endsWith('/pulls?per_page=20')) {
      return new Response(JSON.stringify([{
        number: 6,
        title: 'Post updates to Discord',
        body: '## Summary\n- Notify the team after checks pass.',
        html_url: 'https://github.com/mx-mw/chronicle/pull/6',
        merge_commit_sha: 'c'.repeat(40),
        merged_at: '2026-07-10T00:00:00Z',
      }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.startsWith('https://discord.com/api/webhooks/')) {
      return new Response('{}', { status: 200 });
    }
    if (url.includes('/statuses/')) return new Response('{}', { status: 201 });
    return new Response('{}', { status: 404 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await main({
    DISCORD_MAIN_UPDATES_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/token',
    GITHUB_TOKEN: 'test-token',
    GITHUB_REPOSITORY: 'mx-mw/chronicle',
    GITHUB_SHA: 'c'.repeat(40),
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_API_URL: 'https://api.github.test',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_RUN_ID: '12345',
  });

  assert.equal(requests.length, 4);
  const discordRequest = requests.find((request) => request.url.startsWith('https://discord.com/'));
  assert.ok(discordRequest?.body);
  const payload = JSON.parse(discordRequest.body);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.match(payload.content, /Notify the team after checks pass/);
  const marker = requests.at(-1);
  assert.equal(marker?.method, 'POST');
  assert.match(marker?.body ?? '', /chronicle\/discord-main-notified/);
});

test('an existing successful marker skips the Discord webhook', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'chronicle-discord-update-'));
  const eventPath = path.join(directory, 'event.json');
  await writeFile(eventPath, JSON.stringify({ head_commit: { message: 'Already sent' } }));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const requests: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return new Response(JSON.stringify([{
      context: 'chronicle/discord-main-notified',
      state: 'success',
    }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  await main({
    DISCORD_MAIN_UPDATES_WEBHOOK_URL: 'https://discord.com/api/webhooks/123/token',
    GITHUB_TOKEN: 'test-token',
    GITHUB_REPOSITORY: 'mx-mw/chronicle',
    GITHUB_SHA: 'd'.repeat(40),
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_API_URL: 'https://api.github.test',
  });

  assert.equal(requests.length, 1);
  assert.match(requests[0], /statuses\?per_page=100$/);
});
