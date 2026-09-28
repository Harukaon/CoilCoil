import assert from "node:assert/strict";
import test from "node:test";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import type { PromptBrowserElementPart, PromptDocument } from "@coilcoil/runtime-protocol";
import { BrowserElementNode } from "../src/renderer/src/features/composer/tiptapPromptExtensions.ts";
import {
  caretOffsetAtPosition,
  positionAtCaretOffset,
  promptDocumentSignature,
  promptDocumentToTiptap,
  tiptapToPromptDocument,
} from "../src/renderer/src/features/composer/tiptapPromptDocument.ts";
import {
  browserElementLabel,
  browserElementOrdinal,
  highestBrowserElementOrdinal,
  promptDocumentText,
} from "../src/renderer/src/features/composer/promptDocument.ts";

const schema = getSchema([StarterKit, BrowserElementNode]);

const element = (id: string, label: string): PromptBrowserElementPart => ({
  type: "browser-element",
  id,
  label,
  element: { pageUrl: "https://example.test", pageTitle: "Example", tagName: "h1", selector: "h1", xpath: "/html/body/h1", outerHtml: "<h1>x</h1>", text: "x", attributes: {}, styles: {} },
});

const sample: PromptDocument = {
  version: 1,
  parts: [
    { type: "text", text: "看" },
    element("a", "元素一"),
    { type: "text", text: "字1" },
    element("b", "元素二"),
    element("c", "元素三"),
    { type: "text", text: "ab\ncd" },
  ],
};
const doc = schema.nodeFromJSON(promptDocumentToTiptap(sample));

test("光标在最后：纯文本位置就是整段长度，元素按名字算，不再往前偏", () => {
  const end = doc.content.size - 1;
  assert.equal(caretOffsetAtPosition(doc, end), promptDocumentText(sample).length);
  // 旧算法在这里少算 2×元素个数（3 个元素就差 6 个字）。
  assert.equal(positionAtCaretOffset(doc, promptDocumentText(sample).length), end);
});

test("编辑器位置和纯文本位置来回换算一致；落在元素名字中间的放到元素后面", () => {
  const text = promptDocumentText(sample);
  // 元素名字所占的纯文本范围（名字中间不是合法光标位置）。
  const inside = new Set<number>();
  let cursor = 0;
  for (const part of sample.parts) {
    const length = part.type === "text" ? part.text.length : part.label.length;
    if (part.type === "browser-element") for (let i = 1; i < length; i += 1) inside.add(cursor + i);
    cursor += length;
  }
  for (let offset = 0; offset <= text.length; offset += 1) {
    const position = positionAtCaretOffset(doc, offset);
    const back = caretOffsetAtPosition(doc, position);
    if (inside.has(offset)) assert.ok(back > offset, `offset ${offset} 在元素名字中间，应该放到元素后面，实际 ${back}`);
    else assert.equal(back, offset, `offset ${offset}`);
  }
  // 编辑器里每一个合法位置换过去再换回来都不变。
  for (let position = 1; position <= doc.content.size - 1; position += 1) {
    assert.equal(positionAtCaretOffset(doc, caretOffsetAtPosition(doc, position)), position, `position ${position}`);
  }
});

test("元素紧跟在文字后面：光标在元素后，纯文本位置是元素名字的末尾", () => {
  // 看 | 元素一 | 字1 …：「看」占位置 1→2，元素一占 2→3。
  assert.equal(caretOffsetAtPosition(doc, 3), "看元素一".length);
  assert.equal(positionAtCaretOffset(doc, "看元素一".length), 3);
  assert.equal(caretOffsetAtPosition(doc, 2), "看".length);
});

test("多个段落之间算一个换行", () => {
  const twoParagraphs = schema.nodeFromJSON({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "ab" }, { type: "browserElement", attrs: { id: "a", label: "元素一" } }] },
      { type: "paragraph", content: [{ type: "text", text: "cd" }] },
    ],
  });
  const second = 1 + 2 + 1 + 1 + 1; // 第二段开头：段落首 + ab + 元素 + 段落尾 + 下一段首
  assert.equal(caretOffsetAtPosition(twoParagraphs, second), "ab元素一\n".length);
  assert.equal(positionAtCaretOffset(twoParagraphs, "ab元素一\n".length), second);
  assert.equal(caretOffsetAtPosition(twoParagraphs, twoParagraphs.content.size - 1), "ab元素一\ncd".length);
});

test("空输入框：光标在开头", () => {
  const empty = schema.nodeFromJSON(promptDocumentToTiptap({ version: 1, parts: [] }));
  assert.equal(caretOffsetAtPosition(empty, 1), 0);
  assert.equal(positionAtCaretOffset(empty, 0), 1);
  assert.equal(positionAtCaretOffset(empty, 5), 1);
});

test("剪切后粘贴、删掉后撤销：元素已不在当前文档里，也能按编号找回原来的元素，不会变成普通文字", () => {
  const content = promptDocumentToTiptap(sample);
  const withoutElements: PromptDocument = { version: 1, parts: [{ type: "text", text: "字1" }] };
  const known = new Map(sample.parts.filter((part): part is PromptBrowserElementPart => part.type === "browser-element").map((part) => [part.id, part]));
  const lost = tiptapToPromptDocument(content, withoutElements).document;
  assert.equal(lost.parts.filter((part) => part.type === "browser-element").length, 0, "不给见过的元素时，旧行为是变成文字");
  const restored = tiptapToPromptDocument(content, withoutElements, known).document;
  assert.equal(promptDocumentSignature(restored), promptDocumentSignature(sample));
  assert.equal(restored.parts.filter((part) => part.type === "browser-element").length, 3);
});

test("只比文字会把「元素变成同名文字」当成没变；比样子能看出来", () => {
  const asText: PromptDocument = { version: 1, parts: [{ type: "text", text: promptDocumentText(sample) }] };
  assert.equal(promptDocumentText(asText), promptDocumentText(sample));
  assert.notEqual(promptDocumentSignature(asText), promptDocumentSignature(sample));
});

test("元素编号：名字和编号互相换算，取当前最大的编号", () => {
  assert.equal(browserElementLabel(1), "元素一");
  assert.equal(browserElementLabel(10), "元素十");
  assert.equal(browserElementLabel(11), "元素11");
  for (const ordinal of [1, 5, 10, 11, 23]) assert.equal(browserElementOrdinal(browserElementLabel(ordinal)), ordinal);
  assert.equal(browserElementOrdinal("随便什么"), 0);
  assert.equal(highestBrowserElementOrdinal(sample), 3);
  assert.equal(highestBrowserElementOrdinal({ version: 1, parts: [element("x", "元素五"), element("y", "元素二")] }), 5);
});
