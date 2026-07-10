/**
 * The join/leave decision for auto-recording, as pure functions.
 *
 * The Discord event plumbing that feeds these can't be run without a live call,
 * but the decisions themselves are where the bugs live — not counting the bot
 * as a participant (or it never leaves), not recursing when the bot's own join
 * fires an event, ignoring mute/deafen churn — so they're isolated here and
 * unit-tested exhaustively. The event handler stays a thin translator.
 */
import { isLoopbackUrl } from './runtime.js';

export interface ModelProcessingNoticeInput {
  llmProvider: 'local' | 'anthropic';
  llmBaseUrl: string;
  embedBaseUrl: string;
}

/** Compose every configured off-machine processing boundary into one notice. */
export function modelProcessingNotice(input: ModelProcessingNoticeInput): string {
  const remoteDistillation =
    input.llmProvider === 'anthropic' || !isLoopbackUrl(input.llmBaseUrl);
  const remoteEmbeddings = !isLoopbackUrl(input.embedBaseUrl);

  if (!remoteDistillation && !remoteEmbeddings) {
    return 'Transcription and AI processing stay on this machine.';
  }

  const distillation =
    input.llmProvider === 'anthropic'
      ? 'The transcript will be sent to Anthropic for AI distillation.'
      : remoteDistillation
        ? 'The transcript will be sent to the configured remote model service for AI distillation.'
        : 'Transcript distillation stays on this machine.';
  const embeddings = remoteEmbeddings
    ? `If approved, the extracted record will${remoteDistillation ? ' also' : ''} be sent to the configured remote embedding service.`
    : 'Embeddings stay on this machine.';

  return `${distillation} ${embeddings}`;
}

export interface AutoStartInput {
  /** Runtime AUTO_RECORD switch. Omission retains the legacy pure-function behavior. */
  autoRecordEnabled?: boolean;
  /** True if the member whose state changed is a bot (including Chronicle itself). */
  joinerIsBot: boolean;
  /** The channel the member is now in (newState.channelId), or null if they left voice. */
  channelId: string | null;
  /** True if this guild already has a recording session or one being set up. */
  alreadyRecording: boolean;
  /** Non-bot members now in the joined channel (the joiner counts). */
  humansInChannel: number;
}

/**
 * Start recording when a human joins a voice channel we aren't already covering.
 * A bot joining (Chronicle included) must never trigger this, or it recurses on
 * its own connection event and records empty rooms of bots.
 */
export function shouldAutoStart(input: AutoStartInput): boolean {
  return (
    input.autoRecordEnabled !== false &&
    !input.joinerIsBot &&
    input.channelId !== null &&
    !input.alreadyRecording &&
    input.humansInChannel >= 1
  );
}

export interface AutoStopInput {
  /** The channel the member just left (oldState.channelId), or null if they were not in voice. */
  leftChannelId: string | null;
  /** The channel the active session is recording, or undefined if nothing is recording. */
  recordingChannelId: string | undefined;
  /** Non-bot members still in the left channel after this change. */
  humansRemaining: number;
}

/**
 * Stop and file when the last human leaves the channel we're recording. The bot
 * itself stays in the channel until we tell it to leave, so it must be excluded
 * from `humansRemaining` upstream — otherwise the room never reads as empty.
 */
export function shouldAutoStop(input: AutoStopInput): boolean {
  return (
    input.leftChannelId !== null &&
    input.leftChannelId === input.recordingChannelId &&
    input.humansRemaining === 0
  );
}

/** Per-participant capture gate. Unknown/late users are suppressed by default. */
export class ParticipantAdmissionGate {
  private readonly admitted = new Set<string>();
  private readonly optedOut = new Set<string>();

  constructor(initiallyAdmitted: Iterable<string> = []) {
    for (const userId of initiallyAdmitted) this.admitted.add(userId);
  }

  canCapture(userId: string): boolean {
    return this.admitted.has(userId) && !this.optedOut.has(userId);
  }

  admit(userId: string): boolean {
    if (this.optedOut.has(userId)) return false;
    this.admitted.add(userId);
    return true;
  }

  revoke(userId: string): void {
    this.admitted.delete(userId);
  }

  optOut(userId: string): void {
    this.optedOut.add(userId);
    this.admitted.delete(userId);
  }

  isOptedOut(userId: string): boolean {
    return this.optedOut.has(userId);
  }

  optedOutUserIds(): string[] {
    return [...this.optedOut];
  }

  admittedUserIds(): string[] {
    return [...this.admitted];
  }
}

/**
 * Fail-closed handoff from room-wide consent to live capture. This only revokes
 * prior admissions; it never re-adds somebody who left (and may have rejoined)
 * while Discord was establishing the voice connection.
 */
export function revalidateAdmissionGate(
  gate: ParticipantAdmissionGate,
  isParticipantPresent: (userId: string) => boolean,
): string[] {
  for (const userId of gate.admittedUserIds()) {
    if (!isParticipantPresent(userId)) gate.revoke(userId);
  }
  return gate.admittedUserIds();
}

export type ParticipantAdmissionOutcome =
  | 'admitted'
  | 'cancelled'
  | 'ineligible'
  | 'opted_out';

function graceDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason ?? new Error('Participant admission cancelled.'));
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Notice must resolve successfully before a full personal grace period begins. */
export async function admitParticipantAfterNotice(input: {
  announce: () => Promise<unknown>;
  graceMs: number;
  signal: AbortSignal;
  stillEligible: () => boolean | Promise<boolean>;
  isOptedOut: () => boolean;
  admit: () => boolean;
}): Promise<ParticipantAdmissionOutcome> {
  try {
    await input.announce();
    await graceDelay(input.graceMs, input.signal);
  } catch {
    return 'cancelled';
  }
  if (input.signal.aborted) return 'cancelled';
  if (input.isOptedOut()) return 'opted_out';
  if (!(await input.stillEligible())) return 'ineligible';
  return input.admit() ? 'admitted' : 'opted_out';
}

/** Processing output follows the recorded room, never the slash invocation room. */
export function recordingOutputChannelId(input: {
  recordingChannelId: string;
  interactionChannelId: string;
}): string {
  return input.recordingChannelId;
}
