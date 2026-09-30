# Hackathon submission checklist (lablab)

## Links

- Public GitHub repo (this project)
- Demo URL (deploy with `docs/deploy.md`, health: `/api/health`)
- Cover image 16:9
- Video MP4 ≤ 5 minutes
- PDF slides

## Short description (≤255 chars, English)

Memory Card: a voice interviewer for one old photo. It only asks questions. The card keeps verbatim quotes from your transcript and is written only after you say yes. $1 unlocks download and a TikTok-ready video.

## 30-second script

People freeze in front of an old photo. They do not trust AI to write the story. Memory Card asks short questions, stops when you interrupt, and saves only continuous quotes from what you actually said. Say yes, and you get a private card. One dollar unlocks the file and a vertical video for TikTok. The server can prove every line on the card is anchored to your transcript hash.

## Demo shot list (2–3 min video)

1. Upload photo or **Try sample photo**
2. Text or voice: who / one line / **yes**
3. Card preview on screen (free)
4. Unlock $1 → download Markdown + **proof.json**
5. Make TikTok video → Share or Studio upload
6. Optional: show a **rejected** paraphrased quote in tool log (Rejected note_quote)

## Slides (5–7 pages)

1. Problem: drawer photo, fear of invented words, no feed
2. Solution: interviewer only, verbatim gate, explicit yes
3. Tech: Streaming token (not master key), LLM tools, server `applyTool`, proof hashes
4. Business: free telling, $1 artifact (file + video)
5. Privacy: local-first option, user-initiated share
6. Roadmap: Voice Agent, encrypted export

## Judges (1–5)

- **Presentation**: clear 30s + live demo URL
- **Business**: $1 unlock, family keepsake TAM
- **Application of technology**: AssemblyAI streaming + gateway tools + verifiable spans
- **Originality**: anti-hallucination card, not memorial chatbot
