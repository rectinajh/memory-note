import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { mailTransport, sendLetter } from "./mail.js";

export const EXAMPLE_QUOTES = [
  "The courtyard was behind the house.",
  "I still know the door.",
  "It was the last summer we lived there.",
];

const SUBJECT = "A card you sealed for yourself";

export function validateLetter({ email, deliverAt, now = Date.now() }) {
  const to = String(email || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) || to.length > 254) {
    return { error: "Enter the email address that should receive this." };
  }
  const at = new Date(deliverAt);
  if (Number.isNaN(at.getTime())) return { error: "Choose a date and time." };
  if (at.getTime() <= now + 60_000) return { error: "Choose a time at least a minute from now." };
  const fiveYears = now + 5 * 366 * 24 * 60 * 60 * 1000;
  if (at.getTime() > fiveYears) return { error: "Choose a time within five years." };
  return { to, at };
}

export function letterText(quotes) {
  const lines = quotes.map((quote) => `"${String(quote).replace(/\s+/g, " ").trim()}"`);
  return ["These are the words you kept.", "", ...lines.flatMap((line) => [line, ""]), "You sealed this card for yourself. This is the only email.", ""].join("\n");
}

export function sealedMessage(email, deliverAt) {
  const when = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(deliverAt));
  const via = mailTransport();
  const how = via
    ? "It sends once. Leave Memory Card running until then."
    : "This server has no mailbox yet, so the letter is saved and cannot leave.";
  return `Sealed. One email to ${email} on ${when} China Standard Time. ${how}`;
}

function lettersDir(dir) {
  return path.join(dir, "letters");
}

function readPending(folder) {
  if (!fs.existsSync(folder)) return [];
  return fs
    .readdirSync(folder)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      const file = path.join(folder, name);
      return { file, row: JSON.parse(fs.readFileSync(file, "utf8")) };
    });
}

export function scheduleLetter(dir, { to, deliverAt, quotes, sessionId = null }) {
  const folder = lettersDir(dir);
  fs.mkdirSync(folder, { recursive: true });
  const pending = readPending(folder).filter((item) => !item.row.sentAt && (item.row.attempts || 0) < 5);
  if (pending.length >= 30) return { error: "Too many unsent letters on this computer." };
  if (sessionId && pending.some((item) => item.row.sessionId === sessionId)) {
    return { error: "This card already has a letter waiting." };
  }
  if (!sessionId && pending.some((item) => item.row.to === to)) {
    return { error: "That address already has a letter waiting." };
  }
  const id = randomUUID();
  const row = {
    id,
    to,
    deliverAt: deliverAt.toISOString(),
    quotes,
    sessionId,
    createdAt: new Date().toISOString(),
    sentAt: null,
    attempts: 0,
  };
  fs.writeFileSync(path.join(folder, `${id}.json`), JSON.stringify(row, null, 2));
  return { ok: true, id, deliverAt: row.deliverAt };
}

export async function deliverDueLetters(dir, { now = new Date(), send = sendLetter } = {}) {
  const folder = lettersDir(dir);
  const sent = [];
  for (const item of readPending(folder)) {
    const row = item.row;
    if (row.sentAt || (row.attempts || 0) >= 5) continue;
    if (new Date(row.deliverAt).getTime() > now.getTime()) continue;
    try {
      await send({ to: row.to, subject: SUBJECT, text: letterText(row.quotes) });
      row.sentAt = new Date().toISOString();
      sent.push(row.id);
    } catch (err) {
      row.attempts = (row.attempts || 0) + 1;
      row.lastError = String(err.message || "send_failed").slice(0, 180);
    }
    fs.writeFileSync(item.file, JSON.stringify(row, null, 2));
  }
  return sent;
}
