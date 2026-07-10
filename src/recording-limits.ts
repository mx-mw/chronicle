export const DEFAULT_MAX_RECORDING_MINUTES = 180;
export const DEFAULT_MAX_SESSION_AUDIO_BYTES = 8 * 1024 * 1024 * 1024;
export const DEFAULT_MIN_FREE_DISK_BYTES = 5 * 1024 * 1024 * 1024;
/** Bounds inode use and manifest rewrite growth from very short speaking bursts. */
export const DEFAULT_MAX_SESSION_SEGMENTS = 5_000;

export type RecordingLimitKind = 'duration' | 'audio_bytes' | 'free_disk' | 'segment_count';

export interface RecordingResourceLimits {
  maxDurationMs: number;
  maxAudioBytes: number;
  minFreeDiskBytes: number;
  maxSegments: number;
}

export interface RecordingLimitTrip {
  kind: RecordingLimitKind;
  message: string;
  audioBytes: number;
}

function byteLabel(bytes: number): string {
  const gib = bytes / (1024 * 1024 * 1024);
  return `${gib.toFixed(gib >= 10 ? 0 : 1)} GiB`;
}

/**
 * Synchronous accounting shared by every speaker stream in a session. Node
 * invokes stream transforms on one event loop, so reserving a chunk here is
 * atomic across concurrent speakers and never depends on an async stat/write
 * race.
 */
export class RecordingResourceGuard {
  private totalBytes = 0;
  private segmentCount = 0;
  private freeBytesAtSample: number;
  private bytesAtFreeSample = 0;
  private limitTrip?: RecordingLimitTrip;

  constructor(
    readonly limits: RecordingResourceLimits,
    initialFreeDiskBytes: number,
  ) {
    for (const [name, value] of Object.entries(limits)) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive safe integer.`);
      }
    }
    if (!Number.isSafeInteger(initialFreeDiskBytes) || initialFreeDiskBytes < 0) {
      throw new Error('initialFreeDiskBytes must be a non-negative safe integer.');
    }
    this.freeBytesAtSample = initialFreeDiskBytes;
    if (initialFreeDiskBytes < limits.minFreeDiskBytes) {
      this.tripFreeDisk(initialFreeDiskBytes);
    }
  }

  get audioBytes(): number {
    return this.totalBytes;
  }

  get tripped(): RecordingLimitTrip | undefined {
    return this.limitTrip;
  }

  /** Reserve one PCM file before it is created. */
  acceptSegment(): RecordingLimitTrip | undefined {
    if (this.limitTrip) return this.limitTrip;
    if (this.segmentCount >= this.limits.maxSegments) {
      return this.trip({
        kind: 'segment_count',
        message:
          `Recording stopped at the ${this.limits.maxSegments.toLocaleString('en-US')}-segment ` +
          'session safety limit. Audio captured before the limit remains recoverable.',
        audioBytes: this.totalBytes,
      });
    }
    this.segmentCount += 1;
    return undefined;
  }

  /**
   * Reserve a decoded PCM chunk before it is passed to the file writer. The
   * free-space projection subtracts all Chronicle bytes written since the last
   * filesystem sample, so Chronicle itself cannot consume the configured
   * reserve between disk probes.
   */
  acceptAudioBytes(bytes: number): RecordingLimitTrip | undefined {
    if (this.limitTrip) return this.limitTrip;
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new Error('Audio chunk size must be a non-negative safe integer.');
    }
    const nextTotal = this.totalBytes + bytes;
    if (!Number.isSafeInteger(nextTotal) || nextTotal > this.limits.maxAudioBytes) {
      return this.trip({
        kind: 'audio_bytes',
        message:
          `Recording stopped at the ${byteLabel(this.limits.maxAudioBytes)} per-session raw-audio limit. ` +
          'Audio captured before the limit remains recoverable.',
        audioBytes: this.totalBytes,
      });
    }
    const projectedFree =
      this.freeBytesAtSample - (nextTotal - this.bytesAtFreeSample);
    if (projectedFree < this.limits.minFreeDiskBytes) {
      return this.tripFreeDisk(Math.max(0, projectedFree));
    }
    this.totalBytes = nextTotal;
    return undefined;
  }

  /** Update the filesystem sample atomically between stream callbacks. */
  sampleFreeDisk(freeDiskBytes: number): RecordingLimitTrip | undefined {
    if (this.limitTrip) return this.limitTrip;
    if (!Number.isSafeInteger(freeDiskBytes) || freeDiskBytes < 0) {
      return this.trip({
        kind: 'free_disk',
        message:
          'Recording stopped because Chronicle could not verify safe free disk space. ' +
          'Audio captured before the check remains recoverable.',
        audioBytes: this.totalBytes,
      });
    }
    this.freeBytesAtSample = freeDiskBytes;
    this.bytesAtFreeSample = this.totalBytes;
    return freeDiskBytes < this.limits.minFreeDiskBytes
      ? this.tripFreeDisk(freeDiskBytes)
      : undefined;
  }

  checkDuration(elapsedMs: number): RecordingLimitTrip | undefined {
    if (this.limitTrip) return this.limitTrip;
    if (elapsedMs < this.limits.maxDurationMs) return undefined;
    const minutes = Math.round(this.limits.maxDurationMs / 60_000);
    return this.trip({
      kind: 'duration',
      message:
        `Recording stopped at the configured ${minutes}-minute duration limit. ` +
        'Audio captured before the limit remains recoverable.',
      audioBytes: this.totalBytes,
    });
  }

  private tripFreeDisk(observedFreeBytes: number): RecordingLimitTrip {
    return this.trip({
      kind: 'free_disk',
      message:
        `Recording stopped to preserve the configured ${byteLabel(this.limits.minFreeDiskBytes)} ` +
        `free-disk reserve (${byteLabel(observedFreeBytes)} observed). ` +
        'Audio captured before the limit remains recoverable.',
      audioBytes: this.totalBytes,
    });
  }

  private trip(trip: RecordingLimitTrip): RecordingLimitTrip {
    this.limitTrip ??= trip;
    return this.limitTrip;
  }
}
