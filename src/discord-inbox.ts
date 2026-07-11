import { authorize, type AccessPolicy } from './policy.js';
import type { ProcessingJob } from './jobs.js';
import {
  EncryptedSourceCatalog,
  SourceRevisionConflictError,
  type CaptureDiscordMessageInput,
  type DiscordAttachmentInput,
  type DiscordMessageIdentity,
  type SourceAnalysis,
  type SourceCatalogRecord,
  type StoredDiscordReceipt,
} from './source-catalog.js';

export interface DiscordInboxMessage {
  id: string;
  guildId: string;
  channelId: string;
  author: {
    id: string;
    username: string;
    displayName?: string;
    bot: boolean;
  };
  roleIds?: readonly string[];
  content: string;
  createdAt: string;
  editedAt?: string;
  type: 'default' | 'reply' | 'other';
  webhookId?: string;
  system?: boolean;
  urls?: readonly string[];
  attachments?: readonly DiscordAttachmentInput[];
  /** Runtime-only adapter; never persisted in the encrypted source envelope. */
  sendReceipt?: (initialContent: string) => Promise<DiscordInboxReceipt | undefined>;
}

export interface DiscordInboxReceipt {
  /** Durable identity only; the update function itself is never persisted. */
  identity?: {
    channelId: string;
    messageId: string;
  };
  update: (content: string) => Promise<void>;
}

export interface DiscordInboxQueue {
  enqueue: (job: ProcessingJob<unknown>) => Promise<unknown>;
  cancel: (jobId: string, reason?: string) => boolean;
}

export interface DiscordInboxServiceOptions {
  catalog: EncryptedSourceCatalog;
  queue: DiscordInboxQueue;
  policy: AccessPolicy;
  process: (record: SourceCatalogRecord, signal: AbortSignal) => Promise<SourceAnalysis>;
  sendReceipt?: (
    message: DiscordInboxMessage,
    initialContent: string,
  ) => Promise<DiscordInboxReceipt | undefined>;
  /** Rebuilds an update adapter for a receipt after a queue retry or restart. */
  restoreReceipt?: (receipt: StoredDiscordReceipt) => DiscordInboxReceipt | undefined;
  disclosure?: string;
  resolveCurrentRoleIds?: (
    guildId: string,
    userId: string,
  ) => Promise<readonly string[] | undefined>;
  maxAttachments?: number;
  maxAttachmentBytes?: number;
  maxTotalAttachmentBytes?: number;
  maxUrls?: number;
  retryInitialDelayMs?: number;
  retryMaxDelayMs?: number;
}

export interface DiscordInboxCaptureResult {
  status: 'ignored' | 'duplicate' | 'captured' | 'revised' | 'waiting' | 'failed';
  sourceId?: string;
}

type DiscordInboxReceiptBinding =
  | { status: 'ready'; record: SourceCatalogRecord }
  | { status: 'superseded' };

function isAcceptedMessageType(type: DiscordInboxMessage['type']): boolean {
  return type === 'default' || type === 'reply';
}

export function inboxMessageAuthorized(
  message: DiscordInboxMessage,
  policy: AccessPolicy,
): boolean {
  if (
    message.author.bot ||
    message.webhookId ||
    message.system ||
    !isAcceptedMessageType(message.type) ||
    !message.roleIds
  ) {
    return false;
  }
  return authorize(policy, {
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.author.id,
    roleIds: message.roleIds,
  }).allowed;
}

function processingJobId(record: SourceCatalogRecord): string {
  return `${record.source.id}:revision:${record.source.sourceRevision}`;
}

function compactDisclosure(value: string | undefined): string {
  const cleaned = value?.replace(/\s+/g, ' ').trim();
  return cleaned ? ` ${cleaned}` : '';
}

function libraryReceipt(status: string, disclosure: string): string {
  return `${status} | encrypted Library storage.${disclosure}`;
}

function captureInput(
  message: DiscordInboxMessage,
  options: DiscordInboxServiceOptions,
): { input: CaptureDiscordMessageInput; acquisitionWarnings: string[] } {
  const maxAttachments = options.maxAttachments ?? 10;
  const maxAttachmentBytes = options.maxAttachmentBytes ?? 25 * 1024 * 1024;
  const maxTotalAttachmentBytes = options.maxTotalAttachmentBytes ?? 50 * 1024 * 1024;
  const maxUrls = options.maxUrls ?? 10;
  const acquisitionWarnings: string[] = [];
  const attachments = [...(message.attachments ?? [])].slice(0, maxAttachments);
  if ((message.attachments?.length ?? 0) > attachments.length) {
    acquisitionWarnings.push(`Only the first ${maxAttachments} attachment metadata entries were kept.`);
  }
  const totalBytes = attachments.reduce((sum, attachment) => sum + (attachment.sizeBytes ?? 0), 0);
  const oversized = attachments.filter((attachment) => (attachment.sizeBytes ?? 0) > maxAttachmentBytes);
  if (oversized.length > 0) {
    acquisitionWarnings.push(`${oversized.length} attachment${oversized.length === 1 ? '' : 's'} exceeded the per-file processing limit.`);
  }
  if (totalBytes > maxTotalAttachmentBytes) {
    acquisitionWarnings.push('Attachments exceeded the total processing limit.');
  }
  const urls = [...(message.urls ?? [])].slice(0, maxUrls);
  if ((message.urls?.length ?? 0) > urls.length) {
    acquisitionWarnings.push(`Only the first ${maxUrls} links were kept.`);
  }
  return {
    input: {
      workspaceId: message.guildId,
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      author: message.author,
      text: message.content,
      urls,
      attachments,
      messageCreatedAt: message.createdAt,
      messageEditedAt: message.editedAt,
    },
    acquisitionWarnings,
  };
}

function withAcquisitionWarnings(
  analysis: SourceAnalysis,
  warnings: readonly string[],
): SourceAnalysis {
  if (warnings.length === 0) return analysis;
  return {
    ...analysis,
    capability: 'partial',
    warning: [analysis.warning, ...warnings].filter(Boolean).join(' '),
  };
}

async function updateReceipt(
  receipt: DiscordInboxReceipt | undefined,
  content: string,
): Promise<void> {
  await receipt?.update(content).catch(() => undefined);
}

export function createDiscordInboxService(options: DiscordInboxServiceOptions) {
  const disclosure = compactDisclosure(options.disclosure);
  const retryInitialDelayMs = Math.max(1, options.retryInitialDelayMs ?? 1_000);
  const retryMaxDelayMs = Math.max(retryInitialDelayMs, options.retryMaxDelayMs ?? 30_000);
  let retryDelayMs = retryInitialDelayMs;
  let retryTimer: NodeJS.Timeout | undefined;
  let recoveryPromise: Promise<number> | undefined;
  let closed = false;

  function resetRetryBackoff(): void {
    retryDelayMs = retryInitialDelayMs;
  }

  function scheduleRetry(): void {
    if (closed || retryTimer) return;
    const delayMs = retryDelayMs;
    retryDelayMs = Math.min(retryMaxDelayMs, retryDelayMs * 2);
    const timer = setTimeout(() => {
      if (retryTimer === timer) retryTimer = undefined;
      if (closed) return;
      void recover().catch(() => scheduleRetry());
    }, delayMs);
    retryTimer = timer;
    timer.unref();
  }

  async function storedRecordAuthorized(record: SourceCatalogRecord): Promise<boolean> {
    const context = {
      guildId: record.source.discord.guildId,
      channelId: record.source.discord.channelId,
      userId: record.source.author.id,
      roleIds: [] as readonly string[],
    };
    if (authorize(options.policy, context).allowed) return true;
    if (!options.resolveCurrentRoleIds) return false;
    const currentRoleIds = await options.resolveCurrentRoleIds(context.guildId, context.userId);
    if (!currentRoleIds) return false;
    return authorize(options.policy, { ...context, roleIds: currentRoleIds }).allowed;
  }

  async function canFetchUpdate(identity: DiscordMessageIdentity): Promise<boolean> {
    const existing = await options.catalog.getByDiscordMessage(identity);
    return existing?.recordType === 'source' && await storedRecordAuthorized(existing);
  }

  async function sendMessageReceipt(
    message: DiscordInboxMessage,
    content: string,
  ): Promise<DiscordInboxReceipt | undefined> {
    if (message.sendReceipt) return message.sendReceipt(content).catch(() => undefined);
    return options.sendReceipt?.(message, content).catch(() => undefined);
  }

  async function bindReceipt(
    record: SourceCatalogRecord,
    receipt: DiscordInboxReceipt | undefined,
  ): Promise<DiscordInboxReceiptBinding> {
    if (!receipt?.identity) return { status: 'ready', record };
    try {
      return {
        status: 'ready',
        record: await options.catalog.update(
          record.source.id,
          {
            receipt: {
              channelId: receipt.identity.channelId,
              messageId: receipt.identity.messageId,
              sourceRevision: record.source.sourceRevision,
            },
          },
          { expectedSourceRevision: record.source.sourceRevision },
        ),
      };
    } catch (error) {
      // A concurrent Discord edit owns the newer receipt and processing job.
      if (error instanceof SourceRevisionConflictError) {
        await updateReceipt(
          receipt,
          libraryReceipt('Superseded by a newer Discord edit', disclosure),
        );
        return { status: 'superseded' };
      }
      throw error;
    }
  }

  function restoreStoredReceipt(record: SourceCatalogRecord): DiscordInboxReceipt | undefined {
    if (!record.save.receipt || !options.restoreReceipt) return undefined;
    try {
      return options.restoreReceipt({ ...record.save.receipt });
    } catch {
      return undefined;
    }
  }

  async function enqueueRecord(
    record: SourceCatalogRecord,
    receipt: DiscordInboxReceipt | undefined,
    acquisitionWarnings: readonly string[],
  ): Promise<'captured' | 'waiting' | 'failed'> {
    const sourceId = record.source.id;
    const expectedSourceRevision = record.source.sourceRevision;
    const jobId = processingJobId(record);
    try {
      await options.queue.enqueue({
        id: jobId,
        onAttempt: async () => {
          await options.catalog.update(
            sourceId,
            { processingStatus: 'processing' },
            { expectedSourceRevision },
          );
          await updateReceipt(receipt, libraryReceipt('Saved to Chronicle | processing', disclosure));
        },
        run: async (signal) => {
          const current = await options.catalog.get(sourceId);
          if (
            !current ||
            current.recordType !== 'source' ||
            current.source.sourceRevision !== expectedSourceRevision
          ) {
            throw new SourceRevisionConflictError(
              sourceId,
              expectedSourceRevision,
              current?.recordType === 'source' ? current.source.sourceRevision : 0,
            );
          }
          const analysis = withAcquisitionWarnings(
            await options.process(current, signal),
            acquisitionWarnings,
          );
          await options.catalog.update(
            sourceId,
            {
              analysis,
              processingStatus: analysis.capability === 'processable' ? 'succeeded' : 'partial',
            },
            { expectedSourceRevision },
          );
          return analysis;
        },
      });
      const current = await options.catalog.get(sourceId);
      if (current?.recordType !== 'source') return 'captured';
      const partial = current.save.processingStatus === 'partial';
      await updateReceipt(
        receipt,
        libraryReceipt(
          partial ? 'Saved with limited processing' : 'Processed by Chronicle',
          disclosure,
        ),
      );
      resetRetryBackoff();
      return 'captured';
    } catch (error) {
      if (error instanceof SourceRevisionConflictError) return 'captured';
      const current = await options.catalog.get(sourceId).catch(() => undefined);
      if (
        current?.recordType === 'source' &&
        current.source.sourceRevision === expectedSourceRevision &&
        current.save.processingStatus === 'queued'
      ) {
        await updateReceipt(
          receipt,
          libraryReceipt('Saved to Chronicle | waiting for capacity', disclosure),
        );
        scheduleRetry();
        return 'waiting';
      }
      if (
        current?.recordType === 'source' &&
        current.source.sourceRevision === expectedSourceRevision
      ) {
        const failed = await options.catalog.update(
          sourceId,
          { processingStatus: 'failed' },
          { expectedSourceRevision },
        ).catch(() => undefined);
        if (failed) {
          scheduleRetry();
          await updateReceipt(
            receipt,
            libraryReceipt(
              'Saved to Chronicle | processing failed; retrying automatically',
              disclosure,
            ),
          );
          return 'failed';
        }
      }
      await updateReceipt(
        receipt,
        libraryReceipt('Saved to Chronicle | processing stopped', disclosure),
      );
      return 'failed';
    }
  }

  async function handleCreate(message: DiscordInboxMessage): Promise<DiscordInboxCaptureResult> {
    if (!inboxMessageAuthorized(message, options.policy)) return { status: 'ignored' };
    const { input, acquisitionWarnings } = captureInput(message, options);
    let captured;
    try {
      captured = await options.catalog.captureDiscordMessage(input);
    } catch (error) {
      if (/must contain text, a URL, or an attachment/.test(String(error))) {
        return { status: 'ignored' };
      }
      throw error;
    }
    if (captured.outcome === 'unchanged' || captured.entry.recordType !== 'source') {
      return {
        status: 'duplicate',
        sourceId: captured.entry.recordType === 'source'
          ? captured.entry.source.id
          : captured.entry.sourceId,
      };
    }
    const receipt = await sendMessageReceipt(
      message,
      libraryReceipt('Saved to Chronicle | queued', disclosure),
    );
    const binding = await bindReceipt(captured.entry, receipt);
    if (binding.status === 'superseded') {
      return {
        status: captured.outcome === 'revised' ? 'revised' : 'captured',
        sourceId: captured.entry.source.id,
      };
    }
    const result = await enqueueRecord(binding.record, receipt, acquisitionWarnings);
    return {
      status: result === 'captured'
        ? captured.outcome === 'revised' ? 'revised' : 'captured'
        : result,
      sourceId: captured.entry.source.id,
    };
  }

  async function handleUpdate(message: DiscordInboxMessage): Promise<DiscordInboxCaptureResult> {
    if (!inboxMessageAuthorized(message, options.policy)) return { status: 'ignored' };
    const existing = await options.catalog.getByDiscordMessage({
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
    });
    if (!existing || existing.recordType !== 'source') return { status: 'ignored' };
    const { input, acquisitionWarnings } = captureInput(message, options);
    const captured = await options.catalog.captureDiscordMessage(input);
    if (captured.outcome === 'unchanged' || captured.entry.recordType !== 'source') {
      return { status: 'duplicate', sourceId: existing.source.id };
    }
    options.queue.cancel(processingJobId(existing), 'Discord source was edited.');
    const receipt = await sendMessageReceipt(
      message,
      libraryReceipt('Updated Chronicle source | queued', disclosure),
    );
    const binding = await bindReceipt(captured.entry, receipt);
    if (binding.status === 'superseded') {
      return { status: 'revised', sourceId: captured.entry.source.id };
    }
    const result = await enqueueRecord(binding.record, receipt, acquisitionWarnings);
    return {
      status: result === 'captured' ? 'revised' : result,
      sourceId: captured.entry.source.id,
    };
  }

  async function handleDelete(identity: {
    guildId: string;
    channelId: string;
    messageId: string;
  }): Promise<boolean> {
    const existing = await options.catalog.getByDiscordMessage(identity);
    if (!existing || existing.recordType !== 'source') return false;
    options.queue.cancel(processingJobId(existing), 'Discord source was deleted.');
    await options.catalog.discardByDiscordMessage(identity, 'discord_message_deleted');
    return true;
  }

  async function recoverPass(): Promise<number> {
    let cursor: string | undefined;
    const pending: SourceCatalogRecord[] = [];
    do {
      const page = await options.catalog.listRecoverable({ limit: 100, cursor });
      for (const entry of page.items) {
        if (entry.recordType === 'source') pending.push(entry);
      }
      cursor = page.nextCursor;
    } while (cursor);

    let recovered = 0;
    for (const entry of pending) {
      try {
        if (!await storedRecordAuthorized(entry)) continue;
        const current = await options.catalog.get(entry.source.id);
        if (
          current?.recordType !== 'source' ||
          current.source.sourceRevision !== entry.source.sourceRevision
        ) {
          continue;
        }
        const queued = await options.catalog.update(
          current.source.id,
          { processingStatus: 'queued' },
          { expectedSourceRevision: current.source.sourceRevision },
        );
        await enqueueRecord(queued, restoreStoredReceipt(queued), []);
        recovered += 1;
      } catch (error) {
        if (error instanceof SourceRevisionConflictError) continue;
        scheduleRetry();
      }
    }
    return recovered;
  }

  function recover(): Promise<number> {
    if (closed) return Promise.resolve(0);
    if (recoveryPromise) return recoveryPromise;
    const running = recoverPass().finally(() => {
      if (recoveryPromise === running) recoveryPromise = undefined;
    });
    recoveryPromise = running;
    return running;
  }

  async function close(): Promise<void> {
    closed = true;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = undefined;
    await recoveryPromise?.catch(() => undefined);
  }

  return { handleCreate, handleUpdate, handleDelete, canFetchUpdate, recover, close };
}
