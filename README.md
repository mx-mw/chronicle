# Chronicle

A centralised knowledge base that grows itself. Feature one: a Discord bot that
sits in your meetings, records who said what, and distills it into a
memory-palace style repository of small, linked markdown notes.

## How it works

```
/record start ──▶ per-speaker Opus streams ──▶ PCM on disk
/record stop  ──▶ ffmpeg ──▶ Parakeet MLX (local) ──▶ speaker-attributed transcript
                                  │
                                  ▼
                     a local LLM (Ollama) distills the transcript
                                  │
                                  ▼
        kb/  — the memory palace (plain markdown, git-friendly)
```

Because Discord hands the bot one audio stream **per speaker**, attribution is
exact — no diarization guesswork. Transcription runs locally via Parakeet MLX
(NVIDIA's Parakeet ASR model, ported to run on Apple Silicon GPUs), and
distillation runs locally too via Ollama — nothing leaves your machine.

## The knowledge base format

Plain markdown, one fact-dense note per file, heavily cross-linked — built to
be read by humans *and* grepped by tools:

```
kb/
  INDEX.md        # the palace map: one line per note, rebuilt on every write
  meetings/       # one distilled note per meeting: summary, decisions, action items
  topics/         # durable topics that accumulate atomic facts over time
  transcripts/    # raw transcripts, kept for provenance
```

Every note has `name:`/`description:` frontmatter and links to related notes
with `[[wiki-links]]`. Topic notes are append-style logs: each atomic fact is
one self-contained sentence with a backlink to the meeting it came from. Make
`kb/` its own git repo if you want history.

## Setup

1. **Create the Discord app** at <https://discord.com/developers/applications>:
   - *Bot* tab → copy the token. No privileged intents are needed.
   - *OAuth2 → URL Generator* → scopes `bot` + `applications.commands`;
     bot permissions **View Channels**, **Send Messages**, **Connect**.
     Open the generated URL to invite the bot to your server.

2. **Install the local pieces** (macOS, Apple Silicon):

   ```sh
   brew install ffmpeg ollama
   uv tool install parakeet-mlx
   npm install
   ```

   `parakeet-mlx` downloads its model (`mlx-community/parakeet-tdt-0.6b-v3`,
   ~0.6B params) from Hugging Face automatically on first transcription.

3. **Pull a model for distillation** and keep Ollama running alongside the
   bot:

   ```sh
   ollama serve &
   ollama pull qwen2.5:3b
   ```

   Any instruction-tuned model that's decent at following a JSON schema
   works. Avoid "thinking"/reasoning models (e.g. qwen3) here unless you
   don't mind the wait — their chain-of-thought runs before the JSON output
   and adds minutes per meeting even on short transcripts. Point
   `CHRONICLE_MODEL` at whatever you pull.

4. **Configure**: `cp .env.example .env`, then fill in `DISCORD_TOKEN` and
   (recommended) `GUILD_ID`. `LLM_BASE_URL` already points at Ollama's
   default address (`http://127.0.0.1:11434/v1`) — change it if you run a
   different OpenAI-compatible server (e.g. llama.cpp's `llama-server`) or a
   different port.

5. **Run**:

   ```sh
   npm run dev      # development (tsx)
   npm run build && npm start   # production
   ```

## Commands

| Command | What it does |
| --- | --- |
| `/record start` | Joins your voice channel and starts recording (announces itself in-channel) |
| `/record stop` | Stops, transcribes, distills locally, files the meeting into `kb/`, posts the summary |
| `/record status` | Shows recording duration and speakers so far |
| `/recall query:<text>` | Searches the knowledge base and returns matching notes |

You can also ingest a recording made elsewhere:

```sh
npm run ingest -- path/to/meeting.m4a --speaker "Max"
```

## Consent

The bot records everyone in the voice channel. It announces recording when it
starts — make sure that's acceptable in your jurisdiction and to the people in
the call before using it.

## Roadmap

- `/recall` answered by Claude over the KB instead of raw text search
- Ingest other sources (Slack threads, docs, PRs) into the same palace
- Periodic "review" pass that merges and prunes topics as they grow
- Web UI over `kb/`
