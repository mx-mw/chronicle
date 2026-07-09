# Handoff

Status as of this session: Chronicle runs fully offline (no cloud API calls) and
the Discord side is fully configured and ready to go. The transcription
question left open by the previous session is now resolved — see "Resolved"
below. Discord itself is still untested end-to-end.

## What's done

- **Distillation** switched from the Anthropic API to any local
  OpenAI-compatible server (`src/summarize.ts` calls `POST {LLM_BASE_URL}/chat/completions`).
  Configured against Ollama, model `qwen2.5:3b`.
  - `qwen3:4b` was tried first and rejected: it's a reasoning model and burned
    5,134 tokens of hidden chain-of-thought before writing JSON, taking 159s
    for a 4-line test transcript. `qwen2.5:3b` did the same task in 30s with
    comparable output quality. If you swap models, avoid "thinking" models
    for this step unless you don't mind the latency.
  - Verified end-to-end: real `summarizeMeeting()` call against real Ollama,
    valid structured JSON out.

- **Transcription** switched from whisper.cpp to Parakeet MLX
  (`src/transcribe.ts`, `uv tool install parakeet-mlx`, model
  `mlx-community/parakeet-tdt-0.6b-v3`, runs on Apple Silicon GPU via MLX).
  whisper.cpp's `WHISPER_*` env vars, `scripts/download-model.sh`, and the
  `npm run setup:whisper` script are gone. Old `models/ggml-base.en.bin` may
  still be sitting on disk (gitignored) — safe to delete, it's unused now.

- **Discord**: `.env` has a live `DISCORD_TOKEN` and `GUILD_ID` already
  filled in (not committed — gitignored). Bot is invited via OAuth2 URL
  (scopes `bot` + `applications.commands`; perms View Channels / Send
  Messages / Connect).

## Resolved

**Parakeet transcription accuracy: confirmed good.** Word-perfect on the macOS
`say` test, ~5s for a 10s clip once the model is cached. The `HF_HUB_DISABLE_XET=1`
workaround for the stalled first-run download works and is now in the README.

**But it needed an MLX pin.** On an M5 / macOS 26.1, `mlx==0.32.0` cannot compile
its Metal GPU kernels — every transcription dies with `unsupported
deferred-static-alloca-size` inside `mpp::tensor_ops::__matmul2d` (MLX's new
tensor-core GEMM path). 0.32.0 is the latest release, so there is nothing to
upgrade to; pin backwards instead:

```sh
uv tool install --force parakeet-mlx --with "mlx==0.31.2"
```

Worth re-testing on the next MLX release — this is an upstream bug, not ours.

**A real bug fell out of that.** `parakeet-mlx` catches per-file errors
internally, prints "transcription complete", writes no output file, and still
**exits 0**. `transcribeWav()` only threw on a nonzero exit, so a totally broken
ASR backend was swallowed segment-by-segment and reported to the user as *"No
usable speech was captured"* — blaming them for a toolchain failure while
silently discarding a real meeting. Fixed: the output file's existence is now
the success signal, and `transcribeSession()` throws a `TranscriptionError` when
every attempted segment fails, instead of returning an empty transcript. The
error names the Metal failure and prints the pin command.

**Pipeline verified end-to-end** (audio → Parakeet → Ollama → `kb/`) via
`npm run ingest` on a synthetic meeting: 14.7s total, correct decisions, owned
action items, and open questions extracted. Both the success and failure paths
were tested (the latter with a stub binary that mimics the exit-0-write-nothing
behaviour).

## Still needs verification

A real end-to-end test through Discord itself (`/record start` → talk →
`/record stop`). Everything up to the bot boundary is now exercised, but the
voice-receive path has still only been tested via `npm run ingest`, not a live
call.

## Architecture notes

- `transcribeWav()` in `src/transcribe.ts` shells out to `parakeet-mlx` once
  per audio segment (one Discord utterance = one segment), same pattern
  whisper.cpp used. Each invocation reloads the model, which is wasteful —
  `parakeet-mlx` actually accepts multiple file args in one invocation
  (`parakeet-mlx file1.wav file2.wav ...`), so batching all of a session's
  segments into a single call would avoid N model loads. Not done here to
  keep the whisper→Parakeet swap a straight substitution; worth doing if
  transcription latency turns out to matter in practice.
- `summarizeMeeting()` reads `data.choices[0].message.content` from the
  OpenAI-compat response and deliberately ignores `.reasoning` — that's what
  makes it safe to point at a reasoning model later without code changes,
  just accept the latency cost.

## Config reference (`.env`)

| Var | Purpose |
| --- | --- |
| `DISCORD_TOKEN` / `GUILD_ID` | already filled in |
| `LLM_BASE_URL`, `CHRONICLE_MODEL`, `LLM_API_KEY` | distillation backend |
| `PARAKEET_BIN`, `PARAKEET_MODEL` | transcription backend |
| `KB_DIR`, `SESSIONS_DIR` | output locations |
