import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  SYSTEM_PROMPT,
  TOOLS,
  addUtterance,
  applyTool,
  captureStatement,
  confirmIfAgreed,
  createSession,
  localReply,
  publicView,
  turnUserContent,
} from "./lib/session.js";
import { chatComplete, hasKey, mintStreamingToken, parseCompletion, redact } from "./lib/aai.js";
import { proofJson } from "./lib/proof.js";
import { loadSession, persistSession } from "./lib/persist.js";
import { deliverDueLetters, EXAMPLE_QUOTES, scheduleLetter, sealedMessage, validateLetter } from "./lib/letter.js";
import { mailTransport } from "./lib/mail.js";

const root = path.dirname(fileURLToPath(import.meta.url));

function resolvePublicDir() {
  const candidates = [path.join(root, "public"), path.join(process.cwd(), "public")];
  return candidates.find((dir) => fs.existsSync(path.join(dir, "index.html"))) || candidates[0];
}

const publicDir = resolvePublicDir();

function loadEnvFile() {
  let text;
  try {
    text = fs.readFileSync(path.join(root, ".env"), "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key]) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) process.env[key] = value;
  }
}

export function dataDir() {
  if (process.env.MEMORY_NOTE_DATA) return process.env.MEMORY_NOTE_DATA;
  if (process.env.VERCEL) return path.join("/tmp", "memory-note");
  return path.join(root, "data");
}

const sessions = new Map();
const queues = new Map();

function resolveSession(id) {
  let session = sessions.get(id);
  if (session) return session;
  session = loadSession(dataDir(), id);
  if (session) sessions.set(id, session);
  return session;
}

function touchSession(session) {
  persistSession(dataDir(), session);
}

function publicPaymentUrl() {
  const url = process.env.STRIPE_PAYMENT_LINK || "";
  if (/^https:\/\/(buy\.stripe\.com|[\w.-]+\.lemonsqueezy\.com)\//.test(url)) return url;
  return null;
}

function send(res, status, obj) {
  let body = JSON.stringify(obj);
  const key = process.env.ASSEMBLYAI_API_KEY || "";
  if (key.length >= 8) body = body.split(key).join("[redacted]");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (chunk) => {
      n += chunk.length;
      if (n > limit) {
        const err = new Error("too_large");
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function safeFilename(name) {
  const base = String(name || "photo.jpg")
    .split(/[/\\]/)
    .pop()
    .replace(/[^\w.\-\u4e00-\u9fff]/g, "_")
    .slice(0, 80);
  return base || "photo.jpg";
}

function sniffImage(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && buf.subarray(0, 6).toString("ascii") === "GIF87a") return "image/gif";
  if (buf.length >= 6 && buf.subarray(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString("ascii") === "RIFF" &&
    buf.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function enqueue(id, fn) {
  const prev = queues.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(id, next.catch(() => {}));
  return next;
}

function fallbackSay(toolLog) {
  const saved = toolLog.filter((t) => t.name === "note_quote" && t.ok);
  const flagged = toolLog.filter((t) => t.name === "flag_unclear" && t.ok);
  const card = toolLog.find((t) => t.name === "confirm_card" && t.ok);
  const failed = toolLog.filter((t) => !t.ok);
  if (card) return "The card is ready. It contains only the quotes you confirmed.";
  if (flagged.length) return `I didn't catch this: ${flagged.map((t) => t.detail).join(", ")}. Please say it again.`;
  if (failed.length && !saved.length) return "I can't write that down yet. Please say one short line in your own words.";
  if (saved.length) return "I saved that in your own words.";
  return "I'm listening.";
}

async function runTurn(session, body) {
  if (!hasKey()) {
    const err = new Error("NO_KEY");
    err.code = "NO_KEY";
    throw err;
  }
  const utterance = addUtterance(session, { text: body?.text, words: body?.words });
  session.messages.push({
    role: "user",
    content: turnUserContent(utterance.text, utterance.words),
  });
  const toolLog = [];
  let say = "";
  let gatewayDown = false;
  for (let round = 0; round < 4 && !gatewayDown; round++) {
    let data;
    try {
      data = await chatComplete({
        messages: [{ role: "system", content: SYSTEM_PROMPT }, ...session.messages],
        tools: TOOLS,
      });
    } catch (err) {
      if (err.message !== "llm_failed") throw err;
      gatewayDown = true;
      break;
    }
    const { text, calls } = parseCompletion(data);
    if (!calls.length) {
      say = text;
      session.messages.push({ role: "assistant", content: say || "" });
      break;
    }
    const normalized = calls.map((call, i) => ({
      id: typeof call.id === "string" && call.id ? call.id : `call_${round}_${i}`,
      type: "function",
      function: {
        name: call.function?.name || call.name,
        arguments:
          typeof call.function?.arguments === "string"
            ? call.function.arguments
            : JSON.stringify(call.function?.arguments ?? call.arguments ?? {}),
      },
    }));
    session.messages.push({
      role: "assistant",
      content: text || null,
      tool_calls: normalized,
    });
    for (const call of normalized) {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || "{}");
      } catch {
        args = {};
      }
      const out = applyTool(session, call.function.name, args);
      toolLog.push(toolEntry(call.function.name, out));
      session.messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(out.ok ? out.result && stripCardAudio(out.result) : { error: out.error }),
      });
    }
    if (text) say = text;
  }
  if (gatewayDown) {
    const local = localReply(session);
    toolLog.push(...local.tools);
    say = local.say;
    session.messages.push({ role: "assistant", content: say });
  }
  const quoted = toolLog.some((tool) => tool.name === "note_quote" && tool.ok);
  const confirmed = toolLog.some((tool) => tool.name === "confirm_card" && tool.ok);
  if (!quoted && !confirmed) {
    const caught = captureStatement(session);
    if (caught) toolLog.push(toolEntry("note_quote", caught));
  }
  if (!toolLog.some((tool) => tool.name === "confirm_card" && tool.ok)) {
    const agreed = confirmIfAgreed(session);
    if (agreed) {
      toolLog.push(toolEntry("confirm_card", agreed));
      if (agreed.ok) say = "The card is ready. It contains only the quotes you confirmed.";
      else say = "Tell me one line about the photo first. Then say yes.";
    }
  }
  if (session.messages.length > 24) {
    session.messages.splice(0, session.messages.length - 24);
  }
  if (session.card) writeCard(session);
  touchSession(session);
  if (!say) say = fallbackSay(toolLog);
  return {
    say,
    tools: toolLog,
    ...publicView(session),
  };
}

function toolEntry(name, out) {
  const entry = {
    name,
    ok: out.ok,
    detail: out.ok
      ? out.result?.saved || out.result?.flagged || (out.result?.card ? "saved" : "ok")
      : out.error,
  };
  if (out.rejected) entry.rejected = out.rejected;
  if (out.heard) entry.heard = out.heard;
  return entry;
}

function stripCardAudio(result) {
  if (!result || !result.card) return result;
  return {
    saved: true,
    quotes: result.card.quotes,
    photoFilename: result.card.photoFilename,
  };
}

function writeCard(session) {
  const dir = path.join(dataDir(), "cards");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${session.id}.md`), session.card.markdown);
  const proof = proofJson(session);
  if (proof) fs.writeFileSync(path.join(dir, `${session.id}.proof.json`), proof);
}

async function scheduleFromBody(req, { example = false, quotes = null, sessionId = null } = {}) {
  let body;
  try {
    body = JSON.parse((await readBody(req, 20_000)).toString("utf8") || "{}");
  } catch {
    return { status: 400, body: { error: "Request is not JSON" } };
  }
  if (example && body.example !== true) {
    return { status: 400, body: { error: "This letter needs a sealed card." } };
  }
  const checked = validateLetter({ email: body.email, deliverAt: body.deliverAt });
  if (checked.error) return { status: 400, body: { error: checked.error } };
  const kept = example ? EXAMPLE_QUOTES : quotes;
  const saved = scheduleLetter(dataDir(), {
    to: checked.to,
    deliverAt: checked.at,
    quotes: kept,
    sessionId,
  });
  if (saved.error) return { status: 409, body: { error: saved.error } };
  return { status: 201, body: { ok: true, message: sealedMessage(checked.to, checked.at) } };
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    const paymentUrl = publicPaymentUrl();
    send(res, 200, {
      ok: true,
      app: "Memory Card",
      assemblyai: hasKey() ? "configured" : "missing",
      payments: paymentUrl ? "link" : "demo",
      paymentUrl,
      mail: mailTransport() || "missing",
      hint: hasKey()
        ? null
        : "This process has no ASSEMBLYAI_API_KEY. Speech recognition and questions will not start. Put the key in .env, then restart.",
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/streaming-token") {
    try {
      const token = await mintStreamingToken();
      send(res, 200, token);
    } catch (err) {
      if (err.code === "NO_KEY") {
        send(res, 503, {
          error: "The server has no ASSEMBLYAI_API_KEY, so it cannot request a temporary streaming token.",
        });
        return;
      }
      send(res, err.status && err.status < 500 ? 502 : 502, {
        error: "Could not get a temporary streaming token",
        detail: redact(err.detail || err.message),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/session/sample") {
    const samplePath = path.join(publicDir, "sample-photo.png");
    if (!fs.existsSync(samplePath)) {
      send(res, 500, { error: "Sample photo is missing on the server" });
      return;
    }
    const buf = fs.readFileSync(samplePath);
    const id = randomUUID();
    const filename = "sample-yard.png";
    const dir = path.join(dataDir(), "photos");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id), buf);
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ filename, mime: "image/png" }));
    const session = createSession({ id, photoFilename: filename });
    sessions.set(id, session);
    touchSession(session);
    send(res, 201, { ...publicView(session), photoUrl: `/api/photos/${id}` });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/session") {
    let payload;
    try {
      payload = JSON.parse((await readBody(req, 9_000_000)).toString("utf8") || "{}");
    } catch (err) {
      send(res, err.status || 400, { error: "Could not read the photo data" });
      return;
    }
    const filename = safeFilename(payload.filename);
    let buf;
    try {
      buf = Buffer.from(String(payload.dataBase64 || ""), "base64");
    } catch {
      send(res, 400, { error: "Photo is not valid base64" });
      return;
    }
    if (!buf.length || buf.length > 6_000_000) {
      send(res, 400, { error: "Photo is empty or larger than 6MB" });
      return;
    }
    const mime = sniffImage(buf);
    if (!mime) {
      send(res, 415, { error: "Only jpg, png, webp, or gif" });
      return;
    }
    const id = randomUUID();
    const dir = path.join(dataDir(), "photos");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id), buf);
    fs.writeFileSync(
      path.join(dir, `${id}.json`),
      JSON.stringify({ filename, mime }),
    );
    const session = createSession({ id, photoFilename: filename });
    sessions.set(id, session);
    touchSession(session);
    send(res, 201, { ...publicView(session), photoUrl: `/api/photos/${id}` });
    return;
  }

  const photoMatch = url.pathname.match(/^\/api\/photos\/([0-9a-f-]{36})$/);
  if (req.method === "GET" && photoMatch) {
    const id = photoMatch[1];
    const file = path.join(dataDir(), "photos", id);
    const metaPath = path.join(dataDir(), "photos", `${id}.json`);
    if (!fs.existsSync(file) || !fs.existsSync(metaPath)) {
      send(res, 404, { error: "Photo not found" });
      return;
    }
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    res.writeHead(200, {
      "Content-Type": meta.mime || "application/octet-stream",
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
    fs.createReadStream(file).pipe(res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/letter") {
    const scheduled = await scheduleFromBody(req, { example: true });
    send(res, scheduled.status, scheduled.body);
    return;
  }

  const sessionMatch = url.pathname.match(
    /^\/api\/session\/([0-9a-f-]{36})(\/turn|\/card\.md|\/proof\.json|\/unlock|\/letter)?$/,
  );
  if (sessionMatch) {
    const id = sessionMatch[1];
    const session = resolveSession(id);
    const tail = sessionMatch[2] || "";
    if (!session) {
      send(res, 404, { error: "This telling was not found. Please upload the photo again." });
      return;
    }
    if (req.method === "GET" && tail === "") {
      send(res, 200, { ...publicView(session), photoUrl: `/api/photos/${id}` });
      return;
    }
    if (req.method === "POST" && tail === "/unlock") {
      session.unlocked = true;
      touchSession(session);
      send(res, 200, publicView(session));
      return;
    }
    if (req.method === "GET" && tail === "/proof.json") {
      if (!session.card) {
        send(res, 404, { error: "No confirmed memory card yet" });
        return;
      }
      if (!session.unlocked) {
        send(res, 402, { error: "Unlock all features for $1 to download the verification file." });
        return;
      }
      const proof = proofJson(session);
      if (!proof) {
        send(res, 500, { error: "Could not build proof" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": 'attachment; filename="memory-card.proof.json"',
        "Cache-Control": "no-store",
      });
      res.end(proof);
      return;
    }
    if (req.method === "GET" && tail === "/card.md") {
      if (!session.card) {
        send(res, 404, { error: "No confirmed memory card yet" });
        return;
      }
      if (!session.unlocked) {
        send(res, 402, { error: "Unlock all features for $1 to download the card." });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": 'attachment; filename="memory-card.md"',
        "Cache-Control": "no-store",
      });
      res.end(session.card.markdown);
      return;
    }
    if (req.method === "POST" && tail === "/letter") {
      if (!session.card?.quotes?.length) {
        send(res, 404, { error: "Seal the card before emailing it." });
        return;
      }
      const scheduled = await scheduleFromBody(req, { quotes: session.card.quotes, sessionId: session.id });
      send(res, scheduled.status, scheduled.body);
      return;
    }
    if (req.method === "POST" && tail === "/turn") {
      let body;
      try {
        body = JSON.parse((await readBody(req, 200_000)).toString("utf8") || "{}");
      } catch {
        send(res, 400, { error: "Request is not JSON" });
        return;
      }
      try {
        const result = await enqueue(id, () => runTurn(session, body));
        send(res, 200, result);
      } catch (err) {
        if (err.status === 400) {
          send(res, 400, { error: err.message });
          return;
        }
        if (err.code === "NO_KEY") {
          send(res, 503, {
            error: "The server has no ASSEMBLYAI_API_KEY, so it cannot continue the questions or write a card.",
          });
          return;
        }
        send(res, 502, {
          error: "This turn did not finish",
          detail: redact(err.detail || err.message),
        });
      }
      return;
    }
  }

  send(res, 404, { error: "No such endpoint" });
}

const STATIC = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

function serveStatic(req, res, url) {
  const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  if (rel.includes("..") || path.isAbsolute(rel)) {
    send(res, 400, { error: "Invalid path" });
    return;
  }
  const file = path.join(publicDir, rel);
  if (!file.startsWith(publicDir + path.sep) && file !== publicDir) {
    send(res, 400, { error: "Invalid path" });
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    send(res, 404, { error: "Page not found" });
    return;
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    "Content-Type": STATIC[ext] || "application/octet-stream",
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; connect-src 'self' wss://streaming.assemblyai.com; img-src 'self' blob: data:; media-src 'self' blob:; style-src 'self'; script-src 'self'; base-uri 'none'; form-action 'self'",
  });
  fs.createReadStream(file).pipe(res);
}

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    try {
      if (url.pathname.startsWith("/api/")) {
        await handleApi(req, res, url);
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        send(res, 405, { error: "Method not allowed" });
        return;
      }
      serveStatic(req, res, url);
    } catch (err) {
      if (!res.headersSent) send(res, 500, { error: "Server error", detail: redact(err.message) });
    }
  });
}

const server = createServer();
export default server;

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain || process.env.VERCEL) {
  if (isMain) loadEnvFile();
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || (process.env.VERCEL ? "0.0.0.0" : "127.0.0.1");
  server.listen(port, host, () => {
    const where = host === "0.0.0.0" ? `http://0.0.0.0:${port}` : `http://127.0.0.1:${port}`;
    const keyState = hasKey() ? "key loaded from the environment (not printed)" : "no ASSEMBLYAI_API_KEY, speech and questions unavailable";
    process.stdout.write(`Memory Card ${where}  ${keyState}\n`);
    const timer = setInterval(() => {
      deliverDueLetters(dataDir()).catch(() => {});
    }, 30_000);
    timer.unref();
    deliverDueLetters(dataDir()).catch(() => {});
  });
}
