import test from "node:test";
import assert from "node:assert/strict";
import {
  addUtterance,
  applyTool,
  createSession,
  extractSlice,
  isExplicitAgree,
} from "../lib/session.js";

function sessionWith(text, words) {
  const session = createSession({ id: "s", photoFilename: "院子.jpg" });
  addUtterance(session, { text, words });
  return session;
}

test("saves an exact user quote and rejects invented text", () => {
  const session = sessionWith("那是我爷爷在上海的院子");
  const saved = applyTool(session, "note_quote", { quote: "我爷爷在上海" });
  assert.equal(saved.ok, true);
  assert.equal(saved.result.saved, "我爷爷在上海");
  const invented = applyTool(session, "note_quote", { quote: "我奶奶在北京哭了" });
  assert.equal(invented.ok, false);
  assert.equal(session.quotes.length, 1);
});

test("maps punctuation-only differences back to the transcript slice", () => {
  const corpus = "那是我爷爷，在上海。";
  assert.equal(extractSlice(corpus, "我爷爷在上海"), "我爷爷，在上海");
});

test("low-confidence words are flagged instead of written", () => {
  const session = sessionWith("我爷爷叫德明", [
    { text: "我爷爷", confidence: 0.92 },
    { text: "叫", confidence: 0.9 },
    { text: "德明", confidence: 0.31 },
  ]);
  const blocked = applyTool(session, "note_quote", { quote: "我爷爷叫德明" });
  assert.equal(blocked.ok, false);
  assert.equal(session.quotes.length, 0);
  assert.ok(session.unclear.some((item) => item.phrase === "德明"));
  const flagged = applyTool(session, "flag_unclear", { phrase: "德明" });
  assert.equal(flagged.ok, true);
  const safe = applyTool(session, "note_quote", { quote: "我爷爷" });
  assert.equal(safe.ok, true);
});

test("flag_unclear rejects a word the user never said", () => {
  const session = sessionWith("这是上海");
  const result = applyTool(session, "flag_unclear", { phrase: "北京" });
  assert.equal(result.ok, false);
  assert.equal(session.unclear.length, 0);
});

test("confirm_card requires a short explicit yes and only stores quotes", () => {
  const session = sessionWith("那是我爷爷在上海的院子");
  applyTool(session, "note_quote", { quote: "那是我爷爷在上海的院子" });
  const early = applyTool(session, "confirm_card", { agreed: true, story: "我是你已经去世的祖父，那年我说过想家" });
  assert.equal(early.ok, false);
  assert.equal(session.card, null);

  addUtterance(session, { text: "我确认那个人是我爷爷" });
  const sneaky = applyTool(session, "confirm_card", { agreed: true });
  assert.equal(sneaky.ok, false);

  addUtterance(session, { text: "可以" });
  const done = applyTool(session, "confirm_card", { agreed: true, story: "我是照片里的人" });
  assert.equal(done.ok, true);
  assert.match(session.card.markdown, /院子\.jpg/);
  assert.match(session.card.markdown, /北京时间/);
  assert.match(session.card.markdown, /那是我爷爷在上海的院子/);
  assert.doesNotMatch(session.card.markdown, /祖父|去世|想家|照片里的人/);
  assert.equal(isExplicitAgree("可以"), true);
  assert.equal(isExplicitAgree("写成卡片吧"), true);
  assert.equal(isExplicitAgree("我确认那个人是我爷爷"), false);
});

test("does not save a bare acknowledgement as a quote", () => {
  const session = sessionWith("好的");
  const result = applyTool(session, "note_quote", { quote: "好的" });
  assert.equal(result.ok, false);
});
