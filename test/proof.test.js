import test from "node:test";
import assert from "node:assert/strict";
import { buildProof, sha256Utf8 } from "../lib/proof.js";
import { addUtterance, applyTool, corpusOf, createSession } from "../lib/session.js";

test("buildProof hashes transcript and markdown and verifies quote spans", () => {
  const session = createSession({ id: "p1", photoFilename: "yard.jpg" });
  addUtterance(session, { text: "That was my grandfather in the courtyard." });
  applyTool(session, "note_quote", { quote: "my grandfather in the courtyard" });
  addUtterance(session, { text: "yes" });
  applyTool(session, "confirm_card", {});
  const corpus = corpusOf(session);
  const proof = buildProof(session);
  assert.equal(proof.transcriptSha256, sha256Utf8(corpus));
  assert.equal(proof.markdownSha256, sha256Utf8(session.card.markdown));
  assert.equal(proof.allQuotesVerified, true);
  assert.equal(proof.quotes[0].start, corpus.indexOf(proof.quotes[0].text));
});
