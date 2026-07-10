# Chronicle

Chronicle is a local-first working archive for a small trusted team. It captures
Discord meetings and external sources, extracts structured knowledge into a
review inbox, and promotes only approved material into a portable Markdown
knowledge base. Recall answers cite retrieved evidence and abstain when the
archive cannot support an answer.

The current product is designed for Ethan Wu and Max Morrow, but workspaces and
authorization rules keep each Discord server's memory isolated.

## Trust contract

Chronicle's defaults are intentionally conservative:

- Recording is off until `AUTO_RECORD=true` or an authorized person starts it.
- Discord recording and recall both use explicit, deny-by-default allowlists.
- A public notice must succeed, followed by a consent grace period, before any
  audio packet is captured. It states whether AI processing stays local or
  uses a configured off-machine model service.
- Before recording stops, participants can run `/record optout`; authorized
  operators can discard an active or queued capture.
- Committed captures and ingests persist raw text before model inference, so a
  model failure does not erase the source. Previews intentionally persist
  nothing.
- Model output enters `needs_review`; it is not searchable until approved.
  If an operator explicitly sets `REQUIRE_REVIEW=false`, the participant notice
  instead discloses that the result will be filed without human review.
- The web app binds to loopback by default and refuses a remote bind without an
  authentication token.
- Embeddings and local model calls refuse non-loopback endpoints by default.
- Markdown is the source of truth. SQLite indexes and operational state remain
  inspectable, recoverable, or rebuildable.

## System flow

```text
Discord audio / file / URL
             |
             v
      durable raw capture
             |
             v
 transcription + extraction
             |
             v
       needs_review draft  <--- edit / reject
             |
          approve
             |
             v
 approved record + topics  ---> hybrid search ---> cited recall
             |
             v
      portable Markdown
```

Discord provides a separate Opus stream for each speaker, so attribution does
not depend on diarization. Parakeet MLX transcribes locally. Distillation can use
a local OpenAI-compatible server or, only when selected explicitly, Anthropic.

## Product surfaces

- **Inbox:** edit, approve, or reject extracted drafts with source context and
  revision protection.
- **Capture:** preview a URL or local source, then stage it for review. A preview
  is short-lived and does not write approved memory.
- **Records and Topics:** read approved Markdown through the archive interface.
- **Ask and Find:** synthesize a cited answer, or inspect hybrid keyword/vector
  matches directly.
- **Digest:** review the last week of decisions, actions, questions, and pending
  drafts.
- **Trust:** inspect policy, model, index, and archive readiness.
- **Discord:** consent-aware recording plus guild-scoped recall.
- **CLI:** batch ingest, review, retrieval, indexing, diagnostics, digest, and
  archive maintenance.

## Requirements

- Node.js 22.12 or newer
- ffmpeg and ffprobe
- Parakeet MLX for meeting audio
- A local OpenAI-compatible embedding endpoint such as Ollama for semantic
  search and a fully green readiness check. Anthropic can replace the local
  distillation/recall model, but embeddings remain local.
- yt-dlp only when ingesting YouTube URLs

Recommended macOS setup:

```sh
brew install ffmpeg ollama yt-dlp
uv tool install parakeet-mlx --with "mlx==0.31.2"
npm ci
```

The MLX pin avoids a Metal kernel failure observed on M5 hardware with MLX
0.32.0. Re-test the latest MLX release before removing it. On a stalled first
model download, run Parakeet once with `HF_HUB_DISABLE_XET=1`.

## Quick start

1. Create a Discord application at
   <https://discord.com/developers/applications>. Invite it with the `bot` and
   `applications.commands` scopes and the View Channels, Send Messages, and
   Connect permissions. No privileged gateway intent is required.

2. Create the local configuration:

   ```sh
   cp .env.example .env
   chmod 600 .env
   ```

3. Set `DISCORD_TOKEN`, then configure complete allowlists. Authorization needs
   an allowed guild, an allowed channel, and either an allowed user or role.
   Empty lists deny access. `*` is an explicit wildcard.

   ```dotenv
   RECORD_GUILD_IDS=123
   RECORD_CHANNEL_IDS=456
   RECORD_USER_IDS=789

   RECALL_GUILD_IDS=123
   RECALL_CHANNEL_IDS=456
   RECALL_USER_IDS=789

   # Discord stores this server's captures under its guild ID. Keep the web
   # review surface and CLI default pointed at that same workspace.
   WORKSPACE_ID=123
   WEB_WORKSPACE_ID=123
   ```

   `GUILD_ID` only controls where slash commands are registered quickly. It does
   not grant authorization.

4. Start Ollama in its own terminal (or as a system service):

   ```sh
   ollama serve
   ```

   In another terminal, install the models:

   ```sh
   ollama pull qwen2.5:3b
   ollama pull nomic-embed-text
   ```

   If Anthropic handles distillation and recall, only the embedding model is
   required locally. Without an embedding endpoint, keyword-only recall still
   works, but semantic search is degraded and `doctor` will report the missing
   capability.

5. Build the derived index, then check readiness before recording anything:

   ```sh
   npm run index
   npm run doctor
   npm run doctor -- --offline
   ```

6. Start the web app and Discord bot in separate terminals:

   ```sh
   npm run web
   npm run dev
   ```

   Open <http://127.0.0.1:4321>. Production commands are:

   ```sh
   npm run build
   npm run start:web
   npm start
   ```

`AUTO_RECORD=false` is the default. Leave it off while validating a server and
use `/record start` manually. When auto-recording is enabled, the same complete
record allowlist still applies.

## Recording and review

| Discord command | Result |
| --- | --- |
| `/record start` | Announces the grace period, then records if notice succeeds |
| `/record stop` | Stops capture and queues durable processing |
| `/record status [page:<n>]` | Shows active and newest-first, paginated discardable session IDs |
| `/record optout` | Before stop, excludes and erases the caller's captured audio |
| `/record discard [session:<id>]` | Cancels one capture and erases raw audio, preserving the audit event |
| `/recall query:<text>` | Answers from approved memory in the current guild workspace |

Processing survives a restart through session manifests and a bounded retry
queue. Raw audio and session-local ASR artifacts are purged according to
`RAW_AUDIO_RETENTION_HOURS`; the default is 72 hours. Forgotten calls stop
automatically after 180 minutes, 8 GiB of aggregate decoded PCM, or before they
would consume the final 5 GiB of free disk. These fail-safe values are
configurable, and a separate 5,000-segment ceiling bounds inode and manifest
growth from very short speaking bursts. Audio captured before a safety stop is
preserved and enters the normal processing policy. Anyone joining an
already-active call remains suppressed until their own visible notice and grace
period complete. A stopped session produces a review draft by default. If
captures overlap, `/record status page:<n>` exposes every nonterminal session ID
and `/record discard session:<id>` selects the intended one instead of guessing.

Review through the web Inbox or the CLI:

```sh
npm run review -- list --workspace <guild-id>
npm run review -- show <draft-id> --workspace <guild-id>
npm run review -- approve <draft-id> --revision <n> --workspace <guild-id>
npm run review -- reject <draft-id> --revision <n> --reason "duplicate" --workspace <guild-id>
```

When `WORKSPACE_ID` already equals the Discord guild ID, those `--workspace`
flags can be omitted. The browser uses `WEB_WORKSPACE_ID`; it must match the
guild ID to show Discord drafts in Inbox.

An approval writes one record, updates its topic logs, rebuilds the Markdown
map, and refreshes the derived search index. Repeating an approval is
idempotent. Revision checks prevent one reviewer from overwriting another. If
index refresh fails, Chronicle marks the index stale instead of reporting false
readiness; the next search or `npm run index` repairs it.

## Ingest other sources

Chronicle supports local audio/video, PDFs, text files, web articles, and
single-video YouTube URLs. YouTube playlists, channels, redirect wrappers, and
other multi-item routes are rejected. Multiple inputs can be processed as one
batch.

```sh
npm run ingest -- meeting.m4a --speaker "Max"
npm run ingest -- brief.pdf https://example.com/article --author "Ethan"
npm run ingest -- notes.txt --kind text --workspace project-a
```

With the default `REQUIRE_REVIEW=true`, every source lands in the review inbox
unless `--approve` is supplied. Preview performs extraction and distillation
without persisting the source or a draft:

```sh
npm run ingest -- notes.txt --preview
npm run ingest -- notes.txt --approve
npm run ingest -- notes.txt --json
```

Source size, duration, command, download, model, and transcription limits are
bounded and configurable. Temporary conversion/download artifacts are removed
unless `KEEP_INGEST_ARTIFACTS=true` is set for debugging.

Browser capture accepts URLs by default. Local filesystem paths are rejected
unless `WEB_INGEST_ROOT` names an explicit allowed directory; realpath checks
also prevent symlink escapes. CLI ingest remains available for deliberate paths
outside that browser boundary.

## Recall and search

Chronicle combines SQLite FTS5 keyword results with local cosine similarity.
Topic notes receive a small ranking preference because they contain the durable
fact, while exact identifiers remain discoverable through keyword search.
Candidates below the vector relevance floor are excluded.

```sh
npm run index
npm run index -- --health
npm run index -- --force

npm run recall -- "what did we decide about storage?"
npm run recall -- "storage" --raw
npm run recall -- "invoice-8472" --keyword-only
npm run recall -- "what changed?" --workspace project-a --json
```

The model receives only retrieved excerpts for recall. Its cited filenames are
validated against that evidence set. If no valid evidence remains, the result is
`INSUFFICIENT_EVIDENCE` instead of a plausible guess.

If the embedding service is unavailable, use `--keyword-only`. The Markdown
archive remains readable even if every derived database is deleted.

## Digest and maintenance

```sh
npm run digest
npm run digest -- --days 14 --workspace project-a --json
npm run digest -- --write

npm run maintain
npm run maintain -- --stale-days 120 --workspace project-a
npm run maintain -- --write
```

The digest rolls up recent records, decisions, actions, questions, and pending
reviews. Maintenance reports broken wiki links, duplicate facts, overlapping
topics, and stale topics. `--write` saves a dated report; it does not silently
rewrite approved knowledge.

## Knowledge base layout

The default workspace remains compatible with Chronicle's original layout.
Additional workspaces live below `workspaces/`.

```text
kb/
  INDEX.md
  meetings/                     approved records
  topics/                       accumulated atomic facts
  transcripts/                  durable raw source text
  workspaces/<workspace-key>/   isolated non-default workspaces
  .chronicle/
    inbox/<workspace-key>/      review records and revisions
    tombstones/                 durable discard fences
    index-state.json            approved/indexed generation health
    ledger.db                   operational audit ledger
    write.lock                  cross-process knowledge lock
    approval-transactions/      crash-recovery journals for approval
  .index.db                     rebuildable search index
```

Approved files use YAML frontmatter, stable UUID-derived names, content hashes,
and Obsidian-style `[[wiki-links]]`. Writes use temporary files plus atomic
rename. `INDEX.md` and `.index.db` are derived; meeting, topic, and transcript
Markdown are the durable content layer.

## Privacy and network behavior

With `LLM_PROVIDER=local`, model and embedding endpoints are loopback-only by
default, and extracted source content stays on the machine during model work.
URL and YouTube ingestion still contact the source host, and first-time model
installation may contact its model registry. Set
`ALLOW_REMOTE_MODEL_ENDPOINTS=true` only when the endpoint and transport are
trusted.

Browser and CLI article capture accept only HTTP(S) targets without embedded
credentials. Every redirect is revalidated, any private or special-purpose DNS
answer rejects the request, and the connection is pinned to the address that
was checked so DNS rebinding cannot redirect the fetch into a local service.

With `LLM_PROVIDER=anthropic`, Chronicle sends the source/transcript needed for
distillation and retrieved excerpts needed for recall to Anthropic. The corpus
and embeddings are not uploaded as a batch. This mode requires an explicit API
key and should be treated as an off-machine data-processing choice.

For remote web access, set a strong `WEB_AUTH_TOKEN`, restrict
`WEB_ALLOWED_HOSTS`, and put Chronicle behind trusted encrypted transport. The
server accepts Bearer auth and HTTP Basic password auth. Loopback access needs
no token.

## Important configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `AUTO_RECORD` | `false` | Enable consent-gated voice-state auto capture |
| `RECORD_*_IDS` | empty | Guild, channel, and identity record allowlists |
| `RECALL_*_IDS` | empty | Independent recall allowlists |
| `REQUIRE_REVIEW` | `true` | Keep model output out of approved memory until review |
| `CONSENT_GRACE_MS` | `10000` | Delay after successful notice and before capture |
| `MAX_RECORDING_MINUTES` | `180` | Automatic stop for a single Discord capture |
| `MAX_SESSION_AUDIO_BYTES` | `8589934592` | Aggregate raw PCM ceiling (8 GiB) |
| `MIN_FREE_DISK_BYTES` | `5368709120` | Free-disk reserve protected during capture (5 GiB) |
| `MAX_SESSION_SEGMENTS` | `5000` | PCM file/inode and manifest-growth ceiling |
| `RAW_AUDIO_RETENTION_HOURS` | `72` | Raw session-artifact retention; `0` purges after processing |
| `WORKSPACE_ID` | `default` | CLI/default knowledge workspace |
| `WEB_WORKSPACE_ID` | `default` | Browser workspace; set to the Discord guild ID to review its drafts |
| `LLM_PROVIDER` | `local` | `local` or explicit `anthropic` processing |
| `EMBED_MODEL` | `nomic-embed-text` | Local search embedding model |
| `PROCESSING_RETRIES` | `2` | Retries after the initial queue attempt |
| `WEB_HOST` / `WEB_PORT` | `127.0.0.1` / `4321` | Web bind address |
| `WEB_AUTH_TOKEN` | empty | Required for a non-loopback bind |
| `WEB_INGEST_ROOT` | empty | Optional realpath boundary for browser local-file capture |

See [.env.example](.env.example) for the complete operational configuration.

## Development and verification

```sh
npm run typecheck
npm test
npm run build
npm run smoke:web
npm run check
npm audit
```

`npm run check` is the local release gate: strict TypeScript, the full unit and
integration suite, production build, and compiled web smoke test. CI runs it on
Node 22.12 and the current Node 24 release.

The remaining environment-specific release gate is a live Discord smoke test in
one private allowlisted channel. It is intentionally not automated because it
sends a consent notice and captures external audio.

Architecture decisions are recorded in [ARCHITECTURE.md](ARCHITECTURE.md), and
the product's visual and interaction contract is in [DESIGN.md](DESIGN.md).
