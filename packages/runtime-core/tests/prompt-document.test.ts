import assert from "node:assert/strict";
import test from "node:test";
import { legacyPromptDocumentFromText, mapMessage, promptDocumentFromUnknown, promptDocumentPrompt } from "../src/message-helpers.js";

const element = {
  type: "browser-element" as const,
  id: "element-1",
  label: "元素一",
  screenshotId: "shot-1",
  element: {
    pageUrl: "https://example.test/products",
    pageTitle: "Products",
    tagName: "button",
    selector: "button.buy",
    xpath: "/html/body/button[1]",
    outerHtml: '<button class="buy">购买</button>',
    text: "购买",
    attributes: { class: "buy" },
    styles: { display: "inline-flex" },
  },
};

test("structured prompt nodes serialize to normal text and image context", () => {
  const result = promptDocumentPrompt({ version: 1, parts: [
    { type: "text", text: "请检查 " },
    element,
    { type: "text", text: " 是否可用" },
  ] }, [{ id: "shot-1", mimeType: "image/png", data: "abc" }]);
  assert.match(result.text, /请检查 元素一 是否可用/);
  assert.equal(result.text.includes("outerHTML"), false);
  assert.match(result.images?.[0]?.context ?? "", /选择器: button\.buy/);
});

test("persisted prompt metadata is validated before history restore", () => {
  const decoded = promptDocumentFromUnknown({ version: 1, parts: [element] });
  assert.equal(decoded?.parts[0]?.type, "browser-element");
  assert.equal(promptDocumentFromUnknown({ version: 2, parts: [element] }), undefined);
  assert.equal(promptDocumentFromUnknown({ version: 1, parts: [{ type: "browser-element" }] }), undefined);
});

test("旧会话的 image hint 可以恢复成可回显的原子节点", () => {
  const raw = "元素一 你可以看到这个吗\n\n<image name=\"网页元素 · #gb &gt; div.gb\">[元素一]\n页面: 你好 - Google 搜索\nURL: https://www.google.com/search?q=x\n标签: ::before\n选择器: #gb &gt; div.gb\nXPath: /html/body/span\nouterHTML:\n<span>登录</span></image>";
  const document = legacyPromptDocumentFromText(raw);
  assert.equal(document?.parts[0]?.type, "browser-element");
  assert.equal(document?.parts[0]?.type === "browser-element" ? document.parts[0].label : undefined, "元素一");
  assert.equal(document?.parts[1]?.type, "text");
  assert.equal(document?.parts[1]?.type === "text" ? document.parts[1].text : undefined, " 你可以看到这个吗\n\n");

  const mapped = mapMessage({ role: "user", content: [{ type: "text", text: raw }] }, "m1", 1);
  assert.equal(mapped?.promptDocument?.parts[0]?.type, "browser-element");
  assert.equal(mapped?.text, "元素一 你可以看到这个吗\n\n");
});
