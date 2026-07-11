import type { RecallResult } from './recall.js';
import type { DiscordAttachmentInput } from './source-catalog.js';

export interface DiscordAttachmentLike {
  id: string;
  name: string;
  url: string;
  contentType: string | null;
  size: number;
  width: number | null;
  height: number | null;
  duration: number | null;
}

/** Preserve the Discord attachment metadata Chronicle can safely store. */
export function discordAttachmentInput(
  attachment: DiscordAttachmentLike,
): DiscordAttachmentInput {
  return {
    id: attachment.id,
    filename: attachment.name,
    url: attachment.url,
    contentType: attachment.contentType ?? undefined,
    sizeBytes: attachment.size,
    width: attachment.width ?? undefined,
    height: attachment.height ?? undefined,
    durationSeconds: attachment.duration ?? undefined,
  };
}

export type DiscordRecallPresentation =
  | { kind: 'insufficient'; message: string }
  | { kind: 'answered'; title: string; description: string; footer: string };

/** Present only the citations the recall core validated, never every retrieved hit. */
export function discordRecallPresentation(
  query: string,
  result: RecallResult,
): DiscordRecallPresentation {
  if (result.status === 'insufficient' || result.citations.length === 0) {
    return {
      kind: 'insufficient',
      message:
        result.status === 'insufficient' && result.answer.trim()
          ? result.answer
          : `Chronicle could not validate enough approved evidence to answer "${query}".`,
    };
  }

  const sources = [...new Set(result.citations.map((citation) => citation.sourceId))];
  return {
    kind: 'answered',
    title: `🔎 ${query}`.slice(0, 256),
    description: result.answer.slice(0, 4000),
    footer: `Sources: ${sources.join(' · ')}`.slice(0, 2048),
  };
}

export interface EditableDiscordNotice {
  edit(content: string): Promise<unknown>;
}

export const RECORDING_START_ABORTED_NOTICE =
  '⚪ **Chronicle did not start recording.** The command acknowledgement failed after the consent notice was posted. No voice connection was opened.';

/** Correct the public notice if the private command acknowledgement fails. */
export async function publishConsentNotice(input: {
  notice: string;
  send: (notice: string) => Promise<EditableDiscordNotice>;
  acknowledge: () => Promise<unknown>;
}): Promise<void> {
  const posted = await input.send(input.notice);
  try {
    await input.acknowledge();
  } catch (error) {
    try {
      await posted.edit(RECORDING_START_ABORTED_NOTICE);
    } catch {
      await input.send(RECORDING_START_ABORTED_NOTICE).catch(() => undefined);
    }
    throw error;
  }
}
