# Transcribe

Free audio transcription at **[transcribe.santisiordia.com](https://transcribe.santisiordia.com)**. Upload a recording, get the text back with timestamps. It runs [Whisper](https://github.com/ggml-org/whisper.cpp) large-v3-turbo on a Mac at my home, so there is no bill per minute and nothing to sell.

- No account, no API key, no cookies, no analytics, no third-party requests.
- English and Spanish pages; Whisper handles many more languages on Auto.
- REST API with Swagger docs at [/docs](https://transcribe.santisiordia.com/docs).
- If it saves you time, [buy me a coffee](https://buymeacoffee.com/santisiordia). Supporters get an API key with higher limits.

## Your data: check it yourself

The whole server is one file, [`server.mjs`](server.mjs), with no dependencies.

| What | Where it lives | When it goes away | Code |
|---|---|---|---|
| Your audio | A temp file | The moment its job ends, success or failure; after 10 minutes if you chose a file but never pressed Transcribe; also wiped at every start | `transcribe()`, its `finally` block, and the first lines of `createServer()` |
| The transcript | Server memory, never disk | One hour after the job ends, or immediately when the page fetches it and sends `DELETE` | the sweep at the bottom, `DELETE /api/jobs/{id}` |
| Readable paragraphs | Made by a second local model (Gemma via Ollama on `127.0.0.1`), held in server memory with the transcript | Same as the transcript | `polish()`; `sameWords()` rejects any output that changes a word |
| Your IP address | Server memory, for the hourly limit | One hour | `limiter()` |
| Donor email | Only as a SHA-256 hash, next to the key | When a donation is refunded | `grant()`, `revoke()` |
| Your library | Your browser's `localStorage` | When you delete it | `index.html` |

The only log line per job is its status, the audio length and `free` or `donor`. The site is served through a Cloudflare tunnel.

## API

```sh
curl --data-binary @recording.mp3 'https://transcribe.santisiordia.com/api/transcribe?language=auto'
# {"id":"…","status":"queued","position":0}
curl https://transcribe.santisiordia.com/api/jobs/ID
# {"status":"done","language":"en","duration":372,"segments":[{"start":0,"end":2.7,"text":"…"}],"text":"…"}
```

| | Without a key | Supporter key |
|---|---|---|
| Transcriptions per hour | 3 per IP | 30 |
| File | 100 MB, 3 hours | 100 MB, 3 hours |
| Queue | normal | goes first |

A donation on Buy Me a Coffee creates a key automatically (webhook → `POST /api/bmc-webhook`). Claim it in the About and API dialog or with `POST /api/claim {"email": "…"}`, then send `Authorization: Bearer <key>`.

## Run your own

Needs Node 20.6+, ffmpeg and whisper.cpp. Readable paragraphs are optional and need [Ollama](https://ollama.com) with `gemma3:4b` (`brew install ollama && brew services start ollama && ollama pull gemma3:4b`); without it the Paragraphs view just joins Whisper's text. On a Mac:

```sh
brew install ffmpeg whisper-cpp
mkdir -p ~/Library/Application\ Support/transcribe
curl -L -o ~/Library/Application\ Support/transcribe/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
cp .env.example .env
node --env-file=.env server.mjs      # http://127.0.0.1:3015
node server.test.mjs                 # checks
```

Paths, port, public URL and links are environment variables listed in `.env.example` and at the top of `server.mjs`. `com.santi.transcribe.plist` is the LaunchAgent I use to keep it running. The server listens on `127.0.0.1` only and trusts `CF-Connecting-IP`, so put it behind a Cloudflare tunnel or change `ip()` for your proxy.

Page copy and the SEO landing pages live in `pages.json`; `index.html` is the single template.

## License

MIT

Bundled in `public/`: Swagger UI (Apache-2.0) and the Inter typeface (SIL OFL 1.1), self-hosted so the page makes no third-party requests.
