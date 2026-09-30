# Deploy Memory Card (P0 demo URL)

Single Node process, no npm install. You need `ASSEMBLYAI_API_KEY` on the server only.

## Docker

```bash
docker build -t memory-card .
docker run -p 8787:8787 -e ASSEMBLYAI_API_KEY=your_key -e HOST=0.0.0.0 memory-card
```

Data (photos, cards, sessions) lives in `/app/data` unless you set `MEMORY_NOTE_DATA` and mount a volume:

```bash
docker run -p 8787:8787 -e HOST=0.0.0.0 -e ASSEMBLYAI_API_KEY=... \
  -v memory-note-data:/data -e MEMORY_NOTE_DATA=/data memory-card
```

## Render / Railway / Fly

1. Connect this repo.
2. Start command: `node server.js`
3. Environment:
   - `ASSEMBLYAI_API_KEY` (secret)
   - `HOST=0.0.0.0`
   - `PORT` (platform often injects this)
4. Health check path: `/api/health`

The browser still connects to `wss://streaming.assemblyai.com` from the user's machine. CSP already allows that host.

## Vercel

`server.js` is the entry. Vercel runs that Node server. `public/` is bundled with it. On Vercel the disk is not durable, so photos, sessions, and future-you letters are written under `/tmp/memory-note`. A card can disappear when a new instance starts, and the email only leaves if that same instance is still alive at the chosen time.

```bash
vercel --prod
```

Put `ASSEMBLYAI_API_KEY` in the Vercel project environment. Do not commit `.env`.

## Local vs public

- Default `HOST=127.0.0.1` for local-only.
- Set `HOST=0.0.0.0` when the process must accept traffic from a reverse proxy or the internet.

Do not commit `.env`. Use the platform secret store.
