import assert from "node:assert/strict";
import test from "node:test";
import {
  browserElementPart,
  emptyPromptDocument,
  insertPartAtOffset,
  promptDocumentText,
  removeBrowserElement,
  replaceTextRange,
} from "../src/renderer/src/features/composer/promptDocument.ts";
import type { BrowserElementSelection } from "../src/shared/desktop-api.ts";

const selection: BrowserElementSelection = {
  pageUrl: "https://example.test",
  pageTitle: "Example",
  tagName: "button",
  selector: "button.primary",
  xpath: "/html/body/button[1]",
  outerHtml: "<button>提交</button>",
  text: "提交",
  attributes: { class: "primary" },
  styles: { display: "inline-flex" },
};

test("text and selected elements interleave while the element stays atomic", () => {
  const part = browserElementPart(selection, undefined, 1);
  let document = insertPartAtOffset({ version: 1, parts: [{ type: "text", text: "请点击 " }] }, part, 2);
  document = insertPartAtOffset(document, { type: "text", text: " 后继续" }, promptDocumentText(document).length);
  assert.equal(promptDocumentText(document), "请点元素一击  后继续");

  const elementStart = "请点".length;
  const deleted = replaceTextRange(document, elementStart, elementStart + part.label.length, "");
  assert.equal(promptDocumentText(deleted), "请点击  后继续");
  assert.equal(deleted.parts.some((item) => item.type === "browser-element"), false);
});

test("removing an element does not change neighboring text", () => {
  const part = browserElementPart(selection, undefined, 1);
  const document = insertPartAtOffset({ version: 1, parts: [{ type: "text", text: "前后" }] }, part, 1);
  const next = removeBrowserElement(document, part.id);
  assert.equal(promptDocumentText(next), "前后");
  assert.deepEqual(emptyPromptDocument(), { version: 1, parts: [] });
});
