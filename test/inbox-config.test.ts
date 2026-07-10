import assert from 'node:assert/strict';
import test from 'node:test';
import { config } from '../src/config.js';

const KEYS = [
  'INBOX_GUILD_IDS',
  'INBOX_CHANNEL_IDS',
  'INBOX_USER_IDS',
  'INBOX_ROLE_IDS',
  'SOURCE_ENCRYPTION_KEY',
  'INBOX_RETENTION_DAYS',
  'DISCORD_PRIVACY_POLICY_URL',
  'DISCORD_DATA_REQUEST_URL',
] as const;

test('Discord Inbox configuration rejects wildcard locations and weak security inputs', () => {
  const previous = new Map(KEYS.map((key) => [key, process.env[key]]));
  try {
    process.env.INBOX_GUILD_IDS = '*';
    process.env.INBOX_CHANNEL_IDS = 'channel-1';
    process.env.INBOX_USER_IDS = '*';
    assert.throws(() => config.inboxPolicy, /wildcard inbox locations are not allowed/i);

    process.env.INBOX_GUILD_IDS = 'guild-1';
    assert.deepEqual(config.inboxPolicy.guildIds, ['guild-1']);

    process.env.SOURCE_ENCRYPTION_KEY = 'not-a-key';
    assert.throws(() => config.sourceEncryptionKey, /base64 encoding exactly 32 random bytes/i);
    process.env.SOURCE_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString('base64');
    assert.equal(config.sourceEncryptionKey, Buffer.alloc(32, 4).toString('base64'));

    process.env.INBOX_RETENTION_DAYS = '0';
    assert.throws(() => config.inboxRetentionDays, /positive whole number/i);
    process.env.INBOX_RETENTION_DAYS = '30';
    assert.equal(config.inboxRetentionDays, 30);

    process.env.DISCORD_PRIVACY_POLICY_URL = 'https://localhost/privacy';
    assert.throws(() => config.discordPrivacyPolicyUrl, /local-only host/i);
    process.env.DISCORD_PRIVACY_POLICY_URL = 'https://example.com/privacy';
    process.env.DISCORD_DATA_REQUEST_URL = 'https://example.com/data-requests';
    assert.equal(config.discordPrivacyPolicyUrl, 'https://example.com/privacy');
    assert.equal(config.discordDataRequestUrl, 'https://example.com/data-requests');
  } finally {
    for (const key of KEYS) {
      const value = previous.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});
