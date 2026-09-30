import test from "node:test";
import assert from "node:assert/strict";
import {
  addUtterance,
  applyTool,
  createSession,
  extractSlice,
  isExplicitAgree,
  captureStatement,
  confirmIfAgreed,
  localReply,
} from "../lib/session.js";

function sessionWith(text, words) {
  const session = createSession({ id: "s", photoFilename: "courtyard.jpg" });
  addUtterance(session, { text, words });
  return session;
}

test("saves an exact user quote and rejects invented text", () => {
  const session = sessionWith("That was my grandfather in the Shanghai courtyard");
  const saved = applyTool(session, "note_quote", { quote: "my grandfather in the Shanghai" });
  assert.equal(saved.ok, true);
  assert.equal(saved.result.saved, "my grandfather in the Shanghai");
  const invented = applyTool(session, "note_quote", { quote: "my grandmother cried in Beijing" });
  assert.equal(invented.ok, false);
  assert.equal(session.quotes.length, 1);
});

test("maps punctuation-only differences back to the transcript slice", () => {
  const corpus = "That was my grandfather, in Shanghai.";
  assert.equal(extractSlice(corpus, "my grandfather in Shanghai"), "my grandfather, in Shanghai");
});

test("low-confidence words are flagged instead of written", () => {
  const session = sessionWith("My grandfather's name is Deming", [
    { text: "My", confidence: 0.95 },
    { text: "grandfather's", confidence: 0.92 },
    { text: "name", confidence: 0.9 },
    { text: "is", confidence: 0.9 },
    { text: "Deming", confidence: 0.31 },
  ]);
  const blocked = applyTool(session, "note_quote", { quote: "My grandfather's name is Deming" });
  assert.equal(blocked.ok, false);
  assert.equal(session.quotes.length, 0);
  assert.ok(session.unclear.some((item) => item.phrase === "Deming"));
  const flagged = applyTool(session, "flag_unclear", { phrase: "Deming" });
  assert.equal(flagged.ok, true);
  const safe = applyTool(session, "note_quote", { quote: "My grandfather" });
  assert.equal(safe.ok, true);
});

test("flag_unclear rejects a word the user never said", () => {
  const session = sessionWith("This is Shanghai");
  const result = applyTool(session, "flag_unclear", { phrase: "Beijing" });
  assert.equal(result.ok, false);
  assert.equal(session.unclear.length, 0);
});

test("confirm_card requires a short explicit yes and only stores quotes", () => {
  const session = sessionWith("That was my grandfather in the Shanghai courtyard");
  applyTool(session, "note_quote", { quote: "That was my grandfather in the Shanghai courtyard" });
  const early = applyTool(session, "confirm_card", {
    agreed: true,
    story: "I am your grandfather who has died, and that year I said I missed home",
  });
  assert.equal(early.ok, false);
  assert.equal(session.card, null);

  addUtterance(session, { text: "I confirm that person is my grandfather" });
  const sneaky = applyTool(session, "confirm_card", { agreed: true });
  assert.equal(sneaky.ok, false);

  addUtterance(session, { text: "yes" });
  const done = applyTool(session, "confirm_card", { agreed: true, story: "I am the person in the photo" });
  assert.equal(done.ok, true);
  assert.match(session.card.markdown, /courtyard\.jpg/);
  assert.match(session.card.markdown, /China Standard Time/);
  assert.match(session.card.markdown, /That was my grandfather in the Shanghai courtyard/);
  assert.doesNotMatch(session.card.markdown, /died|missed home|person in the photo/);
  assert.equal(isExplicitAgree("yes"), true);
  assert.equal(isExplicitAgree("make the card"), true);
  assert.equal(isExplicitAgree("I confirm that person is my grandfather"), false);
});

test("local reply keeps a statement and skips a short question", () => {
  const session = sessionWith("Who is it?");
  const skipped = localReply(session);
  assert.equal(session.quotes.length, 0);
  assert.match(skipped.say, /Who is in this photo/);

  addUtterance(session, { text: "It's my cat." });
  const saved = localReply(session);
  assert.equal(session.quotes[0].text, "It's my cat.");
  assert.match(saved.say, /Where was this/);

  addUtterance(session, { text: "yes" });
  const card = localReply(session);
  assert.equal(card.tools[0].ok, true);
  assert.match(session.card.markdown, /It's my cat/);
});

test("captureStatement keeps a skipped statement and ignores a question", () => {
  const told = sessionWith("It's my cat.");
  const saved = captureStatement(told);
  assert.equal(saved.ok, true);
  assert.equal(told.quotes[0].text, "It's my cat.");
  assert.equal(captureStatement(told), null);

  const asked = sessionWith("Who is it?");
  assert.equal(captureStatement(asked), null);
  const agreed = sessionWith("yes");
  assert.equal(captureStatement(agreed), null);
});

test("confirmIfAgreed writes the card when the model skipped the tool", () => {
  const session = sessionWith("It's my cat.");
  applyTool(session, "note_quote", { quote: "It's my cat." });
  addUtterance(session, { text: "yes" });
  const out = confirmIfAgreed(session);
  assert.equal(out.ok, true);
  assert.match(session.card.markdown, /It's my cat/);
  assert.equal(confirmIfAgreed(session), null);
});

test("a rejected paraphrase keeps what was heard beside what was refused", () => {
  const session = sessionWith("It's my cat.");
  const invented = applyTool(session, "note_quote", { quote: "This is my beloved cat" });
  assert.equal(invented.ok, false);
  assert.equal(invented.rejected, "This is my beloved cat");
  assert.equal(invented.heard, "It's my cat.");
  assert.equal(session.quotes.length, 0);
});

test("does not save a bare acknowledgement as a quote", () => {
  const session = sessionWith("okay");
  const result = applyTool(session, "note_quote", { quote: "okay" });
  assert.equal(result.ok, false);
});
