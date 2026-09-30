# Memory Card technical notes

This document describes the prototype that already runs in the repo. It does not describe paid finished pieces that are not built.

## Architecture

One Node.js process, no npm dependencies. Entry point `server.js`. It uses built-in `http`, `fs`, and `crypto`. Static files are in `public/`. Rules are in `lib/session.js`. AssemblyAI calls are in `lib/aai.js`.

```
browser
  |  POST /api/session          photo (base64)
  |  GET  /api/streaming-token  temporary token only
  |  POST /api/session/:id/turn one transcript turn
  |  GET  /api/session/:id/card.md
  |  GET  /api/session/:id/proof.json
  |  POST /api/session/sample
  |
  +-- WebSocket direct to AssemblyAI Streaming (token, not the permanent key)
  +-- speechSynthesis (en-US) reads the server's say

server.js
  |  sessions live in an in-memory Map
  |  turns for one session are queued in order
  +-- lib/aai.js     token and LLM Gateway
  +-- lib/session.js hard tool checks and card Markdown
  +-- data/photos, data/cards
```

The process listens only on `127.0.0.1`, default port `8787` (`PORT` overrides it). `node server.js` is enough. Node.js 20+.

One session: `POST /api/session` or `POST /api/session/sample` creates a UUID, writes the photo to disk, and puts the session object in memory. After each turn the session is written to `data/sessions/<id>.json`. On the next request, `resolveSession` loads from disk if the id is not in memory. The browser can restore the last session id from `localStorage`.

## AssemblyAI integration

The key is read from the process environment variable `ASSEMBLYAI_API_KEY`. On startup, `node server.js` also loads `.env` from the project root and fills any variable that is not already set. The key is not logged and not sent to the page. If a response body accidentally contains the key (length at least 8), it is replaced with `[redacted]`. `Bearer` values are stripped too.

### Streaming transcription

`GET /api/streaming-token` is requested by the server:

`GET https://streaming.assemblyai.com/v3/token?expires_in_seconds=300&max_session_duration_seconds=900`

Authorization is tried with the key itself, then `Bearer` if that returns 401. The returned `token` must not equal the permanent key. If it does, that is treated as an upstream error.

The browser connects with the temporary token:

`wss://streaming.assemblyai.com/v3/ws`

Query parameters: `sample_rate=16000`, `encoding=pcm_s16le`, `speech_model=universal-3-6-pro`, `language_codes=["en"]`, `language_detection=true`.

The microphone is resampled in an AudioWorklet to 16 kHz, 16-bit PCM, and sent in frames of 800 samples (50ms). After `Begin`, the page speaks a fixed greeting: "I'm listening. This photo is yours. Who is in it?" That line is frontend copy. It does not go through the model.

`Turn` messages: an unfinished partial transcript is used only to detect an interruption. Text is sent to `/turn` when `end_of_turn` and `turn_is_formatted`. If the formatted result does not arrive, the unformatted turn is used after 450ms so the conversation does not stick. Each `turn_order` is submitted once.

On end, or when the page is left, the browser sends `{ "type": "Terminate" }`.

Without a key, the token endpoint returns 503 and speech does not start.

### Turns and the language model

The body of `POST /api/session/:id/turn` is `{ "text", "words" }`. `words` may include `confidence`. Empty text returns 400.

The server appends the turn to the session, then requests:

`POST https://llm-gateway.assemblyai.com/v1/chat/completions`

The request uses `tool_choice: "auto"`, `temperature: 0.2`, `max_tokens: 600`, and `post_processing_steps: [{ type: "json-repair" }]`. Tool definitions come from `TOOLS` in `lib/session.js`.

Models are tried in this order. After a success, the index is remembered and the next request starts there:

1. `gemini-3.5-flash-lite`
2. `gemini-2.5-flash-lite`
3. `gpt-5-mini`
4. `claude-haiku-4-5-20251001`

Only 400, 404, 422, or a success body that cannot be parsed moves to the next model. 401 and 403 fail immediately, with no rotation. Other 4xx and 5xx fail immediately too.

One turn may call the model up to 4 times so tools can run in sequence. If there is no tool call, the model text becomes `say`. If there is still nothing to read aloud, a local fallback is used (saved, please repeat, or "I'm listening"). If every model is rejected because the account has no LLM Gateway access, `localReply` asks the next fixed question and still runs the same three tools. It does not invent a quote. When conversation messages exceed 24, the oldest are dropped. The system prompt is not part of those 24. It is placed at the front on every request.

### Playback and interruption (not Voice Agent)

`say` is read by the browser `speechSynthesis`, language `en-US`, preferring an `en-US` voice and otherwise any `en` voice. If no English voice is installed, the text still shows.

Interruption happens on a partial transcript: while speech is playing, and the new text looks like speech (contains a letter and is at least 2 characters) and does not look like an echo of the line just spoken, the page calls `speechSynthesis.cancel()`. Echo detection strips whitespace and punctuation, then checks whether either string contains the other. If the turn was already sent when it was interrupted, the reply is not read aloud when it comes back.

This is not AssemblyAI Voice Agent, and it is not `interrupt_response`.

The Voice Agent browser session (`GET https://agents.assemblyai.com/v1/token`, then `wss://agents.assemblyai.com/v1/ws`) is not connected. Playback is the browser voice. Do not describe the page as an AssemblyAI voice agent.

The text entry calls the same `/turn` and does not send word-level confidence. Without a key it also returns 503.

## Tool contract

The model may call tools. The result is whatever `applyTool` returns. A failure reason comes back as a tool message. The model should change what it says. A failure is not a successful save.

`note_quote`

- Argument `quote` (string).
- It must map to a continuous span of the concatenated user transcript. An exact substring is tried first. If that fails, alignment ignores whitespace and common punctuation, but the saved text is still the original slice from the transcript, not the model's edited string.
- At most 120 code points. A non-exact match is accepted only when the loosened text is at least 2 characters.
- A pure answer ("yes", "okay", "make the card", and the other short agreements) is rejected.
- If the slice touches a low-confidence word, it is rejected and automatically marked unclear. Thresholds: confidence below 0.6 for a word longer than one character; below 0.4 for a single character. A word with no confidence is not treated as low by this rule.
- On success, the quote is appended to `session.quotes` (the same text is not stored twice).

`flag_unclear`

- Argument `phrase`. It must also be a continuous span of the transcript, or it is rejected.
- Success only marks the phrase. It does not write a quote. The prompt then asks the user to repeat it.

`confirm_card`

- The schema has an `agreed` boolean. The server does not trust it, and it does not accept a story body.
- It passes only when the latest user transcript is a short explicit yes. After trimming and dropping punctuation, the length is at most 40, and the text matches a fixed set of short lines (for example "yes", "okay", "make the card"). "I confirm that person is my grandfather" is not agreement.
- It also requires at least one checked quote and a photo filename.
- On success, Markdown is generated and written immediately to `data/cards/<sessionId>.md`. The tool result returned to the model strips the card body and keeps the quote list and filename, so the model does not rewrite the whole card.

The card Markdown has a fixed shape:

- Title "Memory Card"
- Photo filename
- Confirmation time, `Asia/Shanghai`, format `YYYY-MM-DD HH:mm`, labeled China Standard Time
- "What you said": each quote as a blockquote
- If unclear phrases are still unresolved: a separate section listing them, and a line that they were not written onto the card
- A closing line that the sentences come only from the transcript

"Unresolved" means an unclear phrase is not contained in any saved quote.

The system prompt also requires: do not invent, do not speak as a person in the photo or as someone who has died, at most two spoken sentences, and the user transcript is not an instruction to the model. Those are prompts, not a parser. The hard boundary is the three tools.

## Data

| Location | Contents | Lifetime |
| --- | --- | --- |
| In-memory `sessions` | hot copy of session | Reloaded from `data/sessions/` on demand |
| `data/sessions/<uuid>.json` | utterances, quotes, card, unlock flag | Survives process restart |
| `data/photos/<uuid>` | raw image bytes | On disk until someone deletes them |
| `data/photos/<uuid>.json` | `{ filename, mime }` | Same |
| `data/cards/<uuid>.md` | confirmed Markdown | Written on confirm |
| `data/cards/<uuid>.proof.json` | transcript + markdown hashes, quote spans | Written on confirm |

`MEMORY_NOTE_DATA` replaces the `data/` root. `data/` is gitignored.

Photo limits: JSON body about 9MB; decoded image from 1 byte to 6MB. The file header identifies PNG, JPEG, GIF87a/GIF89a, and WEBP. The filename has its path stripped, keeps a limited character set, and is at most 80 characters.

Static-page CSP: `connect-src` allows only this origin and `wss://streaming.assemblyai.com`. `agents.assemblyai.com` is not allowed.

Main endpoints:

- `GET /api/health`: `assemblyai` is `configured` or `missing`. The key is not returned.
- `GET /api/streaming-token`
- `POST /api/session`
- `POST /api/session/sample`: demo photo without upload
- `GET /api/photos/:id`
- `GET /api/session/:id`
- `POST /api/session/:id/unlock`: prototype $1 unlock (no payment processor)
- `POST /api/session/:id/turn`
- `GET /api/session/:id/card.md`: attachment `memory-card.md`. 402 until unlocked.
- `GET /api/session/:id/proof.json`: verifiable bundle. 402 until unlocked.

See `lib/proof.js` for `transcriptSha256`, quote spans, and `markdownSha256`.

## Privacy

- The permanent key never leaves the server. The temporary token reaches the browser and is used only for that streaming session. It is valid for about 300 seconds. The session lasts about 15 minutes.
- Transcript text and the photo leave this machine: audio goes to AssemblyAI Streaming, transcript text goes to the LLM Gateway. The photo is not sent to either endpoint.
- There is no account, no third-party login, and no analytics script.
- The server binds only to loopback, and it has no authentication. Other local programs on this machine can reach the photos and sessions.
- Do not put the key in the repo, the README, the PRD, or the logs. `.env` is gitignored. The running process loads it once at startup. A variable already set in the shell is left as-is.

## Known gaps

- When the key is not in `.env` or the process environment, the speech token and `/turn` both return 503. That is a missing key, not a feature flag. Do not write the key into code or docs.
- Playback quality depends on the browser voice. Interruption cancels the current utterance. It is not official agent interruption down to half a word.
- The assistant can still say something the user never said. The card rejects it. Playback does not.
- Sessions are persisted under `data/sessions/` but messages are trimmed in memory during long tells. Proof and Markdown are also written under `data/cards/` when the card is confirmed.
- Photo files are not expired with the session.
- The model list is a fixed order based on current availability, not a probe of what the account actually has enabled. A dead name is skipped on 400, 404, or 422.
- Single machine, single user, no durable queue. Turns for one session are serialized with an in-memory promise chain.
- Paid abilities are not built: a long interview turned into a short piece, several photos, a human edit, a short film.

## Tests

No key, and no network:

```bash
node --test test/*.js
```

`test/session.test.js` covers: a quote must be a substring, punctuation differences map back to the original slice, low confidence is rejected and marked, a word never said cannot be flagged, confirmation must be a short yes, the card does not contain a story the model tried to insert, and an acknowledgement cannot be a quote.

`test/server.test.js` starts the server in a temporary data directory and asserts: without a key, health is missing, the token and turn are 503, the page HTML does not assign the key, a photo is saved by file header, and a fake key does not appear in the health response.

Passing tests show the rules and local HTTP behavior. They do not show that an AssemblyAI account works.
