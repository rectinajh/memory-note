import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { deliverDueLetters, EXAMPLE_QUOTES, letterText, scheduleLetter, validateLetter } from "../lib/letter.js";
import { sendSmtp } from "../lib/mail.js";
import { addUtterance, applyTool, createSession } from "../lib/session.js";
import { persistSession } from "../lib/persist.js";
import { createServer } from "../server.js";

test("a future letter keeps only the sealed quotes and sends once", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "memory-letter-"));
  const past = validateLetter({ email: "not-an-email", deliverAt: new Date(Date.now() + 3600_000).toISOString() });
  assert.match(past.error, /email/i);
  const soon = validateLetter({ email: "me@example.com", deliverAt: new Date(Date.now() + 1000).toISOString() });
  assert.match(soon.error, /minute/i);

  const when = new Date(Date.now() + 24 * 3600_000);
  const saved = scheduleLetter(dir, {
    to: "me@example.com",
    deliverAt: when,
    quotes: ["The courtyard was behind the house."],
  });
  assert.equal(saved.ok, true);
  const early = await deliverDueLetters(dir, { now: new Date(), send: async () => { throw new Error("too early"); } });
  assert.deepEqual(early, []);

  let calls = 0;
  let body = "";
  const sent = await deliverDueLetters(dir, {
    now: new Date(when.getTime() + 1000),
    send: async (mail) => {
      calls += 1;
      body = mail.text;
    },
  });
  assert.equal(sent.length, 1);
  assert.equal(calls, 1);
  assert.match(body, /The courtyard was behind the house/);
  assert.doesNotMatch(body, /grandfather|invented/);
  const again = await deliverDueLetters(dir, {
    now: new Date(when.getTime() + 2000),
    send: async () => { calls += 1; },
  });
  assert.deepEqual(again, []);
  assert.equal(calls, 1);
});

test("smtp sends the sealed words and nothing else", async () => {
  const received = await new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      let mode = "cmd";
      let data = "";
      socket.write("220 localhost\r\n");
      socket.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        if (mode === "data") {
          data += text;
          if (data.includes("\r\n.\r\n")) {
            socket.write("250 ok\r\n");
            socket.end();
            server.close();
            resolve(data);
          }
          return;
        }
        for (const line of text.split("\r\n").filter(Boolean)) {
          const cmd = line.toUpperCase();
          if (cmd === "DATA") {
            mode = "data";
            socket.write("354 go\r\n");
          } else {
            socket.write("250 localhost\r\n");
          }
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      sendSmtp({
        host: "127.0.0.1",
        port,
        from: "Memory Card <card@example.com>",
        to: "me@example.com",
        subject: "A card you sealed for yourself",
        text: letterText(EXAMPLE_QUOTES),
        auth: false,
      }).catch(reject);
    });
  });
  for (const quote of EXAMPLE_QUOTES) assert.match(received, new RegExp(quote.replace(/[.]/g, "\\.")));
  assert.doesNotMatch(received, /grandfather/);
});

test("the letter endpoint stores the card, not a sentence from the request", async () => {
  const previous = process.env.MEMORY_NOTE_DATA;
  const dir = mkdtempSync(path.join(tmpdir(), "memory-letter-http-"));
  process.env.MEMORY_NOTE_DATA = dir;
  const id = randomUUID();
  const session = createSession({ id, photoFilename: "yard.png" });
  addUtterance(session, { text: "The courtyard was behind the house." });
  applyTool(session, "note_quote", { quote: "The courtyard was behind the house." });
  addUtterance(session, { text: "yes" });
  assert.equal(applyTool(session, "confirm_card", {}).ok, true);
  persistSession(dir, session);
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const missing = await fetch(`${base}/api/session/${randomUUID()}/letter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "me@example.com", deliverAt: new Date(Date.now() + 86400_000).toISOString() }),
    });
    assert.equal(missing.status, 404);

    const invented = "A sentence nobody said.";
    const res = await fetch(`${base}/api/session/${id}/letter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "me@example.com",
        deliverAt: new Date(Date.now() + 86400_000).toISOString(),
        quotes: [invented],
      }),
    });
    assert.equal(res.status, 201);
    const payload = await res.json();
    assert.match(payload.message, /One email to me@example.com/);
    const files = readdirSync(path.join(dir, "letters"));
    const stored = JSON.parse(readFileSync(path.join(dir, "letters", files[0]), "utf8"));
    assert.deepEqual(stored.quotes, ["The courtyard was behind the house."]);
    assert.equal(JSON.stringify(stored).includes(invented), false);

    const example = await fetch(`${base}/api/letter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        example: true,
        email: "later@example.com",
        deliverAt: new Date(Date.now() + 86400_000).toISOString(),
        quotes: [invented],
      }),
    });
    assert.equal(example.status, 201);
    const exampleFile = readdirSync(path.join(dir, "letters"))
      .map((name) => JSON.parse(readFileSync(path.join(dir, "letters", name), "utf8")))
      .find((row) => row.to === "later@example.com");
    assert.deepEqual(exampleFile.quotes, EXAMPLE_QUOTES);
  } finally {
    if (previous === undefined) delete process.env.MEMORY_NOTE_DATA;
    else process.env.MEMORY_NOTE_DATA = previous;
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});
