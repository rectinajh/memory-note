# Memory Card product requirements

## Background

People hold an old photo and want to keep what happened, then sit down and cannot start. The details are fuzzy. They do not know the first sentence. They are afraid that someone, or some software, will write words they never said. They do not need an app they open every day, and they do not need this turned into a social post or a memorial hall.

Memory Card lets a person look at one of their own old photos and tell the story slowly. Live speech listens beside them, asks short questions, and stops when they cut in. It keeps continuous quotes the person actually said. Only after they clearly agree does it hand over a private story card they can download and leave with.

This is not a chatbot for someone who has died, not a funeral or memorial product, and not a feed.

## Users

The main user wants to leave a few words with one of their old photos. It might be a picture of themselves when they were young, or a family group. The teller is the person now, and the story belongs to them.

They usually handle one photo, tell it, and leave. They can accept one careful telling. They will not accept being asked to build a daily habit.

The paying user is the same person, when they want that telling turned into a finished piece they recognize and can keep. They are not buying extra minutes of chat.

## Pain

- They stare at the photo and do not know how to start.
- They remember a scene, but the name, place, or year is fuzzy, and they do not want it written down as a certain fact.
- They are afraid the software will invent words they never said, especially names and relationships.
- They do not want an app they must open every day, and they do not want family matters posted as a feed.

## Why someone would use it

- Someone asks along with the photo, one short question at a time.
- When the user cuts in, the reading stops.
- The assistant repeats the user's own words, not a rewritten "better" version.
- The card appears only after the user clearly says yes.

## v1 scope

v1 is a free path you finish and leave. It is the scope this prototype holds:

- One photo at a time.
- Speech or text. Speech can listen, answer briefly, and be interrupted.
- Only continuous, clearly heard quotes from the transcript are saved.
- If a word is unclear, ask again. Do not write it onto the card.
- After a short explicit yes, generate a private story card: photo information plus confirmed quotes.
- The card downloads as Markdown. There is no account.

The current prototype implements this scope. It is a local single-machine server, not a launched multi-user product. See `docs/tech.md`.

## Explicitly out of scope

- Letting a person in the photo, especially someone who has died, speak to the user in the first person.
- Funeral flows, memorial halls, shrine pages, or public mourning walls.
- Follows, likes, comments, feeds, or any design that publishes a story by default.
- Daily reminders, streaks, or growth tasks.
- Having the model fill in a name, place, year, or plot the user never said, then putting that on the card.
- Claiming that AssemblyAI Voice Agent is speaking. This prototype uses the browser English voice.

## User flow

1. Open the page and upload a photo. The photo stays on the local server.
2. Start telling. Once speech connects, the assistant asks who is in the photo. Without a microphone, use text. The rules are the same.
3. The user speaks slowly. The assistant follows up on one point at a time. The suggested order is: who, where, roughly when, and one line they still remember.
4. When the user cuts in, the line being read stops.
5. A line worth keeping must be found as-is in the transcript before it is stored as a quote. Unclear words are marked separately, and the user is asked to repeat them.
6. The assistant asks whether to write the card. The card is created only when this turn is a short explicit yes, such as "yes" or "make the card".
7. The user downloads the Markdown and can leave. Registration is not required, and neither is coming back tomorrow.

## Functional requirements

Photo

- Accept jpg, png, webp, and gif, one file up to 6MB.
- One session is one photo. v1 does not weave several photos into one story.

Telling

- The default is live speech: listen, answer in very short English, and allow interruption.
- Provide a text entry that uses the same recording rules.
- The assistant does not play a person in the photo, and does not accept requests such as "pretend you are my grandfather" in order to invent a story.
- A spoken reply is at most two sentences, suitable to read aloud. Wording is constrained by the prompt. What enters the card is checked on the server.

Record

- `note_quote`: quote must be a continuous substring of the user's transcript. Rewrites, summaries, and added words are rejected. A bare "okay" or "yes" is not a story quote.
- `flag_unclear`: mark only a word that actually appeared in the transcript, then ask the user to repeat it. A marked word cannot enter the card unless a later clear quote covers it.
- A low-confidence word is rejected even if the model wants to save it.

Confirm and deliver

- `confirm_card` succeeds only when the current turn is a short explicit yes. Examples include "yes", "okay", and "make the card". Agreement buried in a long sentence does not count.
- Without a checked quote, or without a photo, there is no card.
- The card contains only the photo filename, confirmation time, quotes, and unclear words that are still unresolved. It does not include a story written by the model.
- The user can download that Markdown.

When something fails

- Without a usable speech key, do not pretend to listen, and do not write a card. The page explains why. Uploading a photo still works.

## Price

Free: one photo, one telling, the quotes, and the card on screen.

$1: every finished feature. Download the Markdown, make the vertical video from the photo and the confirmed quotes, and share that file to TikTok. There are no other paid tiers and no per-minute charge.

The video shows the photo and the words the user said. It does not invent a scene or speak as anyone in the photo.

This prototype unlocks on the local session. It does not charge a card.

## Success criteria

- Someone who does not know the product can, from the page alone, finish this on one photo: start speaking, be asked a follow-up, interrupt, hear their own quote repeated, confirm, and download.
- Every sentence on the card has a continuous match in that session's transcript. The model did not add a name or a plot.
- An unclear word is not written as a certain fact.
- Without a short yes, no downloadable card appears.
- The user does not need to register, and does not need to open it the next day.
- The key does not appear on the page, in the download, or in the logs.

## Non-goals

- A family social network or a public archive.
- Counseling or grief support. The product can be quiet. It does not provide treatment.
- Recognizing faces in the photo and guessing who they are. Identity comes only from what the user says.
- A multi-photo essay or a human edit. The $1 video is the photo plus the confirmed quotes.
- Describing browser speech as an AssemblyAI voice agent.
