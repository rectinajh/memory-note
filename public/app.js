const $ = (id) => document.getElementById(id);

const ui = {
  banner: $("banner"),
  frame: $("frame"),
  file: $("file"),
  photoName: $("photo-name"),
  start: $("start"),
  stop: $("stop"),
  status: $("status"),
  log: $("log"),
  live: $("live"),
  quotes: $("quotes"),
  unclear: $("unclear"),
  tools: $("tools"),
  compare: $("compare"),
  source: $("source"),
  sourceText: $("source-text"),
  payCopy: $("pay-copy"),
  textForm: $("text-form"),
  textInput: $("text-input"),
  logEmpty: $("log-empty"),
  cardPanel: $("card-panel"),
  cardPreview: $("card-preview"),
  card: $("card"),
  locked: $("locked"),
  paid: $("paid"),
  unlock: $("unlock"),
  download: $("download"),
  downloadProof: $("download-proof"),
  sample: $("sample"),
  own: $("own"),
  makeVideo: $("make-video"),
  share: $("share"),
  videoStatus: $("video-status"),
  storyVideo: $("story-video"),
  cardFile: $("card-file"),
  later: $("later"),
  laterEmail: $("later-email"),
  laterWhen: $("later-when"),
  laterStatus: $("later-status"),
  steps: $("steps"),
  now: $("now"),
  voice: $("voice"),
  keepsake: $("keepsake"),
  keepsakePhoto: $("keepsake-photo"),
  keepsakeDate: $("keepsake-date"),
  pay: $("pay"),
  payLink: $("pay-link"),
  payConfirm: $("pay-confirm"),
  receipt: $("receipt"),
  exportForm: $("export-form"),
  passphrase: $("passphrase"),
};

const state = {
  sessionId: null,
  ws: null,
  audioCtx: null,
  stream: null,
  ready: false,
  speakGen: 0,
  speaking: false,
  lastAgent: "",
  committed: new Set(),
  pending: null,
  pendingTimer: null,
  turnChain: Promise.resolve(),
  pcmQueue: new Int16Array(0),
  unlocked: false,
  videoFile: null,
  quotes: [],
  quoteRecords: [],
  cardQuotes: [],
  transcript: "",
  photoUrl: "",
  paper: "letter",
  paymentUrl: "",
  markdown: "",
};

const GREETING = "I'm listening. This photo is yours. Who is in it?";
const SESSION_KEY = "memory-card-session-id";

function setStatus(text) {
  ui.status.textContent = text;
}

function setPhase(phase) {
  document.body.dataset.phase = phase;
  ui.frame.classList.toggle("listening", phase === "listening");
}

function explain(raw) {
  const text = String(raw || "");
  if (/NotAllowedError|Permission denied|permission/i.test(text)) {
    return "The microphone is blocked. Allow it in the browser bar, then press Start telling again.";
  }
  if (/NotFoundError/i.test(text)) {
    return "No microphone was found. Type the story instead. It uses the same card.";
  }
  if (/ASSEMBLYAI_API_KEY|temporary streaming token|No speech key/i.test(text)) {
    return "Speech is off until a key is in .env. You can still type, and the card uses the same rules.";
  }
  if (/did not finish|llm_failed|gateway/i.test(text)) {
    return "That question did not come back. Send the line again. Quotes already saved stay saved.";
  }
  if (/Unlock did not finish|payment/i.test(text)) {
    return "Unlock did not finish. Nothing was charged. Try again.";
  }
  return text;
}

function setBanner(text) {
  if (!text) {
    ui.banner.hidden = true;
    ui.banner.textContent = "";
    return;
  }
  ui.banner.hidden = false;
  ui.banner.textContent = explain(text);
}

function humanTool(tool) {
  if (tool.name === "note_quote" && tool.ok) return "Kept in your words.";
  if (tool.name === "note_quote") return "That line is not a continuous quote from what you said.";
  if (tool.name === "flag_unclear" && tool.ok) return "Left out until you repeat it clearly.";
  if (tool.name === "confirm_card" && tool.ok) return "The card is sealed.";
  if (tool.name === "confirm_card") return "Say a short yes after at least one quote.";
  return tool.ok ? "Noted." : "Not written on the card.";
}

function renderSteps(quoteCount, hasCard) {
  const items = [...ui.steps.children];
  const active = hasCard ? 3 : Math.min(quoteCount, 3);
  items.forEach((item, index) => {
    item.classList.toggle("done", hasCard ? index <= 3 : index < active);
    item.classList.toggle("now", index === active);
  });
}

function addLog(who, text) {
  const row = document.createElement("div");
  row.className = who === "You" ? "bubble you" : "bubble assistant";
  if (who !== "You") ui.now.textContent = text;
  const label = document.createElement("span");
  label.className = "who";
  label.textContent = who;
  const body = document.createElement("span");
  body.textContent = text;
  row.append(label, body);
  ui.logEmpty.hidden = true;
  ui.log.append(row);
  ui.log.scrollTop = ui.log.scrollHeight;
}

function norm(s) {
  return String(s || "").replace(/[\s\u3000,.;:!?，。！？、；：]/g, "");
}

function isEcho(heard, spoken) {
  const h = norm(heard);
  const s = norm(spoken);
  if (h.length < 2 || s.length < 2) return false;
  return s.includes(h) || h.includes(s);
}

function looksLikeSpeech(text) {
  const t = text.trim();
  return /[a-z]/i.test(t) && t.length >= 2;
}

function showSource(text) {
  const lines = state.quoteRecords.length
    ? state.quoteRecords.map((quote) => quote.text)
    : [text];
  ui.source.hidden = false;
  ui.sourceText.replaceChildren();
  for (const line of lines) {
    const row = document.createElement("p");
    if (line === text) {
      const mark = document.createElement("mark");
      mark.textContent = line;
      row.append(mark);
    } else {
      row.textContent = line;
    }
    ui.sourceText.append(row);
  }
}

function renderCompare(tools) {
  const rejected = (tools || []).find((tool) => tool.name === "note_quote" && !tool.ok && tool.rejected && tool.heard);
  ui.compare.replaceChildren();
  if (!rejected) {
    ui.compare.hidden = true;
    return;
  }
  ui.compare.hidden = false;
  for (const [className, label, text] of [
    ["heard", "You said", rejected.heard],
    ["refused", "Not saved", rejected.rejected],
  ]) {
    const row = document.createElement("p");
    row.className = className;
    const title = document.createElement("span");
    title.textContent = label;
    row.append(title, document.createTextNode(text));
    ui.compare.append(row);
  }
}

function renderSession(data) {
  state.transcript = data.transcript || state.transcript;
  state.quoteRecords = data.quotes || [];
  ui.quotes.replaceChildren();
  for (const quote of state.quoteRecords) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = quote.text;
    chip.addEventListener("click", () => showSource(quote.text, quote.start, quote.end));
    ui.quotes.append(chip);
  }
  if (!data.quotes?.length) {
    const empty = document.createElement("span");
    empty.className = "chip";
    empty.textContent = "None yet";
    ui.quotes.append(empty);
  }
  ui.unclear.replaceChildren();
  for (const item of data.unclear || []) {
    const chip = document.createElement("span");
    chip.className = "chip warn";
    chip.textContent = item.phrase;
    ui.unclear.append(chip);
  }
  if (!data.unclear?.length) {
    const empty = document.createElement("span");
    empty.className = "chip";
    empty.textContent = "None";
    ui.unclear.append(empty);
  }
  const lines = (data.tools || []).map(humanTool);
  ui.tools.textContent = lines.join(" ");
  ui.tools.classList.toggle("warn", (data.tools || []).some((tool) => !tool.ok));
  renderCompare(data.tools);
  if (typeof data.unlocked === "boolean") state.unlocked = data.unlocked;
  state.quotes = (data.quotes || []).map((quote) => quote.text);
  renderSteps(state.quotes.length, Boolean(data.card?.markdown));
  if (data.card?.markdown) {
    state.markdown = data.card.markdown;
    state.cardQuotes = data.card.quotes || state.quotes;
    ui.cardPanel.hidden = false;
    ui.cardFile.hidden = false;
    showLater();
    ui.cardPanel.classList.add("arrive");
    ui.card.textContent = data.card.markdown;
    ui.download.href = `/api/session/${state.sessionId}/card.md`;
    ui.downloadProof.href = `/api/session/${state.sessionId}/proof.json`;
    renderPreview(data.card.quotes || state.quotes, data.card.confirmedAt);
    ui.locked.hidden = state.unlocked;
    ui.paid.hidden = !state.unlocked;
    if (state.unlocked) ui.pay.hidden = true;
  }
}

function renderPreview(quotes, confirmedAt) {
  ui.keepsake.className = `keepsake ${state.paper}`;
  ui.keepsakePhoto.src = state.photoUrl || "";
  ui.keepsakePhoto.alt = ui.photoName.textContent || "Your photo";
  const when = String(confirmedAt || "");
  ui.keepsakeDate.textContent = /^\d{4}-\d{2}-\d{2}T/.test(when)
    ? when.slice(0, 16).replace("T", " ")
    : when;
  ui.cardPreview.replaceChildren();
  for (const quote of quotes) {
    const text = typeof quote === "string" ? quote : quote.text;
    const record = state.quoteRecords.find((item) => item.text === text) || {};
    const block = document.createElement("blockquote");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "quote-line";
    button.textContent = text;
    button.addEventListener("click", () => showSource(text, record.start, record.end));
    block.append(button);
    ui.cardPreview.append(block);
  }
}

async function postTurn(text, words) {
  const res = await fetch(`/api/session/${state.sessionId}/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, words: words || [] }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = data.error || "This turn failed";
    const detail = data.detail ? ` ${data.detail}` : "";
    throw new Error(message + detail);
  }
  return data;
}

const VOICE_NAMES = ["Samantha", "Google US English", "Daniel", "Alex"];

function pickVoice() {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  return (
    voices.find((voice) => VOICE_NAMES.some((name) => voice.name.includes(name)) && /^en/i.test(voice.lang)) ||
    voices.find((voice) => /^en(-|_)?US/i.test(voice.lang)) ||
    voices.find((voice) => /^en/i.test(voice.lang)) ||
    null
  );
}

function showVoice() {
  const voice = pickVoice();
  ui.voice.textContent = voice ? `Voice · ${voice.name}` : "Voice · on-screen text if this browser has no English voice";
}

function speak(text) {
  const clean = String(text || "").trim();
  if (!clean || !window.speechSynthesis) return Promise.resolve();
  const gen = state.speakGen;
  state.lastAgent = clean;
  state.speaking = true;
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(clean);
    utterance.lang = "en-US";
    const voice = pickVoice();
    if (voice) utterance.voice = voice;
    const done = () => {
      if (state.speakGen === gen) state.speaking = false;
      resolve();
    };
    utterance.onend = done;
    utterance.onerror = done;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  });
}

function barge() {
  state.speakGen += 1;
  state.speaking = false;
  window.speechSynthesis?.cancel();
  setPhase("interrupted");
  setStatus("You cut in. I'm listening.");
  setPhase("listening");
}

async function handleFinal(text, words) {
  const heard = String(text || "").trim();
  if (!heard || isEcho(heard, state.lastAgent)) return;
  ui.live.textContent = "";
  addLog("You", heard);
  const genAtSend = state.speakGen;
  setPhase("thinking");
  setStatus("Thinking of the next short question…");
  try {
    const data = await postTurn(heard, words);
    renderSession(data);
    if (data.say) addLog("Assistant", data.say);
    if (state.speakGen === genAtSend) {
      setPhase("speaking");
      setStatus("The assistant is speaking. You can cut in.");
      await speak(data.say);
      if (state.speakGen === genAtSend) {
        setPhase(state.ready ? "listening" : "idle");
        setStatus(state.ready ? "Listening." : "This turn is over.");
      }
    } else {
      setPhase("listening");
      setStatus("That line was interrupted. Keep going.");
    }
  } catch (err) {
    setBanner(err.message);
    setPhase("idle");
    setStatus("Send that line again.");
  }
}

function enqueueTurn(text, words) {
  state.turnChain = state.turnChain
    .then(() => handleFinal(text, words))
    .catch((err) => setBanner(err.message));
  return state.turnChain;
}

function onTranscript(msg) {
  const text = msg.transcript || "";
  if (!msg.end_of_turn) {
    ui.live.textContent = text ? `Hearing: ${text}` : "";
    if (state.speaking && looksLikeSpeech(text) && !isEcho(text, state.lastAgent)) barge();
    return;
  }
  if (state.committed.has(msg.turn_order)) return;
  if (!msg.turn_is_formatted) {
    state.pending = msg;
    clearTimeout(state.pendingTimer);
    state.pendingTimer = setTimeout(() => {
      const pending = state.pending;
      state.pending = null;
      if (!pending || state.committed.has(pending.turn_order)) return;
      state.committed.add(pending.turn_order);
      enqueueTurn(pending.transcript, pending.words);
    }, 450);
    return;
  }
  clearTimeout(state.pendingTimer);
  state.pending = null;
  state.committed.add(msg.turn_order);
  enqueueTurn(text, msg.words);
}

function appendPcm(chunk) {
  if (!state.ready || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  const next = new Int16Array(state.pcmQueue.length + chunk.length);
  next.set(state.pcmQueue);
  next.set(chunk, state.pcmQueue.length);
  state.pcmQueue = next;
  const frame = 800;
  while (state.pcmQueue.length >= frame) {
    const piece = state.pcmQueue.slice(0, frame);
    state.pcmQueue = state.pcmQueue.slice(frame);
    state.ws.send(piece.buffer);
  }
}

async function startVoice() {
  if (!state.sessionId) return;
  setBanner("");
  ui.start.disabled = true;
  setStatus("Requesting a temporary token…");
  const tokenRes = await fetch("/api/streaming-token");
  const tokenBody = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok) {
    ui.start.disabled = false;
    setBanner(tokenBody.error || "Could not get a streaming token");
    if (tokenBody.detail) setBanner(`${tokenBody.error} ${tokenBody.detail}`);
    setStatus("Voice is not connected yet.");
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: false, autoGainControl: true },
  });
  const audioCtx = new AudioContext();
  await audioCtx.resume();
  await audioCtx.audioWorklet.addModule("/pcm-processor.js");
  const source = audioCtx.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(audioCtx, "pcm-processor", {
    processorOptions: { inputSampleRate: audioCtx.sampleRate, targetSampleRate: 16000 },
  });
  worklet.port.onmessage = (event) => appendPcm(new Int16Array(event.data));
  source.connect(worklet);
  state.stream = stream;
  state.audioCtx = audioCtx;

  const params = new URLSearchParams({
    sample_rate: "16000",
    speech_model: "universal-3-6-pro",
    encoding: "pcm_s16le",
    language_codes: JSON.stringify(["en"]),
    language_detection: "true",
    token: tokenBody.token,
  });
  const ws = new WebSocket(`wss://streaming.assemblyai.com/v3/ws?${params}`);
  state.ws = ws;
  ws.addEventListener("open", () => {
    ui.stop.disabled = false;
    setStatus("Connecting transcription…");
  });
  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type === "Begin") {
      state.ready = true;
      ui.stop.disabled = false;
      setPhase("listening");
      setStatus("Listening.");
      addLog("Assistant", GREETING);
      setPhase("speaking");
      speak(GREETING).then(() => {
        if (state.ready && !state.speaking) {
          setPhase("listening");
          setStatus("Listening.");
        }
      });
      return;
    }
    if (msg.type === "Turn") {
      onTranscript(msg);
      return;
    }
    if (msg.type === "Termination") {
      setStatus("The voice session has ended.");
      cleanupAudio();
      return;
    }
    if (msg.error || msg.type === "Error") {
      setBanner(String(msg.error || msg.message || "The transcription session failed").slice(0, 180));
    }
  });
  ws.addEventListener("close", () => {
    state.ready = false;
    if (!ui.cardPanel.hidden) setStatus("Voice disconnected. The card is still here.");
    else setStatus("The voice connection closed.");
    cleanupAudio();
  });
  ws.addEventListener("error", () => {
    setBanner("Could not connect to live transcription. Check that the key is valid and the browser allows the microphone.");
  });
}

function cleanupAudio() {
  state.ready = false;
  state.pcmQueue = new Int16Array(0);
  ui.start.disabled = !state.sessionId;
  ui.stop.disabled = true;
  state.stream?.getTracks().forEach((track) => track.stop());
  state.stream = null;
  if (state.audioCtx && state.audioCtx.state !== "closed") state.audioCtx.close().catch(() => {});
  state.audioCtx = null;
}

function endVoice() {
  const ws = state.ws;
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "Terminate" }));
  } else {
    cleanupAudio();
  }
  window.speechSynthesis?.cancel();
  state.speaking = false;
}

function applySession(data) {
  state.sessionId = data.id;
  try {
    localStorage.setItem(SESSION_KEY, data.id);
  } catch {
    /* private mode */
  }
  ui.frame.classList.add("has-photo");
  ui.frame.querySelectorAll("img").forEach((node) => node.remove());
  const img = document.createElement("img");
  img.alt = "Uploaded old photo";
  img.src = data.photoUrl;
  ui.frame.append(img);
  state.photoUrl = data.photoUrl;
  ui.photoName.textContent = data.photoFilename;
  ui.start.disabled = false;
  ui.own.hidden = true;
  state.playingExample = false;
  renderSession(data);
}

async function startSessionFromResponse(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    setBanner(data.error || "The photo was not saved");
    setStatus("Try a jpg, png, webp, or gif.");
    return;
  }
  setBanner("");
  applySession(data);
  setStatus('Photo ready. Press "Start telling", then speak.');
}

ui.file.addEventListener("change", async () => {
  const file = ui.file.files?.[0];
  if (!file) return;
  setStatus("Saving the photo…");
  const dataBase64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || "");
      resolve(value.slice(value.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("Could not read this photo"));
    reader.readAsDataURL(file);
  });
  const res = await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, dataBase64 }),
  });
  await startSessionFromResponse(res);
});

const EXAMPLE = [
  { who: "Assistant", text: "Who is in this photo?" },
  { who: "You", text: "The courtyard was behind the house.", quote: true },
  { who: "Assistant", text: "Where was this?" },
  { who: "You", text: "I still know the door.", quote: true },
  { who: "Assistant", text: "About when was this?" },
  { who: "You", text: "It was the last summer we lived there.", quote: true },
  { who: "Assistant", text: "Should I make the card? Say yes." },
  { who: "You", text: "yes" },
  { who: "Assistant", text: "The card is ready. It contains only the quotes you confirmed.", seal: true },
];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function showExamplePhoto() {
  ui.frame.classList.add("has-photo");
  ui.frame.querySelectorAll("img").forEach((node) => node.remove());
  const img = document.createElement("img");
  img.alt = "Example courtyard";
  img.src = "/sample-photo.png";
  ui.frame.append(img);
  state.photoUrl = "/sample-photo.png";
  ui.photoName.textContent = "Example · courtyard";
}

function resetTeller() {
  state.sessionId = null;
  state.playingExample = false;
  state.quotes = [];
  state.cardQuotes = [];
  state.quoteRecords = [];
  state.transcript = "";
  ui.own.hidden = true;
  ui.frame.classList.remove("has-photo");
  ui.frame.querySelectorAll("img").forEach((node) => node.remove());
  ui.photoName.textContent = "";
  ui.start.disabled = true;
  ui.cardPanel.hidden = true;
  ui.later.hidden = true;
  ui.laterStatus.textContent = "";
  ui.now.textContent = "Who is in this photo?";
  ui.quotes.replaceChildren();
  ui.log.replaceChildren(ui.logEmpty);
  ui.logEmpty.hidden = false;
  renderSteps(0, false);
  setBanner("");
  setStatus("Choose a photo, or watch the example again.");
}

async function playExample() {
  if (state.playingExample) return;
  state.playingExample = true;
  state.sessionId = null;
  ui.start.disabled = true;
  ui.own.hidden = true;
  ui.cardPanel.hidden = true;
  ui.log.replaceChildren();
  ui.logEmpty.hidden = true;
  const conversation = ui.log.closest("details");
  if (conversation) conversation.open = true;
  ui.quotes.replaceChildren();
  showExamplePhoto();
  setBanner("A finished example. Watch what gets said, then use your own photo.");
  setStatus("Playing the example…");
  const quotes = [];
  const said = [];
  for (const line of EXAMPLE) {
    if (!state.playingExample) return;
    said.push(line.text);
    addLog(line.who, line.text);
    ui.now.textContent = line.text;
    if (line.quote) {
      quotes.push(line.text);
      state.transcript = quotes.join("\n");
      state.quoteRecords = quotes.map((text) => ({ text }));
      state.quotes = quotes.slice();
      ui.quotes.replaceChildren();
      for (const quote of state.quoteRecords) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "chip";
        chip.textContent = quote.text;
        chip.addEventListener("click", () => showSource(quote.text, quote.start, quote.end));
        ui.quotes.append(chip);
      }
      renderSteps(quotes.length, false);
    }
    if (line.seal) {
      state.transcript = quotes.join("\n");
      state.cardQuotes = quotes.slice();
      renderSteps(quotes.length, true);
      ui.cardPanel.hidden = false;
      ui.cardFile.hidden = true;
      ui.source.hidden = true;
      ui.cardPanel.classList.add("arrive");
      ui.locked.hidden = true;
      ui.paid.hidden = true;
      ui.pay.hidden = true;
      ui.receipt.hidden = true;
      renderPreview(quotes, "");
      ui.keepsakeDate.textContent = "An example, not your card";
      showLater();
      ui.own.hidden = false;
    }
    await wait(700);
  }
  state.playingExample = false;
  setStatus("That’s the whole example. Tell your own when you know the first sentence.");
}

function localStamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function showLater() {
  const soon = new Date(Date.now() + 2 * 60 * 1000);
  const year = new Date();
  year.setFullYear(year.getFullYear() + 1);
  year.setHours(9, 0, 0, 0);
  ui.laterWhen.min = localStamp(soon);
  if (!ui.laterWhen.value) ui.laterWhen.value = localStamp(year);
  ui.later.hidden = false;
}

ui.later.addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = ui.laterEmail.value.trim();
  const when = ui.laterWhen.value;
  const deliverAt = new Date(when);
  if (!email || Number.isNaN(deliverAt.getTime()) || deliverAt.getTime() <= Date.now() + 60_000) {
    ui.laterStatus.textContent = "Choose your email and a time at least a minute from now.";
    return;
  }
  const lines = state.cardQuotes.length ? state.cardQuotes : state.quotes;
  if (!lines.length) {
    ui.laterStatus.textContent = "Seal the card before emailing it.";
    return;
  }
  ui.laterStatus.textContent = "Sealing…";
  const body = { email, deliverAt: deliverAt.toISOString() };
  const url = state.sessionId ? `/api/session/${state.sessionId}/letter` : "/api/letter";
  if (!state.sessionId) body.example = true;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    ui.laterStatus.textContent = data.message || data.error || "The letter was not sealed.";
  } catch {
    ui.laterStatus.textContent = "The letter was not sealed.";
  }
});

ui.sample.addEventListener("click", () => {
  playExample().catch((err) => setBanner(err.message));
});

ui.own.addEventListener("click", resetTeller);

async function restoreSession() {
  let id;
  try {
    id = localStorage.getItem(SESSION_KEY);
  } catch {
    return;
  }
  if (!id) return;
  const res = await fetch(`/api/session/${id}`);
  if (!res.ok) {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
    return;
  }
  const data = await res.json();
  applySession(data);
  if (data.card) setStatus("Your card is still here after a refresh.");
  else setStatus('Photo ready. Press "Start telling", then speak.');
}

ui.start.addEventListener("click", () => {
  startVoice().catch((err) => {
    ui.start.disabled = false;
    setBanner(err.name || err.message || "The microphone or voice session did not start");
    setPhase("idle");
    cleanupAudio();
  });
});
ui.stop.addEventListener("click", endVoice);

ui.textForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!state.sessionId) {
    setBanner("Upload a photo first.");
    return;
  }
  const text = ui.textInput.value.trim();
  if (!text) return;
  ui.textInput.value = "";
  enqueueTurn(text, []);
});

window.addEventListener("pagehide", () => {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: "Terminate" }));
  }
});

function wrapLines(ctx, text, maxWidth) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 8);
}

function paperColors(paper) {
  if (paper === "back") return { bg: "#f7f1e8", ink: "#241c16", bar: "rgba(247,241,232,0.92)" };
  if (paper === "postcard") return { bg: "#f4efe6", ink: "#241c16", bar: "rgba(255,250,243,0.94)" };
  return { bg: "#241c16", ink: "#f4efe6", bar: "rgba(36,28,22,0.55)" };
}

function drawStoryFrame(ctx, image, quotes, progress) {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  const colors = paperColors(state.paper);
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, width, height);
  if (progress < 0.12) {
    ctx.fillStyle = colors.ink;
    ctx.font = "64px Georgia, serif";
    ctx.fillText("Memory Card", 64, height * 0.46);
    ctx.font = "28px Georgia, serif";
    ctx.fillText("Your words only", 64, height * 0.52);
    return;
  }
  if (progress > 0.88) {
    ctx.fillStyle = colors.ink;
    ctx.font = "42px Georgia, serif";
    ctx.fillText("Verbatim", 64, height * 0.48);
    return;
  }
  const span = 0.76;
  const local = (progress - 0.12) / span;
  const slots = Math.max(quotes.length, 1);
  const index = Math.min(slots - 1, Math.floor(local * slots));
  const quote = quotes[index] || "";
  if (image) {
    const zoom = 1 + local * 0.08;
    const scale = Math.max(width / image.width, (height * 0.62) / image.height) * zoom;
    const dw = image.width * scale;
    const dh = image.height * scale;
    ctx.drawImage(image, (width - dw) / 2, (height * 0.42 - dh) / 2, dw, dh);
  }
  ctx.fillStyle = colors.bar;
  ctx.fillRect(0, height * 0.58, width, height * 0.42);
  ctx.fillStyle = colors.ink;
  ctx.font = "28px Georgia, serif";
  ctx.fillText("Memory Card", 64, height * 0.66);
  ctx.font = "42px Georgia, serif";
  const lines = wrapLines(ctx, quote, width - 128);
  lines.forEach((line, i) => ctx.fillText(line, 64, height * 0.74 + i * 54));
}

function makeStoryVideo(quotes) {
  const canvas = document.createElement("canvas");
  canvas.width = 720;
  canvas.height = 1280;
  const ctx = canvas.getContext("2d");
  const image = ui.frame.querySelector("img");
  const mime = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
    ? "video/webm;codecs=vp9"
    : "video/webm";
  const stream = canvas.captureStream(30);
  const recorder = new MediaRecorder(stream, { mimeType: mime });
  const chunks = [];
  const duration = Math.min(18000, 4000 + quotes.length * 3500);
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data);
  };
  const done = new Promise((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || "video/webm" }));
  });
  recorder.start();
  const started = performance.now();
  function frame(now) {
    const progress = Math.min(1, (now - started) / duration);
    drawStoryFrame(ctx, image, quotes, progress);
    if (progress < 1) requestAnimationFrame(frame);
    else recorder.stop();
  }
  requestAnimationFrame(frame);
  return done;
}

ui.unlock.addEventListener("click", () => {
  if (!state.sessionId) return;
  const lines = state.cardQuotes.map((quote) => `“${quote}”`).join(" ");
  ui.payCopy.textContent = lines
    ? `You are buying this card only: ${lines} Markdown, proof, and video. Not a membership. This demo does not charge a card.`
    : "You are buying this card’s file and video. Not a membership. This demo does not charge a card.";
  ui.pay.hidden = false;
  if (state.paymentUrl) {
    ui.payLink.hidden = false;
    ui.payLink.href = state.paymentUrl;
    ui.payConfirm.textContent = "I've paid · unlock";
  }
});

ui.payConfirm.addEventListener("click", async () => {
  if (!state.sessionId) return;
  ui.payConfirm.disabled = true;
  const res = await fetch(`/api/session/${state.sessionId}/unlock`, { method: "POST" });
  const data = await res.json().catch(() => ({}));
  ui.payConfirm.disabled = false;
  if (!res.ok) {
    setBanner(data.error || "Unlock did not finish");
    return;
  }
  renderSession(data);
  ui.pay.hidden = true;
  const receipt = `MC-${Date.now().toString(36).toUpperCase()}`;
  const lines = state.cardQuotes.map((quote) => `“${quote}”`).join(" ");
  ui.payCopy.textContent = `You are buying this card only: ${lines} Markdown, proof, and video. Not a membership. This demo does not charge a card.`;
  ui.receipt.hidden = false;
  ui.receipt.textContent = `${receipt} · $1 · this card only · ${lines} · Markdown, proof, and video. Not a membership. Demo, no card charged.`;
  ui.videoStatus.textContent = "Unlocked. Download the card, or make the TikTok video.";
});

ui.makeVideo.addEventListener("click", async () => {
  if (!state.cardQuotes.length) {
    ui.videoStatus.textContent = "Say yes to seal the card. The video can only caption those lines.";
    return;
  }
  ui.makeVideo.disabled = true;
  ui.videoStatus.textContent = "Making a vertical video. Captions are the sealed quotes only.";
  try {
    const blob = await makeStoryVideo(state.cardQuotes);
    const type = blob.type || "video/webm";
    const ext = type.includes("mp4") ? "mp4" : "webm";
    state.videoFile = new File([blob], `memory-card.${ext}`, { type });
    ui.storyVideo.hidden = false;
    ui.storyVideo.src = URL.createObjectURL(blob);
    ui.share.hidden = false;
    const phone = navigator.canShare?.({ files: [state.videoFile] });
    ui.videoStatus.textContent = phone
      ? "Video ready. Share opens the phone sheet. Choose TikTok."
      : "Video ready. On a phone, share can open TikTok. Here it downloads and opens TikTok's upload page.";
  } catch (err) {
    ui.videoStatus.textContent = err.message || "The video could not be made.";
  }
  ui.makeVideo.disabled = false;
});

ui.share.addEventListener("click", async () => {
  const file = state.videoFile;
  if (!file) return;
  const text = state.quotes.join(" ");
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Memory Card", text });
      ui.videoStatus.textContent = "Share sheet opened. Choose TikTok.";
      return;
    } catch (err) {
      if (err.name === "AbortError") return;
    }
  }
  const url = URL.createObjectURL(file);
  const link = document.createElement("a");
  link.href = url;
  link.download = file.name;
  link.click();
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard may be blocked */
  }
  window.open("https://www.tiktok.com/tiktokstudio/upload", "_blank", "noopener");
  ui.videoStatus.textContent = "Video downloaded and the caption copied. TikTok's upload page is open.";
});

document.querySelectorAll("[data-paper]").forEach((button) => {
  button.addEventListener("click", () => {
    state.paper = button.dataset.paper;
    document.querySelectorAll("[data-paper]").forEach((item) => {
      item.setAttribute("aria-pressed", item === button ? "true" : "false");
    });
    if (state.quotes.length) renderPreview(state.quotes, ui.keepsakeDate.textContent);
  });
});

function bytesToBase64(bytes) {
  let binary = "";
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary);
}

ui.exportForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.sessionId || !state.unlocked) return;
  ui.videoStatus.textContent = "Packing the photo, the card, and the proof…";
  try {
    const [photo, markdown, proofRes] = await Promise.all([
      fetch(state.photoUrl).then((res) => res.arrayBuffer()),
      fetch(`/api/session/${state.sessionId}/card.md`).then((res) => res.text()),
      fetch(`/api/session/${state.sessionId}/proof.json`).then((res) => res.json()),
    ]);
    const payload = {
      version: 1,
      paper: state.paper,
      markdown,
      proof: proofRes,
      photoBase64: bytesToBase64(photo),
    };
    const passphrase = ui.passphrase.value;
    let fileBody;
    if (!passphrase) {
      fileBody = JSON.stringify({ version: 1, encrypted: false, payload }, null, 2);
    } else {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const keyMaterial = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(passphrase),
        "PBKDF2",
        false,
        ["deriveKey"],
      );
      const key = await crypto.subtle.deriveKey(
        { name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt"],
      );
      const cipher = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        key,
        new TextEncoder().encode(JSON.stringify(payload)),
      );
      fileBody = JSON.stringify({
        version: 1,
        encrypted: true,
        kdf: "PBKDF2-SHA256-100000",
        salt: bytesToBase64(salt),
        iv: bytesToBase64(iv),
        data: bytesToBase64(cipher),
      });
    }
    const blob = new Blob([fileBody], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "memory-card.bundle.json";
    link.click();
    ui.videoStatus.textContent = passphrase
      ? "Keepsake downloaded. It opens only with that passphrase."
      : "Keepsake downloaded. Add a passphrase next time to encrypt it.";
  } catch (err) {
    ui.videoStatus.textContent = explain(err.message || "The keepsake could not be packed.");
  }
});

window.speechSynthesis?.addEventListener?.("voiceschanged", showVoice);
showVoice();

fetch("/api/health")
  .then((res) => res.json())
  .then((data) => {
    state.paymentUrl = data.paymentUrl || "";
    if (data.assemblyai !== "configured") {
      setBanner("Speech is off until a key is in .env. You can still type, and the card uses the same rules.");
    }
    if (location.hash === "#sample") {
      ui.sample.click();
      return;
    }
    return restoreSession();
  })
  .catch(() => setBanner("This page could not reach the local server."));
