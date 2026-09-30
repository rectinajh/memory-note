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
  makeVideo: $("make-video"),
  share: $("share"),
  videoStatus: $("video-status"),
  storyVideo: $("story-video"),
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
};

const GREETING = "I'm listening. This photo is yours. Who is in it?";
const SESSION_KEY = "memory-card-session-id";

function setStatus(text) {
  ui.status.textContent = text;
}

function setBanner(text) {
  if (!text) {
    ui.banner.hidden = true;
    ui.banner.textContent = "";
    return;
  }
  ui.banner.hidden = false;
  ui.banner.textContent = text;
}

function addLog(who, text) {
  const row = document.createElement("div");
  row.className = "bubble";
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

function renderSession(data) {
  ui.quotes.replaceChildren();
  for (const quote of data.quotes || []) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.textContent = quote.text;
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
  const lines = (data.tools || []).map((tool) => {
    const mark = tool.ok ? "Saved" : "Rejected";
    return `${mark} ${tool.name}: ${tool.detail}`;
  });
  ui.tools.textContent = lines.join(" | ");
  ui.tools.classList.toggle("warn", (data.tools || []).some((tool) => !tool.ok));
  if (typeof data.unlocked === "boolean") state.unlocked = data.unlocked;
  state.quotes = (data.quotes || []).map((quote) => quote.text);
  if (data.card?.markdown) {
    ui.cardPanel.hidden = false;
    ui.card.textContent = data.card.markdown;
    ui.download.href = `/api/session/${state.sessionId}/card.md`;
    ui.downloadProof.href = `/api/session/${state.sessionId}/proof.json`;
    renderPreview(data.card.quotes || state.quotes);
    ui.locked.hidden = state.unlocked;
    ui.paid.hidden = !state.unlocked;
  }
}

function renderPreview(quotes) {
  ui.cardPreview.replaceChildren();
  const title = document.createElement("p");
  title.className = "status";
  title.textContent = ui.photoName.textContent || "Your photo";
  ui.cardPreview.append(title);
  for (const quote of quotes) {
    const block = document.createElement("blockquote");
    block.textContent = quote;
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

function pickVoice() {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  return (
    voices.find((voice) => /^en(-|_)?US/i.test(voice.lang)) ||
    voices.find((voice) => /^en/i.test(voice.lang)) ||
    null
  );
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
  setStatus("You cut in. I'm listening.");
}

async function handleFinal(text, words) {
  const heard = String(text || "").trim();
  if (!heard || isEcho(heard, state.lastAgent)) return;
  ui.live.textContent = "";
  addLog("You", heard);
  const genAtSend = state.speakGen;
  setStatus("Thinking of the next short question…");
  try {
    const data = await postTurn(heard, words);
    renderSession(data);
    if (data.say) addLog("Assistant", data.say);
    if (state.speakGen === genAtSend) {
      setStatus("The assistant is speaking. You can cut in.");
      await speak(data.say);
      if (state.speakGen === genAtSend) setStatus(state.ready ? "Listening." : "This turn is over.");
    } else {
      setStatus("That line was interrupted. Keep going.");
    }
  } catch (err) {
    setBanner(err.message);
    setStatus("This turn did not finish.");
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
      setStatus("You can start talking.");
      addLog("Assistant", GREETING);
      speak(GREETING);
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
  ui.frame.replaceChildren();
  const img = document.createElement("img");
  img.alt = "Uploaded old photo";
  img.src = data.photoUrl;
  ui.frame.append(img);
  ui.photoName.textContent = data.photoFilename;
  ui.start.disabled = false;
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

ui.sample.addEventListener("click", async () => {
  setStatus("Loading the sample photo…");
  const res = await fetch("/api/session/sample", { method: "POST" });
  await startSessionFromResponse(res);
});

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
    setBanner(err.message || "The microphone or voice session did not start");
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

function drawStoryFrame(ctx, image, quotes, progress) {
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;
  ctx.fillStyle = "#241c16";
  ctx.fillRect(0, 0, width, height);
  const slots = Math.max(quotes.length, 1);
  const index = Math.min(slots - 1, Math.floor(progress * slots));
  const quote = quotes[index] || "";
  if (image) {
    const zoom = 1 + progress * 0.08;
    const scale = Math.max(width / image.width, (height * 0.62) / image.height) * zoom;
    const dw = image.width * scale;
    const dh = image.height * scale;
    ctx.drawImage(image, (width - dw) / 2, (height * 0.42 - dh) / 2, dw, dh);
  }
  ctx.fillStyle = "rgba(36, 28, 22, 0.55)";
  ctx.fillRect(0, height * 0.58, width, height * 0.42);
  ctx.fillStyle = "#f4efe6";
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

ui.unlock.addEventListener("click", async () => {
  if (!state.sessionId) return;
  ui.unlock.disabled = true;
  const res = await fetch(`/api/session/${state.sessionId}/unlock`, { method: "POST" });
  const data = await res.json().catch(() => ({}));
  ui.unlock.disabled = false;
  if (!res.ok) {
    setBanner(data.error || "Unlock did not finish");
    return;
  }
  renderSession(data);
  ui.videoStatus.textContent = "Unlocked. Download the card, or make the TikTok video.";
});

ui.makeVideo.addEventListener("click", async () => {
  if (!state.quotes.length) {
    ui.videoStatus.textContent = "Say yes to make the card before the video.";
    return;
  }
  ui.makeVideo.disabled = true;
  ui.videoStatus.textContent = "Making a vertical video from your photo and your words…";
  try {
    const blob = await makeStoryVideo(state.quotes);
    const type = blob.type || "video/webm";
    const ext = type.includes("mp4") ? "mp4" : "webm";
    state.videoFile = new File([blob], `memory-card.${ext}`, { type });
    ui.storyVideo.hidden = false;
    ui.storyVideo.src = URL.createObjectURL(blob);
    ui.share.hidden = false;
    ui.videoStatus.textContent = "Video ready. Share sends it to TikTok when your phone can. Otherwise it downloads and opens TikTok's upload page.";
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

window.speechSynthesis?.addEventListener?.("voiceschanged", () => pickVoice());

fetch("/api/health")
  .then((res) => res.json())
  .then((data) => {
    if (data.assemblyai !== "configured") setBanner(data.hint || "No speech key is configured.");
    return restoreSession();
  })
  .catch(() => setBanner("This page could not reach the local server."));
