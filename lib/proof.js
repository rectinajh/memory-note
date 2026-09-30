import { createHash } from "node:crypto";
import { corpusOf, extractSlice } from "./session.js";

export function sha256Utf8(text) {
  return createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

/** Verifiable bundle: transcript hash + quote spans + card markdown hash. */
export function buildProof(session) {
  if (!session?.card?.markdown) return null;
  const corpus = corpusOf(session);
  const quotes = session.quotes.map((q) => {
    const text = q.text;
    const start = corpus.indexOf(text);
    const verified = Boolean(extractSlice(corpus, text) === text);
    return {
      text,
      start: start >= 0 ? start : null,
      end: start >= 0 ? start + text.length : null,
      verified,
    };
  });
  return {
    version: 1,
    app: "Memory Card",
    sessionId: session.id,
    photoFilename: session.photoFilename,
    confirmedAt: session.card.confirmedAt,
    transcriptSha256: sha256Utf8(corpus),
    markdownSha256: sha256Utf8(session.card.markdown),
    quotes,
    allQuotesVerified: quotes.every((q) => q.verified),
    note: "Each quote must be a continuous substring of the transcript. Recompute transcriptSha256 from the utterances joined with newlines.",
  };
}

export function proofJson(session) {
  const proof = buildProof(session);
  return proof ? `${JSON.stringify(proof, null, 2)}\n` : null;
}
