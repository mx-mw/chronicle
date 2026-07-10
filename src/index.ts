import {
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageType,
  Options,
  Partials,
  SlashCommandBuilder,
  type GuildMember,
  type Message,
  type PartialMessage,
  type SendableChannels,
  type VoiceBasedChannel,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import {
  createDiscordInboxService,
  type DiscordInboxMessage,
} from './discord-inbox.js';
import { extractInboxUrls, processInboxSource } from './inbox-processing.js';
import { ProcessingCancelledError, ProcessingQueue } from './jobs.js';
import { readDraft, rejectDraft, tombstoneOperation } from './kb.js';
import { describeProvider } from './llm.js';
import { authorize, explainDenial, type AuthorizationContext } from './policy.js';
import {
  processMeeting,
  reconcileDiscardedSessions,
  type PipelineResult,
} from './pipeline.js';
import { recall } from './recall.js';
import { RecordingSession, type RecordingStopResult } from './recorder.js';
import type { RecordingLimitTrip } from './recording-limits.js';
import { formatActionableSessionPage } from './recording-status.js';
import {
  backfillSessionRetentionDeadlines,
  findRecoverableSessions,
  listSessionManifests,
  purgeExpiredSessionAudio,
  purgeRawSessionAudio,
  purgeSessionAudioAfterAttempt,
  readSessionManifest,
  recoverInterruptedActiveSessions,
  setSessionStage,
  tombstoneSession,
  updateSessionManifest,
  type LocatedSessionManifest,
  type SessionManifest,
  type SessionStage,
} from './session-manifest.js';
import { extract } from './sources/index.js';
import { EncryptedSourceCatalog, type SourceCatalogRecord } from './source-catalog.js';
import { summarizeSource } from './summarize.js';
import { assertParakeetReady } from './transcribe.js';
import {
  admitParticipantAfterNotice,
  modelProcessingNotice as composeModelProcessingNotice,
  ParticipantAdmissionGate,
  recordingOutputChannelId,
  shouldAutoStart,
  shouldAutoStop,
} from './voice-policy.js';

const sessions = new Map<string, RecordingSession>(); // guildId -> active session

interface PendingStart {
  sessionId: string;
  guildId: string;
  channelId: string;
  controller: AbortController;
  admission: ParticipantAdmissionGate;
  settled: Promise<void>;
  resolveSettled: () => void;
  cancellation?: Promise<Awaited<ReturnType<typeof tombstoneOperation>>>;
  cancellationRequested?: boolean;
  preparedSession?: RecordingSession;
}

interface PendingParticipantAdmission {
  sessionId: string;
  userId: string;
  controller: AbortController;
}

interface TrackedCapture {
  id: string;
  guildId: string;
  dir: string;
  manifestPath: string;
}

const pendingStarts = new Map<string, PendingStart>();
const pendingParticipantAdmissions = new Map<string, PendingParticipantAdmission>();
const processingByGuild = new Map<string, TrackedCapture>();
const latestCaptureByGuild = new Map<string, TrackedCapture>();
const captureSettlements = new Map<string, Promise<void>>();

const ACTIONABLE_SESSION_STAGES = new Set<SessionStage>([
  'connecting',
  'recording',
  'captured',
  'queued',
  'transcribing',
  'distilling',
  'needs_review',
  'failed',
  'empty',
]);
const backgroundTasks = new Set<Promise<unknown>>();
const processingQueue = new ProcessingQueue<unknown>({
  maxPending: config.processingQueueLimit,
  retries: config.processingRetries,
  timeoutMs: config.processingTimeoutMs,
});

let shuttingDown = false;
let runtimeReady = false;
let discordInboxReady = false;
let discordInboxRetentionTimer: NodeJS.Timeout | undefined;
const DISCORD_INBOX_RETENTION_SWEEP_MS = 60 * 60_000;

/** Count non-bot members in a voice channel. The bot must never count itself. */
function humanCount(channel: VoiceBasedChannel): number {
  return channel.members.filter((member) => !member.user.bot).size;
}

function roleIds(member: GuildMember): string[] {
  return [...member.roles.cache.keys()];
}

function authorizationContext(
  interaction: ChatInputCommandInteraction,
  member: GuildMember,
  channelId = interaction.channelId,
): AuthorizationContext {
  return {
    guildId: interaction.guildId,
    channelId,
    userId: interaction.user.id,
    roleIds: roleIds(member),
  };
}

async function requireRecordAuthorization(
  interaction: ChatInputCommandInteraction,
  member: GuildMember,
  channelId?: string,
): Promise<boolean> {
  const decision = authorize(config.recordPolicy, authorizationContext(interaction, member, channelId));
  if (decision.allowed) return true;
  await interaction.reply({ content: `⛔ ${explainDenial(decision.reason)}`, ephemeral: true });
  return false;
}

async function requireRecallAuthorization(
  interaction: ChatInputCommandInteraction,
  member: GuildMember,
): Promise<boolean> {
  const decision = authorize(config.recallPolicy, authorizationContext(interaction, member));
  if (decision.allowed) return true;
  await interaction.reply({ content: `⛔ ${explainDenial(decision.reason)}`, ephemeral: true });
  return false;
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal.reason ?? new Error('Recording start cancelled.'));
    };
    timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function consentNotice(channelName: string): string {
  const seconds = Math.ceil(config.consentGraceMs / 1_000);
  return (
    `🔴 **Chronicle intends to record ${channelName} in ${seconds} second${seconds === 1 ? '' : 's'}.** ` +
    `${knowledgeOutcomeNotice()} ${modelProcessingNotice()} ` +
    'Run `/record optout` before recording stops ' +
    'to exclude and erase your audio. After stop, an authorized operator can only discard the whole queued capture; ' +
    'an already-preserved transcript remains in the local audit archive until an operator explicitly removes it.'
  );
}

function knowledgeOutcomeNotice(): string {
  return config.requireReview
    ? 'Audio will be transcribed into a local draft that requires human approval before entering memory.'
    : 'Audio will be transcribed and automatically filed into approved memory without human review.';
}

function modelProcessingNotice(): string {
  return composeModelProcessingNotice({
    llmProvider: config.llmProvider,
    llmBaseUrl: config.llmBaseUrl,
    embedBaseUrl: config.embedBaseUrl,
  });
}

function participantAdmissionKey(sessionId: string, userId: string): string {
  return `${sessionId}:${userId}`;
}

function cancelParticipantAdmission(sessionId: string, userId: string, reason: string): void {
  const key = participantAdmissionKey(sessionId, userId);
  const pending = pendingParticipantAdmissions.get(key);
  if (!pending) return;
  pending.controller.abort(new Error(reason));
  pendingParticipantAdmissions.delete(key);
}

function cancelSessionAdmissions(sessionId: string, reason: string): void {
  for (const pending of pendingParticipantAdmissions.values()) {
    if (pending.sessionId === sessionId) {
      cancelParticipantAdmission(sessionId, pending.userId, reason);
    }
  }
}

function scheduleParticipantAdmission(
  session: RecordingSession,
  channel: VoiceBasedChannel,
  userId: string,
): void {
  if (session.isAdmitted(userId) || session.isOptedOut(userId)) return;
  const key = participantAdmissionKey(session.id, userId);
  if (pendingParticipantAdmissions.has(key)) return;
  const pending: PendingParticipantAdmission = {
    sessionId: session.id,
    userId,
    controller: new AbortController(),
  };
  pendingParticipantAdmissions.set(key, pending);

  const task = admitParticipantAfterNotice({
    announce: () =>
      (channel as unknown as SendableChannels).send(
        `🔴 <@${userId}>, Chronicle is already recording **${channel.name}**. ` +
          `Your audio is suppressed for ${Math.ceil(config.consentGraceMs / 1_000)} seconds. ` +
          `${knowledgeOutcomeNotice()} ${modelProcessingNotice()} ` +
          'Run `/record optout` now or before recording stops to remain excluded.',
      ),
    graceMs: config.consentGraceMs,
    signal: pending.controller.signal,
    stillEligible: () =>
      sessions.get(session.guildId) === session && channel.members.has(userId),
    isOptedOut: () => session.isOptedOut(userId),
    admit: () => session.admit(userId),
  })
    .then(async (outcome) => {
      if (outcome === 'admitted') {
        await (channel as unknown as SendableChannels)
          .send(`<@${userId}> is now included in the active Chronicle recording.`)
          .catch(() => {});
      }
    })
    .finally(() => {
      if (pendingParticipantAdmissions.get(key) === pending) {
        pendingParticipantAdmissions.delete(key);
      }
    });
  trackBackground(task);
}

/**
 * Announce successfully, wait the full consent grace, and only then connect the
 * recorder. Announcement failure or cancellation means no capture can start.
 */
async function finishResourceLimitedSession(
  trip: RecordingLimitTrip,
  session: RecordingSession,
  channel: SendableChannels,
): Promise<void> {
  if (sessions.get(session.guildId) !== session) return;
  sessions.delete(session.guildId);
  cancelSessionAdmissions(session.id, 'Recording stopped at a configured safety limit.');
  const settlement = beginFinishAndFile(session, channel);
  await channel
    .send(
      `⏹️ Chronicle automatically stopped session ${session.id} at a capture safety limit. ` +
        `${trip.message} The preserved capture is ${
          config.requireReview
            ? 'being processed into the local Review Inbox.'
            : 'being processed under the configured automatic filing policy.'
        }`,
    )
    .catch(() => {});
  await settlement;
}

/** KB fence first, then abort/erase any pending or just-published recorder. */
async function fenceAndCancelPendingStart(
  pending: PendingStart,
  reason: string,
): Promise<Awaited<ReturnType<typeof tombstoneOperation>>> {
  if (pending.cancellation) return pending.cancellation;
  pending.cancellationRequested = true;
  const cancellation = (async () => {
    const fence = await tombstoneOperation(pending.sessionId, {
      workspaceId: pending.guildId,
      reason,
    });
    pending.controller.abort(new ProcessingCancelledError(pending.sessionId, reason));

    const discardPublishedSession = async (): Promise<void> => {
      const published = sessions.get(pending.guildId);
      if (published?.id !== pending.sessionId) return;
      sessions.delete(pending.guildId);
      cancelSessionAdmissions(published.id, reason);
      await published.discard();
    };
    await discardPublishedSession();
    await pending.settled;
    // Covers publication while the KB fence itself was awaiting its durable lock.
    await discardPublishedSession();
    await processingQueue.cancelAndWait(pending.sessionId, reason).catch((error) => {
      console.warn(`Pending capture job ${pending.sessionId} settled during discard:`, error);
      return 'not_found' as const;
    });
    await captureSettlements.get(pending.sessionId)?.catch((error) => {
      console.warn(`Pending capture ${pending.sessionId} settled during discard:`, error);
    });
    await reconcileDiscardedSessions(config.sessionsDir);
    return fence;
  })();
  pending.cancellation = cancellation;
  return cancellation;
}

async function startAfterConsent(
  channel: VoiceBasedChannel,
  announce: (notice: string) => Promise<unknown>,
): Promise<RecordingSession | null> {
  const guildId = channel.guild.id;
  if (sessions.has(guildId) || pendingStarts.has(guildId) || shuttingDown) return null;
  let resolveSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    resolveSettled = resolve;
  });
  const initiallyPresent = channel.members
    .filter((member) => !member.user.bot)
    .map((member) => member.id);
  const pending: PendingStart = {
    sessionId: randomUUID(),
    guildId,
    channelId: channel.id,
    controller: new AbortController(),
    admission: new ParticipantAdmissionGate(initiallyPresent),
    settled,
    resolveSettled,
  };
  pendingStarts.set(guildId, pending);
  let prepared: RecordingSession | undefined;

  try {
    await announce(consentNotice(channel.name));
    await abortableDelay(config.consentGraceMs, pending.controller.signal);
    if (pending.controller.signal.aborted || shuttingDown) return null;
    prepared = await RecordingSession.start(
      channel,
      config.sessionsDir,
      async (userId) => (await channel.guild.members.fetch(userId)).displayName,
      {
        sessionId: pending.sessionId,
        workspaceId: guildId,
        admissionGate: pending.admission,
        signal: pending.controller.signal,
        resourceLimits: {
          maxDurationMs: config.maxRecordingMinutes * 60_000,
          maxAudioBytes: config.maxSessionAudioBytes,
          minFreeDiskBytes: config.minFreeDiskBytes,
          maxSegments: config.maxSessionSegments,
        },
        onResourceLimit: (trip, session) =>
          finishResourceLimitedSession(
            trip,
            session,
            channel as unknown as SendableChannels,
          ),
      },
    );
    pending.preparedSession = prepared;
    if (pending.cancellationRequested || shuttingDown) {
      await prepared.stop();
      return null;
    }
    if (pending.controller.signal.aborted) {
      await prepared.discard();
      return null;
    }
    await prepared.activate({
      signal: pending.controller.signal,
      isParticipantPresent: (userId) => channel.members.has(userId),
    });
    if (pending.cancellationRequested || shuttingDown) {
      await prepared.stop();
      return null;
    }
    if (pending.controller.signal.aborted) {
      await prepared.discard();
      return null;
    }
    sessions.set(guildId, prepared);
    for (const member of channel.members.values()) {
      if (!member.user.bot && !prepared.isAdmitted(member.id)) {
        scheduleParticipantAdmission(prepared, channel, member.id);
      }
    }
    return prepared;
  } catch (error) {
    if (prepared) await prepared.discard().catch(() => {});
    if (pending.controller.signal.aborted) return null;
    throw error;
  } finally {
    if (pendingStarts.get(guildId) === pending) pendingStarts.delete(guildId);
    pending.resolveSettled();
  }
}

function trackBackground(task: Promise<unknown>): void {
  const tracked = task.catch((error) => {
    console.error('Background Chronicle task failed:', error);
  });
  backgroundTasks.add(tracked);
  void tracked.finally(() => backgroundTasks.delete(tracked));
}

async function getSendableChannel(channelId: string): Promise<SendableChannels | null> {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  return channel?.isSendable() ? channel : null;
}

function captureFromManifest(located: LocatedSessionManifest): RecordingStopResult {
  const { manifest } = located;
  return {
    segments: manifest.segments,
    speakers: new Map(Object.entries(manifest.speakers)),
    durationMs: manifest.durationMs ?? Math.max(0, Date.parse(manifest.updatedAt) - Date.parse(manifest.startedAt)),
    sessionId: manifest.id,
    sessionDir: located.dir,
    manifestPath: located.path,
    warnings: manifest.warnings,
  };
}

function trackedFromManifest(located: LocatedSessionManifest): TrackedCapture {
  return {
    id: located.manifest.id,
    guildId: located.manifest.workspace.guildId,
    dir: located.dir,
    manifestPath: located.path,
  };
}

async function guildSessionManifests(guildId: string): Promise<LocatedSessionManifest[]> {
  return (await listSessionManifests(config.sessionsDir)).filter(
    ({ manifest }) => manifest.workspace.guildId === guildId,
  );
}

function formatActionableSessions(
  sessionsToFormat: LocatedSessionManifest[],
  excludeSessionId?: string,
  page = 1,
): string {
  return formatActionableSessionPage(sessionsToFormat, {
    excludeSessionId,
    page,
  }).text;
}

async function armRawAudioRetention(capture: RecordingStopResult): Promise<void> {
  if (config.rawAudioRetentionHours === 0) return;
  const updated = await updateSessionManifest(capture.manifestPath, (manifest) => {
    const computedExpiryMs =
      Date.parse(manifest.endedAt ?? manifest.updatedAt) +
      config.rawAudioRetentionHours * 60 * 60_000;
    const existingExpiryMs = manifest.rawAudioExpiresAt
      ? Date.parse(manifest.rawAudioExpiresAt)
      : Number.NaN;
    return {
      ...manifest,
      rawAudioExpiresAt: new Date(
        Number.isFinite(existingExpiryMs)
          ? Math.min(existingExpiryMs, computedExpiryMs)
          : computedExpiryMs,
      ).toISOString(),
    };
  });
  if (config.rawAudioRetentionHours > 0 && updated.rawAudioExpiresAt) {
    scheduleRetentionSweep(updated.rawAudioExpiresAt);
  }
}

function scheduleRetentionSweep(expiresAt: string): void {
  const remaining = Date.parse(expiresAt) - Date.now();
  const maxTimerMs = 2_147_483_647;
  const timer = setTimeout(() => {
    if (remaining > maxTimerMs) {
      scheduleRetentionSweep(expiresAt);
      return;
    }
    void purgeExpiredSessionAudio(config.sessionsDir).catch((error) => {
      console.error('Raw-audio retention sweep failed:', error);
    });
  }, Math.max(0, Math.min(remaining, maxTimerMs)));
  timer.unref();
}

async function enforceImmediateRetention(capture: RecordingStopResult): Promise<void> {
  if (config.rawAudioRetentionHours !== 0) return;
  await purgeSessionAudioAfterAttempt(
    {
      path: capture.manifestPath,
      dir: capture.sessionDir,
      manifest: await readSessionManifest(capture.manifestPath),
    },
    config.rawAudioRetentionHours,
  );
}

async function reportPipelineResult(
  result: PipelineResult | null,
  channel: SendableChannels | null,
  sessionId: string,
): Promise<void> {
  const say = async (message: string) => channel?.send(message).catch(() => {});
  if (!result) {
    await say('No usable speech was captured. The session audit record was kept, but no draft was made.');
    return;
  }

  if (result.status === 'needs_review') {
    await say(
      `✅ A meeting draft is ready in the authenticated local Review Inbox (${result.draft.id}). ` +
        `Capture session: ${sessionId}. ` +
        `Its AI-generated content is not posted or searchable before approval.${
          result.warnings.length > 0
            ? ` ${result.warnings.length} processing warning(s) are attached for the reviewer.`
            : ''
        }`,
    );
    return;
  }

  const { summary } = result;
  const embed = new EmbedBuilder()
    .setTitle(`📚 ${summary.title}`);
  if (summary.summary.trim()) {
    embed.setDescription(summary.summary.slice(0, 4000));
  }
  if (summary.decisions.length) {
    embed.addFields({
      name: 'Decisions',
      value: summary.decisions.map((decision) => `• ${decision}`).join('\n').slice(0, 1024),
    });
  }
  if (summary.action_items.length) {
    embed.addFields({
      name: 'Action items',
      value: summary.action_items
        .map((item) => `• **${item.owner}**: ${item.task}`)
        .join('\n')
        .slice(0, 1024),
    });
  }

  embed.setFooter({
    text: `Filed as ${path.relative(process.cwd(), result.written.meetingPath)} · ${
      result.written.topicPaths.length
    } topic(s) updated`,
  });
  await channel?.send({ embeds: [embed] }).catch(() => {});
  if (result.warnings.length > 0) {
    await say(`⚠️ ${result.warnings.length} processing warning(s) were recorded for this meeting.`);
  }
}

/** Queue one durable capture and report status/results without losing recovery state. */
async function enqueueCapture(
  capture: RecordingStopResult,
  manifest: SessionManifest,
  channel: SendableChannels | null,
): Promise<void> {
  const say = async (message: string) => channel?.send(message).catch(() => {});
  const tracked: TrackedCapture = {
    id: capture.sessionId,
    guildId: manifest.workspace.guildId,
    dir: capture.sessionDir,
    manifestPath: capture.manifestPath,
  };
  processingByGuild.set(manifest.workspace.guildId, tracked);
  latestCaptureByGuild.set(manifest.workspace.guildId, tracked);
  await armRawAudioRetention(capture);

  try {
    const result = await processingQueue.enqueue({
      id: capture.sessionId,
      onAttempt: async () => {
        await updateSessionManifest(capture.manifestPath, (current) => {
          if (current.stage === 'discarded' || current.stage === 'completed') {
            throw new ProcessingCancelledError(
              capture.sessionId,
              `Session is already terminal (${current.stage}).`,
            );
          }
          return {
            ...current,
            stage: 'queued',
            attempts: current.attempts + 1,
            error: undefined,
          };
        });
      },
      onRetry: async (_error, nextAttempt) => {
        await say(
          `⚠️ Processing attempt failed. Retrying attempt ${nextAttempt}; details remain in local logs.`,
        );
      },
      run: async (signal) =>
        processMeeting(
          capture.segments,
          capture.speakers,
          capture.durationMs,
          (status) => void say(status),
          {
            workspaceId: manifest.workspace.id,
            origin: `discord:${manifest.workspace.channelId}`,
            sessionId: manifest.id,
            manifestPath: capture.manifestPath,
            requireReview: config.requireReview,
            warnings: capture.warnings,
            signal,
            date: manifest.startedAt.slice(0, 10),
          },
        ),
    }) as PipelineResult | null;
    await reportPipelineResult(result, channel, capture.sessionId);
  } catch (error) {
    if (error instanceof ProcessingCancelledError) return;
    const detail = error instanceof Error ? error.message : String(error);
    await setSessionStage(capture.manifestPath, 'failed', { error: detail }).catch(() => {});
    console.error(`Meeting ${capture.sessionId} processing failed:`, error);
    const failureState = await readSessionManifest(capture.manifestPath).catch(() => undefined);
    const attempts = failureState?.attempts ?? 0;
    const recoveryMessage =
      failureState?.recoverable === false
        ? `Session ${capture.sessionId} is terminal because its raw audio is no longer retained.`
        : `The capture is preserved as session ${capture.sessionId} and will be recovered on restart.`;
    await say(
      `⚠️ Chronicle could not finish this meeting${
        attempts > 0 ? ` after ${attempts} attempt(s)` : ' because the processing queue could not accept it'
      }. Details remain in local logs. ${recoveryMessage}`,
    );
  } finally {
    await enforceImmediateRetention(capture).catch((error) => {
      console.error(`Immediate raw-audio purge failed for ${capture.sessionId}:`, error);
    });
    if (processingByGuild.get(manifest.workspace.guildId)?.id === capture.sessionId) {
      processingByGuild.delete(manifest.workspace.guildId);
    }
  }
}

/** Stop a session, make it durable, enqueue it, and report into the same channel. */
async function finishAndFile(
  session: RecordingSession,
  channel: SendableChannels | null,
): Promise<void> {
  const capture = await session.stop();
  const manifest = await readSessionManifest(capture.manifestPath);
  if (manifest.stage === 'discarded' || manifest.stage === 'completed') return;
  await enqueueCapture(capture, manifest, channel);
}

function beginFinishAndFile(
  session: RecordingSession,
  channel: SendableChannels | null,
): Promise<void> {
  markCaptureAsProcessing(session);
  const existing = captureSettlements.get(session.id);
  if (existing) return existing;
  const settlement = finishAndFile(session, channel).finally(() => {
    if (captureSettlements.get(session.id) === settlement) {
      captureSettlements.delete(session.id);
    }
  });
  captureSettlements.set(session.id, settlement);
  return settlement;
}

function markCaptureAsProcessing(session: RecordingSession): void {
  const tracked: TrackedCapture = {
    id: session.id,
    guildId: session.guildId,
    dir: session.dir,
    manifestPath: session.manifestPath,
  };
  processingByGuild.set(session.guildId, tracked);
  latestCaptureByGuild.set(session.guildId, tracked);
}

async function recoverInterruptedSessions(): Promise<void> {
  const reconciled = await reconcileDiscardedSessions(config.sessionsDir);
  for (const result of reconciled) {
    if (result.outcome === 'already_approved') {
      console.warn(
        `Discarded session ${result.sessionId} was already approved; preserved approval and removed ${result.removedMedia} raw media file(s).`,
      );
    }
  }
  if (reconciled.length > 0) {
    console.log(`Reconciled ${reconciled.length} interrupted discard transaction(s).`);
  }

  const interrupted = await recoverInterruptedActiveSessions(config.sessionsDir, {
    retentionHours: config.rawAudioRetentionHours,
  });
  if (interrupted.length > 0) {
    console.log(`Recovered/tombstoned ${interrupted.length} session(s) interrupted during capture.`);
  }
  const backfilled = await backfillSessionRetentionDeadlines(
    config.sessionsDir,
    config.rawAudioRetentionHours,
  );
  if (backfilled.length > 0) {
    console.log(`Backfilled ${backfilled.length} raw-audio retention deadline(s).`);
  }
  const purged =
    config.rawAudioRetentionHours > 0
      ? await purgeExpiredSessionAudio(config.sessionsDir)
      : 0;
  if (purged > 0) console.log(`Purged ${purged} expired raw audio file(s).`);

  const recoverable = await findRecoverableSessions(config.sessionsDir);
  if (recoverable.length > 0) {
    console.log(`Recovering ${recoverable.length} captured/failed Chronicle session(s).`);
  }
  for (const located of recoverable) {
    const capture = captureFromManifest(located);
    const retainedSegments = [] as RecordingStopResult['segments'];
    for (const segment of capture.segments) {
      if (await access(segment.pcmPath).then(() => true).catch(() => false)) {
        retainedSegments.push(segment);
      }
    }
    capture.segments = retainedSegments;
    if (capture.segments.length === 0) {
      await setSessionStage(located.path, 'failed', {
        error: 'Session recovery found no retained audio segments.',
        recoverable: false,
        segments: [],
      });
      continue;
    }
    if (capture.segments.length < located.manifest.segments.length) {
      const warning = `${located.manifest.segments.length - capture.segments.length} raw audio segment(s) expired or were missing during recovery.`;
      capture.warnings = [...new Set([...capture.warnings, warning])];
      await updateSessionManifest(located.path, (manifest) => ({
        ...manifest,
        segments: capture.segments,
        warnings: capture.warnings,
      }));
    }
    const channel = await getSendableChannel(located.manifest.workspace.channelId);
    trackBackground(enqueueCapture(capture, located.manifest, channel));
  }
}

async function autoStartRecording(channel: VoiceBasedChannel): Promise<void> {
  try {
    const sendable = channel as unknown as SendableChannels;
    const session = await startAfterConsent(channel, (notice) => sendable.send(notice));
    if (session) {
      await sendable
        .send(
          `🔴 **Recording is now active in ${channel.name}.** ` +
            'Run `/record optout` before recording stops to erase your own captured audio.',
        )
        .catch(() => {});
    }
  } catch (error) {
    // A failed notice is a hard stop: startAfterConsent has not connected yet.
    console.error('Auto-start recording aborted before capture:', error);
  }
}

const commands = [
  new SlashCommandBuilder()
    .setName('record')
    .setDescription('Manage an authorized Chronicle voice capture')
    .addSubcommand((sub) => sub.setName('start').setDescription('Announce consent grace, then start recording'))
    .addSubcommand((sub) =>
      sub
        .setName('stop')
        .setDescription(
          config.requireReview
            ? 'Stop recording and queue a review draft'
            : 'Stop recording and automatically file approved memory',
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('status')
        .setDescription('Show active and actionable recording sessions')
        .addIntegerOption((option) =>
          option
            .setName('page')
            .setDescription('Page of newest-first actionable session IDs')
            .setMinValue(1),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName('discard')
        .setDescription('Cancel and discard a capture')
        .addStringOption((option) =>
          option
            .setName('session')
            .setDescription('Session ID from /record status (required when several are actionable)'),
        ),
    )
    .addSubcommand((sub) =>
      sub.setName('optout').setDescription('Exclude and erase your audio before capture stops'),
    ),
  new SlashCommandBuilder()
    .setName('recall')
    .setDescription('Search the authorized guild knowledge workspace')
    .addStringOption((option) =>
      option.setName('query').setDescription('What to look for').setRequired(true),
    ),
].map((command) => command.toJSON());

const clientIntents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates];
if (config.discordInboxEnabled) {
  clientIntents.push(GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent);
}

const client = new Client({
  intents: clientIntents,
  partials: config.discordInboxEnabled ? [Partials.Channel, Partials.Message] : [],
  // Gateway delivery cannot be channel-scoped. Do not retain messages from
  // visible, unallowlisted channels in discord.js's default per-channel cache.
  makeCache: Options.cacheWithLimits({
    ...Options.DefaultMakeCacheSettings,
    MessageManager: 0,
  }),
});

function requireCompleteInboxPolicy(): void {
  const policy = config.inboxPolicy;
  if (!config.discordMessageContentEnabled) {
    throw new Error(
      'Discord Inbox requires DISCORD_MESSAGE_CONTENT_ENABLED=true after enabling the intent in Discord Developer Portal.',
    );
  }
  if (
    policy.guildIds.length === 0 ||
    policy.channelIds.length === 0 ||
    (policy.userIds.length === 0 && policy.roleIds.length === 0)
  ) {
    throw new Error(
      'Discord Inbox requires exact INBOX_GUILD_IDS and INBOX_CHANNEL_IDS plus an INBOX_USER_IDS or INBOX_ROLE_IDS identity rule.',
    );
  }
}

function discordInboxMessage(message: Message): DiscordInboxMessage | undefined {
  if (!message.inGuild()) return undefined;
  const member = message.member;
  const attachments = [...message.attachments.values()].map((attachment) => ({
    id: attachment.id,
    filename: attachment.name,
    url: attachment.url,
    contentType: attachment.contentType ?? undefined,
    sizeBytes: attachment.size,
    width: attachment.width ?? undefined,
    height: attachment.height ?? undefined,
  }));
  return {
    id: message.id,
    guildId: message.guildId,
    channelId: message.channelId,
    author: {
      id: message.author.id,
      username: message.author.username,
      displayName: member?.displayName ?? message.author.globalName ?? undefined,
      bot: message.author.bot,
    },
    roleIds: member ? [...member.roles.cache.keys()] : undefined,
    content: message.content,
    createdAt: message.createdAt.toISOString(),
    editedAt: message.editedAt?.toISOString(),
    type: message.type === MessageType.Default
      ? 'default'
      : message.type === MessageType.Reply
        ? 'reply'
        : 'other',
    webhookId: message.webhookId ?? undefined,
    system: message.system,
    urls: extractInboxUrls(message.content, [], config.inboxMaxUrls),
    attachments,
    sendReceipt: async (content) => {
      const receipt = await message.reply({
        content,
        allowedMentions: { parse: [], repliedUser: false },
      });
      return {
        update: async (next) => {
          await receipt.edit({ content: next, allowedMentions: { parse: [] } });
        },
      };
    },
  };
}

async function processDiscordInboxRecord(
  record: SourceCatalogRecord,
  signal: AbortSignal,
) {
  if (signal.aborted) throw signal.reason;
  const analysis = await processInboxSource(
    {
      content: record.source.text,
      capturedAt: record.save.capturedAt,
      authorName: record.source.author.displayName ?? record.source.author.username,
      origin:
        `https://discord.com/channels/${record.source.discord.guildId}/` +
        `${record.source.discord.channelId}/${record.source.discord.messageId}`,
      urls: record.source.urls.map(({ url }) => url),
      attachments: record.source.attachments.map((attachment) => ({
        id: attachment.id,
        filename: attachment.filename,
        contentType: attachment.contentType,
        size: attachment.sizeBytes ?? 0,
      })),
    },
    { extract, summarize: summarizeSource },
  );
  if (signal.aborted) throw signal.reason;
  return analysis;
}

let discordInboxService: ReturnType<typeof createDiscordInboxService> | undefined;
if (config.discordInboxEnabled) {
  requireCompleteInboxPolicy();
  const privacyPolicyUrl = config.discordPrivacyPolicyUrl;
  const dataRequestUrl = config.discordDataRequestUrl;
  const retentionDays = config.inboxRetentionDays;
  const catalog = new EncryptedSourceCatalog({
    directory: config.sourceCatalogDir,
    encryptionKey: config.sourceEncryptionKey,
  });
  const purged = await catalog.purgeExpired(retentionDays);
  if (purged > 0) console.log(`Discarded ${purged} expired Discord Inbox source(s).`);
  discordInboxService = createDiscordInboxService({
    catalog,
    queue: processingQueue,
    policy: config.inboxPolicy,
    process: processDiscordInboxRecord,
    resolveCurrentRoleIds: async (guildId, userId) => {
      const guild =
        client.guilds.cache.get(guildId) ??
        await client.guilds.fetch(guildId).catch(() => undefined);
      if (!guild) return undefined;
      const member =
        guild.members.cache.get(userId) ??
        await guild.members.fetch(userId).catch(() => undefined);
      return member ? roleIds(member) : undefined;
    },
    disclosure:
      `${modelProcessingNotice()} Privacy: ${privacyPolicyUrl} Data requests: ${dataRequestUrl}`,
    maxAttachments: config.inboxMaxAttachments,
    maxAttachmentBytes: config.inboxMaxAttachmentBytes,
    maxTotalAttachmentBytes: config.inboxMaxTotalAttachmentBytes,
    maxUrls: config.inboxMaxUrls,
  });
  discordInboxRetentionTimer = setInterval(() => {
    trackDiscordInboxTask(
      catalog.purgeExpired(retentionDays).then((count) => {
        if (count > 0) console.log(`Discarded ${count} expired Discord Inbox source(s).`);
      }),
      'retention sweep',
    );
  }, DISCORD_INBOX_RETENTION_SWEEP_MS);
  discordInboxRetentionTimer.unref();
}

client.once('clientReady', async () => {
  // Inbox storage is ready before login. Admit new messages immediately rather
  // than dropping them while voice recovery and command registration await.
  discordInboxReady = Boolean(discordInboxService);
  try {
    // Safety recovery precedes command readiness. A failed discard
    // reconciliation must never leave approvals/recording commands live.
    await recoverInterruptedSessions();
    if (config.guildId) {
      const guild = await client.guilds.fetch(config.guildId);
      await guild.commands.set(commands);
    } else {
      await client.application!.commands.set(commands);
    }
    runtimeReady = true;
    if (discordInboxService) {
      trackBackground(
        discordInboxService.recover().then((count) => {
          if (count > 0) console.log(`Recovered ${count} queued Discord Inbox source(s).`);
        }),
      );
    }
    console.log(`Chronicle is ready as ${client.user!.tag}`);
    console.log(`Distilling and answering with ${describeProvider()}`);
    console.log(`Auto-record is ${config.autoRecord ? 'enabled' : 'disabled'}; review is ${
      config.requireReview ? 'required' : 'auto-approved'
    }.`);
    console.log(`Discord Inbox is ${discordInboxService ? 'enabled for allowlisted new messages' : 'disabled'}.`);
  } catch (error) {
    console.error('Chronicle startup recovery failed:', error);
    shuttingDown = true;
    discordInboxReady = false;
    await discordInboxService?.close();
    if (discordInboxRetentionTimer) clearInterval(discordInboxRetentionTimer);
    discordInboxRetentionTimer = undefined;
    processingQueue.close();
    processingQueue.cancelAll('Chronicle safety recovery failed during startup.');
    client.destroy();
    process.exitCode = 1;
  }
});

function inboxLocationAllowed(guildId: string | null, channelId: string): boolean {
  if (!discordInboxService || !guildId) return false;
  const policy = config.inboxPolicy;
  return policy.guildIds.includes(guildId) && policy.channelIds.includes(channelId);
}

function inboxMessageMetadataAllowed(message: Message): boolean {
  if (!message.inGuild() || !inboxLocationAllowed(message.guildId, message.channelId)) return false;
  if (
    message.author.bot ||
    message.webhookId ||
    message.system ||
    (message.type !== MessageType.Default && message.type !== MessageType.Reply) ||
    !message.member
  ) {
    return false;
  }
  return authorize(config.inboxPolicy, {
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.author.id,
    roleIds: [...message.member.roles.cache.keys()],
  }).allowed;
}

function trackDiscordInboxTask(task: Promise<unknown>, action: string): void {
  trackBackground(task.catch(() => {
    console.error(`Discord Inbox ${action} failed; inspect the encrypted Library state.`);
  }));
}

client.on(Events.MessageCreate, (message) => {
  if (!discordInboxReady || shuttingDown || !inboxMessageMetadataAllowed(message)) return;
  const input = discordInboxMessage(message);
  if (input) trackDiscordInboxTask(discordInboxService!.handleCreate(input), 'capture');
});

client.on(Events.MessageUpdate, (_oldMessage, updatedMessage) => {
  if (
    !discordInboxReady ||
    shuttingDown ||
    !inboxLocationAllowed(updatedMessage.guildId, updatedMessage.channelId)
  ) {
    return;
  }
  trackDiscordInboxTask((async () => {
    const identity = {
      guildId: updatedMessage.guildId!,
      channelId: updatedMessage.channelId,
      messageId: updatedMessage.id,
    };
    if (updatedMessage.partial && !await discordInboxService!.canFetchUpdate(identity)) return;
    const complete = updatedMessage.partial ? await updatedMessage.fetch() : updatedMessage;
    if (!inboxMessageMetadataAllowed(complete)) return;
    const input = discordInboxMessage(complete);
    if (input) await discordInboxService!.handleUpdate(input);
  })(), 'update');
});

client.on(Events.MessageDelete, (message: Message | PartialMessage) => {
  if (
    !discordInboxReady ||
    shuttingDown ||
    !message.guildId ||
    !inboxLocationAllowed(message.guildId, message.channelId)
  ) {
    return;
  }
  trackDiscordInboxTask(
    discordInboxService!.handleDelete({
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
    }),
    'deletion',
  );
});

client.on(Events.MessageBulkDelete, (messages) => {
  if (!discordInboxReady || shuttingDown || !discordInboxService) return;
  for (const message of messages.values()) {
    if (!message.guildId || !inboxLocationAllowed(message.guildId, message.channelId)) continue;
    trackDiscordInboxTask(
      discordInboxService.handleDelete({
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
      }),
      'bulk deletion',
    );
  }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  try {
    if (!runtimeReady || shuttingDown || oldState.channelId === newState.channelId) return;
    const guildId = (newState.guild ?? oldState.guild).id;

    const pending = pendingStarts.get(guildId);
    if (pending && oldState.channelId === pending.channelId && oldState.member) {
      pending.admission.revoke(oldState.member.id);
    }
    if (
      pending &&
      oldState.channelId === pending.channelId &&
      oldState.channel &&
      humanCount(oldState.channel) === 0
    ) {
      trackBackground(
        fenceAndCancelPendingStart(
          pending,
          'Recording start cancelled because everyone left before activation.',
        ),
      );
    }

    const session = sessions.get(guildId);
    if (session && oldState.channelId && oldState.channel) {
      if (oldState.channelId === session.voiceChannelId && oldState.member) {
        session.revokeAdmission(oldState.member.id);
        cancelParticipantAdmission(
          session.id,
          oldState.member.id,
          'Participant left before their recording grace period completed.',
        );
      }
      if (
        shouldAutoStop({
          leftChannelId: oldState.channelId,
          recordingChannelId: session.voiceChannelId,
          humansRemaining: humanCount(oldState.channel),
        })
      ) {
        sessions.delete(guildId);
        cancelSessionAdmissions(session.id, 'Recording stopped because everyone left.');
        trackBackground(
          beginFinishAndFile(session, oldState.channel as unknown as SendableChannels),
        );
      }
    }

    if (!newState.channel || !newState.member) return;
    const activeSession = sessions.get(guildId);
    if (
      activeSession &&
      newState.channelId === activeSession.voiceChannelId &&
      !newState.member.user.bot
    ) {
      scheduleParticipantAdmission(activeSession, newState.channel, newState.member.id);
    }
    const decision = authorize(config.recordPolicy, {
      guildId,
      channelId: newState.channelId,
      userId: newState.member.id,
      roleIds: roleIds(newState.member),
    });
    if (
      decision.allowed &&
      shouldAutoStart({
        autoRecordEnabled: config.autoRecord,
        joinerIsBot: newState.member.user.bot,
        channelId: newState.channelId,
        alreadyRecording: sessions.has(guildId) || pendingStarts.has(guildId),
        humansInChannel: humanCount(newState.channel),
      })
    ) {
      await autoStartRecording(newState.channel);
    }
  } catch (error) {
    console.error('voiceStateUpdate handler failed:', error);
  }
});

async function handleRecordStart(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  if (sessions.has(guildId) || pendingStarts.has(guildId)) {
    await interaction.reply({ content: 'A recording is already active or awaiting consent.', ephemeral: true });
    return;
  }

  const member = await interaction.guild!.members.fetch(interaction.user.id);
  const channel = member.voice.channel;
  if (!channel) {
    await interaction.reply({ content: 'Join a voice channel first, then run `/record start`.', ephemeral: true });
    return;
  }
  if (!(await requireRecordAuthorization(interaction, member, channel.id))) return;

  await interaction.deferReply({ ephemeral: true });
  const session = await startAfterConsent(channel, async (notice) => {
    // The voice room's own text surface is the consent channel of record; a
    // slash-command acknowledgement somewhere else is not enough for everyone
    // whose audio would be captured.
    await (channel as unknown as SendableChannels).send(notice);
    await interaction.editReply(
      `Consent notice posted in ${channel.name}; capture waits the configured grace period.`,
    );
  });
  if (!session) {
    await interaction.editReply('Recording start was cancelled before capture.');
    return;
  }
  await interaction.editReply(
    `Recording is now active in ${channel.name}. Use \`/record optout\` before recording stops, ` +
      (config.requireReview
        ? 'or `/record stop` to create a local review draft. '
        : 'or `/record stop` to file the result automatically without human review. ') +
      'Public recording notices stay in the recorded room.',
  );
}

async function handleRecordStop(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const session = sessions.get(guildId);
  if (!session) {
    await interaction.reply({ content: 'Nothing is being recorded here.', ephemeral: true });
    return;
  }
  const member = await interaction.guild!.members.fetch(interaction.user.id);
  if (!(await requireRecordAuthorization(interaction, member, session.voiceChannelId))) return;
  if (sessions.get(guildId) !== session) {
    await interaction.reply({
      content:
        'Recording state changed while the stop request was being authorized. Nothing else was stopped or queued; run `/record status` for the current state.',
      ephemeral: true,
    });
    return;
  }
  sessions.delete(guildId);
  cancelSessionAdmissions(session.id, 'Recording was stopped.');
  markCaptureAsProcessing(session);
  await interaction.deferReply({ ephemeral: true });

  const outputChannelId = recordingOutputChannelId({
    recordingChannelId: session.voiceChannelId,
    interactionChannelId: interaction.channelId,
  });
  const outputChannel = await getSendableChannel(outputChannelId);
  const settlement = beginFinishAndFile(session, outputChannel);
  await interaction.editReply(
    config.requireReview
      ? '⏹️ Recording stopped. Processing updates stay in the recorded voice room; review content stays local until approved.'
      : '⏹️ Recording stopped. The result will be filed automatically without human review; processing output stays in the recorded voice room.',
  );
  await settlement;
}

async function handleRecordStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const page = interaction.options.getInteger('page') ?? 1;
  const session = sessions.get(guildId);
  const pending = pendingStarts.get(guildId);
  const member = await interaction.guild!.members.fetch(interaction.user.id);
  const actionable = (await guildSessionManifests(guildId)).filter(({ manifest }) =>
    ACTIONABLE_SESSION_STAGES.has(manifest.stage),
  );
  const authorizedActionable = actionable.filter(({ manifest }) =>
    authorize(
      config.recordPolicy,
      authorizationContext(interaction, member, manifest.workspace.channelId),
    ).allowed,
  );
  const channelId =
    session?.voiceChannelId ??
    pending?.channelId ??
    authorizedActionable[0]?.manifest.workspace.channelId ??
    interaction.channelId;
  if (!(await requireRecordAuthorization(interaction, member, channelId))) return;
  const sessionList = formatActionableSessions(authorizedActionable, session?.id, page);

  if (pending) {
    await interaction.reply({
      content:
        `🟠 Consent/connection setup is in progress for session ${pending.sessionId}; ` +
        'the capture listener is not active yet.' +
        (sessionList ? `\nOther actionable sessions:\n${sessionList}` : ''),
      ephemeral: true,
    });
    return;
  }
  if (session) {
    const minutes = Math.round((Date.now() - session.startedAt) / 60_000);
    await interaction.reply({
      content: `🔴 Session ${session.id} recording for ${minutes} min. Speakers: ${
        [...session.speakers.values()].join(', ') || 'none yet'
      }. Opted out: ${session.optedOutUserIds.length}.${
        sessionList ? `\nActionable sessions:\n${sessionList}` : ''
      }`,
      ephemeral: true,
    });
    return;
  }
  if (authorizedActionable.length > 0) {
    await interaction.reply({
      content: `🟡 Actionable Chronicle sessions:\n${sessionList}\nUse \`/record discard session:<id>\` when more than one is listed.`,
      ephemeral: true,
    });
    return;
  }
  await interaction.reply({ content: 'Not recording or processing.', ephemeral: true });
}

async function handleRecordDiscard(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const requestedSessionId = interaction.options.getString('session')?.trim();
  let session = sessions.get(guildId);
  let pending = pendingStarts.get(guildId);
  let manifests = await guildSessionManifests(guildId);
  let selectedLocated = requestedSessionId
    ? manifests.find(({ manifest }) => manifest.id === requestedSessionId)
    : undefined;
  if (requestedSessionId) {
    if (session?.id !== requestedSessionId) session = undefined;
    if (pending?.sessionId !== requestedSessionId) pending = undefined;
    if (!session && !pending && !selectedLocated) {
      await interaction.reply({
        content: `No Chronicle session ${requestedSessionId} exists in this server.`,
        ephemeral: true,
      });
      return;
    }
  }
  const member = await interaction.guild!.members.fetch(interaction.user.id);
  const authorizedActionable = manifests.filter(
    ({ manifest }) =>
      ACTIONABLE_SESSION_STAGES.has(manifest.stage) &&
      authorize(
        config.recordPolicy,
        authorizationContext(interaction, member, manifest.workspace.channelId),
      ).allowed,
  );
  if (!requestedSessionId && !session && !pending && authorizedActionable.length > 1) {
    await interaction.reply({
      content:
        'Several sessions can still be discarded:\n' +
        formatActionableSessions(authorizedActionable) +
        '\nRun `/record discard session:<id>` so Chronicle cannot delete the wrong capture.',
      ephemeral: true,
    });
    return;
  }
  if (!requestedSessionId && !session && !pending && authorizedActionable.length === 1) {
    selectedLocated = authorizedActionable[0];
  }
  let tracked = selectedLocated
    ? trackedFromManifest(selectedLocated)
    : (processingByGuild.get(guildId) ?? latestCaptureByGuild.get(guildId));
  let trackedManifest = selectedLocated?.manifest ??
    (tracked ? await readSessionManifest(tracked.manifestPath) : undefined);
  const channelId =
    session?.voiceChannelId ??
    pending?.channelId ??
    trackedManifest?.workspace.channelId ??
    interaction.channelId;
  if (!(await requireRecordAuthorization(interaction, member, channelId))) return;

  // Authorization and REST member lookup yield to concurrent stop/start
  // commands. Refresh ownership before choosing the active vs queued path.
  const currentSession = sessions.get(guildId);
  session = requestedSessionId
    ? (currentSession?.id === requestedSessionId ? currentSession : undefined)
    : currentSession;
  const currentPending = pendingStarts.get(guildId);
  pending = requestedSessionId
    ? (currentPending?.sessionId === requestedSessionId ? currentPending : undefined)
    : currentPending;
  manifests = await guildSessionManifests(guildId);
  selectedLocated = requestedSessionId
    ? manifests.find(({ manifest }) => manifest.id === requestedSessionId)
    : selectedLocated
      ? manifests.find(({ manifest }) => manifest.id === selectedLocated!.manifest.id)
      : undefined;
  if (selectedLocated) {
    tracked = trackedFromManifest(selectedLocated);
    trackedManifest = selectedLocated.manifest;
  } else if (!session && !pending) {
    tracked = processingByGuild.get(guildId) ?? latestCaptureByGuild.get(guildId);
    trackedManifest = tracked ? await readSessionManifest(tracked.manifestPath) : undefined;
  }
  const refreshedChannelId =
    session?.voiceChannelId ??
    pending?.channelId ??
    trackedManifest?.workspace.channelId ??
    interaction.channelId;
  if (
    refreshedChannelId !== channelId &&
    !(await requireRecordAuthorization(interaction, member, refreshedChannelId))
  ) {
    return;
  }

  if (pending) {
    await interaction.deferReply({ ephemeral: true });
    const fence = await fenceAndCancelPendingStart(
      pending,
      `Discarded by ${interaction.user.id} from Discord before activation.`,
    );
    await interaction.editReply(
      fence.outcome === 'already_approved'
        ? 'Chronicle found an already-approved record for this operation ID; that approved record was preserved while the duplicate pending capture was erased.'
        : '🗑️ Recording start cancelled behind a durable discard fence. Any connecting manifest and raw audio were reconciled and erased.',
    );
    return;
  }
  if (session) {
    await interaction.deferReply({ ephemeral: true });
    const reason = `Discarded by ${interaction.user.id} from Discord.`;
    const knowledgeFence = await tombstoneOperation(session.id, {
      workspaceId: guildId,
      reason,
    });
    if (sessions.get(guildId) === session) sessions.delete(guildId);
    cancelSessionAdmissions(session.id, 'Recording was discarded.');
    if (knowledgeFence.outcome === 'already_approved') {
      await session.stop();
      await processingQueue.cancelAndWait(session.id, reason).catch(() => 'not_found' as const);
      await captureSettlements.get(session.id)?.catch(() => {});
      const approved = await readDraft(knowledgeFence.recordId, { workspaceId: guildId }).catch(
        () => undefined,
      );
      await updateSessionManifest(session.manifestPath, (current) => ({
        ...current,
        stage: 'completed',
        draftId: knowledgeFence.recordId,
        meetingPath: approved?.approval?.meetingPath ?? current.meetingPath,
        topicPaths: approved?.approval?.topicPaths ?? current.topicPaths,
        error: undefined,
      }));
      await interaction.editReply(
        'Chronicle completed and approved this session before the discard fence was acquired; it was not discarded.',
      );
      return;
    }
    await session.discard();
    await processingQueue.cancelAndWait(session.id, reason).catch(() => 'not_found' as const);
    await captureSettlements.get(session.id)?.catch(() => {});
    await reconcileDiscardedSessions(config.sessionsDir);
    await interaction.editReply(
      '🗑️ Capture discarded. Raw audio was erased; any staged draft was rejected. ' +
        'An already-preserved transcript remains in the local audit archive until an operator explicitly removes it.',
    );
    return;
  }
  if (tracked && trackedManifest) {
    if (trackedManifest.stage === 'completed') {
      if (processingByGuild.get(guildId)?.id === tracked.id) {
        processingByGuild.delete(guildId);
      }
      await interaction.reply({
        content: 'Chronicle had already completed and approved this session, so it was not discarded.',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });
    const reason = `Discarded by ${interaction.user.id} from Discord.`;
    // Acquire the KB fence first. Session-first ordering leaves an approval
    // window if the process crashes between its two durable writes.
    const knowledgeFence = await tombstoneOperation(trackedManifest.id, {
      workspaceId: trackedManifest.workspace.id,
      reason,
    });
    if (knowledgeFence.outcome === 'tombstoned') {
      await tombstoneSession(tracked.manifestPath, reason);
    }
    await processingQueue.cancelAndWait(tracked.id, reason).catch((error) => {
      console.warn(`Processing job ${tracked.id} settled with an error during discard:`, error);
      return 'not_found' as const;
    });
    await captureSettlements.get(tracked.id)?.catch((error) => {
      console.warn(`Capture ${tracked.id} settled with an error during discard:`, error);
    });

    const afterCancellation = await readSessionManifest(tracked.manifestPath);
    const draftId =
      knowledgeFence.outcome === 'already_approved'
        ? knowledgeFence.recordId
        : (afterCancellation.draftId ?? afterCancellation.rawCaptureId);
    const draft = draftId
      ? await readDraft(draftId, { workspaceId: trackedManifest.workspace.id }).catch(() => undefined)
      : undefined;
    if (knowledgeFence.outcome === 'already_approved') {
      await updateSessionManifest(tracked.manifestPath, (current) => ({
        ...current,
        stage: 'completed',
        meetingPath: draft?.approval?.meetingPath ?? current.meetingPath,
        topicPaths: draft?.approval?.topicPaths ?? current.topicPaths,
        draftId,
        discardedAt: undefined,
        discardReason: undefined,
        error: undefined,
      }));
      if (processingByGuild.get(guildId)?.id === tracked.id) {
        processingByGuild.delete(guildId);
      }
      await interaction.editReply(
        'Chronicle completed and approved this session before the discard fence was acquired; it was not discarded.',
      );
      return;
    }
    if (draft?.status === 'needs_review') {
      await rejectDraft(draft.id, {
        workspaceId: trackedManifest.workspace.id,
        reason: 'The originating Discord capture was discarded.',
      });
    }

    const latestManifest = await readSessionManifest(tracked.manifestPath);
    await purgeRawSessionAudio({ path: tracked.manifestPath, dir: tracked.dir, manifest: latestManifest });
    await updateSessionManifest(tracked.manifestPath, (current) =>
      current.stage === 'completed'
        ? current
        : {
            ...current,
            stage: 'discarded',
            segments: [],
            speakers: {},
            warnings: [],
            recoverable: false,
            rawAudioExpiresAt: new Date().toISOString(),
            error: undefined,
          },
    );
    if (processingByGuild.get(guildId)?.id === tracked.id) {
      processingByGuild.delete(guildId);
    }
    await interaction.editReply(
      '🗑️ Processing is fenced and cancelled, its review draft is rejected, and raw audio is erased. ' +
        'Any already-preserved raw transcript remains in the local archive/rejected audit record until an operator explicitly archives or removes it.',
    );
    return;
  }
  await interaction.reply({ content: 'There is no current capture to discard.', ephemeral: true });
}

async function handleRecordOptOut(interaction: ChatInputCommandInteraction): Promise<void> {
  const guildId = interaction.guildId!;
  const pending = pendingStarts.get(guildId);
  const session = sessions.get(guildId);
  if (pending) {
    pending.admission.optOut(interaction.user.id);
    if (pending.preparedSession) {
      const cleanup = pending.preparedSession.optOut(interaction.user.id);
      void cleanup.catch(() => {});
      await interaction.deferReply({ ephemeral: true });
      await cleanup;
      await interaction.editReply(
        '✅ You are opted out before capture. Chronicle will ignore your audio for this session.',
      );
    } else {
      await interaction.reply({
        content: '✅ You are opted out before capture. Chronicle will ignore your audio for this session.',
        ephemeral: true,
      });
    }
    return;
  }
  if (session) {
    cancelParticipantAdmission(session.id, interaction.user.id, 'Participant opted out.');
    // Calling optOut establishes its in-memory fence synchronously before this
    // first Discord await; cleanup completion controls the truthfulness of the reply.
    const cleanup = session.optOut(interaction.user.id);
    void cleanup.catch(() => {});
    await interaction.deferReply({ ephemeral: true });
    await cleanup;
    await interaction.editReply('✅ You are opted out. Your captured audio for this active session was erased.');
    return;
  }
  await interaction.reply({
    content:
      'The per-person opt-out deadline has passed because no recording is active. ' +
      'An authorized operator may still use `/record discard` to discard the whole queued capture.',
    ephemeral: true,
  });
}

async function handleRecall(interaction: ChatInputCommandInteraction): Promise<void> {
  const member = await interaction.guild!.members.fetch(interaction.user.id);
  if (!(await requireRecallAuthorization(interaction, member))) return;
  const query = interaction.options.getString('query', true);
  await interaction.deferReply({ ephemeral: true });

  const { answer, hits } = await recall(query, 8, { workspaceId: interaction.guildId! });
  if (hits.length === 0) {
    await interaction.editReply(`Nothing in this server's knowledge workspace is relevant to “${query}”.`);
    return;
  }

  const sources = [...new Set(hits.map((hit) => hit.file.replace(/\.md$/, '')))];
  const embed = new EmbedBuilder()
    .setTitle(`🔎 ${query}`.slice(0, 256))
    .setDescription(answer.slice(0, 4000))
    .setFooter({ text: `Sources: ${sources.join(' · ')}`.slice(0, 2048) });
  await interaction.editReply({ embeds: [embed] });
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Chronicle only works inside a server.', ephemeral: true });
    return;
  }
  if (!runtimeReady) {
    await interaction.reply({
      content: 'Chronicle is unavailable until its safety recovery completes.',
      ephemeral: true,
    });
    return;
  }
  try {
    if (interaction.commandName === 'record') {
      const subcommand = interaction.options.getSubcommand();
      if (subcommand === 'start') await handleRecordStart(interaction);
      else if (subcommand === 'stop') await handleRecordStop(interaction);
      else if (subcommand === 'discard') await handleRecordDiscard(interaction);
      else if (subcommand === 'optout') await handleRecordOptOut(interaction);
      else await handleRecordStatus(interaction);
    } else if (interaction.commandName === 'recall') {
      await handleRecall(interaction);
    }
  } catch (error) {
    console.error(`Command /${interaction.commandName} failed:`, error);
    const message = `⚠️ ${error instanceof Error ? error.message : 'Something went wrong.'}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(message).catch(() => {});
    } else {
      await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
    }
  }
});

async function gracefulShutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    console.error(`Received ${signal} again; forcing exit.`);
    process.exit(1);
  }
  shuttingDown = true;
  discordInboxReady = false;
  await discordInboxService?.close();
  if (discordInboxRetentionTimer) clearInterval(discordInboxRetentionTimer);
  discordInboxRetentionTimer = undefined;
  console.log(`Received ${signal}; preserving active captures before shutdown…`);
  processingQueue.close();
  for (const pending of [...pendingStarts.values()]) {
    await fenceAndCancelPendingStart(
      pending,
      `Shutdown (${signal}) cancelled this pending recording before activation.`,
    ).catch(async (error) => {
      console.error(`Could not durably cancel pending session ${pending.sessionId}:`, error);
      process.exitCode = 1;
      pending.controller.abort(
        new Error(`Shutdown (${signal}) failed closed after a discard-fence error.`),
      );
      await pending.preparedSession?.discard().catch((discardError) => {
        console.error(`Could not erase pending session ${pending.sessionId}:`, discardError);
      });
      await pending.settled;
    });
  }
  for (const pending of pendingParticipantAdmissions.values()) {
    pending.controller.abort(new Error(`Shutdown (${signal}) during participant consent grace.`));
  }
  pendingParticipantAdmissions.clear();

  const active = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(active.map((session) => session.stop()));

  const outstanding = Promise.allSettled([...backgroundTasks]);
  const drained = Promise.all([processingQueue.drain(), outstanding]);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), config.shutdownTimeoutMs);
  });
  if ((await Promise.race([drained.then(() => 'drained' as const), deadline])) === 'timeout') {
    console.error('Shutdown processing deadline reached; durable sessions will recover next start.');
    processingQueue.cancelAll('Shutdown timeout; recover this durable capture on next start.');
  }
  if (timer) clearTimeout(timer);
  client.destroy();
}

process.once('SIGINT', () => void gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => void gracefulShutdown('SIGTERM'));

await assertParakeetReady();
await client.login(config.discordToken);
