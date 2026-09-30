import net from "node:net";
import tls from "node:tls";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

function addressOf(from) {
  const match = String(from || "").match(/<([^>]+)>/);
  return (match ? match[1] : String(from || "")).trim();
}

function createReader(socket) {
  let buffer = "";
  const waiters = [];
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    while (waiters.length && buffer.includes("\r\n")) {
      const idx = buffer.indexOf("\r\n");
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      waiters.shift()(line);
    }
  });
  return {
    line() {
      if (buffer.includes("\r\n")) {
        const idx = buffer.indexOf("\r\n");
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        return Promise.resolve(line);
      }
      return new Promise((resolve, reject) => {
        waiters.push(resolve);
        socket.once("error", reject);
        socket.once("close", () => reject(new Error("The mail server closed the connection.")));
      });
    },
  };
}

async function expectCode(reader, code) {
  const lines = [];
  let line = await reader.line();
  lines.push(line);
  while (line.startsWith(`${code}-`)) {
    line = await reader.line();
    lines.push(line);
  }
  if (!line.startsWith(String(code))) throw new Error("The mail server refused the letter.");
  return lines.join("\n");
}

function command(socket, reader, line, code) {
  socket.write(`${line}\r\n`);
  return expectCode(reader, code);
}

function mailBody({ from, to, subject, text }) {
  const lines = String(text).replace(/\r\n/g, "\n").split("\n");
  const stuffed = lines.map((line) => (line.startsWith(".") ? `.${line}` : line)).join("\r\n");
  return [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    stuffed,
    ".",
  ].join("\r\n");
}

function openSocket(host, port, { secure = false, socket } = {}) {
  return new Promise((resolve, reject) => {
    const next = secure || socket ? tls.connect({ host, port, socket, servername: host }) : net.connect({ host, port });
    next.once("error", reject);
    const reader = createReader(next);
    next.once(secure || socket ? "secureConnect" : "connect", () => resolve({ socket: next, reader }));
  });
}

export async function sendSmtp({ host, port, user, pass, from, to, subject, text, secure = false, auth = true }) {
  let opened = await openSocket(host, port, { secure });
  let socket = opened.socket;
  let reader = opened.reader;
  await expectCode(reader, 220);
  let hello = await command(socket, reader, "EHLO memory-card", 250);
  if (!secure && /STARTTLS/i.test(hello)) {
    await command(socket, reader, "STARTTLS", 220);
    opened = await openSocket(host, port, { socket });
    socket = opened.socket;
    reader = opened.reader;
    await command(socket, reader, "EHLO memory-card", 250);
  }
  if (auth) {
    await command(socket, reader, "AUTH LOGIN", 334);
    await command(socket, reader, Buffer.from(user).toString("base64"), 334);
    await command(socket, reader, Buffer.from(pass).toString("base64"), 235);
  }
  await command(socket, reader, `MAIL FROM:<${addressOf(from)}>`, 250);
  await command(socket, reader, `RCPT TO:<${to}>`, 250);
  await command(socket, reader, "DATA", 354);
  socket.write(`${mailBody({ from, to, subject, text })}\r\n`);
  await expectCode(reader, 250);
  socket.destroy();
}

export async function sendResend({ from, to, subject, text }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [to], subject, text }),
  });
  if (!res.ok) throw new Error("The mail service refused the letter.");
}

export function sendMacMail({ to, subject, text }) {
  const file = path.join(os.tmpdir(), `memory-card-letter-${randomUUID()}.txt`);
  fs.writeFileSync(file, text);
  const script = `on run argv
  set theSubject to item 1 of argv
  set theTo to item 2 of argv
  set bodyText to read POSIX file (item 3 of argv)
  tell application "Mail"
    set msg to make new outgoing message with properties {subject:theSubject, content:bodyText, visible:false}
    tell msg
      make new to recipient at end of to recipients with properties {address:theTo}
      send
    end tell
  end tell
end run`;
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-e", script, subject, to, file]);
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Mail did not send in time."));
    }, 20_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      fs.rmSync(file, { force: true });
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      fs.rmSync(file, { force: true });
      if (code === 0) resolve();
      else reject(new Error("Mail could not send the letter."));
    });
  });
}

export function mailTransport() {
  if (process.env.RESEND_API_KEY && process.env.MAIL_FROM) return "resend";
  if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS && process.env.MAIL_FROM) return "smtp";
  if (process.platform === "darwin") return "mail";
  return null;
}

export async function sendLetter({ to, subject, text }) {
  const via = mailTransport();
  if (via === "resend") {
    await sendResend({ from: process.env.MAIL_FROM, to, subject, text });
    return;
  }
  if (via === "smtp") {
    const port = Number(process.env.SMTP_PORT || 587);
    await sendSmtp({
      host: process.env.SMTP_HOST,
      port,
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      from: process.env.MAIL_FROM,
      to,
      subject,
      text,
      secure: port === 465,
    });
    return;
  }
  if (via === "mail") {
    await sendMacMail({ to, subject, text });
    return;
  }
  throw new Error("This server has no mailbox yet.");
}
