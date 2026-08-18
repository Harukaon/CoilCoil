import assert from "node:assert/strict";
import test from "node:test";
import { parseMarkdownFileHref } from "../src/renderer/src/features/conversation/markdownFileLinks.ts";

test("absolute Markdown paths expose file and source location", () => {
  assert.deepEqual(parseMarkdownFileHref("/Users/hao/project/App.tsx:42:7"), {
    path: "/Users/hao/project/App.tsx",
    line: 42,
    column: 7,
  });
  assert.deepEqual(parseMarkdownFileHref("/Users/hao/project/App.tsx#L12"), {
    path: "/Users/hao/project/App.tsx",
    line: 12,
    column: undefined,
  });
});

test("file URLs and encoded spaces become local file targets", () => {
  assert.deepEqual(parseMarkdownFileHref("file:///Users/hao/My%20Project/report.md:9"), {
    path: "/Users/hao/My Project/report.md",
    line: 9,
    column: undefined,
  });
});

test("relative, web, and malformed links fall back to ordinary Markdown", () => {
  assert.equal(parseMarkdownFileHref("src/App.tsx:4"), undefined);
  assert.equal(parseMarkdownFileHref("https://example.com/file.ts"), undefined);
  assert.equal(parseMarkdownFileHref("not a link"), undefined);
});
