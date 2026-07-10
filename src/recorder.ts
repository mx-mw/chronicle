import {
  EndBehaviorType,
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import prism from 'prism-media';
import { randomUUID } from 'node:crypto';
import { createWriteStream, statfsSync, type WriteStream } from 'node:fs';
import { rm, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  appendSessionWarning,
  createSessionManifest,
  ensurePrivateDirectory,
  manifestPath,
  purgeRawSessionAudio,
  readSessionManifest,
  setSessionStage,
  tombstoneSession,
  updateSessionManifest,
  writeJsonAtomic,
  type LocatedSessionManifest,
  type SessionManifest,
} from './session-manifest.js';
import {
  DEFAULT_MAX_RECORDING_MINUTES,
  DEFAULT_MAX_SESSION_SEGMENTS,
  DEFAULT_MAX_SESSION_AUDIO_BYTES,
  DEFAULT_MIN_FREE_DISK_BYTES,
  RecordingResourceGuard,
  type RecordingLimitTrip,
  type RecordingResourceLimits,
} from './recording-limits.js';
import { ParticipantAdmissionGate, revalidateAdmissionGate } from './voice-policy.js';

export interface Segment {
  userId: string;
  /** Offset from session start, in ms. */
  startMs: number;
  pcmPath: string;
}

export interface RecordingStartOptions {
  /** Stable knowledge workspace; Discord callers should use the guild ID. */
  workspaceId?: string;
  sessionId?: string;
  optedOutUserIds?: Iterable<string>;
  /** Participants who received the room notice for its full grace period. */
  admittedUserIds?: Iterable<string>;
  /** Shared with the pending-consent state so late opt-outs cannot miss handoff. */
  admissionGate?: ParticipantAdmissionGate;
  /** Cancels voice connection setup before any receiver listener is activated. */
  signal?: AbortSignal;
  resourceLimits?: RecordingResourceLimits;
  onResourceLimit?: (
    trip: RecordingLimitTrip,
    session: RecordingSession,
  ) => void | Promise<void>;
}

export interface RecordingActivationOptions {
  signal?: AbortSignal;
  /** Rechecked immediately before the capture listener is installed. */
  isParticipantPresent?: (userId: string) => boolean;
}

export interface RecordingStopResult {
  segments: Segment[];
  speakers: Map<string, string>;
  durationMs: number;
  sessionId: string;
  sessionDir: string;
  manifestPath: string;
  warnings: string[];
}

type DestroyableStream = NodeJS.ReadableStream & { destroy(error?: Error): void };

const DEFAULT_RESOURCE_LIMITS: RecordingResourceLimits = {
  maxDurationMs: DEFAULT_MAX_RECORDING_MINUTES * 60_000,
  maxAudioBytes: DEFAULT_MAX_SESSION_AUDIO_BYTES,
  minFreeDiskBytes: DEFAULT_MIN_FREE_DISK_BYTES,
  maxSegments: DEFAULT_MAX_SESSION_SEGMENTS,
};

function availableDiskBytes(stats: { bavail: number; bsize: number }): number {
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.max(0, Math.floor(stats.bavail * stats.bsize)),
  );
}

class RecordingLimitError extends Error {
  constructor(readonly trip: RecordingLimitTrip) {
    super(trip.message);
    this.name = 'RecordingLimitError';
  }
}

class GuardedPcmTransform extends Transform {
  constructor(
    private readonly guard: RecordingResourceGuard,
    private readonly onTrip: (trip: RecordingLimitTrip) => void,
  ) {
    super();
  }

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk, encoding);
    const trip = this.guard.acceptAudioBytes(bytes);
    if (trip) {
      this.onTrip(trip);
      callback(new RecordingLimitError(trip));
      return;
    }
    callback(null, chunk);
  }
}

export function createGuardedPcmTransform(
  guard: RecordingResourceGuard,
  onTrip: (trip: RecordingLimitTrip) => void,
): Transform {
  return new GuardedPcmTransform(guard, onTrip);
}

export function createPrivatePcmWriteStream(pcmPath: string): WriteStream {
  return createWriteStream(pcmPath, { mode: 0o600, flags: 'wx' });
}

export function fenceParticipantOptOut(input: {
  userId: string;
  admission: ParticipantAdmissionGate;
  segments: Segment[];
  speakers: Map<string, string>;
}): Segment[] {
  input.admission.optOut(input.userId);
  const removed = input.segments.filter((segment) => segment.userId === input.userId);
  for (let index = input.segments.length - 1; index >= 0; index -= 1) {
    if (input.segments[index].userId === input.userId) input.segments.splice(index, 1);
  }
  input.speakers.delete(input.userId);
  return removed;
}

function timeout(ms: number): Promise<'timeout'> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref?.();
  });
}

/**
 * Records a voice channel by subscribing to each speaker's Opus stream and
 * decoding it to raw PCM (48kHz stereo s16le) on disk, one file per utterance.
 * Every capture is backed by a completion promise and a durable session
 * manifest, so shutdown and crash recovery do not depend on polling memory.
 */
export class RecordingSession {
  readonly speakers = new Map<string, string>(); // userId -> display name
  readonly startedAt: number;
  readonly id: string;
  readonly manifestPath: string;

  private readonly segments: Segment[] = [];
  private readonly activeUsers = new Set<string>();
  private readonly completions = new Set<Promise<void>>();
  private readonly streams = new Map<string, Set<DestroyableStream>>();
  private readonly admission: ParticipantAdmissionGate;
  private readonly warnings: string[] = [];
  private stopped = false;
  private finalized = false;
  private discardRequested = false;
  private activated = false;
  private speakingHandler?: (userId: string) => void;
  private durationTimer?: NodeJS.Timeout;
  private diskTimer?: NodeJS.Timeout;
  private readonly resourceGuard: RecordingResourceGuard;
  private stopPromise?: Promise<RecordingStopResult>;

  private constructor(
    readonly guildId: string,
    readonly voiceChannelId: string,
    readonly dir: string,
    private readonly connection: VoiceConnection,
    private readonly resolveName: (userId: string) => Promise<string>,
    manifest: SessionManifest,
    admission: ParticipantAdmissionGate,
    initialFreeDiskBytes: number,
    limits: RecordingResourceLimits,
    private readonly onResourceLimit?: RecordingStartOptions['onResourceLimit'],
  ) {
    this.id = manifest.id;
    this.manifestPath = manifestPath(dir);
    this.startedAt = Date.parse(manifest.startedAt);
    this.admission = admission;
    this.resourceGuard = new RecordingResourceGuard(limits, initialFreeDiskBytes);
  }

  static async start(
    channel: VoiceBasedChannel,
    sessionsRoot: string,
    resolveName: (userId: string) => Promise<string>,
    options: RecordingStartOptions = {},
  ): Promise<RecordingSession> {
    const id = options.sessionId ?? randomUUID();
    const dir = path.join(
      sessionsRoot,
      `${new Date().toISOString().replace(/[:.]/g, '-')}-${id}`,
    );
    await ensurePrivateDirectory(sessionsRoot);
    await ensurePrivateDirectory(dir);

    const manifest = createSessionManifest({
      id,
      workspaceId: options.workspaceId ?? 'default',
      guildId: channel.guild.id,
      channelId: channel.id,
    });
    const admission = options.admissionGate ?? new ParticipantAdmissionGate(options.admittedUserIds);
    for (const userId of options.optedOutUserIds ?? []) admission.optOut(userId);
    manifest.optedOutUserIds = admission.optedOutUserIds();
    const filePath = manifestPath(dir);
    await writeJsonAtomic(filePath, manifest);

    const limits = options.resourceLimits ?? DEFAULT_RESOURCE_LIMITS;
    const initialFreeDiskBytes = availableDiskBytes(await statfs(dir));
    const initialGuard = new RecordingResourceGuard(limits, initialFreeDiskBytes);
    if (initialGuard.tripped) {
      await setSessionStage(filePath, 'failed', {
        endedAt: new Date().toISOString(),
        durationMs: 0,
        warnings: [initialGuard.tripped.message],
        recoverable: false,
        error: initialGuard.tripped.message,
      });
      throw new Error(initialGuard.tripped.message);
    }

    if (options.signal?.aborted) {
      await tombstoneSession(filePath, 'Recording start was cancelled before voice connection.');
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error('Recording start was cancelled.');
    }

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });

    let rejectAbort: ((reason?: unknown) => void) | undefined;
    const onAbort = () => {
      connection.destroy();
      rejectAbort?.(options.signal?.reason ?? new Error('Recording start was cancelled.'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const ready = entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      const aborted = options.signal
        ? new Promise<never>((_resolve, reject) => {
            rejectAbort = reject;
          })
        : new Promise<never>(() => {});
      await Promise.race([ready, aborted]);
    } catch (error) {
      connection.destroy();
      if (options.signal?.aborted) {
        await tombstoneSession(filePath, 'Recording start was cancelled while connecting.');
      } else {
        await setSessionStage(filePath, 'failed', {
          recoverable: false,
          error: `Could not connect to the voice channel: ${String(error)}`,
        });
      }
      throw new Error(`Could not connect to the voice channel: ${error}`);
    } finally {
      options.signal?.removeEventListener('abort', onAbort);
    }

    const session = new RecordingSession(
      channel.guild.id,
      channel.id,
      dir,
      connection,
      resolveName,
      manifest,
      admission,
      initialFreeDiskBytes,
      limits,
      options.onResourceLimit,
    );
    return session;
  }

  /**
   * Publish the receiver only after index.ts has atomically handed over the
   * latest opt-out and membership state from the pending-consent phase.
   */
  async activate(options: RecordingActivationOptions = {}): Promise<void> {
    if (this.activated) return;
    if (this.stopped || options.signal?.aborted) {
      throw options.signal?.reason instanceof Error
        ? options.signal.reason
        : new Error('Recording activation was cancelled.');
    }
    await setSessionStage(this.manifestPath, 'recording', {
      optedOutUserIds: this.admission.optedOutUserIds(),
    });
    if (this.stopped || options.signal?.aborted) {
      throw options.signal?.reason instanceof Error
        ? options.signal.reason
        : new Error('Recording activation was cancelled.');
    }
    if (options.isParticipantPresent) {
      revalidateAdmissionGate(this.admission, options.isParticipantPresent);
    }
    this.speakingHandler = (userId) => this.capture(userId);
    this.connection.receiver.speaking.on('start', this.speakingHandler);
    this.activated = true;
    this.armResourceTimers();
  }

  get optedOutUserIds(): readonly string[] {
    return this.admission.optedOutUserIds();
  }

  isAdmitted(userId: string): boolean {
    return this.admission.canCapture(userId);
  }

  isOptedOut(userId: string): boolean {
    return this.admission.isOptedOut(userId);
  }

  admit(userId: string): boolean {
    return !this.stopped && this.admission.admit(userId);
  }

  revokeAdmission(userId: string): void {
    this.admission.revoke(userId);
  }

  private armResourceTimers(): void {
    const remainingMs = Math.max(
      0,
      this.resourceGuard.limits.maxDurationMs - (Date.now() - this.startedAt),
    );
    this.durationTimer = setTimeout(() => {
      const trip = this.resourceGuard.checkDuration(Date.now() - this.startedAt);
      if (trip) this.tripResourceLimit(trip);
    }, remainingMs);
    this.durationTimer.unref?.();

    // A synchronous sample every five seconds avoids per-chunk filesystem I/O
    // and keeps the guard update atomic with respect to stream callbacks.
    this.diskTimer = setInterval(() => {
      if (this.stopped) return;
      try {
        const trip = this.resourceGuard.sampleFreeDisk(
          availableDiskBytes(statfsSync(this.dir)),
        );
        if (trip) this.tripResourceLimit(trip);
      } catch {
        const trip = this.resourceGuard.sampleFreeDisk(Number.NaN);
        if (trip) this.tripResourceLimit(trip);
      }
    }, 5_000);
    this.diskTimer.unref?.();
  }

  private clearResourceTimers(): void {
    if (this.durationTimer) clearTimeout(this.durationTimer);
    if (this.diskTimer) clearInterval(this.diskTimer);
    this.durationTimer = undefined;
    this.diskTimer = undefined;
  }

  private destroyConnection(): void {
    try {
      this.connection.destroy();
    } catch {
      // The Discord connection may already be destroyed by a manual stop,
      // shutdown, or another concurrent resource-limit path.
    }
  }

  private tripResourceLimit(trip: RecordingLimitTrip): void {
    if (this.stopped) return;
    // This is the one-shot ownership fence. No later speaking event or stream
    // chunk can be admitted after it is set.
    this.stopped = true;
    this.addWarning(trip.message);
    this.clearResourceTimers();
    if (this.speakingHandler) {
      this.connection.receiver.speaking.off('start', this.speakingHandler);
      this.speakingHandler = undefined;
    }
    for (const streams of this.streams.values()) {
      for (const stream of streams) stream.destroy(new RecordingLimitError(trip));
    }
    this.destroyConnection();
    queueMicrotask(() => {
      void Promise.resolve(this.onResourceLimit?.(trip, this)).catch((error) => {
        console.error('Recording resource-limit callback failed:', error);
      });
    });
  }

  private trackStream(userId: string, stream: DestroyableStream): void {
    const streams = this.streams.get(userId) ?? new Set<DestroyableStream>();
    streams.add(stream);
    this.streams.set(userId, streams);
  }

  private untrackStream(userId: string, stream: DestroyableStream): void {
    const streams = this.streams.get(userId);
    streams?.delete(stream);
    if (streams?.size === 0) this.streams.delete(userId);
  }

  private addWarning(warning: string): void {
    if (!this.warnings.includes(warning)) this.warnings.push(warning);
    void appendSessionWarning(this.manifestPath, warning).catch((error) => {
      console.error('Failed to persist recording warning:', error);
    });
  }

  private async commitSegment(segment: Segment): Promise<void> {
    if (this.segments.some((existing) => existing.pcmPath === segment.pcmPath)) return;
    this.segments.push(segment);
    await updateSessionManifest(this.manifestPath, (manifest) => ({
      ...manifest,
      speakers: {
        ...manifest.speakers,
        [segment.userId]: this.speakers.get(segment.userId) ?? segment.userId,
      },
      segments: manifest.segments.some((existing) => existing.pcmPath === segment.pcmPath)
        ? manifest.segments
        : [...manifest.segments, segment],
    }));
  }

  private capture(userId: string): void {
    if (this.stopped || !this.admission.canCapture(userId) || this.activeUsers.has(userId)) return;
    const segmentTrip = this.resourceGuard.acceptSegment();
    if (segmentTrip) {
      this.tripResourceLimit(segmentTrip);
      return;
    }
    this.activeUsers.add(userId);

    if (!this.speakers.has(userId)) {
      this.speakers.set(userId, userId); // placeholder until the fetch resolves
      this.resolveName(userId)
        .then(async (name) => {
          if (this.admission.isOptedOut(userId)) return;
          this.speakers.set(userId, name);
          await updateSessionManifest(this.manifestPath, (manifest) => ({
            ...manifest,
            speakers: { ...manifest.speakers, [userId]: name },
          }));
        })
        .catch(() => {});
    }

    const startMs = Date.now() - this.startedAt;
    const pcmPath = path.join(this.dir, `${String(startMs).padStart(10, '0')}-${userId}.pcm`);
    const opusStream = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 800 },
    }) as DestroyableStream;
    const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
    const guard = createGuardedPcmTransform(this.resourceGuard, (trip) =>
      this.tripResourceLimit(trip),
    );
    const out = createPrivatePcmWriteStream(pcmPath);
    this.trackStream(userId, opusStream);
    this.trackStream(userId, decoder as DestroyableStream);
    this.trackStream(userId, guard as DestroyableStream);
    this.trackStream(userId, out as unknown as DestroyableStream);

    let completion!: Promise<void>;
    completion = pipeline(opusStream, decoder, guard, out)
      .then(async () => {
        if (this.admission.isOptedOut(userId) || this.finalized) {
          await rm(pcmPath, { force: true });
          return;
        }
        const segment = { userId, startMs, pcmPath };
        await this.commitSegment(segment);
      })
      .catch(async (error: unknown) => {
        if (this.admission.isOptedOut(userId) || this.finalized) {
          await rm(pcmPath, { force: true }).catch(() => {});
          return;
        }
        // Destroying the voice connection can end an in-progress utterance with
        // ERR_STREAM_PREMATURE_CLOSE even though useful PCM is already flushed.
        // Preserve that recoverable tail instead of silently deleting it.
        const bytes = await stat(pcmPath).then((value) => value.size).catch(() => 0);
        if (this.finalized) {
          await rm(pcmPath, { force: true }).catch(() => {});
          return;
        }
        if (this.stopped && bytes > 0) {
          await this.commitSegment({ userId, startMs, pcmPath });
          this.addWarning(
            `The final audio segment for ${this.speakers.get(userId) ?? userId} ended early when recording stopped.`,
          );
          return;
        }
        await rm(pcmPath, { force: true }).catch(() => {});
        const warning = `Audio segment for ${this.speakers.get(userId) ?? userId} failed: ${
          error instanceof Error ? error.message : String(error)
        }`;
        console.error(warning);
        this.addWarning(warning);
      })
      .finally(() => {
        this.activeUsers.delete(userId);
        this.untrackStream(userId, opusStream);
        this.untrackStream(userId, decoder as DestroyableStream);
        this.untrackStream(userId, guard as DestroyableStream);
        this.untrackStream(userId, out as unknown as DestroyableStream);
        this.completions.delete(completion);
      });
    this.completions.add(completion);
  }

  /**
   * Exclude a participant immediately, terminate their in-flight stream, and
   * remove their already captured audio from this still-active session.
   */
  async optOut(userId: string): Promise<void> {
    // Everything the stop path snapshots is fenced synchronously before the
    // first filesystem await. A concurrent stop can therefore never enqueue
    // this participant after opt-out has begun.
    const removed = fenceParticipantOptOut({
      userId,
      admission: this.admission,
      segments: this.segments,
      speakers: this.speakers,
    });
    for (const stream of this.streams.get(userId) ?? []) stream.destroy();
    // Persist the fail-closed recovery rule before touching files. If deletion
    // is interrupted, startup recovery sees optedOutUserIds and removes every
    // matching PCM rather than re-admitting it.
    await updateSessionManifest(this.manifestPath, (manifest) => {
      const speakers = { ...manifest.speakers };
      delete speakers[userId];
      return {
        ...manifest,
        optedOutUserIds: [...new Set([...manifest.optedOutUserIds, userId])],
        speakers,
        segments: manifest.segments.filter((segment) => segment.userId !== userId),
      };
    });
    const deletionFailures: unknown[] = [];
    for (const segment of removed) {
      await rm(segment.pcmPath, { force: true }).catch((error) => deletionFailures.push(error));
    }
    if (deletionFailures.length > 0) {
      throw new AggregateError(
        deletionFailures,
        `Opt-out was recorded, but ${deletionFailures.length} audio file(s) could not be erased.`,
      );
    }
  }

  /** Stop recording, wait on in-flight stream promises, and persist a recoverable capture. */
  async stop(): Promise<RecordingStopResult> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.performStop();
    return this.stopPromise;
  }

  private async performStop(): Promise<RecordingStopResult> {
    this.stopped = true;
    this.clearResourceTimers();
    if (this.speakingHandler) {
      this.connection.receiver.speaking.off('start', this.speakingHandler);
      this.speakingHandler = undefined;
    }
    const durationMs = Date.now() - this.startedAt;
    this.destroyConnection();

    const pending = [...this.completions];
    if (pending.length > 0) {
      const completed = Promise.allSettled(pending).then(() => 'completed' as const);
      if ((await Promise.race([completed, timeout(5_000)])) === 'timeout') {
        this.addWarning(`${this.completions.size} audio stream(s) did not flush within 5 seconds; forcing them closed.`);
        for (const streams of this.streams.values()) {
          for (const stream of streams) stream.destroy();
        }
        await Promise.race([completed, timeout(1_000)]);
      }
    }

    // No promise completing after this point may mutate the capture returned to
    // the processing queue. Any pathological late stream deletes its own file.
    this.finalized = true;
    const segments = [...this.segments].sort((a, b) => a.startMs - b.startMs);
    const endedAt = new Date().toISOString();
    if (this.discardRequested) {
      await tombstoneSession(this.manifestPath, 'Active recording was discarded.');
    } else {
      await updateSessionManifest(this.manifestPath, (manifest) =>
        manifest.stage === 'discarded'
          ? manifest
          : {
              ...manifest,
              stage: 'captured',
              endedAt,
              durationMs,
              speakers: Object.fromEntries(this.speakers),
              optedOutUserIds: this.admission.optedOutUserIds(),
              segments,
              warnings: [...this.warnings],
              recoverable: true,
              error: undefined,
            },
      );
    }

    return {
      segments,
      speakers: new Map(this.speakers),
      durationMs,
      sessionId: this.id,
      sessionDir: this.dir,
      manifestPath: this.manifestPath,
      warnings: [...this.warnings],
    };
  }

  /** Discard audio but retain the minimal manifest as an auditable consent event. */
  async discard(): Promise<void> {
    this.discardRequested = true;
    await this.stop();
    await tombstoneSession(this.manifestPath, 'Active recording was discarded.');
    const located: LocatedSessionManifest = {
      path: this.manifestPath,
      dir: this.dir,
      manifest: await readSessionManifest(this.manifestPath),
    };
    await purgeRawSessionAudio(located);
    await updateSessionManifest(this.manifestPath, (manifest) => ({
      ...manifest,
      stage: 'discarded',
      segments: [],
      speakers: {},
      warnings: [],
      recoverable: false,
      error: undefined,
      rawAudioExpiresAt: new Date().toISOString(),
    }));
  }
}
