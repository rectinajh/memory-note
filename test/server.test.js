import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "../server.js";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("local server keeps the key off the page and blocks voice without it", async () => {
  const previous = process.env.ASSEMBLYAI_API_KEY;
  delete process.env.ASSEMBLYAI_API_KEY;
  process.env.MEMORY_NOTE_DATA = mkdtempSync(path.join(tmpdir(), "memory-note-"));
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(`${base}/api/health`);
    const healthBody = await health.json();
    assert.equal(healthBody.assemblyai, "missing");
    assert.match(healthBody.hint, /ASSEMBLYAI_API_KEY/);

    const page = await fetch(`${base}/`);
    const html = await page.text();
    assert.match(html, /Memory Card/);
    assert.doesNotMatch(html, /ASSEMBLYAI_API_KEY\s*=/);

    const token = await fetch(`${base}/api/streaming-token`);
    const tokenBody = await token.json();
    assert.equal(token.status, 503);
    assert.equal(tokenBody.token, undefined);

    const sample = await fetch(`${base}/api/session/sample`, { method: "POST" });
    assert.equal(sample.status, 201);
    const sampleBody = await sample.json();
    assert.equal(sampleBody.photoFilename, "sample-yard.png");

    const created = await fetch(`${base}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: "courtyard.jpg", dataBase64: PNG.toString("base64") }),
    });
    assert.equal(created.status, 201);
    const session = await created.json();
    assert.equal(session.photoFilename, "courtyard.jpg");
    const photo = await fetch(`${base}${session.photoUrl}`);
    assert.equal(photo.headers.get("content-type"), "image/png");

    const turn = await fetch(`${base}/api/session/${session.id}/turn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "That was my grandfather" }),
    });
    assert.equal(turn.status, 503);
    const turnBody = await turn.json();
    assert.match(turnBody.error, /ASSEMBLYAI_API_KEY/);

    const fake = "fake-key-value-should-not-leak-zz";
    process.env.ASSEMBLYAI_API_KEY = fake;
    const leaked = await fetch(`${base}/api/health`);
    const leakedText = await leaked.text();
    assert.equal(leakedText.includes(fake), false);
    assert.match(leakedText, /configured/);
    const index = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
    assert.equal(index.includes(fake), false);
    assert.doesNotMatch(index, /agents\.assemblyai\.com/);
  } finally {
    if (previous === undefined) delete process.env.ASSEMBLYAI_API_KEY;
    else process.env.ASSEMBLYAI_API_KEY = previous;
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
});
