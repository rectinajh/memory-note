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
  createSession,
  publicView,
  turnUserContent,
} from "./lib/session.js";
import { chatComplete, hasKey, mintStreamingToken, parseCompletion, redact } from "./lib/aai.js";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");

export function dataDir() {
  return process.env.MEMORY_NOTE_DATA || path.join(root, "data");
}

const sessions = new Map();
const queues = new Map();

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
  if (card) return "卡片写好了，里面只有你确认过的原话。";
  if (flagged.length) return `有个词我没听清：${flagged.map((t) => t.detail).join("、")}。请再说一遍。`;
  if (failed.length && !saved.length) return "这句我还不能写下来。请用你自己的话再说短短一句。";
  if (saved.length) return "这句话我按你的原话记下了。";
  return "我在听。";
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
  for (let round = 0; round < 4; round++) {
    const data = await chatComplete({
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...session.messages],
      tools: TOOLS,
    });
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
      const detail = out.ok
        ? out.result.saved || out.result.flagged || (out.result.card ? "已写入" : "ok")
        : out.error;
      toolLog.push({ name: call.function.name, ok: out.ok, detail });
      session.messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(out.ok ? out.result && stripCardAudio(out.result) : { error: out.error }),
      });
    }
    if (text) say = text;
  }
  if (session.messages.length > 24) {
    session.messages.splice(0, session.messages.length - 24);
  }
  if (session.card) writeCard(session);
  if (!say) say = fallbackSay(toolLog);
  return {
    say,
    tools: toolLog,
    ...publicView(session),
  };
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
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    send(res, 200, {
      ok: true,
      app: "记忆卡",
      assemblyai: hasKey() ? "configured" : "missing",
      hint: hasKey()
        ? null
        : "当前进程没有 ASSEMBLYAI_API_KEY。语音识别和提问都不会开始。请在启动 node 的环境里设置该变量后重启，不要把密钥写进文件。",
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
          error: "服务器没有读到 ASSEMBLYAI_API_KEY，无法申请临时转写令牌。",
        });
        return;
      }
      send(res, err.status && err.status < 500 ? 502 : 502, {
        error: "申请临时转写令牌失败",
        detail: redact(err.detail || err.message),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/session") {
    let payload;
    try {
      payload = JSON.parse((await readBody(req, 9_000_000)).toString("utf8") || "{}");
    } catch (err) {
      send(res, err.status || 400, { error: "照片数据无法读取" });
      return;
    }
    const filename = safeFilename(payload.filename);
    let buf;
    try {
      buf = Buffer.from(String(payload.dataBase64 || ""), "base64");
    } catch {
      send(res, 400, { error: "照片不是有效的 base64" });
      return;
    }
    if (!buf.length || buf.length > 6_000_000) {
      send(res, 400, { error: "照片为空或超过 6MB" });
      return;
    }
    const mime = sniffImage(buf);
    if (!mime) {
      send(res, 415, { error: "只接受 jpg、png、webp 或 gif" });
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
    send(res, 201, { ...publicView(session), photoUrl: `/api/photos/${id}` });
    return;
  }

  const photoMatch = url.pathname.match(/^\/api\/photos\/([0-9a-f-]{36})$/);
  if (req.method === "GET" && photoMatch) {
    const id = photoMatch[1];
    const file = path.join(dataDir(), "photos", id);
    const metaPath = path.join(dataDir(), "photos", `${id}.json`);
    if (!fs.existsSync(file) || !fs.existsSync(metaPath)) {
      send(res, 404, { error: "找不到照片" });
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

  const sessionMatch = url.pathname.match(/^\/api\/session\/([0-9a-f-]{36})(\/turn|\/card\.md)?$/);
  if (sessionMatch) {
    const id = sessionMatch[1];
    const session = sessions.get(id);
    const tail = sessionMatch[2] || "";
    if (!session) {
      send(res, 404, { error: "找不到这次讲述。请重新上传照片。" });
      return;
    }
    if (req.method === "GET" && tail === "") {
      send(res, 200, { ...publicView(session), photoUrl: `/api/photos/${id}` });
      return;
    }
    if (req.method === "GET" && tail === "/card.md") {
      if (!session.card) {
        send(res, 404, { error: "还没有确认的记忆卡" });
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": "attachment; filename*=UTF-8''%E8%AE%B0%E5%BF%86%E5%8D%A1.md",
        "Cache-Control": "no-store",
      });
      res.end(session.card.markdown);
      return;
    }
    if (req.method === "POST" && tail === "/turn") {
      let body;
      try {
        body = JSON.parse((await readBody(req, 200_000)).toString("utf8") || "{}");
      } catch {
        send(res, 400, { error: "请求不是 JSON" });
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
            error: "服务器没有读到 ASSEMBLYAI_API_KEY，没法继续问下去，也不会写卡片。",
          });
          return;
        }
        send(res, 502, {
          error: "这一轮没能完成",
          detail: redact(err.detail || err.message),
        });
      }
      return;
    }
  }

  send(res, 404, { error: "没有这个接口" });
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
    send(res, 400, { error: "路径无效" });
    return;
  }
  const file = path.join(publicDir, rel);
  if (!file.startsWith(publicDir + path.sep) && file !== publicDir) {
    send(res, 400, { error: "路径无效" });
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    send(res, 404, { error: "找不到页面" });
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
        send(res, 405, { error: "方法不允许" });
        return;
      }
      serveStatic(req, res, url);
    } catch (err) {
      if (!res.headersSent) send(res, 500, { error: "服务器出错", detail: redact(err.message) });
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const port = Number(process.env.PORT || 8787);
  const server = createServer();
  server.listen(port, "127.0.0.1", () => {
    const keyState = hasKey() ? "已从环境变量读到密钥（不会打印）" : "没有 ASSEMBLYAI_API_KEY，语音与提问不可用";
    process.stdout.write(`记忆卡 http://127.0.0.1:${port}  ${keyState}\n`);
  });
}
