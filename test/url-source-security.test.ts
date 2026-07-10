import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import { Agent } from 'undici';
import { fetchWithTimeout } from '../src/runtime.js';
import {
  createPinnedLookup,
  isBlockedIpAddress,
  resolvePublicTarget,
  safeFetchResolved,
} from '../src/sources/url.js';

test('URL SSRF guard blocks private and special-purpose IPv4 ranges', () => {
  for (const address of [
    '0.0.0.1',
    '10.20.30.40',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.169.254',
    '172.31.255.255',
    '192.0.0.9',
    '192.0.2.10',
    '192.88.99.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.2',
    '203.0.113.9',
    '224.0.0.1',
    '255.255.255.255',
  ]) {
    assert.equal(isBlockedIpAddress(address), true, `${address} should be blocked`);
  }

  assert.equal(isBlockedIpAddress('1.1.1.1'), false);
  assert.equal(isBlockedIpAddress('8.8.8.8'), false);
});

test('URL SSRF guard covers the complete IPv6 link-local range and transition ranges', () => {
  for (const address of [
    '::',
    '::1',
    '::ffff:8.8.8.8',
    '::ffff:0:127.0.0.1',
    '64:ff9b::808:808',
    '64:ff9b:1::808:808',
    '100::1',
    '100:0:0:1::1',
    '2001::1',
    '2001:2::1',
    '2001:10::1',
    '2001:20::1',
    '2001:db8::1',
    '2002::1',
    '2d00::1',
    '3000::1',
    '3f00::1',
    '3ffe::1',
    '3fff:1000::1',
    '3fff::1',
    '5f00::1',
    'fc00::1',
    'fd00::1',
    'fe80::1',
    'fe90::1',
    'febf::1',
    'fec0::1',
    'ff02::1',
  ]) {
    assert.equal(isBlockedIpAddress(address), true, `${address} should be blocked`);
  }

  assert.equal(isBlockedIpAddress('2001:4860:4860::8888'), false);
  assert.equal(isBlockedIpAddress('2606:4700:4700::1111'), false);
  assert.equal(isBlockedIpAddress('2404:6800:4008::200e'), false);
  assert.equal(isBlockedIpAddress('2a00:1450:4009::200e'), false);
  assert.equal(isBlockedIpAddress('2c0f:fb50:4003::1'), false);
});

test('hostname validation rejects every answer when any resolved address is unsafe', async () => {
  await assert.rejects(
    resolvePublicTarget('https://mixed.example/article', async (hostname) => {
      assert.equal(hostname, 'mixed.example');
      return [
        { address: '1.1.1.1', family: 4 },
        { address: 'fe90::1', family: 6 },
      ];
    }),
    /resolves to a private, reserved, or special-purpose address \(fe90::1\)/,
  );
});

test('hostname validation returns the exact validated address to pin', async () => {
  let resolutions = 0;
  const target = await resolvePublicTarget('https://rebind.example/article', async () => {
    resolutions += 1;
    return [{ address: '1.1.1.1', family: 4 }];
  });

  assert.equal(resolutions, 1);
  assert.equal(target.url.hostname, 'rebind.example');
  assert.deepEqual(target.address, { address: '1.1.1.1', family: 4 });
});

test('hostname validation bounds a resolver that never settles', async () => {
  await assert.rejects(
    resolvePublicTarget(
      'https://slow-dns.example/article',
      async () => new Promise<never>(() => {}),
      20,
    ),
    /DNS lookup for slow-dns\.example exceeded 20ms/,
  );
});

test('pinned lookup connects without re-resolving and preserves the original HTTP Host', async () => {
  let observedHost: string | undefined;
  const server = createServer((request, response) => {
    observedHost = request.headers.host;
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('pinned');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const port = (server.address() as AddressInfo).port;
  const agent = new Agent({
    connect: { lookup: createPinnedLookup({ address: '127.0.0.1', family: 4 }) },
  });
  try {
    const init = { dispatcher: agent } as RequestInit & { dispatcher: Agent };
    const response = await fetchWithTimeout(`http://dns-must-not-resolve.invalid:${port}/`, init, 2_000);
    assert.equal(await response.text(), 'pinned');
    assert.equal(observedHost, `dns-must-not-resolve.invalid:${port}`);
  } finally {
    await agent.close();
  }
});

test('redirect loop connects each original hostname through its validated pinned address', async () => {
  const observed: Array<{ host: string | undefined; path: string | undefined }> = [];
  let port = 0;
  const server = createServer((request, response) => {
    observed.push({ host: request.headers.host, path: request.url });
    if (request.url === '/start') {
      response.writeHead(302, { Location: `http://second.invalid:${port}/final` });
      response.end();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('redirect pinned');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  port = (server.address() as AddressInfo).port;

  const resolutions: string[] = [];
  try {
    const leased = await safeFetchResolved(
      `http://first.invalid:${port}/start`,
      async (raw) => {
        const url = new URL(raw);
        resolutions.push(url.hostname);
        return { url, address: { address: '127.0.0.1', family: 4 } };
      },
    );
    try {
      assert.equal(await leased.response.text(), 'redirect pinned');
    } finally {
      await leased.release();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  assert.deepEqual(resolutions, ['first.invalid', 'second.invalid']);
  assert.deepEqual(observed, [
    { host: `first.invalid:${port}`, path: '/start' },
    { host: `second.invalid:${port}`, path: '/final' },
  ]);
});

test('URL validation fails closed on empty, malformed, and inconsistent DNS answers', async () => {
  await assert.rejects(resolvePublicTarget('file:///etc/passwd'), /only http and https/);
  await assert.rejects(resolvePublicTarget('https://user:pass@example.com'), /embedded credentials/);
  await assert.rejects(resolvePublicTarget('https://empty.example', async () => []), /did not resolve/);
  await assert.rejects(
    resolvePublicTarget('https://mismatch.example', async () => [
      { address: '2001:4860:4860::8888', family: 4 },
    ]),
    /special-purpose address/,
  );
  assert.equal(isBlockedIpAddress('not-an-address'), true);
});
