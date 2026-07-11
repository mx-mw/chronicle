# Chronicle V1 acceptance audit - 2026-07-11

## Verdict

Chronicle's storage, review, indexing, recall, task, and recovery foundations
work end to end. The prior local runtime was not a working Discord deployment:
there was no bot process, token, allowlist, source catalog, or captured session.

This audit found and repaired multiple real correctness and frontend defects.
Chronicle is suitable for an isolated pilot after a live Discord acceptance
run. It is not yet certified as an unattended shared server.

## Tested baseline

- Baseline commit: `d9675e048a23b477d8a3c8348e555bf20835fd5a`
- Release gate after repairs: 213 tests, strict TypeScript, production build,
  compiled web smoke test, and zero npm audit vulnerabilities
- All acceptance state used isolated temporary workspaces; no personal Chronicle
  data was changed

## Confirmed working

- Text, one-page PDF, and real local audio ingestion
- Parakeet transcription with temporary artifact cleanup
- Preview without persistence and raw-source persistence before model failure
- Review list, detail, editing, revision conflicts, approval, rejection, and
  idempotent repeated approval
- Approved Markdown records/topics, automatic index refresh, forced and
  incremental rebuilds, keyword-only degradation, vector search, cited recall,
  and workspace isolation
- Direct and meeting-sourced tasks, persistence across processes, optimistic
  concurrency, close/reopen, and filters
- Digest and maintenance report writing
- Interrupted session recovery, private file modes, retention, opt-out, discard,
  and processing queue fencing
- Encrypted Discord Inbox capture, edit/delete behavior, retry/restart recovery,
  revision-bound receipt updates, and legacy encrypted-record compatibility
- Browser Capture, Review, Tasks, Records, Topics, Ask/Find, Trust, refresh, and
  restart persistence on desktop and mobile

## Defects repaired

1. Existing topic context could replace `Project Juniper / 4303` with an
   unrelated approved `Project Atlas / 4242` topic and persist false knowledge.
   Grounding now rejects catalog-injected entities, changed identifiers, and
   unsupported known-topic reuse.
2. Maintenance reported valid `[[transcripts/...]]` provenance links as broken,
   while a same-named topic could hide a genuinely broken transcript link.
3. Review editing replaced topic titles/descriptions with their slug. Stable
   topic references now also prevent reordered same-name facts from being filed
   under the wrong topic, and an escaped line codec preserves delimiters and
   newlines without corrupting topic or fact text.
4. Quoted frontmatter appeared literally in the Library.
5. Generated source blockquotes and internal fact markers rendered as raw text.
6. The five-item mobile navigation used four columns, wrapped, and obscured
   content.
7. Home exposed raw Obsidian transcript citations.
8. Unknown meeting durations rendered as `~? min`.
9. Local recall omitted a deterministic temperature and could alternate between
   an answer and abstention for the same evidence.
10. Discord receipts falsely claimed `local only` with remote processing.
11. Retry/restart could complete an Inbox item while leaving its Discord receipt
    permanently stale. A concurrent edit during receipt binding could also
    enqueue the stale revision; it is now marked superseded and never queued.
12. Discord recall footers listed retrieved files rather than validated
    citations.
13. Discord voice-message duration metadata was dropped.
14. Parakeet was required at bot startup even for recall/Inbox-only operation.
15. A failed private acknowledgement could leave a public recording-start
    notice without a corrective message.
16. Web health could report ready with configured Discord policies but no bot
    token. `doctor --bot` now makes missing token/policies fail readiness.
17. Unspecified remote web binds accepted arbitrary Host headers when no exact
    host allowlist was configured. Web startup and diagnostics now also share
    one IPv4/IPv6 loopback classifier.
18. Invalid review statuses were silently accepted and normal CLI conflicts
    printed internal TypeScript stack traces.

## Remaining limits and gates

- Live Discord Gateway, slash-command propagation, actual UDP/Opus voice,
  channel permissions, partial-message events, and rate limits still require the
  private credentialed acceptance run in `HANDOFF.md`.
- `qwen2.5:3b` transcribes nothing; it is the downstream distillation/recall
  model. It repeatedly omitted explicit decisions/actions and is not a safe
  auto-approval model. Keep review enabled or use a stronger disclosed provider.
- Discord voice messages, files, and provider links such as Reels remain
  metadata/link-only. Media download and transcription are not implemented.
- A dedicated Processing timeline is not implemented in the web app. Processing
  counts and sessions are available through the API and Trust view.
- Raw transcripts are deliberately excluded from search. An identifier is
  searchable only when retained in the approved record/topic.
- External article and YouTube network behavior was covered by focused security
  tests, but not exercised against third-party production services in this
  audit.
- The web process verifies Discord configuration, not a live Gateway heartbeat.
  Production monitoring still needs a bot readiness signal.
- Deployment still needs one supervised bot, one supervised web process,
  persistent encrypted storage, backups, logs, and a tested restart/rollback
  procedure.

## Release decision

- **Local isolated pilot:** go after `doctor --bot` passes and the private live
  Discord run succeeds.
- **Always-on shared V1:** no-go until deployment, live Discord certification,
  and the processing-provider decision are complete.
- **Automatic approval with the documented 3B model:** no-go.
