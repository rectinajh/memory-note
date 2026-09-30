# Privacy boundary (Memory Card)

## What we optimize for

- **Your words, not the model's.** The card is built from transcript spans the server can verify. The LLM asks questions; it does not author the card.
- **Keys stay server-side.** The browser gets a short-lived streaming token, not your AssemblyAI API key.
- **Share is opt-in.** TikTok export is a file you choose to upload. Nothing posts by default.

## Data flow

```
Microphone → AssemblyAI Streaming (transcript)
           → Your server (tool gate, session, card, proof)
           → Browser (display, optional download / video)
```

## On disk (this prototype)

| Item | Where | When |
|------|--------|------|
| Photo bytes | `data/photos/<sessionId>` | Upload |
| Session JSON | `data/sessions/<sessionId>.json` | After each turn |
| Card Markdown + proof | `data/cards/<sessionId>.md` + `.proof.json` | After you say yes |

Restarting the process does **not** erase a saved session if `data/sessions/` still has the id. The page can restore from `localStorage` session id.

## What we do not do (v1)

- No accounts, no analytics pixel, no social graph.
- No face recognition or relationship guessing from the image.
- No speaking as a person in the photo.

## Hardening roadmap (P2)

- Passphrase-encrypted export bundle (photo + transcript + card + proof).
- Optional Voice Agent path with the same server-side `applyTool` gate.
