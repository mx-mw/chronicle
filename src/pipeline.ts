import {
  approveDraft,
  listTopicCatalog,
  listDrafts,
  persistRawCapture,
  readDraft,
  readOperationTombstone,
  rejectDraft,
  stageSourceDraft,
  tombstoneOperation,
  type RawCapture,
  type ReviewDraft,
  type WrittenMeeting,
} from './kb.js';
import type { Segment } from './recorder.js';
import {
  listSessionManifests,
  purgeRawSessionAudio,
  setSessionStage,
  tombstoneSession,
  updateSessionManifest,
} from './session-manifest.js';
import { summarizeMeeting, type MeetingSummary } from './summarize.js';
import { transcribeSession } from './transcribe.js';

export interface PipelineOptions {
  /** Discord callers must use their guild ID so knowledge never crosses guilds. */
  workspaceId?: string;
  /** e.g. discord:<channel id>. */
  origin?: string;
  sessionId?: string;
  manifestPath?: string;
  requireReview?: boolean;
  warnings?: string[];
  signal?: AbortSignal;
  date?: string;
}

interface PipelineResultBase {
  summary: MeetingSummary;
  rawCapture: RawCapture;
  transcript: string;
  lineCount: number;
  warnings: string[];
}

export interface ReviewPipelineResult extends PipelineResultBase {
  status: 'needs_review';
  draft: ReviewDraft;
  written?: never;
}

export interface ApprovedPipelineResult extends PipelineResultBase {
  status: 'completed';
  written: WrittenMeeting;
  draft?: never;
}

export type PipelineResult = ReviewPipelineResult | ApprovedPipelineResult;

export interface DiscardReconciliationResult {
  sessionId: string;
  outcome: 'tombstoned' | 'already_approved';
  rejectedDraftIds: string[];
  removedMedia: number;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('Meeting processing aborted.');
  }
}

function uniqueWarnings(warnings: string[]): string[] {
  return [...new Set(warnings.map((warning) => warning.trim()).filter(Boolean))];
}

/**
 * Full post-meeting pipeline. The exact transcript is persisted before any
 * model call; model output is staged for review by default and reaches the
 * durable KB only when review is explicitly disabled or a draft is approved.
 */
export async function processMeeting(
  segments: Segment[],
  speakers: Map<string, string>,
  durationMs: number,
  onStatus?: (status: string) => void,
  options: PipelineOptions = {},
): Promise<PipelineResult | null> {
  const warnings = uniqueWarnings(options.warnings ?? []);
  const updateStage = async (
    stage: Parameters<typeof setSessionStage>[1],
    patch: Parameters<typeof setSessionStage>[2] = {},
  ): Promise<void> => {
    if (!options.manifestPath) return;
    await updateSessionManifest(options.manifestPath, (manifest) => {
      if (manifest.stage === 'discarded' || manifest.stage === 'completed') {
        throw (
          options.signal?.reason ??
          new Error(`Meeting processing is already terminal (${manifest.stage}).`)
        );
      }
      return { ...manifest, ...patch, stage };
    });
  };

  try {
    throwIfAborted(options.signal);
    await updateStage('transcribing');
    onStatus?.(`Transcribing ${segments.length} audio segments…`);
    const { transcript, lines, warnings: transcriptionWarnings } = await transcribeSession(
      segments,
      speakers,
    );
    for (const warning of transcriptionWarnings) {
      if (!warnings.includes(warning)) warnings.push(warning);
    }
    throwIfAborted(options.signal);
    if (lines.length === 0) {
      warnings.push('No usable speech was found in the captured audio.');
      await updateStage('empty', { warnings, error: undefined });
      return null;
    }

    const date = options.date ?? new Date().toISOString().slice(0, 10);
    const durationMinutes = Math.max(1, Math.round(durationMs / 60_000));
    const participants = [...new Set(lines.map((line) => line.speaker))];
    const meta = {
      date,
      kind: 'meeting' as const,
      origin: options.origin ?? 'discord',
      attribution: participants,
      durationMinutes,
      sourceEventId: options.sessionId,
    };

    onStatus?.('Preserving the raw transcript before distillation…');
    const rawCapture = await persistRawCapture({
      rawText: transcript,
      meta,
      workspaceId: options.workspaceId,
      warnings,
      operationId: options.sessionId,
    });
    throwIfAborted(options.signal);
    await updateStage('distilling', { rawCaptureId: rawCapture.id, warnings });

    onStatus?.('Distilling the meeting into a reviewable draft…');
    const topicCatalog = await listTopicCatalog({ workspaceId: options.workspaceId });
    const summary = await summarizeMeeting({
      transcript,
      participants,
      date,
      durationMinutes,
      topicCatalog,
    });
    throwIfAborted(options.signal);

    const draft = await stageSourceDraft(summary, transcript, meta, {
      workspaceId: options.workspaceId,
      warnings,
      rawCapture,
      operationId: options.sessionId,
    });
    throwIfAborted(options.signal);
    if (options.requireReview !== false) {
      await updateStage('needs_review', {
        rawCaptureId: rawCapture.id,
        draftId: draft.id,
        warnings,
        error: undefined,
      });
      return {
        status: 'needs_review',
        summary,
        draft,
        rawCapture,
        transcript,
        lineCount: lines.length,
        warnings,
      };
    }

    // Explicit auto-approve still goes through a staged operation carrying the
    // durable session ID. approveDraft checks the operation tombstone inside
    // the same KB lock as its final commit.
    await updateStage('distilling', { draftId: draft.id });
    onStatus?.('Auto-approval is enabled; filing the meeting into the knowledge base…');
    const written = await approveDraft(draft.id, { workspaceId: options.workspaceId });
    throwIfAborted(options.signal);
    await updateStage('completed', {
      rawCaptureId: rawCapture.id,
      meetingPath: written.meetingPath,
      topicPaths: written.topicPaths,
      warnings,
      error: undefined,
    });
    return {
      status: 'completed',
      summary,
      written,
      rawCapture,
      transcript,
      lineCount: lines.length,
      warnings,
    };
  } catch (error) {
    if (options.manifestPath) {
      await updateSessionManifest(options.manifestPath, (manifest) =>
        manifest.stage === 'discarded' || manifest.stage === 'completed'
          ? manifest
          : {
              ...manifest,
              stage: 'failed',
              warnings,
              error: error instanceof Error ? error.message : String(error),
            },
      )
        .catch((manifestError) => {
          console.error('Could not persist failed session state:', manifestError);
        });
    }
    throw error;
  }
}

/**
 * Finish discard transactions interrupted in either durable-write order:
 * session-first or KB-fence-first. This runs before normal recovery.
 */
export async function reconcileDiscardedSessions(
  sessionsRoot: string,
): Promise<DiscardReconciliationResult[]> {
  const results: DiscardReconciliationResult[] = [];
  const failures: unknown[] = [];

  for (const located of await listSessionManifests(sessionsRoot)) {
    const { manifest } = located;
    if (manifest.stage === 'completed') continue;
    const workspaceId = manifest.workspace.id || manifest.workspace.guildId;
    let reverseFence: Awaited<ReturnType<typeof readOperationTombstone>>;
    try {
      reverseFence =
        manifest.stage === 'discarded'
          ? undefined
          : await readOperationTombstone(manifest.id, { workspaceId });
    } catch (error) {
      failures.push(
        new Error(`Could not inspect discard fence for session ${manifest.id}`, { cause: error }),
      );
      continue;
    }
    if (manifest.stage !== 'discarded' && !reverseFence) continue;
    let removedMedia = 0;
    try {
      const fence = reverseFence
        ? { outcome: 'tombstoned' as const, tombstone: reverseFence }
        : await tombstoneOperation(manifest.id, {
            workspaceId,
            reason: manifest.discardReason ?? 'Recovered interrupted discard transaction.',
          });
      if (reverseFence) {
        await tombstoneSession(
          located.path,
          reverseFence.reason ?? 'Recovered KB-first discard transaction.',
        );
      }
      const summaries = await listDrafts({ workspaceId });
      const drafts = await Promise.all(
        summaries.map((summary) =>
          readDraft(summary.id, { workspaceId }).catch(() => undefined),
        ),
      );
      const matching = drafts.filter(
        (draft): draft is ReviewDraft => draft?.operationId === manifest.id,
      );

      if (fence.outcome === 'already_approved') {
        const approved =
          matching.find((draft) => draft.id === fence.recordId && draft.status === 'approved') ??
          (await readDraft(fence.recordId, { workspaceId }).catch(() => undefined));
        await updateSessionManifest(located.path, (current) => ({
          ...current,
          stage: 'completed',
          draftId: fence.recordId,
          meetingPath: approved?.approval?.meetingPath ?? current.meetingPath,
          topicPaths: approved?.approval?.topicPaths ?? current.topicPaths,
          recoverable: false,
          error: undefined,
        }));
        results.push({
          sessionId: manifest.id,
          outcome: 'already_approved',
          rejectedDraftIds: [],
          removedMedia: 0,
        });
      } else {
        const rejectedDraftIds: string[] = [];
        for (const draft of matching) {
          if (draft.status !== 'needs_review') continue;
          await rejectDraft(draft.id, {
            workspaceId,
            expectedRevision: draft.revision,
            reason: 'The originating Discord capture was discarded.',
          });
          rejectedDraftIds.push(draft.id);
        }
        results.push({
          sessionId: manifest.id,
          outcome: 'tombstoned',
          rejectedDraftIds,
          removedMedia: 0,
        });
      }
    } catch (error) {
      failures.push(new Error(`Could not reconcile discarded session ${manifest.id}`, { cause: error }));
    } finally {
      removedMedia = await purgeRawSessionAudio(located).catch((error) => {
        failures.push(new Error(`Could not purge discarded session ${manifest.id}`, { cause: error }));
        return 0;
      });
      await updateSessionManifest(located.path, (current) => ({
        ...current,
        segments: [],
        speakers: {},
        recoverable: false,
        rawAudioExpiresAt: current.rawAudioExpiresAt ?? new Date().toISOString(),
      })).catch((error) => {
        failures.push(new Error(`Could not finalize discarded session ${manifest.id}`, { cause: error }));
      });
      const result = results.find((item) => item.sessionId === manifest.id);
      if (result) result.removedMedia = removedMedia;
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, 'One or more discarded Chronicle sessions need reconciliation.');
  }
  return results;
}
