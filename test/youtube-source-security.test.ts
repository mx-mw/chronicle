import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canonicalizeYoutubeVideoUrl,
  YT_DLP_SINGLE_VIDEO_ARGS,
} from '../src/sources/youtube.js';

const ID = 'dQw4w9WgXcQ';
const CANONICAL = `https://www.youtube.com/watch?v=${ID}`;

test('canonicalizer accepts only explicit single-video YouTube routes', () => {
  for (const url of [
    `https://youtube.com/watch?v=${ID}`,
    `https://youtube.com./watch?v=${ID}`,
    `https://www.youtube.com/watch?v=${ID}&t=43&utm_source=test#chapter`,
    `http://m.youtube.com/shorts/${ID}?feature=share`,
    `https://youtube.com/live/${ID}?si=tracking`,
    `https://www.youtube.com/embed/${ID}?autoplay=1`,
    `https://youtu.be/${ID}?si=tracking&t=1`,
  ]) {
    assert.equal(canonicalizeYoutubeVideoUrl(url), CANONICAL, url);
  }
});

test('canonicalizer leaves unrelated URLs for the article source', () => {
  assert.equal(canonicalizeYoutubeVideoUrl('https://example.com/watch?v=dQw4w9WgXcQ'), undefined);
  assert.equal(canonicalizeYoutubeVideoUrl('https://youtube.com.example/watch?v=dQw4w9WgXcQ'), undefined);
  assert.equal(canonicalizeYoutubeVideoUrl('not a URL'), undefined);
});

test('YouTube channel, playlist, redirect, and attribution routes fail closed', () => {
  for (const url of [
    'https://youtube.com/@chronicle',
    'https://youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw',
    'https://youtube.com/playlist?list=PL1234567890',
    `https://youtube.com/watch?v=${ID}&v=aaaaaaaaaaa`,
    `https://youtube.com/watch/${ID}`,
    `https://youtube.com/shorts/${ID}/more`,
    `https://youtube.com/redirect?q=https%3A%2F%2Fexample.com%2F${ID}`,
    `https://youtube.com/attribution_link?a=test&u=%2Fwatch%3Fv%3D${ID}`,
  ]) {
    assert.throws(
      () => canonicalizeYoutubeVideoUrl(url),
      /Unsupported YouTube URL.*one video at a time/,
      url,
    );
  }
});

test('malformed or missing video IDs fail closed', () => {
  for (const url of [
    'https://youtube.com/watch',
    'https://youtube.com/watch?list=PL1234567890',
    'https://youtube.com/watch?v=too-short',
    'https://youtube.com/watch?v=dQw4w9WgXc%51%51',
    'https://youtu.be/',
    'https://youtu.be/too_short',
    'https://youtube.com/embed/dQw4w9WgXcQ%2Fextra',
  ]) {
    assert.throws(() => canonicalizeYoutubeVideoUrl(url), /Unsupported YouTube URL/, url);
  }
});

test('YouTube credentials, ports, and unsupported subdomains fail closed', () => {
  for (const url of [
    `https://user:password@youtube.com/watch?v=${ID}`,
    `https://youtube.com:8443/watch?v=${ID}`,
    `https://youtube.com:443/watch?v=${ID}`,
    `https://studio.youtube.com/watch?v=${ID}`,
    `https://evil.youtube.com/watch?v=${ID}`,
    `https://www.youtu.be/${ID}`,
    `https://www.youtube-nocookie.com/embed/${ID}`,
  ]) {
    assert.throws(() => canonicalizeYoutubeVideoUrl(url), /Unsupported YouTube URL/, url);
  }
});

test('every yt-dlp command is prefixed with scope-limiting safety options', () => {
  assert.deepEqual(YT_DLP_SINGLE_VIDEO_ARGS, [
    '--ignore-config',
    '--no-playlist',
    '--playlist-end',
    '1',
  ]);
});
