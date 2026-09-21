import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { isPromptSendKey } from "../src/renderer/src/features/composer/promptKeyboard.ts";

const rendererRoot = resolve(import.meta.dirname, "../src/renderer/src");

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

test("主输入框和历史编辑态共用Tiptap编辑器", () => {
  const composer = readFileSync(resolve(rendererRoot, "features/composer/ConversationComposer.tsx"), "utf8");
  const timeline = readFileSync(resolve(rendererRoot, "features/conversation/ConversationTimeline.tsx"), "utf8");
  const tiptap = readFileSync(resolve(rendererRoot, "features/composer/TiptapPromptEditor.tsx"), "utf8");
  assert.match(composer, /<TiptapPromptEditor/);
  assert.doesNotMatch(composer, /<PromptEditor\s/);
  assert.match(composer, /ariaLabel=\{inline \?/);
  assert.match(timeline, /isPromptSendKey\(event\)/);
  assert.match(tiptap, /return event\.defaultPrevented;/);
});
