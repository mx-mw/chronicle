# Chronicle v2 architecture

## Product contract

Chronicle is a local-first capture and recall system for a small trusted team.
Markdown remains the portable human-readable record. SQLite and JSON manifests
hold operational and derived state that can be rebuilt or recovered.

Chronicle distinguishes four layers:

1. Raw capture: audio, transcripts, documents, and fetched source text.
2. Draft extraction: model-generated summaries, facts, actions, and questions.
3. Approved memory: human-reviewed records and topic updates.
4. Search index: a versioned, rebuildable derivative of approved memory.

## State machines

### Recording and processing

```text
announced -> grace_period -> recording -> captured -> transcribing
          -> distilled -> needs_review -> approved -> indexed

Any processing state can become failed and can be retried. A recording can be
discarded before approval. A process restart recovers captured, failed, and
processing manifests without silently promoting them.
```

### Draft review

```text
needs_review -> approved
needs_review -> rejected
needs_review -> needs_review (edited revision)
```

Approval is the only path that mutates approved record and topic Markdown.

## Stable identities

- Every source and recording receives a UUID before expensive processing begins.
- A SHA-256 content hash supports duplicate detection and idempotent retry.
- Human-readable filenames include date and slug, with a short UUID suffix.
- Workspace ID scopes every record, search query, policy, and Discord action.

## Persistence

```text
kb/
  .chronicle/
    inbox/
      <workspace-key>/
        <record-id>.json
    approval-transactions/
    tombstones/
      <workspace-key>/
    index-state.json
    ledger.db
    write.lock
  meetings/
    <date>-<slug>-<id>.md
  topics/
    <topic-slug>.md
  transcripts/
    <date>-<slug>-<id>.md
  workspaces/
    <workspace-key>/
      INDEX.md
      meetings/
      topics/
      transcripts/
  INDEX.md
  .index.db

sessions/
  <session-id>/
    session.json
    <speaker-segment>.pcm
```

The default workspace keeps Chronicle's original `meetings/`, `topics/`, and
`transcripts/` paths. Additional workspaces are isolated below `workspaces/`.
Files are written to a sibling temporary path and renamed atomically. A durable
approval journal plus one cross-process knowledge lock makes multi-file
promotion recoverable and prevents readers from observing an in-flight commit.
SQLite index changes run inside transactions and only update the note hash after
all replacement chunks are present.

## Operational ledger

The SQLite ledger records the durable knowledge lifecycle: raw persistence,
draft staging and edits, approval, and rejection, with record/workspace IDs,
content hashes, revisions, timestamps, and relevant artifact paths. Session
manifests separately hold capture/processing stages, retry state, warnings,
consent timing, audio-retention state, and last errors. The ledger and manifests
never replace approved Markdown content.

## Authorization and consent

- Auto-recording defaults to off.
- Auto-recording can be enabled only for allowlisted guilds and channels.
- Recording commands require an allowed user or role.
- Recall permissions are configured separately from recording permissions.
- Announcement must succeed before the consent grace period and capture.
- The notice discloses whether AI processing is local or uses a configured
  off-machine model service; late participants receive the same boundary
  before their personal grace period.
- The notice also discloses whether human review is required or output will be
  filed automatically under the explicit `REQUIRE_REVIEW=false` mode.
- Participants can opt out; moderators can discard.
- Web binds to loopback by default and refuses a non-loopback bind without an
  authentication token.
- Discord queries are always scoped to their guild workspace.
- Manual control and recall replies are ephemeral; unreviewed extraction is not
  posted into Discord.

## Processing

- One bounded worker owns ASR, distillation, approved-memory, and indexing work.
- Live capture has one-shot duration, aggregate PCM byte, free-disk reserve, and
  segment/inode guards; a safety stop preserves prior audio and enters the same
  durable processing path as a manual stop.
- External commands and model calls have timeouts and actionable failures.
- Parakeet receives a session's WAV files in one batch.
- Discard and retention remove PCM, derived WAV, and session-local Parakeet text
  artifacts while preserving audit manifests and unrelated diagnostics.
- Long sources use section-aware chunking and a merge pass; no tail truncation.
- Committed capture and ingest flows persist raw source before model inference;
  no-write previews intentionally do not persist it.
- Partial transcription warnings follow the draft into review.

## External source boundary

- Article fetches accept only credential-free HTTP(S) URLs.
- Every redirect hop resolves independently and fails closed if any DNS answer
  is private, reserved, documentation-only, link-local, or otherwise special.
- The outbound socket is pinned to one validated address while retaining the
  requested Host and TLS server name, closing the DNS-rebinding gap between
  validation and connection.
- YouTube ingestion accepts only canonical single-video routes and forces
  `yt-dlp` to ignore user configuration and playlist expansion.
- Source bytes, HTTP duration, commands, media duration, and temporary files are
  bounded and cleaned up.

## Retrieval

- Keyword and vector results retain their raw scores.
- Vector candidates below the configured relevance floor are excluded.
- Keyword search remains available when embeddings are unavailable.
- The index records embedding model, vector dimension, schema, and chunker version.
- Metadata changes trigger a safe rebuild.
- Recall returns either an answered result with validated citations or an explicit
  insufficient-evidence result.

## Module direction

```text
adapters/
  discord
  cli
  web

application/
  recording service
  ingest service
  review service
  recall service

domain/
  source record
  processing job
  policy
  evidence

infrastructure/
  manifests
  markdown repository
  SQLite ledger and search index
  Parakeet, Ollama, and Anthropic adapters
```

This is a direction, not a requirement for a large folder migration. Existing
modules can move behind these boundaries incrementally while tests preserve
behavior.

## Release gates

- Node 22.13 or newer
- TypeScript build and production web smoke test
- Unit and integration tests for policy, review, persistence, indexing, and web
- Live Discord smoke test in one private allowlisted channel
- Desktop and mobile screenshot review
- Dependency audit with reviewed overrides, never an automatic major downgrade
