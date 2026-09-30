import fs from "node:fs";
import path from "node:path";
import { createSession } from "./session.js";

const VERSION = 1;

export function sessionFile(dataRoot, id) {
  return path.join(dataRoot, "sessions", `${id}.json`);
}

export function persistSession(dataRoot, session) {
  const dir = path.join(dataRoot, "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const payload = {
    version: VERSION,
    id: session.id,
    photoFilename: session.photoFilename,
    createdAt: session.createdAt,
    utterances: session.utterances,
    quotes: session.quotes,
    unclear: session.unclear,
    card: session.card,
    unlocked: Boolean(session.unlocked),
    messages: session.messages,
  };
  fs.writeFileSync(sessionFile(dataRoot, session.id), JSON.stringify(payload));
}

export function loadSession(dataRoot, id) {
  const file = sessionFile(dataRoot, id);
  if (!fs.existsSync(file)) return null;
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (!payload || payload.id !== id) return null;
  const session = createSession({ id, photoFilename: payload.photoFilename || "photo.jpg" });
  session.createdAt = payload.createdAt || session.createdAt;
  session.utterances = Array.isArray(payload.utterances) ? payload.utterances : [];
  session.quotes = Array.isArray(payload.quotes) ? payload.quotes : [];
  session.unclear = Array.isArray(payload.unclear) ? payload.unclear : [];
  session.card = payload.card || null;
  session.unlocked = Boolean(payload.unlocked);
  session.messages = Array.isArray(payload.messages) ? payload.messages : [];
  return session;
}
