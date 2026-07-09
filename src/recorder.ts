import {
  EndBehaviorType,
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice';
import type { VoiceBasedChannel } from 'discord.js';
import prism from 'prism-media';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream';

export interface Segment {
  userId: string;
  /** Offset from session start, in ms. */
  startMs: number;
  pcmPath: string;
}

/**
 * Records a voice channel by subscribing to each speaker's Opus stream and
 * decoding it to raw PCM (48kHz stereo s16le) on disk, one file per utterance.
 * Discord gives us one stream per user, so speaker attribution is exact —
 * no diarization needed.
 */
export class RecordingSession {
  readonly startedAt = Date.now();
  readonly speakers = new Map<string, string>(); // userId -> display name
  private readonly segments: Segment[] = [];
  private readonly active = new Set<string>();
  private stopped = false;

  private constructor(
    readonly guildId: string,
    readonly voiceChannelId: string,
    readonly dir: string,
    private readonly connection: VoiceConnection,
    private readonly resolveName: (userId: string) => Promise<string>,
  ) {}

  static async start(
    channel: VoiceBasedChannel,
    sessionsRoot: string,
    resolveName: (userId: string) => Promise<string>,
  ): Promise<RecordingSession> {
    const dir = path.join(
      sessionsRoot,
      `${new Date().toISOString().replace(/[:.]/g, '-')}-${channel.guild.id}`,
    );
    await mkdir(dir, { recursive: true });

    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
    });

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch (err) {
      connection.destroy();
      throw new Error(`Could not connect to the voice channel: ${err}`);
    }

    const session = new RecordingSession(
      channel.guild.id,
      channel.id,
      dir,
      connection,
      resolveName,
    );

    connection.receiver.speaking.on('start', (userId) => session.capture(userId));
    return session;
  }

  private capture(userId: string): void {
    if (this.stopped || this.active.has(userId)) return;
    this.active.add(userId);

    if (!this.speakers.has(userId)) {
      this.speakers.set(userId, userId); // placeholder until the fetch resolves
      this.resolveName(userId)
        .then((name) => this.speakers.set(userId, name))
        .catch(() => {});
    }

    const startMs = Date.now() - this.startedAt;
    const pcmPath = path.join(
      this.dir,
      `${String(startMs).padStart(10, '0')}-${userId}.pcm`,
    );

    const opusStream = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: 800 },
    });
    const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
    const out = createWriteStream(pcmPath);

    pipeline(opusStream, decoder, out, (err) => {
      this.active.delete(userId);
      if (err) {
        console.error(`Segment for ${userId} failed:`, err.message);
        return;
      }
      this.segments.push({ userId, startMs, pcmPath });
    });
  }

  /** Stop recording, wait for in-flight streams to flush, return ordered segments. */
  async stop(): Promise<{ segments: Segment[]; speakers: Map<string, string>; durationMs: number }> {
    this.stopped = true;
    const durationMs = Date.now() - this.startedAt;
    this.connection.destroy();

    const deadline = Date.now() + 5_000;
    while (this.active.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    return {
      segments: [...this.segments].sort((a, b) => a.startMs - b.startMs),
      speakers: this.speakers,
      durationMs,
    };
  }
}
