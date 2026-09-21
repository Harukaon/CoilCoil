import assert from "node:assert/strict";
import test from "node:test";
import { isPromptSendKey } from "../src/renderer/src/features/composer/promptKeyboard.ts";

test("Tiptap传来的原生Enter事件会触发发送", () => {
  assert.equal(isPromptSendKey({ key: "Enter", shiftKey: false, isComposing: false, keyCode: 13 }), true);
});

test("旧编辑器的React键盘事件也会触发发送", () => {
  assert.equal(isPromptSendKey({
    key: "Enter",
    shiftKey: false,
    nativeEvent: { isComposing: false, keyCode: 13 },
  }), true);
});

test("Shift+Enter和输入法确认不会触发发送", () => {
  assert.equal(isPromptSendKey({ key: "Enter", shiftKey: true, keyCode: 13 }), false);
  assert.equal(isPromptSendKey({ key: "Enter", shiftKey: false, isComposing: true, keyCode: 13 }), false);
  assert.equal(isPromptSendKey({ key: "Enter", shiftKey: false, nativeEvent: { isComposing: true, keyCode: 229 } }), false);
});
