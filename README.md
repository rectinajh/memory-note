# Memory Card

### Verbatim or nothing.

### Background

You already have the photo—the shoebox, the phone roll, the one frame you keep meaning to explain.  
The story is still in your head: half a name, a courtyard, a summer that won’t line up on a timeline.  
You do not need another app that wants you back tomorrow, a feed, or a page that turns family into content.

### The pain

| | |
|--|--|
| **Blank** | You open the picture and the first sentence never comes. |
| **Blur** | Place and year feel wrong if software “polishes” them into facts. |
| **Betrayal** | AI memoirs invent names, ties, scenes you never said—and sound confident doing it. |
| **Noise** | Memorial chatbots, daily streaks, public walls—none of that is what you came for. |

You wanted **one careful telling** and an artifact you can **close the laptop on**.

### How we solve it

**Memory Card** is a **voice interviewer**, not a writer. One photo. Short questions. **Barge-in** when you talk over it.

- The model **asks**; the **server** decides what lands on the card.
- A line is saved only as a **continuous quote** from your transcript—paraphrase gets **rejected**.
- Fuzzy words stay **off** the card until you say them clearly again.
- The assistant never speaks **as** someone in the photo.
- The card is sealed only after a short **yes**—then you can **prove** every line with hashes (`proof.json`).

Free to tell; see the card on screen. **$1** unlocks Markdown, proof, and a TikTok-ready clip (photo + your quotes only).

```
     ┌─────────────┐
     │  old photo  │
     └──────┬──────┘
            │  your voice
            ▼
      [ transcript ] ──► gate: continuous span only ──► card + hashes
            ▲                      │
            └──── AI asks ─────────┘   (never authors)
```

| | |
|--|--|
| **Free** | Tell the story. See the card on screen. |
| **$1** | Markdown, `proof.json`, TikTok-ready vertical video. |
| **Never** | Feed. Memorial hall. “Hi, I’m your grandfather” chatbot. |

*Don’t trust the model. Verify the span.*

---

## The rules (boring on purpose)

1. **Interviewer, not author** — who → where → when → “make the card?”
2. **Barge-in** — your voice wins over playback.
3. **Quote = substring** — paraphrase hits the wall in the tool log.
4. **Yes means yes** — short. Explicit. No buried consent in a paragraph.
5. **Proof** — hash the transcript, anchor each line, hash the card.

---

## Run it

Node **20+**. Zero npm deps.

```bash
cd memory-note
# ASSEMBLYAI_API_KEY=... in .env (gitignored)
node server.js
```

Open **http://127.0.0.1:8787** (or `PORT=8788 node server.js`).

Public demo: see **`docs/deploy.md`** (`HOST=0.0.0.0`, Docker, Railway/Render).  
Hackathon pack: **`docs/submission.md`**.  
Privacy boundary: **`docs/privacy.md`**.

```bash
node --test test/*.js
```

---

## Use it

1. **Choose a photo** or **Try sample photo**.
2. **Start telling** (mic) or **Use text instead**.
3. Answer in your words; watch **Quotes saved** fill with *your* lines.
4. Short **yes** → card preview (free).
5. **Unlock · $1** → download **memory-card.md** + **proof.json** → **Make TikTok video** → share.

Mic needs a key in `.env`; upload works without it.

---

## Under the hood

| Piece | Role |
|-------|------|
| AssemblyAI Streaming | Live transcript (`universal-3-6-pro`, en) |
| Short-lived token | Browser never sees your API key |
| LLM Gateway | Tools only; server runs `applyTool` |
| `captureStatement` / `confirmIfAgreed` | Safety net when the model skips a tool |
| `data/sessions/` | Survives restart; page restores last id |

Playback is browser `speechSynthesis` (not Voice Agent yet). The **card** is what we harden—not every spoken line.

Full rules: **`docs/tech.md`**. Product: **`docs/prd.md`**.

---

## Roadmap (P0 → P2)

| Priority | Ship |
|----------|------|
| **P0** | Public URL, demo video + slides, proof export, end-to-end unlock path |
| **P1** | Voice Agent loop, Stripe $1 code, MP4 export, sample + persist (mostly in repo) |
| **P2** | Encrypted export bundle, optional content-addressed archive |

---

## Privacy

Key stays on the server. Photo is not sent to AssemblyAI. TikTok is **your** upload. `.env` and `data/` are gitignored; default bind is `127.0.0.1`.
