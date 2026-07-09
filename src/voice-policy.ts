/**
 * The join/leave decision for auto-recording, as pure functions.
 *
 * The Discord event plumbing that feeds these can't be run without a live call,
 * but the decisions themselves are where the bugs live — not counting the bot
 * as a participant (or it never leaves), not recursing when the bot's own join
 * fires an event, ignoring mute/deafen churn — so they're isolated here and
 * unit-tested exhaustively. The event handler stays a thin translator.
 */

export interface AutoStartInput {
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
