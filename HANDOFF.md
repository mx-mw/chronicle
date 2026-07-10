# Chronicle v2 handoff

Status date: 2026-07-10

## Decision

Chronicle did not need to be discarded and regenerated as a new framework app.
Its strongest choices were already correct: local processing, speaker-separated
Discord audio, portable Markdown, and a small dependency surface.

The right intervention was a deep seam-level rebuild. The capture runtime,
authorization, durable processing, review boundary, knowledge writes, indexing,
retrieval, web workflow, diagnostics, and release gates have been replaced or
hardened while preserving the original archive and product identity.

## Current product

Chronicle now supports the complete working loop:

```text
capture -> preserve raw source -> extract draft -> review -> approve
        -> update records/topics -> index -> retrieve -> cited answer
```

The web app exposes Capture, Inbox, Records, Topics, Ask/Find, Digest, and Trust.
Discord recording has consent grace, opt-out, discard, recovery, retention, and
guild-scoped recall. CLI workflows cover the same archive without requiring the
web UI.

## What changed

### Trust and runtime

- Auto-record is off by default.
- Record and recall have independent deny-by-default guild, channel, user, and
  role policies.
- The public consent notice must succeed before a grace period and capture.
- Initial and late-participant notices disclose local processing or any
  configured off-machine model boundary before admission.
- Before recording stops, `/record optout` erases a participant's audio;
  `/record discard` cancels a pending, active, or queued capture.
- Stable UUID session manifests preserve recoverable state across restarts.
- A bounded single-worker queue adds retry, stage timeout, cancellation, and
  graceful shutdown behavior.
- Raw audio plus temporary ASR artifacts are retention-swept at startup and
  after processing.
- Forgotten or adversarial captures stop automatically at configured duration,
  aggregate decoded-byte, free-disk-reserve, or segment-count limits; prior
  audio continues through the normal review/filing policy.
- Overlapping captures remain individually addressable through the session IDs
  shown by `/record status` and `/record discard session:<id>`.

### Knowledge integrity

- Committed capture and ingest flows durably write raw source text before model
  inference. No-write previews intentionally do not persist it.
- New model output is a versioned `needs_review` record by default.
- Approval is idempotent and is the only path into approved records and topics.
- Names are Unicode-safe and collision-resistant; frontmatter values are
  YAML-safe; file writes use atomic rename and cross-process locking.
- Source hashes and stable record IDs support duplicate and retry safety.
- Existing topic names are supplied to extraction so the archive does not
  fragment into near-duplicate topics.
- Long sources use section-aware chunks and a deterministic merge rather than
  truncating the tail.
- Source text and retrieved excerpts are treated as untrusted data in prompts.

### Retrieval

- The derived SQLite index is versioned and transactional.
- Workspace, embedding model, vector dimension, schema, and chunker metadata are
  checked before search.
- Keyword retrieval remains usable without an embedding service.
- Vector hits below the evidence floor are excluded.
- Recall validates citations against retrieved sources and returns
  `INSUFFICIENT_EVIDENCE` when it cannot ground an answer.

### Web product

- The old single reading page is now a full review and archive workflow without
  adding a frontend framework.
- The app has explicit loading, empty, partial, error, recovery, dark-mode,
  reduced-motion, keyboard, and mobile states.
- Review mutations use optimistic revision checks.
- Capture uses a short-lived bounded server-side preview cache; raw text is not
  returned to the browser or logged.
- The server validates Host headers, emits security headers, defaults to
  loopback, and requires Bearer or Basic-token auth for remote binding.
- Production builds copy the static assets and run a compiled-server smoke test.

### Operations

- `doctor`, `review`, `digest`, and `maintain` CLIs were added.
- Ingest supports batches, attribution, kinds, workspaces, no-write previews,
  explicit direct approval, and JSON output.
- External commands, HTTP requests, models, source sizes, and media durations
  are bounded.
- Parakeet processes a session batch instead of reloading the model once per
  segment and distinguishes silence from backend failure.
- CI runs the full check on Node 22.13 and Node 24.
- `undici` is a pinned direct dependency for DNS-pinned article fetches;
  `npm audit` is clean.

## Compatibility and data

No destructive migration is required.

- The default workspace still uses `kb/meetings`, `kb/topics`,
  `kb/transcripts`, and `kb/INDEX.md`.
- Existing approved Markdown remains readable and indexable.
- Additional workspaces use `kb/workspaces/<workspace-key>`.
- Review state and the operational ledger live below `kb/.chronicle`.
- `kb/.index.db` is derived. Run `npm run index -- --force` whenever a clean
  rebuild is preferred.
- Session manifests live beside temporary PCM under `sessions/`.

Make a normal filesystem backup of `kb/` before the first live v2 session. The
implementation is backward-compatible, but that backup is the safest rollback
point for any production archive change.

## Start checklist

1. Install Node 22.13+, ffmpeg, Parakeet MLX, Ollama, and optionally yt-dlp.
   Known issue (2026-07-09): the first-run Parakeet model download from
   Hugging Face is flaky when anonymous — the `hf_xet` backend can stall at
   zero bytes/sec, and the plain-HTTPS fallback (`HF_HUB_DISABLE_XET=1`) has
   hit read timeouts near the end of `model.safetensors` with no resumable
   state. Set `HF_TOKEN` (free account) plus `HF_HUB_DISABLE_XET=1`, budget
   10–15 minutes, and confirm the cache directory is still growing before
   concluding a stall:
   `du -sh ~/.cache/huggingface/hub/models--mlx-community--parakeet-tdt-0.6b-v3`
2. Run `npm ci`.
3. Ensure `.env` is owner-only (`chmod 600 .env`), then compare it with
   `.env.example`; do not assume an old config is authorized. Complete
   allowlists are now required. Set `WORKSPACE_ID` and
   `WEB_WORKSPACE_ID` to the Discord guild ID so CLI review and the web Inbox
   open the workspace where Discord writes its drafts.
4. Keep `AUTO_RECORD=false` for the first validation call.
5. Run `npm run index -- --force` for the existing approved archive.
6. Run `npm run doctor` and resolve every failure.
7. Start `npm run web` and inspect Inbox and Trust. Confirm the Inbox is using
   the Discord guild workspace before the live test.
8. Start `npm run dev` and perform the private Discord smoke test below.

## Live smoke test still required

The repository test suite does not send Discord messages or capture external
audio. In one private allowlisted channel:

1. Run `/record start` and confirm the notice is visible before the bot joins.
2. Before recording stops, test `/record optout` once and confirm that speaker
   is absent from capture. After stop, use the authorized whole-capture
   `/record discard` command if queued material must be removed.
3. Have another participant join after recording is active. Confirm their audio
   is suppressed until their personal notice and grace period complete.
4. Record a short two-speaker exchange, then run `/record stop`.
5. Restart once after stop to confirm manifest recovery does not duplicate the
   draft.
6. Open Inbox, compare the source transcript and extraction, edit one field,
   approve, and confirm the record appears in Records and search.
7. Ask one supported and one unsupported `/recall` question. Confirm the first
   cites evidence and the second abstains.
8. Test `/record discard` on a second short capture and confirm PCM is erased.

This test needs explicit human consent and a real Discord server, so it has not
been automated or performed during the code audit.

## Recommended next enrichments

1. Add an operator-facing raw-source lifecycle: per-record archive/delete,
   configurable raw-text retention, and a dry-run retention report. Audio has a
   sweeper today; raw transcripts deliberately do not.
2. Add a web workspace switcher for teams using more than one Discord guild.
   The current browser workspace is explicit and safe, but configured at
   startup rather than switched in the interface.
3. Add a transcript timeline with speaker correction and optional retained-audio
   playback inside Inbox. Keep it review-only and preserve every edit as a
   revision.
4. Add a small retrieval evaluation set: known-answer questions, expected
   citations, and abstention cases. Run it when changing models, chunking, or
   relevance thresholds.
5. Add opt-in action export only after review (for example, tasks or calendar),
   with a visible confirmation queue and idempotency keys. Chronicle should not
   turn extracted model output into external actions automatically.
6. If Chronicle moves beyond one trusted Mac, add at-rest encryption and OS
   keychain-backed secrets before expanding remote access.

## Known limitations

- If `/record discard` arrives after raw text has already been persisted into
  the review inbox, processing is cancelled and PCM is erased, but that durable
  text is retained indefinitely unless an operator explicitly removes or
  archives it. Chronicle does not currently have an automatic raw-text
  retention sweeper, and the bot reports this boundary rather than claiming
  deletion that did not occur.
- Capture preview has been exercised with synthetic UI data, not a live model
  and every extractor combination.
- Node 22 prints an experimental warning for the built-in SQLite module. The
  tested API is available without a runtime flag from Node 22.13, and CI covers Node 22.13 and Node 24.
- The project has no declared open-source license. Add one only after Ethan and
  Max choose the intended ownership and distribution terms.

## Verification completed

- Strict TypeScript typecheck
- Full Node test suite, including web security and trust workflow tests
- Production build and static-asset copy
- Compiled web server smoke test
- Desktop and mobile screenshot review in light and dark modes
- Bearer, Basic, unauthenticated, and malformed-Host web checks
- `git diff --check`
- `npm audit --audit-level=moderate` with zero vulnerabilities

Run the complete local gate with:

```sh
npm run check
```

See `README.md` for operator documentation, `ARCHITECTURE.md` for persistence and
state contracts, and `DESIGN.md` for the interface contract.
