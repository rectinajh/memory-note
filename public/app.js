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
  cardPanel: $("card-panel"),
  card: $("card"),
  download: $("download"),
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
};

const GREETING = "我在听。这张照片是你的。先告诉我，照片里有谁？";

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
  if (/[\u4e00-\u9fff]/.test(t)) return true;
  return t.length >= 3;
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
    empty.textContent = "还没有";
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
    empty.textContent = "没有";
    ui.unclear.append(empty);
  }
  const lines = (data.tools || []).map((tool) => {
    const mark = tool.ok ? "记下" : "拒绝";
    return `${mark} ${tool.name}：${tool.detail}`;
  });
  ui.tools.textContent = lines.join(" ｜ ");
  if (data.card?.markdown) {
    ui.cardPanel.hidden = false;
    ui.card.textContent = data.card.markdown;
    ui.download.href = `/api/session/${state.sessionId}/card.md`;
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
    const message = data.error || "这一轮失败了";
    const detail = data.detail ? ` ${data.detail}` : "";
    throw new Error(message + detail);
  }
  return data;
}

function pickVoice() {
  const voices = window.speechSynthesis?.getVoices?.() || [];
  return (
    voices.find((voice) => /^zh(-|_)?(CN|Hans)/i.test(voice.lang)) ||
    voices.find((voice) => /^zh/i.test(voice.lang)) ||
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
    utterance.lang = "zh-CN";
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
  setStatus("你插话了，我在听。");
}

async function handleFinal(text, words) {
  const heard = String(text || "").trim();
  if (!heard || isEcho(heard, state.lastAgent)) return;
  ui.live.textContent = "";
  addLog("你", heard);
  const genAtSend = state.speakGen;
  setStatus("在想下一句短问题…");
  try {
    const data = await postTurn(heard, words);
    renderSession(data);
    if (data.say) addLog("助手", data.say);
    if (state.speakGen === genAtSend) {
      setStatus("助手在说。你可以直接打断。");
      await speak(data.say);
      if (state.speakGen === genAtSend) setStatus(state.ready ? "在听。" : "这一轮结束了。");
    } else {
      setStatus("上一句被打断了。继续说就行。");
    }
  } catch (err) {
    setBanner(err.message);
    setStatus("这一轮没有完成。");
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
    ui.live.textContent = text ? `正在听：${text}` : "";
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
  setStatus("正在申请临时令牌…");
  const tokenRes = await fetch("/api/streaming-token");
  const tokenBody = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok) {
    ui.start.disabled = false;
    setBanner(tokenBody.error || "拿不到转写令牌");
    if (tokenBody.detail) setBanner(`${tokenBody.error} ${tokenBody.detail}`);
    setStatus("还没连上语音。");
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
    language_codes: JSON.stringify(["zh"]),
    language_detection: "true",
    token: tokenBody.token,
  });
  const ws = new WebSocket(`wss://streaming.assemblyai.com/v3/ws?${params}`);
  state.ws = ws;
  ws.addEventListener("open", () => {
    ui.stop.disabled = false;
    setStatus("正在接通转写…");
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
      setStatus("可以开始说了。");
      addLog("助手", GREETING);
      speak(GREETING);
      return;
    }
    if (msg.type === "Turn") {
      onTranscript(msg);
      return;
    }
    if (msg.type === "Termination") {
      setStatus("语音会话已结束。");
      cleanupAudio();
      return;
    }
    if (msg.error || msg.type === "Error") {
      setBanner(String(msg.error || msg.message || "转写会话出错").slice(0, 180));
    }
  });
  ws.addEventListener("close", () => {
    state.ready = false;
    if (!ui.cardPanel.hidden) setStatus("语音已断开。卡片还在。");
    else setStatus("语音连接已断开。");
    cleanupAudio();
  });
  ws.addEventListener("error", () => {
    setBanner("连不上实时转写。请确认密钥有效，并且浏览器允许麦克风。");
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

ui.file.addEventListener("change", async () => {
  const file = ui.file.files?.[0];
  if (!file) return;
  setBanner("");
  setStatus("正在保存照片…");
  const dataBase64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const value = String(reader.result || "");
      resolve(value.slice(value.indexOf(",") + 1));
    };
    reader.onerror = () => reject(new Error("读不到这张照片"));
    reader.readAsDataURL(file);
  });
  const res = await fetch("/api/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filename: file.name, dataBase64 }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    setBanner(data.error || "照片没有保存");
    setStatus("请换一张 jpg、png、webp 或 gif。");
    return;
  }
  state.sessionId = data.id;
  ui.frame.replaceChildren();
  const img = document.createElement("img");
  img.alt = "上传的旧照片";
  img.src = data.photoUrl;
  ui.frame.append(img);
  ui.photoName.textContent = data.photoFilename;
  ui.start.disabled = false;
  setStatus("照片好了。按「开始讲述」，然后说话。");
  renderSession(data);
});

ui.start.addEventListener("click", () => {
  startVoice().catch((err) => {
    ui.start.disabled = false;
    setBanner(err.message || "麦克风或语音会话没有开始");
    cleanupAudio();
  });
});
ui.stop.addEventListener("click", endVoice);

ui.textForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!state.sessionId) {
    setBanner("请先上传照片。");
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

window.speechSynthesis?.addEventListener?.("voiceschanged", () => pickVoice());

fetch("/api/health")
  .then((res) => res.json())
  .then((data) => {
    if (data.assemblyai !== "configured") setBanner(data.hint || "没有配置语音密钥。");
  })
  .catch(() => setBanner("页面没有连上本地服务。"));
