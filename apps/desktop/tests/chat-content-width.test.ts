import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CHAT_WIDTH,
  MAXIMUM_CHAT_WIDTH,
  MINIMUM_CHAT_WIDTH,
  clampChatContentWidth,
  effectiveChatContentWidth,
  readStoredChatContentWidth,
} from "../src/renderer/src/hooks/useChatContentWidth.ts";
import { findSlashToken } from "../src/renderer/src/features/composer/useSlashSkills.ts";

test("clampChatContentWidth respects minimum, maximum, and viewport", () => {
  assert.equal(clampChatContentWidth(200, 2000), MINIMUM_CHAT_WIDTH);
  assert.equal(clampChatContentWidth(2000, 2000), MAXIMUM_CHAT_WIDTH);
  assert.equal(clampChatContentWidth(820, 700), 700 - 96);
});

test("effectiveChatContentWidth restores preferred width after viewport grows again", () => {
  const preferred = 820;
  const narrow = effectiveChatContentWidth(preferred, 600);
  assert.ok(narrow < preferred);
  assert.equal(narrow, clampChatContentWidth(preferred, 600));
  assert.equal(effectiveChatContentWidth(preferred, 1400), preferred);
});

test("readStoredChatContentWidth falls back to default", () => {
  assert.equal(readStoredChatContentWidth({ getItem: () => null }), DEFAULT_CHAT_WIDTH);
  assert.equal(readStoredChatContentWidth({ getItem: () => "900" }), 900);
  assert.equal(readStoredChatContentWidth({ getItem: () => "100" }), DEFAULT_CHAT_WIDTH);
});

test("findSlashToken matches caret token at start and mid-draft", () => {
  assert.deepEqual(findSlashToken("/sk", 3), { query: "sk", start: 0, end: 3, lineStart: true });
  assert.deepEqual(findSlashToken("帮我 /skill", 8), { query: "skill", start: 3, end: 9, lineStart: false });
  assert.deepEqual(findSlashToken("／skill", 3), { query: "skill", start: 0, end: 6, lineStart: true });
  assert.equal(findSlashToken("hello world", 5), null);
  assert.equal(findSlashToken("path/to/file", 12), null);
});

test("findSlashToken ignores completed skill when caret is past trailing space", () => {
  const draft = "/skill:demo ";
  assert.equal(findSlashToken(draft, draft.length), null);
  assert.deepEqual(findSlashToken(draft, 7), { query: "skill:demo", start: 0, end: 11, lineStart: true });
});
