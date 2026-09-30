// AssemblyAI calls. The API key is read from the environment at request time
// and is never returned, logged, or written to disk.

const TOKEN_URL = "https://streaming.assemblyai.com/v3/token";
const LLM_URL = "https://llm-gateway.assemblyai.com/v1/chat/completions";

// Cheap tool-capable models first. Sonnet is the last resort.
const MODELS = [
  "gemini-3.5-flash-lite",
  "gemini-2.5-flash-lite",
  "gpt-5-mini",
  "claude-haiku-4-5-20251001",
];

let modelIndex = 0;
let gatewayBlocked = false;

export function hasKey() {
  return typeof process.env.ASSEMBLYAI_API_KEY === "string" && process.env.ASSEMBLYAI_API_KEY.length > 0;
}

export function redact(text) {
  const key = process.env.ASSEMBLYAI_API_KEY || "";
  let s = String(text ?? "");
  if (key && key.length >= 8) s = s.split(key).join("[redacted]");
  s = s.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  return s.slice(0, 400);
}

function noKey() {
  const err = new Error("NO_KEY");
  err.code = "NO_KEY";
  throw err;
}

async function aaiText(url, options) {
  if (!hasKey()) noKey();
  const key = process.env.ASSEMBLYAI_API_KEY;
  const send = async (auth) => {
    const headers = new Headers(options.headers || {});
    headers.set("Authorization", auth);
    if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const res = await fetch(url, { ...options, headers });
    const text = await res.text();
    return { status: res.status, text };
  };
  let result = await send(key);
  if (result.status === 401) result = await send(`Bearer ${key}`);
  return result;
}

export async function mintStreamingToken() {
  const url = new URL(TOKEN_URL);
  url.searchParams.set("expires_in_seconds", "300");
  url.searchParams.set("max_session_duration_seconds", "900");
  const { status, text } = await aaiText(url, { method: "GET" });
  let json = {};
  try {
    json = JSON.parse(text);
  } catch {
    json = {};
  }
  if (status < 200 || status >= 300) {
    const err = new Error("token_failed");
    err.code = "UPSTREAM";
    err.status = status;
    err.detail = redact(json.message || json.error || text);
    throw err;
  }
  if (typeof json.token !== "string" || !json.token || json.token === process.env.ASSEMBLYAI_API_KEY) {
    const err = new Error("token_missing");
    err.code = "UPSTREAM";
    err.status = 502;
    err.detail = "Temporary token response was invalid";
    throw err;
  }
  return {
    token: json.token,
    expires_in_seconds: json.expires_in_seconds ?? 300,
  };
}

function messageText(content) {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return "";
}

export function parseCompletion(data) {
  const calls = [];
  const texts = [];
  for (const choice of data?.choices || []) {
    const message = choice?.message || {};
    const text = messageText(message.content).trim();
    if (text) texts.push(text);
    for (const call of message.tool_calls || []) calls.push(call);
  }
  return { text: texts.join("\n").trim(), calls };
}

function gatewayError(text) {
  const safe = redact(text);
  try {
    const json = JSON.parse(text);
    const errors = json?.metadata?.errors;
    if (Array.isArray(errors) && errors.length) return redact(errors.join("; "));
  } catch {
    return safe;
  }
  return safe;
}

export async function chatComplete({ messages, tools }) {
  if (gatewayBlocked) {
    const err = new Error("llm_failed");
    err.code = "UPSTREAM";
    err.status = 400;
    err.detail = "Your account does not have access to this LLM Gateway model";
    throw err;
  }
  let lastErr = null;
  for (let n = 0; n < MODELS.length; n++) {
    const idx = (modelIndex + n) % MODELS.length;
    const model = MODELS[idx];
    const { status, text } = await aaiText(LLM_URL, {
      method: "POST",
      body: JSON.stringify({
        model,
        messages,
        tools,
        tool_choice: "auto",
        temperature: 0.2,
        max_tokens: 600,
        post_processing_steps: [{ type: "json-repair" }],
      }),
    });
    if (status === 401 || status === 403) {
      const err = new Error("auth_failed");
      err.code = "UPSTREAM";
      err.status = status;
      err.detail = "The language model rejected the key on this server";
      throw err;
    }
    if (status < 200 || status >= 300) {
      lastErr = { status, detail: gatewayError(text), model };
      // Try the next model on "no such model" / validation errors only.
      if (status === 404 || status === 400 || status === 422) continue;
      const err = new Error("llm_failed");
      err.code = "UPSTREAM";
      err.status = status;
      err.detail = gatewayError(text);
      throw err;
    }
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      lastErr = { status, detail: "The model returned content that could not be parsed", model };
      continue;
    }
    modelIndex = idx;
    return json;
  }
  if (String(lastErr?.detail || "").includes("does not have access")) gatewayBlocked = true;
  const err = new Error("llm_failed");
  err.code = "UPSTREAM";
  err.status = lastErr?.status || 502;
  err.detail = lastErr?.detail || "No language model is available";
  throw err;
}
