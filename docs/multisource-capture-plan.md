# Multi-source capture, processing, and Library plan

Status: proposed implementation plan

Owners: Ethan and Max

Last updated: 2026-07-10

Sharing dependency: all multi-user sharing phases are BLOCKED pending the
discussion captured in the
[federated sharing proposal](federated-sharing-proposal.md).

## Product outcome

Chronicle should make saving useful material nearly frictionless:

- Save a Discord message, thread, link, attachment, or voice message.
- Send Chronicle a public Reel link with a short note explaining why it matters.
- Preserve the item immediately, even when rich extraction is unavailable.
- Process supported text, audio, video, images, and documents asynchronously.
- Review extracted knowledge before it enters Recall.
- Browse saved material and processing state in the Library.
- Later, deliberately expose activity, share an item, or publish it to a
  project after Ethan and Max agree on permissions.

The first useful vertical slice is:

    Send or select an item in Discord
      -> Chronicle acknowledges it immediately as Local only
      -> a durable job processes what is lawfully accessible
      -> the item appears in Library with live state
      -> extracted claims enter Review
      -> approved claims enter Recall

## Product contract

A saved source is not automatically knowledge.

Chronicle must preserve four distinct layers:

1. Source catalog: everything intentionally saved, including partial and failed
   items.
2. Processing artifacts: metadata, attachments, captions, transcripts, OCR,
   thumbnails, warnings, and provider details.
3. Review draft: model-generated claims that a person can correct.
4. Approved memory: reviewed Markdown and topics searchable by Recall.

Library can show all saved items. Recall searches only approved memory.

A failed Reel fetch must still leave the original URL and the user's note in
Library. Chronicle must never imply it watched or understood unavailable media.

## Current Chronicle baseline

Useful existing seams:

- src/sources/index.ts dispatches URL and file inputs into an extracted source.
- src/ingest.ts and the web preview route already implement extract, raw
  persistence, summarization, review staging, and optional approval.
- src/kb.ts provides stable event identities, durable raw capture, review, and
  atomic approval.
- src/jobs.ts provides bounded concurrency, retry, cancellation, and timeouts.
- src/sources/youtube.ts demonstrates bounded single-item media extraction with
  temporary cleanup.
- The frontend already has Home, Review, Library, and Capture surfaces, plus
  processing health counts and a processing API to extend. It does not yet
  have a standalone Processing view.

Material gaps:

- The Discord bot handles voice and slash commands only. It has no message
  capture.
- Sources are text-first and limited to meeting, article, PDF, video, and text.
- Non-voice web ingestion is synchronous and lacks a durable processing
  manifest.
- Generic URL extraction is not a reliable social-media extractor.
- There is no image OCR or vision path, remote attachment router, retained
  thumbnail, or source media representation.
- Records have workspace scope but no owner, visibility, audience, or grant.
- Library currently shows approved records and topics only.
- The current shared bearer token and caller-provided workspace header are not
  a secure identity boundary.

## Canonical data model

Do not collapse the external object and the act of saving it into one record.

### Source

One canonical external object:

- source ID
- provider and source kind
- provider external ID
- canonical URL or Discord permalink
- original author or creator
- title and source timestamp
- content hash
- media types and basic dimensions/duration
- source revision and active, edited, deleted, or unavailable state
- local security realm; a globally stable identity is deferred until sharing

The same Reel or Discord message should normally resolve to one Source inside a
local security realm.

### Save

One person's decision to keep a Source:

- save ID
- source ID
- owner and captured-by identity
- captured time
- personal destination in Phases 1-5
- user-authored note explaining why it matters
- Discord message, channel, thread, and reply provenance
- access scope, Local only in Phases 1-5

Before Phase 6, owner and captured-by fields are provenance asserted by the
local bot or session. They are not secure authorization identities, so the UI
must not promise per-user privacy yet.

In Phases 1-5, source canonicalization and duplicate detection are confined to
the current local security realm. Cross-person coalescing and duplicate notices
are Phase 6 behavior and may use only Sources the requester can already
discover. A future private save must never reveal that another person saved the
same item.

### Artifact

One representation of a Source:

- original message envelope
- downloaded attachment
- accessible caption
- transcript
- OCR text
- visual description
- thumbnail
- extracted article text
- derived summary
- file path, MIME type, bytes, checksum, provider, and timestamps

Every artifact states whether it is original, provider-supplied, user-supplied,
or model-derived.

### Processing job and review state

Durable, restart-safe work state:

    received
      -> resolving
      -> fetching
      -> extracting
      -> transcribing or analyzing
      -> succeeded

Terminal alternatives:

    partial | failed | discarded

Every stage records attempts, warnings, start/update times, provider, and a
retryable flag. Persist the Source and Save before any network or model work.

Knowledge review is a separate state machine:

    not_generated -> needs_review -> approved
                                -> rejected

Processing success means Chronicle produced artifacts or a draft. It never
means the content is approved, searchable by Recall, or authorized for sharing.
Library displays both processing state and review state.

Source availability is a third independent state:

    active -> edited | deleted | unavailable

An edit creates a new Source revision and invalidates derived output until that
revision is processed. Deleted means Chronicle observed a deletion; unavailable
means the provider could not be checked or permissions were lost.

Access is independent again. Phases 1-5 expose only `local_only` within one
trusted Chronicle node. `private`, `activity_visible`, `shared`, and
`project_published` become meaningful only after Phase 6 introduces identities,
authorization, and grants.

### Grant

Reserved for the blocked sharing phase:

- audience
- discover, read, query, and publish capabilities
- scope and exclusions
- manual or automatic mode
- created, expires, revoked timestamps

The persisted contracts can reserve future visibility fields now, but they must
remain unset before real identities and server-side authorization exist.

## Discord interaction model

The first release is explicit capture, not background collection. Terminology
does not establish compliance: Discord prohibits mining or scraping data, and a
message-history endpoint does not itself authorize maintaining a channel
archive. Bounded history and watched-channel behavior therefore remain
policy-blocked.

### Phase-one explicit capture

1. Save to Chronicle message command
   - Right-click or long-press a message.
   - Select Apps, then Save to Chronicle.
   - Discord provides the resolved target message.
   - This is the best MVP because it is explicit, mobile-friendly, and does not
     require reading every conversation.
   - In the MVP, this may save the requester's own message. Saving another
     author's content requires an explicitly noticed and consented allowlisted
     channel with author opt-out and deletion handling.

2. Direct message to Chronicle
   - Send a link, text note, image, file, or Discord voice message.
   - The DM sender is the default owner.

3. Save slash command
   - /save accepts a URL or selected source plus an optional Why this matters
     note.

The saver pressing Save does not by itself establish the original author's
consent for permanent retention or model processing. Phases 1-5 stay
personal-only, but third-party Discord content still requires a consented
channel policy or a source supplied directly by its author.

The bot responds immediately with:

- detected source type
- owner
- Personal destination
- Local only access
- Received or Processing state
- Open, Retry, and Discard actions as appropriate

Update one receipt as processing advances instead of posting repeated messages.

### Selected channel and history ingestion

POLICY BLOCKED pending a documented Discord policy or App Review determination
that Chronicle's exact backfill and watched-channel behavior is necessary for
its stated approved functionality. Technical API access alone is not approval.

If Discord confirms the behavior is permitted, ambient ingestion and backfill
must still meet these constraints:

- Separate message-ingestion guild and channel allowlists from voice recording
  and recall policies.
- Require View Channel and Read Message History.
- Fetch no more than Discord's 100-message page maximum.
- Page with a cursor and stop at an explicit date or record limit.
- Present a preview with channels, date range, message count, attachment count,
  and expected storage before confirmation.
- Store a per-channel cursor and make Discord message ID the idempotency key.
- Enumerate threads explicitly and never infer access to a thread the bot cannot
  view.
- Handle create, update, delete, and bulk-delete events while the bot is online.
- Re-fetch before replacing partially delivered update payloads.
- Invalidate derived output when source content changes or is deleted.
- Keep a content-free tombstone only when needed for audit and deduplication.
- On startup and periodically, re-check saved message IDs inside a bounded
  configured window to reconcile events missed while offline.
- Enable and test the discord.js partial-message and partial-channel paths
  required by update and deletion events.

Discord does not replay every missed Gateway deletion event. Deletion handling
is therefore best effort: Chronicle must react when an event or reconciliation
observes a change, distinguish deleted from temporarily unavailable, and never
claim continuous synchronization.

Do not ship silent, unlimited, full-server, or policy-unapproved history
ingestion.

### Discord platform requirements

The current bot uses Guilds and Guild Voice States only. Message ingestion may
need:

- Guild Messages for create, update, and delete events.
- Direct Messages for bot DMs.
- Message Content for ordinary guild message text, embeds, attachments,
  components, and polls.
- Guild Message Reactions only if a reaction becomes a save trigger.

Message Content is privileged and must be enabled in Discord's Developer
Portal. A message context command is valuable because Discord makes the targeted
message content available even without general Message Content access. Design
the first release around interactions and DMs so it does not request the intent
unless a later approved feature genuinely requires it. Follow Discord's current
review and renewal process if the application reaches its review threshold.

Official references:

- https://docs.discord.com/developers/events/gateway
- https://docs.discord.com/developers/interactions/application-commands
- https://docs.discord.com/developers/resources/message
- https://docs.discord.com/developers/topics/rate-limits
- https://docs.discord.com/developers/gateway/getting-started-with-privileged-intent-review
- https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy
- https://support-dev.discord.com/hc/en-us/articles/8562894815383-Discord-Developer-Terms-of-Service

Chronicle must use bot APIs only. No self-bots, user tokens, browser automation,
or Discord DOM scraping. Discord message content must never be used to train or
fine-tune an AI or machine-learning model without Discord's express permission;
Chronicle's proposed extraction is runtime inference, not training.

Before persisting Discord API data, Chronicle must encrypt it at rest, including
manifests, attachments, derived artifacts, catalogs, and backups. File
permissions alone are insufficient. Chronicle also needs a public, current
privacy policy linked from its app and Developer Portal, an accessible user
request path for data access/export, correction, and deletion, and a
support/reporting path.

## Attachments and format routing

Every captured message can produce zero or more child Sources or Artifacts.

- Plain text -> text extraction.
- Article link -> existing safe URL and Readability path.
- PDF -> PDF parser, with a later OCR fallback for scanned pages.
- Audio or voice message -> bounded download, ffmpeg normalization, Parakeet
  transcription.
- Video -> bounded download, audio transcript, selected frames, optional OCR or
  vision.
- Image -> MIME validation, OCR, optional vision description, retained
  thumbnail.
- YouTube link -> existing single-video caption/audio path.
- Discord thread -> ordered message bundle with authors, timestamps, reply
  graph, and attachments.
- Social link -> provider-specific capability check, then metadata, official
  embed, user-supplied media, or honest link-only fallback.

Remote files enter a private quarantine first. Validate actual MIME type, byte
size, media duration, filename, and checksum. Use argv arrays for external
commands, ignore local downloader configuration, apply timeouts and output
bounds, and delete temporary files.

All remote fetches must reuse or refactor Chronicle's pinned public-address
policy on the initial request and every redirect. Reject embedded credentials,
private, loopback, link-local, and reserved addresses; pin validated DNS results
against rebinding; cap redirect hops; and use strict provider/CDN host rules
where possible. Never hand an attacker-controlled remote URL directly to
yt-dlp, ffmpeg, or another subprocess: fetch it safely into quarantine first.

Signed Discord CDN URLs can expire and can contain sensitive query parameters.
Store a canonical Discord permalink, attachment metadata, and checksum. Do not
persist expiring signed URLs as durable provenance.

## Reel and social-link behavior

There are three distinct capabilities.

### Saved link

Always supported for an explicitly submitted public URL:

- canonical URL
- platform
- submitted by
- saved time
- user-authored note
- Local-only personal destination in Phases 1-5
- Link only status when no lawful extraction path exists

This alone is useful. The sender's explanation often contains the durable
insight.

### Display-only official embed

Instagram oEmbed can render supported public posts and Reels when Chronicle has
the required Meta app access and token. Meta restricts oEmbed material to
front-end display. Do not persist or analyze oEmbed content as knowledge.

Official reference:

- https://developers.facebook.com/docs/instagram-platform/oembed

### Processable media

Chronicle may process a Reel when:

- the user uploads a media file they are allowed to provide
- the user supplies a transcript, screenshots, or notes
- an official provider API returns media the authenticated account owns and
  permits processing

The Instagram media API is not a general arbitrary-public-Reel download API.
Do not bypass login, DRM, provider access controls, or use unofficial download
services as a product dependency.

Official reference:

- https://developers.facebook.com/docs/instagram-platform/reference/instagram-media

When access fails, Library shows Saved link or Partial, preserves the user's
note, and states exactly what was unavailable. It never presents an invented
description or a Processed badge.

## Duplicate behavior

Normalize provider IDs and URLs before processing.

When a matching Source already exists inside the current local security realm:

- Open existing
- Add my note
- Save to another personal collection
- Save separately only when the user explicitly needs a distinct version

Do not silently merge personal annotations. Deduplicate by provider external ID,
canonical URL, content hash, and provenance, not by title. Cross-person
duplicate detection is blocked until Phase 6 and must not expose private
activity.

## Library evolution

Library becomes the source catalog, not only an approved-note browser.

### Navigation and filters

- All
- Meetings
- Discord
- Links
- Reels and video
- Images
- Documents
- Topics

Filters:

- contributor
- personal collection; project or space after Phase 6
- source type
- processing state
- review state
- Local-only access; visibility and project filters after Phase 6

### Library card

Show the actual item:

- source thumbnail or stable type swatch
- title or honest untitled fallback
- source host or Discord channel
- saved by
- saved date
- processing state and separate review state
- Local-only personal destination

Cards must distinguish Saved link, Display only, Processing, Processed,
Partial, Failed, and Source deleted.

### Item detail

Order the detail around the source:

1. Original source, embed, media, or link.
2. The user's Why this matters note.
3. What Chronicle understood.
4. Transcript, OCR, captions, and exact evidence.
5. Topics and related items.
6. Provenance and processing history.
7. Open original, Review, Retry, Archive, and Discard.

Sharing controls remain absent or disabled with a Discuss with Max status until
the permission proposal is agreed.

### Home and Review

- Home adds one compact Processing strip only when work exists.
- Home can show recently saved items separately from recently approved memory.
- Review remains the focused gate for model claims.
- Review shows the original source beside the extraction, source-kind filters,
  and partial-processing warnings.

## Visibility and activity proposal

This section is BLOCKED pending discussion with Max.

Potential states:

- Private: only the owner.
- Activity visible: a teammate may see that something was saved, without
  opening or querying it.
- Shared item: a named person can read the approved item.
- Project published: a durable snapshot belongs to a project space.
- Query eligible: approved evidence may answer permitted questions without
  publishing the source.

These are separate grants. Activity visibility never implies source access.

Titles, thumbnails, topics, and even the existence of an item can leak
information. Ethan and Max must decide whether Activity visible exposes:

- type and time only
- title and source host
- thumbnail
- the user's Why this matters note

Do not implement Max-facing activity, private-item access, project publication,
or cross-person recommendations until identities, authorization, audit, and
revocation are defined.

## Delivery phases

### Phase 0: document and decide

- Keep federated sharing blocked.
- Decide source-media retention before Phase 1 is allowed to ship.
- Decide Discord channel consent, author opt-out, and deletion behavior before
  Phase 2 is allowed to ship.
- Decide and document encryption-at-rest key management, backup handling, and
  deletion semantics before Phase 2 is allowed to ship.
- Publish the Discord-facing privacy policy and accessible correction,
  access/export, deletion, support, and reporting paths before Phase 2 is
  allowed to ship.
- Decide whether the first Reel release is link-only plus user uploads.

Exit: media retention, Discord consent/deletion, encryption key management, and
the public privacy and data-rights paths are explicit go/no-go gates for their
dependent phases. The remaining sharing questions may stay blocked for Phase 6.

### Phase 1: durable capture foundation

- Add Source, Save, Artifact, and durable generic Processing job contracts.
- Store versioned canonical JSON under the configured Chronicle data directory:
  Source manifests and artifacts under `sources/<realm>/<source-id>/`, Save
  manifests under `saves/<realm>/`, and job manifests under `jobs/<realm>/`.
  Keep the approved Markdown knowledge base canonical for Recall.
- Make manifest updates atomic under the existing knowledge/source lock. Keep
  artifact directories private at the filesystem level and record checksums.
- Add encryption at rest for Discord API data and derivatives across canonical
  files, the derived catalog, and backups, with documented key storage,
  rotation, recovery, and revocation. Filesystem permissions are defense in
  depth, not the encryption control.
- Keep plaintext Discord content and derivatives out of Git history, logs, crash
  dumps, and unencrypted temporary files, including approved Markdown derived
  from Discord sources.
- Build a derived, rebuildable SQLite catalog for pagination and filtering; it
  must never become the source of truth.
- Store `sourceId`, `saveId`, `sourceRevision`, and record validity on review
  drafts and approved Markdown. Extend the approval journal so these links and
  approval commit or roll back together; no catalog or processing state implies
  approval.
- Teach indexing and Recall to include only approved records whose validity is
  current. A source edit marks the prior revision stale until the new revision
  is reviewed; an observed deletion retracts it. Retain stale or retracted
  Markdown only for the agreed audit/retention period and keep it out of Recall.
- During garbage collection, derive Source and Artifact reachability by scanning
  canonical Saves, drafts, approved Markdown, and the durable journal under the
  source lock. Never trust a loosely maintained reference count. Delete only
  when a consistent scan finds no retained reference and policy permits it.
- Persist received items before network or model work.
- Add canonical provider IDs and deduplication.
- Add restart recovery, retry, partial, failure, and discard behavior.
- Add the common bounded downloader and private quarantine: stream with byte
  and duration limits, sniff actual MIME type, checksum bytes, and clean up
  rejected or abandoned files.
- Refactor the existing safe-fetch policy into that downloader: validate and
  pin public addresses on every redirect, reject embedded credentials and
  private network targets, cap hops, use provider allowlists where possible,
  and pass only quarantined local files to media subprocesses.
- Add paginated source catalog and processing APIs.
- Add a minimal paginated Library list and item detail showing processing,
  review, and source state.
- Keep destination Personal and access Local only. Treat owner as provenance,
  not an authorization boundary.

Exit: a synthetic source survives a forced restart at every stage without
duplication or false completion, and malicious URL/redirect tests cannot reach
private addresses or media subprocesses.

### Phase 2: explicit Discord save

- Add Save to Chronicle message command.
- Add bot DM capture.
- Add /save with optional note.
- Route text and URLs. Persist Discord attachment envelopes and metadata, and
  fetch bytes only through the Phase 1 quarantine; rich media analysis remains
  in Phase 3.
- Add message-specific allowlists and policy health checks.
- Post or update one processing receipt.
- Preserve message, channel, thread, author, timestamp, reply, and attachment
  provenance.

Exit: an allowed message, file, and URL each create one restart-safe local-only
Library item; disallowed attempts reveal no content. Stored Discord data is
encrypted, and access/export, correction, and deletion requests can be
completed and audited.

### Phase 3: multi-format processors

- Complete remote attachment routing on top of the Phase 1 quarantine.
- Add a streaming, size-limited upload API with quotas, MIME sniffing, durable
  asset storage, abandoned-upload cleanup, and explicit retention. Before real
  authentication exists, accept browser uploads only over loopback; remote and
  mobile upload is blocked until Phase 6.
- Image OCR and thumbnail generation.
- Voice-message and audio transcription.
- Video audio extraction and selected-frame artifacts.
- Scanned-PDF OCR fallback.
- Social link capability detection.
- Link-only and Partial fallback.
- User-uploaded Reel processing.

Exit: every supported format either produces evidence or an honest partial
record without losing the source or note.

### Phase 4: rich source-first Library

- Evolve the minimal Library into the full all-item catalog and filters.
- Show thumbnails, contributor provenance, source, and state; add visibility
  only after Phase 6.
- Build source-rich detail view and processing history.
- Deep-link to Review and Retry.
- Add pagination and mobile verification.

Exit: a user can understand what was saved, what Chronicle processed, what
failed, and what entered approved memory without opening raw files.

### Phase 5: selected history and watched channels

POLICY BLOCKED pending a documented Discord policy or App Review determination.

- Add preview-and-confirm channel or thread import.
- Add bounded cursors and rate-limit handling.
- Add best-effort Gateway update/deletion handling plus bounded startup and
  periodic reconciliation of previously saved message IDs.
- Add retention controls and source invalidation.
- If specifically approved, add an optional designated Chronicle inbox or
  allowlisted-channel live capture with clear notice and author opt-out.

Exit: an allowlisted date-bounded import is idempotent, resumable, reversible,
and honestly reports the limits of deletion reconciliation.

### Phase 6: multi-user sharing

BLOCKED pending the Max discussion.

- Real user identities and authenticated nodes.
- Project membership and server-enforced ACLs.
- Activity-visible permission.
- Direct item share and Publish to project.
- Audit and revocation.
- WOOZY and Max provider connectors.

### Phase 7: federated discovery

BLOCKED pending Phase 6.

- Permission-aware cross-person query.
- Owner-side retrieval and consent requests.
- Opt-in overlap detection.
- No global private embedding index.

## First-release non-goals

- No silent or unlimited Discord server scrape.
- No Discord history backfill or watched channel until its exact behavior is
  confirmed as permitted for Chronicle's stated functionality.
- No ingestion from unallowlisted channels or private threads.
- No Instagram login or DRM bypass.
- No guarantee that arbitrary public Reels can be transcribed.
- No automatic sharing based on model guesses.
- No cloud upload without explicit provider disclosure and consent.
- No teammate query access or shared personal database.
- No native phone share extension yet.
- No arbitrary model-generated SQL.
- No unreviewed summary in Recall.

## Acceptance criteria

- Saving an allowed Discord message creates a durable local-only item
  immediately.
- The same message or URL is idempotent and offers explicit duplicate choices.
- Original Discord IDs, author, timestamp, channel/thread, reply context, and
  attachment provenance are retained.
- Disallowed channels, users, threads, and sources reveal no content.
- Discord API data and derivatives are encrypted at rest, and users can reach a
  public privacy policy plus access/export, correction, deletion, support, and
  reporting paths.
- Every item exposes an independent processing outcome and review state and can
  be retried safely without becoming approved.
- Remote URLs and redirects cannot reach private addresses or bypass quarantine
  into a media subprocess.
- A blocked Reel remains a useful link and note and never claims to have been
  processed.
- Edited or deleted Discord messages invalidate outdated derived output when a
  Gateway event or bounded reconciliation observes the change.
- Every approved record retains its Source revision, and stale or retracted
  revisions are excluded from Recall while retained only under audit policy.
- Unapproved items can be browsed but never answer Recall.
- Library shows contributor provenance, source kind, Personal destination,
  separate source, processing, and review states, Local-only access, evidence,
  and provider provenance.
- Source catalog APIs are paginated and confined to the current local security
  realm.
- No Max-facing activity or content is exposed before the identity and grant
  model is approved.

## Decisions to take to Max

- Should designated Chronicle channels be live-ingested or save-on-demand only?
- Which Discord servers/channels and history ranges are acceptable?
- What should happen when a Discord author edits or deletes a saved message?
- Has Discord confirmed that any proposed backfill or watched-channel behavior
  is permitted for Chronicle's stated functionality?
- Should Chronicle retain source media, thumbnails only, or derived text only?
- Is link-only Reel bookmarking valuable enough for the first release?
- Which cloud vision or media processors, if any, are acceptable?
- Can Max see type/time activity for Ethan's private saves?
- Which metadata is safe before full item sharing?
- Do all collaborations get a shared project space?
- Which system owns shared project tasks?
- What are the default trust and revocation rules?

## Recommended first build

Do not begin with full Discord history or Instagram extraction.

Build one trustworthy vertical slice:

1. Save to Chronicle on one Discord message or DM.
2. Persist Source and Save immediately as Local only.
3. Process text, an attachment, or a submitted URL asynchronously.
4. Show honest live state in the Library.
5. Preserve Partial when a provider blocks extraction.
6. Route extracted claims through Review before Recall.

This slice establishes the contracts required by every later format without
coupling Chronicle to brittle social scraping or unresolved sharing.
