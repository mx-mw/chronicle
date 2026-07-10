import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { test } from 'node:test';
import {
  DEFAULT_MAX_SESSION_SEGMENTS,
  RecordingResourceGuard,
  type RecordingResourceLimits,
} from '../src/recording-limits.js';
import { createGuardedPcmTransform } from '../src/recorder.js';

const limits: RecordingResourceLimits = {
  maxDurationMs: 60_000,
  maxAudioBytes: 100,
  minFreeDiskBytes: 1_000,
  maxSegments: 3,
};

test('aggregate raw-audio accounting rejects the chunk that would cross the byte limit', () => {
  const guard = new RecordingResourceGuard(limits, 10_000);
  assert.equal(guard.acceptAudioBytes(60), undefined);
  const trip = guard.acceptAudioBytes(41);
  assert.equal(trip?.kind, 'audio_bytes');
  assert.equal(guard.audioBytes, 60);
});

test('free-space projection protects the reserve between filesystem samples', () => {
  const guard = new RecordingResourceGuard(limits, 1_050);
  assert.equal(guard.acceptAudioBytes(40), undefined);
  const trip = guard.acceptAudioBytes(20);
  assert.equal(trip?.kind, 'free_disk');
  assert.equal(guard.audioBytes, 40);
});

test('duration, byte, and disk trips are one-shot', () => {
  const guard = new RecordingResourceGuard(limits, 10_000);
  const first = guard.checkDuration(60_000);
  assert.equal(first?.kind, 'duration');
  assert.equal(guard.acceptAudioBytes(101), first);
  assert.equal(guard.sampleFreeDisk(0), first);
});

test('a refreshed free-space sample detects external disk consumption', () => {
  const guard = new RecordingResourceGuard(limits, 10_000);
  assert.equal(guard.acceptAudioBytes(20), undefined);
  assert.equal(guard.sampleFreeDisk(999)?.kind, 'free_disk');
});

test('segment creation is bounded independently of raw byte size', () => {
  const guard = new RecordingResourceGuard(limits, 10_000);
  for (let index = 0; index < limits.maxSegments; index += 1) {
    assert.equal(guard.acceptSegment(), undefined);
  }
  assert.equal(guard.acceptSegment()?.kind, 'segment_count');
  assert.equal(DEFAULT_MAX_SESSION_SEGMENTS, 5_000);
});

test('the PCM transform passes accepted bytes and rejects an over-limit chunk', async () => {
  const accepted = new RecordingResourceGuard(limits, 10_000);
  const output: Buffer[] = [];
  await pipeline(
    Readable.from([Buffer.alloc(40)]),
    createGuardedPcmTransform(accepted, () => assert.fail('unexpected limit trip')),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        output.push(Buffer.from(chunk));
        callback();
      },
    }),
  );
  assert.equal(Buffer.concat(output).length, 40);

  const rejected = new RecordingResourceGuard(limits, 10_000);
  let trips = 0;
  const rejectedOutput: Buffer[] = [];
  let guarded = createGuardedPcmTransform(rejected, (trip) => {
    trips += 1;
    // Mirrors RecordingSession.tripResourceLimit(), which destroys every
    // tracked stream while this transform callback is still on the stack.
    guarded.destroy(new Error(trip.message));
  });
  await assert.rejects(
    pipeline(
      Readable.from([Buffer.alloc(60), Buffer.alloc(41)]),
      guarded,
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          rejectedOutput.push(Buffer.from(chunk));
          callback();
        },
      }),
    ),
    (error: unknown) => {
      assert.notEqual((error as NodeJS.ErrnoException).code, 'ERR_MULTIPLE_CALLBACK');
      assert.match(String(error), /raw-audio limit/);
      return true;
    },
  );
  assert.equal(trips, 1);
  assert.equal(Buffer.concat(rejectedOutput).length, 60);
});
