import { transcribeSession } from './transcribe.js';
import { summarizeMeeting, type MeetingSummary } from './summarize.js';
import { writeMeeting, type WrittenMeeting } from './kb.js';
import type { Segment } from './recorder.js';

export interface PipelineResult {
  summary: MeetingSummary;
  written: WrittenMeeting;
  transcript: string;
  lineCount: number;
}

/** Full post-meeting pipeline: transcribe → distill locally → write to the KB. */
export async function processMeeting(
  segments: Segment[],
  speakers: Map<string, string>,
  durationMs: number,
  onStatus?: (status: string) => void,
): Promise<PipelineResult | null> {
  onStatus?.(`Transcribing ${segments.length} audio segments…`);
  const { transcript, lines } = await transcribeSession(segments, speakers);
  if (lines.length === 0) return null;

  const date = new Date().toISOString().slice(0, 10);
  const durationMinutes = Math.max(1, Math.round(durationMs / 60_000));
  const participants = [...new Set(lines.map((l) => l.speaker))];

  onStatus?.('Distilling the meeting into the knowledge base…');
  const summary = await summarizeMeeting({ transcript, participants, date, durationMinutes });
  const written = await writeMeeting(summary, transcript, {
    date,
    participants,
    durationMinutes,
  });

  return { summary, written, transcript, lineCount: lines.length };
}
