import assert from "node:assert/strict";
import test from "node:test";
import {
  browserContextMenuItems,
  runContextMenuAction,
  type ContextMenuAction,
  type GuestContextMenuParams,
} from "../src/main/browser-context-menu.ts";

function params(overrides: Partial<GuestContextMenuParams> = {}): GuestContextMenuParams {
  return {
    x: 12,
    y: 34,
    linkURL: "",
    srcURL: "",
    mediaType: "none",
    selectionText: "",
    isEditable: false,
    pageURL: "https://example.com/report",
    editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: true },
    ...overrides,
  };
}

const labels = (items: ReturnType<typeof browserContextMenuItems>): string[] =>
  items.map((item) => (item.type === "separator" ? "---" : item.label ?? ""));

test("a right-click on bare page background still offers navigation and inspection", () => {
  const items = browserContextMenuItems(params(), { canGoBack: true, canGoForward: false });
  assert.deepEqual(labels(items), ["后退", "前进", "重新加载", "---", "复制页面地址", "检查元素"]);
  assert.equal(items.find((item) => item.action === "back")?.enabled, true);
  assert.equal(items.find((item) => item.action === "forward")?.enabled, false);
});

test("links and images add their own copy entries", () => {
  const items = browserContextMenuItems(
    params({ linkURL: "https://example.com/a", srcURL: "https://example.com/a.png", mediaType: "image" }),
    { canGoBack: false, canGoForward: false },
  );
  assert.deepEqual(labels(items).slice(0, 5), ["复制链接地址", "---", "复制图片", "复制图片地址", "---"]);
});

test("an editable field gets the full edit group, plain selected text only copy", () => {
  const editable = browserContextMenuItems(
    params({ isEditable: true, editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true } }),
    { canGoBack: false, canGoForward: false },
  );
  assert.deepEqual(labels(editable).slice(0, 4), ["剪切", "复制", "粘贴", "全选"]);

  const selected = browserContextMenuItems(
    params({ selectionText: "hello", editFlags: { canCut: false, canCopy: true, canPaste: false, canSelectAll: true } }),
    { canGoBack: false, canGoForward: false },
  );
  assert.deepEqual(labels(selected).slice(0, 2), ["复制", "---"]);
});

test("whitespace-only selections do not add a copy entry", () => {
  const items = browserContextMenuItems(params({ selectionText: "   \n " }), { canGoBack: false, canGoForward: false });
  assert.ok(!items.some((item) => item.action === "copy"));
});

test("each copy action reaches for the URL that was clicked", () => {
  const copied: string[] = [];
  const calls: string[] = [];
  const host = {
    copyToClipboard: (text: string) => copied.push(text),
    copyImageAt: (x: number, y: number) => calls.push(`image:${x},${y}`),
    cut: () => calls.push("cut"),
    copy: () => calls.push("copy"),
    paste: () => calls.push("paste"),
    selectAll: () => calls.push("selectAll"),
    goBack: () => calls.push("back"),
    goForward: () => calls.push("forward"),
    reload: () => calls.push("reload"),
    inspectElement: (x: number, y: number) => calls.push(`inspect:${x},${y}`),
  };
  const clicked = params({ linkURL: "https://example.com/a", srcURL: "https://example.com/a.png" });
  for (const action of ["copyLinkUrl", "copyImageUrl", "copyPageUrl"] satisfies ContextMenuAction[]) {
    runContextMenuAction(action, clicked, host);
  }
  assert.deepEqual(copied, ["https://example.com/a", "https://example.com/a.png", "https://example.com/report"]);

  runContextMenuAction("copyImage", clicked, host);
  runContextMenuAction("inspect", clicked, host);
  assert.deepEqual(calls, ["image:12,34", "inspect:12,34"]);
});
