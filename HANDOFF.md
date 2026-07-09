# Handoff

Status as of this session: Chronicle runs fully offline (no cloud API calls) and
the Discord side is fully configured and ready to go. One thing is unverified
— see "Needs verification" below before you trust it in production.

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

## Needs verification

**Parakeet transcription accuracy has not been confirmed — the model still
isn't fully downloaded.** Two failed attempts so far:

1. First attempt hung indefinitely on the default `hf_xet`
   accelerated-transfer backend (connections went idle, zero bytes/sec, no
   error — just stalled at ~64MB).
2. Retried with `HF_HUB_DISABLE_XET=1` (falls back to plain HTTPS). This one
   actually made progress — climbed steadily to ~1GB over about 7 minutes —
   but then hit repeated read timeouts on `model.safetensors` near the end
   (`The read operation timed out`, tried to resume twice, still failed) and
   errored out with no `config.json` written. Whatever partial blob existed
   was cleaned up on failure, so **a fresh attempt starts over from 0**, it
   does not resume from ~1GB.

This looks like flaky/rate-limited network to Hugging Face rather than
anything wrong with Chronicle's code — `parakeet-mlx` itself printed "You
are sending unauthenticated requests to the HF Hub... set HF_TOKEN for
higher rate limits and faster downloads", which may be the actual fix
(anonymous HF downloads are rate-limited and more prone to being cut off).

To finish verifying:
```sh
export PATH="$HOME/.local/bin:$PATH"
export HF_HUB_DISABLE_XET=1
export HF_TOKEN=...   # a free HF account token may fix the mid-download timeouts
parakeet-mlx --help   # trigger nothing; just confirm the binary works
# Then run a real transcription (below) to trigger the model download and
# watch it to completion — it took ~7 min to reach 1GB last time, so budget
# 10-15 min and don't assume a silent multi-minute gap means it's hung;
# check `du -sh ~/.cache/huggingface/hub/models--mlx-community--parakeet-tdt-0.6b-v3`
# growing over 30s before concluding it stalled.
```
Once the model is fully cached, confirm actual transcription quality — a
quick way, since macOS has a TTS voice built in:
```sh
say -o test.aiff "some sentence"; ffmpeg -y -i test.aiff -ar 16000 -ac 1 test.wav
parakeet-mlx test.wav --model mlx-community/parakeet-tdt-0.6b-v3 --output-format txt
cat test.txt   # should roughly match what you said
```
If `hf_xet` hangs again on a fresh machine, set `HF_HUB_DISABLE_XET=1` in
the environment before first run (or `uv tool install parakeet-mlx` env, or
just export it in the shell that runs `npm run dev` / `npm run ingest`).

Also not yet done: a real end-to-end test through Discord itself (`/record
start` → talk → `/record stop`) — everything up to that point has only been
tested by calling `transcribeWav()` / `summarizeMeeting()` directly with
synthetic input, not through the live bot.

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
