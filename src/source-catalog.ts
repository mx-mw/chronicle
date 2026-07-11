import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  redactDiscordMediaSignedUrls,
  sanitizeDiscordMediaSignedUrl,
} from './discord-media-url.js';
import {
  atomicWriteJson,
  ensurePrivateDirectory,
  ensurePrivateFile,
  withFileLock,
} from './fs-safe.js';

const ENVELOPE_AAD = Buffer.from('chronicle:source-catalog:envelope:v1', 'utf8');
const DAY_MS = 24 * 60 * 60 * 1_000;
const LIVE_SOURCE_STATUSES = new Set<LiveSourceStatus>([
  'active',
  'edited',
  'deleted',
  'unavailable',
]);
const LIVE_PROCESSING_STATUSES = new Set<LiveProcessingStatus>([
  'queued',
  'processing',
  'succeeded',
  'partial',
  'failed',
]);
const RECOVERABLE_PROCESSING_STATUSES = new Set<LiveProcessingStatus>([
  'queued',
  'processing',
  'failed',
]);
const REVIEW_STATUSES = new Set<ReviewStatus>([
  'not_generated',
  'needs_review',
  'approved',
  'rejected',
]);
const DISCARD_REASONS = new Set<SourceDiscardReason>([
  'user_requested',
  'retention_expired',
  'discord_message_deleted',
  'policy',
]);

export type SourceStatus = 'active' | 'edited' | 'deleted' | 'unavailable' | 'discarded';
export type ProcessingStatus =
  | 'queued'
  | 'processing'
  | 'succeeded'
  | 'partial'
  | 'failed'
  | 'discarded';
export type ReviewStatus = 'not_generated' | 'needs_review' | 'approved' | 'rejected';
export type SourceDiscardReason =
  | 'user_requested'
  | 'retention_expired'
  | 'discord_message_deleted'
  | 'policy';

type LiveSourceStatus = Exclude<SourceStatus, 'discarded'>;
type LiveProcessingStatus = Exclude<ProcessingStatus, 'discarded'>;

export interface DiscordMessageIdentity {
  guildId: string;
  channelId: string;
  messageId: string;
}

export interface DiscordAuthorInput {
  id: string;
  username: string;
  displayName?: string;
  bot?: boolean;
}

export interface DiscordAttachmentInput {
  id: string;
  filename: string;
  url: string;
  contentType?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
}

export interface StoredUrl {
  url: string;
}

export interface StoredDiscordAttachment {
  id: string;
  filename: string;
  url: string;
  contentType?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
}

export interface SourceAnalysisActionItem {
  owner: string;
  task: string;
}

export interface SourceAnalysisTopic {
  topic: string;
  fact: string;
}

export interface SourceAnalysis {
  capability: 'processable' | 'link_only' | 'partial';
  title?: string;
  summary?: string;
  kind?: string;
  origin?: string;
  decisions?: string[];
  actionItems?: SourceAnalysisActionItem[];
  openQuestions?: string[];
  topics?: SourceAnalysisTopic[];
  warning?: string;
  draftId?: string;
}

export interface CaptureDiscordMessageInput {
  workspaceId: string;
  guildId: string;
  channelId: string;
  messageId: string;
  author: DiscordAuthorInput;
  text: string;
  urls?: string[];
  attachments?: DiscordAttachmentInput[];
  messageCreatedAt: string;
  messageEditedAt?: string;
}

export interface DiscordMessageSource {
  schemaVersion: 1;
  id: string;
  kind: 'discord_message';
  captureMode: 'discord_inbox';
  sourceRevision: number;
  status: LiveSourceStatus;
  workspaceId: string;
  discord: DiscordMessageIdentity;
  author: DiscordAuthorInput;
  text: string;
  urls: StoredUrl[];
  attachments: StoredDiscordAttachment[];
  messageCreatedAt: string;
  messageEditedAt?: string;
  updatedAt: string;
}

export interface StoredDiscordReceipt {
  channelId: string;
  messageId: string;
  /** The source revision whose processing state this receipt represents. */
  sourceRevision: number;
}

export interface SourceSave {
  schemaVersion: 1;
  id: string;
  sourceId: string;
  workspaceId: string;
  capturedAt: string;
  processingStatus: LiveProcessingStatus;
  reviewStatus: ReviewStatus;
  /** Encrypted routing metadata for editing Chronicle's existing Discord reply. */
  receipt?: StoredDiscordReceipt;
}

export interface SourceCatalogRecord {
  schemaVersion: 1;
  recordType: 'source';
  source: DiscordMessageSource;
  save: SourceSave;
  analysis?: SourceAnalysis;
}

export interface SourceCatalogTombstone {
  schemaVersion: 1;
  recordType: 'tombstone';
  sourceId: string;
  saveId: string;
  workspaceId: string;
  discord: DiscordMessageIdentity;
  sourceRevision: number;
  capturedAt: string;
  discardedAt: string;
  discardReason?: SourceDiscardReason;
  sourceStatus: 'discarded';
  processingStatus: 'discarded';
  reviewStatus: ReviewStatus;
}

export type SourceCatalogEntry = SourceCatalogRecord | SourceCatalogTombstone;

export interface CaptureDiscordMessageResult {
  outcome: 'created' | 'unchanged' | 'revised';
  entry: SourceCatalogEntry;
}

export interface SourceCatalogPage {
  items: SourceCatalogEntry[];
  nextCursor?: string;
}

export interface SourceCatalogListOptions {
  /** Callers on an authenticated surface should always scope lists to a workspace. */
  workspaceId?: string;
  limit?: number;
  cursor?: string;
}

export interface SourceCatalogUpdate {
  sourceStatus?: LiveSourceStatus;
  processingStatus?: LiveProcessingStatus;
  reviewStatus?: ReviewStatus;
  /** Pass null to remove a previous analysis. */
  analysis?: SourceAnalysis | null;
  /** Pass null to stop updating a previous Discord receipt. */
  receipt?: StoredDiscordReceipt | null;
}

export interface SourceCatalogUpdateOptions {
  /** Reject the write if a Discord edit has created a newer source revision. */
  expectedSourceRevision?: number;
}

export interface SourceCatalogOptions {
  directory: string;
  /** A standard-base64 encoded 32-byte AES key. */
  encryptionKey: string;
  /** Test seam; production callers should omit it. */
  now?: () => Date;
}

interface EncryptionEnvelope {
  schemaVersion: 1;
  algorithm: 'aes-256-gcm';
  iv: string;
  authTag: string;
  ciphertext: string;
}

export class SourceRevisionConflictError extends Error {
  readonly sourceId: string;
  readonly expectedSourceRevision: number;
  readonly actualSourceRevision: number;

  constructor(sourceId: string, expectedSourceRevision: number, actualSourceRevision: number) {
    super(
      `Source revision conflict for ${sourceId}: expected ${expectedSourceRevision}, found ${actualSourceRevision}`,
    );
    this.name = 'SourceRevisionConflictError';
    this.sourceId = sourceId;
    this.expectedSourceRevision = expectedSourceRevision;
    this.actualSourceRevision = actualSourceRevision;
  }
}

function requireString(value: string, name: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`${name} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`);
  }
  return value;
}

function requireOptionalString(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, name);
}

function requireIsoTimestamp(value: string, name: string): string {
  requireString(value, name);
  if (!Number.isFinite(Date.parse(value))) throw new Error(`${name} must be an ISO timestamp`);
  return value;
}

function requireOptionalNumber(value: number | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be non-negative`);
  return value;
}

function decodeEncryptionKey(encoded: string): Buffer {
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(encoded)) {
    throw new Error('Source catalog encryption key must be a base64-encoded 32-byte key');
  }
  const decoded = Buffer.from(encoded, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== encoded) {
    throw new Error('Source catalog encryption key must be a base64-encoded 32-byte key');
  }
  return decoded;
}

function sanitizedUrl(value: string, name: string, stripQuery: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(requireString(value, name));
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`${name} must use http or https`);
  }
  parsed.username = '';
  parsed.password = '';
  if (stripQuery) parsed.search = '';
  parsed.hash = '';
  return sanitizeDiscordMediaSignedUrl(parsed.toString());
}

function normalizedAnalysis(value: SourceAnalysis): SourceAnalysis {
  if (
    value.capability !== 'processable' &&
    value.capability !== 'link_only' &&
    value.capability !== 'partial'
  ) {
    throw new Error('analysis.capability is invalid');
  }
  const strings = (items: string[] | undefined, name: string) =>
    items?.map((item, index) => requireString(item, `${name}[${index}]`));
  return {
    capability: value.capability,
    title: requireOptionalString(value.title, 'analysis.title'),
    summary: requireOptionalString(value.summary, 'analysis.summary'),
    kind: requireOptionalString(value.kind, 'analysis.kind'),
    origin: requireOptionalString(value.origin, 'analysis.origin'),
    decisions: strings(value.decisions, 'analysis.decisions'),
    actionItems: value.actionItems?.map((item, index) => ({
      owner: requireString(item.owner, `analysis.actionItems[${index}].owner`),
      task: requireString(item.task, `analysis.actionItems[${index}].task`),
    })),
    openQuestions: strings(value.openQuestions, 'analysis.openQuestions'),
    topics: value.topics?.map((item, index) => ({
      topic: requireString(item.topic, `analysis.topics[${index}].topic`),
      fact: requireString(item.fact, `analysis.topics[${index}].fact`),
    })),
    warning: requireOptionalString(value.warning, 'analysis.warning'),
    draftId: requireOptionalString(value.draftId, 'analysis.draftId'),
  };
}

function normalizeCapture(input: CaptureDiscordMessageInput): CaptureDiscordMessageInput & {
  urls: string[];
  attachments: StoredDiscordAttachment[];
} {
  const urls = [
    ...new Set(
      (input.urls ?? []).map((value, index) => sanitizedUrl(value, `urls[${index}]`, false)),
    ),
  ];
  const attachments = (input.attachments ?? []).map((attachment, index) => ({
    id: requireString(attachment.id, `attachments[${index}].id`),
    filename: requireString(attachment.filename, `attachments[${index}].filename`),
    url: sanitizedUrl(attachment.url, `attachments[${index}].url`, true),
    contentType: requireOptionalString(attachment.contentType, `attachments[${index}].contentType`),
    sizeBytes: requireOptionalNumber(attachment.sizeBytes, `attachments[${index}].sizeBytes`),
    width: requireOptionalNumber(attachment.width, `attachments[${index}].width`),
    height: requireOptionalNumber(attachment.height, `attachments[${index}].height`),
    durationSeconds: requireOptionalNumber(
      attachment.durationSeconds,
      `attachments[${index}].durationSeconds`,
    ),
  }));
  const normalized = {
    workspaceId: requireString(input.workspaceId, 'workspaceId'),
    guildId: requireString(input.guildId, 'guildId'),
    channelId: requireString(input.channelId, 'channelId'),
    messageId: requireString(input.messageId, 'messageId'),
    author: {
      id: requireString(input.author.id, 'author.id'),
      username: requireString(input.author.username, 'author.username'),
      displayName: requireOptionalString(input.author.displayName, 'author.displayName'),
      bot: input.author.bot === true,
    },
    text: redactDiscordMediaSignedUrls(requireString(input.text, 'text', true)),
    urls,
    attachments,
    messageCreatedAt: requireIsoTimestamp(input.messageCreatedAt, 'messageCreatedAt'),
    messageEditedAt:
      input.messageEditedAt === undefined
        ? undefined
        : requireIsoTimestamp(input.messageEditedAt, 'messageEditedAt'),
  };
  if (normalized.text.length === 0 && urls.length === 0 && attachments.length === 0) {
    throw new Error('Discord inbox message must contain text, a URL, or an attachment');
  }
  return normalized;
}

function contentFingerprint(input: ReturnType<typeof normalizeCapture>): string {
  return JSON.stringify({
    workspaceId: input.workspaceId,
    guildId: input.guildId,
    channelId: input.channelId,
    messageId: input.messageId,
    author: input.author,
    text: input.text,
    urls: input.urls,
    attachments: input.attachments,
    messageCreatedAt: input.messageCreatedAt,
    messageEditedAt: input.messageEditedAt,
  });
}

/** Match the durable JSON shape so create/update responses equal later reads. */
function durableJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function recordFingerprint(record: SourceCatalogRecord): string {
  return JSON.stringify({
    workspaceId: record.source.workspaceId,
    guildId: record.source.discord.guildId,
    channelId: record.source.discord.channelId,
    messageId: record.source.discord.messageId,
    author: record.source.author,
    text: record.source.text,
    urls: record.source.urls.map(({ url }) => url),
    attachments: record.source.attachments,
    messageCreatedAt: record.source.messageCreatedAt,
    messageEditedAt: record.source.messageEditedAt,
  });
}

function entrySourceId(entry: SourceCatalogEntry): string {
  return entry.recordType === 'source' ? entry.source.id : entry.sourceId;
}

function entryCapturedAt(entry: SourceCatalogEntry): string {
  return entry.recordType === 'source' ? entry.save.capturedAt : entry.capturedAt;
}

function entryWorkspaceId(entry: SourceCatalogEntry): string {
  return entry.recordType === 'source' ? entry.source.workspaceId : entry.workspaceId;
}

function isEnvelope(value: unknown): value is EncryptionEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<EncryptionEnvelope>;
  return (
    candidate.schemaVersion === 1 &&
    candidate.algorithm === 'aes-256-gcm' &&
    typeof candidate.iv === 'string' &&
    typeof candidate.authTag === 'string' &&
    typeof candidate.ciphertext === 'string'
  );
}

function isCatalogEntry(value: unknown): value is SourceCatalogEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const candidate = value as Partial<SourceCatalogEntry>;
  return (
    candidate.schemaVersion === 1 &&
    (candidate.recordType === 'source' || candidate.recordType === 'tombstone')
  );
}

function normalizedStoredReceipt(
  value: unknown,
  sourceRevision: number,
  sourceChannelId: string,
): StoredDiscordReceipt | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('save.receipt must be an object');
  }
  const candidate = value as Partial<StoredDiscordReceipt>;
  const channelId = requireString(candidate.channelId as string, 'save.receipt.channelId');
  const messageId = requireString(candidate.messageId as string, 'save.receipt.messageId');
  if (!Number.isSafeInteger(candidate.sourceRevision) || candidate.sourceRevision! < 1) {
    throw new Error('save.receipt.sourceRevision must be a positive integer');
  }
  if (candidate.sourceRevision !== sourceRevision) {
    throw new Error('save.receipt.sourceRevision must match its source revision');
  }
  if (channelId !== sourceChannelId) {
    throw new Error('save.receipt.channelId must match its source channel');
  }
  return { channelId, messageId, sourceRevision: candidate.sourceRevision };
}

function normalizedCatalogEntry(value: unknown): SourceCatalogEntry {
  if (!isCatalogEntry(value)) throw new Error('unsupported record schema');
  if (value.recordType === 'tombstone') return value;
  if (!Object.prototype.hasOwnProperty.call(value.save, 'receipt')) return value;
  const receipt = normalizedStoredReceipt(
    value.save.receipt,
    value.source.sourceRevision,
    value.source.discord.channelId,
  );
  const normalized: SourceCatalogRecord = {
    ...value,
    save: { ...value.save },
  };
  if (receipt) normalized.save.receipt = receipt;
  else delete normalized.save.receipt;
  return normalized;
}

function encodeCursor(sourceId: string): string {
  return Buffer.from(sourceId, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): string {
  try {
    const sourceId = Buffer.from(cursor, 'base64url').toString('utf8');
    if (encodeCursor(sourceId) !== cursor) throw new Error('non-canonical cursor');
    return sourceId;
  } catch {
    throw new Error('Invalid source catalog cursor');
  }
}

export class EncryptedSourceCatalog {
  readonly directory: string;
  private readonly recordsDirectory: string;
  private readonly lockDirectory: string;
  private readonly key: Buffer;
  private readonly now: () => Date;

  constructor(options: SourceCatalogOptions) {
    this.directory = path.resolve(requireString(options.directory, 'directory'));
    this.recordsDirectory = path.join(this.directory, 'records');
    this.lockDirectory = path.join(this.directory, 'catalog.lock');
    this.key = decodeEncryptionKey(options.encryptionKey);
    this.now = options.now ?? (() => new Date());
  }

  async captureDiscordMessage(input: CaptureDiscordMessageInput): Promise<CaptureDiscordMessageResult> {
    const normalized = normalizeCapture(input);
    await this.prepare();
    return withFileLock(this.lockDirectory, async () => {
      const sourceId = this.sourceIdForMessage(normalized.messageId);
      const existing = await this.readEntry(sourceId);
      if (existing?.recordType === 'tombstone') return { outcome: 'unchanged', entry: existing };
      if (existing && recordFingerprint(existing) === contentFingerprint(normalized)) {
        return { outcome: 'unchanged', entry: existing };
      }

      const now = this.now().toISOString();
      const capturedAt = existing?.save.capturedAt ?? now;
      const sourceRevision = (existing?.source.sourceRevision ?? 0) + 1;
      const record: SourceCatalogRecord = {
        schemaVersion: 1,
        recordType: 'source',
        source: {
          schemaVersion: 1,
          id: sourceId,
          kind: 'discord_message',
          captureMode: 'discord_inbox',
          sourceRevision,
          status: existing ? 'edited' : normalized.messageEditedAt ? 'edited' : 'active',
          workspaceId: normalized.workspaceId,
          discord: {
            guildId: normalized.guildId,
            channelId: normalized.channelId,
            messageId: normalized.messageId,
          },
          author: normalized.author,
          text: normalized.text,
          urls: normalized.urls.map((url) => ({ url })),
          attachments: normalized.attachments,
          messageCreatedAt: normalized.messageCreatedAt,
          messageEditedAt: normalized.messageEditedAt,
          updatedAt: now,
        },
        save: {
          schemaVersion: 1,
          id: this.saveIdForMessage(normalized.messageId),
          sourceId,
          workspaceId: normalized.workspaceId,
          capturedAt,
          processingStatus: 'queued',
          reviewStatus: 'not_generated',
        },
      };
      const durableRecord = durableJsonValue(record);
      await this.writeEntry(durableRecord);
      return { outcome: existing ? 'revised' : 'created', entry: durableRecord };
    });
  }

  async get(sourceId: string): Promise<SourceCatalogEntry | undefined> {
    this.assertSourceId(sourceId);
    await this.prepare();
    return this.readEntry(sourceId);
  }

  async getByDiscordMessage(identity: DiscordMessageIdentity): Promise<SourceCatalogEntry | undefined> {
    const normalized = this.normalizeIdentity(identity);
    const entry = await this.get(this.sourceIdForMessage(normalized.messageId));
    if (!entry) return undefined;
    const stored = entry.recordType === 'source' ? entry.source.discord : entry.discord;
    return stored.guildId === normalized.guildId && stored.channelId === normalized.channelId
      ? entry
      : undefined;
  }

  async list(options: SourceCatalogListOptions = {}): Promise<SourceCatalogPage> {
    await this.prepare();
    return this.listMatching(options, () => true);
  }

  async listRecoverable(options: SourceCatalogListOptions = {}): Promise<SourceCatalogPage> {
    await this.prepare();
    return this.listMatching(
      options,
      (entry) =>
        entry.recordType === 'source' &&
        (entry.source.status === 'active' || entry.source.status === 'edited') &&
        RECOVERABLE_PROCESSING_STATUSES.has(entry.save.processingStatus),
    );
  }

  async update(
    sourceId: string,
    patch: SourceCatalogUpdate,
    options: SourceCatalogUpdateOptions = {},
  ): Promise<SourceCatalogRecord> {
    this.assertSourceId(sourceId);
    if (
      options.expectedSourceRevision !== undefined &&
      (!Number.isSafeInteger(options.expectedSourceRevision) || options.expectedSourceRevision < 1)
    ) {
      throw new Error('expectedSourceRevision must be a positive integer');
    }
    if (patch.sourceStatus !== undefined && !LIVE_SOURCE_STATUSES.has(patch.sourceStatus)) {
      throw new Error('Invalid source status');
    }
    if (
      patch.processingStatus !== undefined &&
      !LIVE_PROCESSING_STATUSES.has(patch.processingStatus)
    ) {
      throw new Error('Invalid processing status');
    }
    if (patch.reviewStatus !== undefined && !REVIEW_STATUSES.has(patch.reviewStatus)) {
      throw new Error('Invalid review status');
    }
    if (
      patch.sourceStatus === undefined &&
      patch.processingStatus === undefined &&
      patch.reviewStatus === undefined &&
      !Object.prototype.hasOwnProperty.call(patch, 'analysis') &&
      !Object.prototype.hasOwnProperty.call(patch, 'receipt')
    ) {
      throw new Error('Source catalog update must change at least one field');
    }
    await this.prepare();
    return withFileLock(this.lockDirectory, async () => {
      const current = await this.readEntry(sourceId);
      if (!current) throw new Error(`Source catalog entry not found: ${sourceId}`);
      if (current.recordType === 'tombstone') {
        throw new Error(`Discarded source catalog entry cannot be updated: ${sourceId}`);
      }
      if (
        options.expectedSourceRevision !== undefined &&
        current.source.sourceRevision !== options.expectedSourceRevision
      ) {
        throw new SourceRevisionConflictError(
          sourceId,
          options.expectedSourceRevision,
          current.source.sourceRevision,
        );
      }
      const next: SourceCatalogRecord = {
        ...current,
        source: {
          ...current.source,
          status: patch.sourceStatus ?? current.source.status,
          updatedAt: this.now().toISOString(),
        },
        save: {
          ...current.save,
          processingStatus: patch.processingStatus ?? current.save.processingStatus,
          reviewStatus: patch.reviewStatus ?? current.save.reviewStatus,
        },
      };
      if (Object.prototype.hasOwnProperty.call(patch, 'analysis')) {
        if (patch.analysis === null || patch.analysis === undefined) delete next.analysis;
        else next.analysis = normalizedAnalysis(patch.analysis);
      }
      if (Object.prototype.hasOwnProperty.call(patch, 'receipt')) {
        if (patch.receipt === null || patch.receipt === undefined) {
          delete next.save.receipt;
        } else {
          next.save.receipt = normalizedStoredReceipt(
            patch.receipt,
            current.source.sourceRevision,
            current.source.discord.channelId,
          );
        }
      }
      const durableRecord = durableJsonValue(next);
      await this.writeEntry(durableRecord);
      return durableRecord;
    });
  }

  async discard(sourceId: string, reason?: SourceDiscardReason): Promise<SourceCatalogTombstone> {
    this.assertSourceId(sourceId);
    await this.prepare();
    return withFileLock(this.lockDirectory, async () => {
      const current = await this.readEntry(sourceId);
      if (!current) throw new Error(`Source catalog entry not found: ${sourceId}`);
      return this.discardUnlocked(current, this.now(), reason);
    });
  }

  async discardByDiscordMessage(
    identity: DiscordMessageIdentity,
    reason?: SourceDiscardReason,
  ): Promise<SourceCatalogTombstone | undefined> {
    const normalized = this.normalizeIdentity(identity);
    await this.prepare();
    return withFileLock(this.lockDirectory, async () => {
      const entry = await this.readEntry(this.sourceIdForMessage(normalized.messageId));
      if (!entry) return undefined;
      const stored = entry.recordType === 'source' ? entry.source.discord : entry.discord;
      if (stored.guildId !== normalized.guildId || stored.channelId !== normalized.channelId) {
        return undefined;
      }
      return this.discardUnlocked(entry, this.now(), reason);
    });
  }

  async purgeExpired(retentionDays: number, now = this.now()): Promise<number> {
    if (!Number.isFinite(retentionDays) || retentionDays < 0) {
      throw new Error('Source catalog retentionDays must be non-negative');
    }
    if (!Number.isFinite(now.getTime())) throw new Error('Source catalog purge time is invalid');
    const cutoff = now.getTime() - retentionDays * DAY_MS;
    await this.prepare();
    return withFileLock(this.lockDirectory, async () => {
      let discarded = 0;
      for (const entry of await this.readAllEntries()) {
        if (entry.recordType === 'tombstone') continue;
        if (Date.parse(entry.save.capturedAt) > cutoff) continue;
        await this.discardUnlocked(entry, now, 'retention_expired');
        discarded += 1;
      }
      return discarded;
    });
  }

  private async prepare(): Promise<void> {
    await ensurePrivateDirectory(this.directory);
    await ensurePrivateDirectory(this.recordsDirectory);
  }

  private normalizeIdentity(identity: DiscordMessageIdentity): DiscordMessageIdentity {
    return {
      guildId: requireString(identity.guildId, 'guildId'),
      channelId: requireString(identity.channelId, 'channelId'),
      messageId: requireString(identity.messageId, 'messageId'),
    };
  }

  private keyedId(kind: 'source' | 'save', messageId: string): string {
    const digest = createHmac('sha256', this.key)
      .update(`discord-${kind}\0${messageId}`, 'utf8')
      .digest('hex');
    return `${kind}_${digest}`;
  }

  private sourceIdForMessage(messageId: string): string {
    return this.keyedId('source', messageId);
  }

  private saveIdForMessage(messageId: string): string {
    return this.keyedId('save', messageId);
  }

  private assertSourceId(sourceId: string): void {
    if (!/^source_[a-f0-9]{64}$/.test(sourceId)) throw new Error('Invalid source catalog ID');
  }

  private recordFile(sourceId: string): string {
    this.assertSourceId(sourceId);
    return path.join(this.recordsDirectory, `${sourceId}.json`);
  }

  private encrypt(entry: SourceCatalogEntry): EncryptionEnvelope {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(ENVELOPE_AAD);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(entry), 'utf8'),
      cipher.final(),
    ]);
    return {
      schemaVersion: 1,
      algorithm: 'aes-256-gcm',
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  private decrypt(envelope: EncryptionEnvelope): SourceCatalogEntry {
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key,
        Buffer.from(envelope.iv, 'base64'),
      );
      decipher.setAAD(ENVELOPE_AAD);
      decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      return normalizedCatalogEntry(JSON.parse(plaintext));
    } catch {
      throw new Error('Unable to decrypt source catalog record');
    }
  }

  private async readEntry(sourceId: string): Promise<SourceCatalogEntry | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.recordFile(sourceId), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error('Invalid source catalog encryption envelope');
    }
    if (!isEnvelope(value)) throw new Error('Invalid source catalog encryption envelope');
    const entry = this.decrypt(value);
    if (entrySourceId(entry) !== sourceId) {
      throw new Error('Source catalog record identity does not match its file');
    }
    return entry;
  }

  private async writeEntry(entry: SourceCatalogEntry): Promise<void> {
    const file = this.recordFile(entrySourceId(entry));
    await atomicWriteJson(file, this.encrypt(entry));
    await ensurePrivateFile(file);
  }

  private async readAllEntries(): Promise<SourceCatalogEntry[]> {
    const files = (await readdir(this.recordsDirectory))
      .filter((file) => /^source_[a-f0-9]{64}\.json$/.test(file))
      .sort();
    return Promise.all(
      files.map(async (file) => {
        const sourceId = file.slice(0, -'.json'.length);
        const entry = await this.readEntry(sourceId);
        if (!entry) throw new Error(`Source catalog record disappeared during read: ${sourceId}`);
        return entry;
      }),
    );
  }

  private async listMatching(
    options: SourceCatalogListOptions,
    predicate: (entry: SourceCatalogEntry) => boolean,
  ): Promise<SourceCatalogPage> {
    const limit = options.limit ?? 25;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error('Source catalog list limit must be between 1 and 100');
    }
    const workspaceId =
      options.workspaceId === undefined
        ? undefined
        : requireString(options.workspaceId, 'workspaceId');
    const entries = (await this.readAllEntries())
      .filter((entry) => workspaceId === undefined || entryWorkspaceId(entry) === workspaceId)
      .filter(predicate)
      .sort(
        (left, right) =>
          Date.parse(entryCapturedAt(right)) - Date.parse(entryCapturedAt(left)) ||
          entrySourceId(right).localeCompare(entrySourceId(left)),
      );
    let start = 0;
    if (options.cursor !== undefined) {
      const sourceId = decodeCursor(options.cursor);
      const position = entries.findIndex((entry) => entrySourceId(entry) === sourceId);
      if (position < 0) throw new Error('Invalid or expired source catalog cursor');
      start = position + 1;
    }
    const items = entries.slice(start, start + limit);
    const hasMore = start + items.length < entries.length;
    return {
      items,
      nextCursor: hasMore && items.length > 0 ? encodeCursor(entrySourceId(items.at(-1)!)) : undefined,
    };
  }

  private async discardUnlocked(
    entry: SourceCatalogEntry,
    now: Date,
    reason?: SourceDiscardReason,
  ): Promise<SourceCatalogTombstone> {
    if (entry.recordType === 'tombstone') return entry;
    if (reason !== undefined && !DISCARD_REASONS.has(reason)) {
      throw new Error('Invalid source discard reason');
    }
    const tombstone: SourceCatalogTombstone = {
      schemaVersion: 1,
      recordType: 'tombstone',
      sourceId: entry.source.id,
      saveId: entry.save.id,
      workspaceId: entry.source.workspaceId,
      discord: entry.source.discord,
      sourceRevision: entry.source.sourceRevision,
      capturedAt: entry.save.capturedAt,
      discardedAt: now.toISOString(),
      discardReason: reason,
      sourceStatus: 'discarded',
      processingStatus: 'discarded',
      reviewStatus: entry.save.reviewStatus,
    };
    const durableTombstone = durableJsonValue(tombstone);
    await this.writeEntry(durableTombstone);
    return durableTombstone;
  }
}
