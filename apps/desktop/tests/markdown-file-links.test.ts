import assert from "node:assert/strict";
import test from "node:test";
import { parseMarkdownFileHref } from "../src/renderer/src/features/conversation/markdownFileLinks.ts";

test("absolute Markdown paths expose file and source location", () => {
  assert.deepEqual(parseMarkdownFileHref("/tmp/suocode-test/project/App.tsx:42:7"), {
    path: "/tmp/suocode-test/project/App.tsx",
    line: 42,
    column: 7,
  });
  assert.deepEqual(parseMarkdownFileHref("/tmp/suocode-test/project/App.tsx#L12"), {
    path: "/tmp/suocode-test/project/App.tsx",
    line: 12,
    column: undefined,
  });
});

test("file URLs and encoded spaces become local file targets", () => {
  assert.deepEqual(parseMarkdownFileHref("file:///tmp/suocode-test/My%20Project/report.md:9"), {
    path: "/tmp/suocode-test/My Project/report.md",
    line: 9,
    column: undefined,
  });
});

test("relative, web, and malformed links fall back to ordinary Markdown", () => {
  assert.equal(parseMarkdownFileHref("src/App.tsx:4"), undefined);
  assert.equal(parseMarkdownFileHref("https://example.com/file.ts"), undefined);
  assert.equal(parseMarkdownFileHref("not a link"), undefined);
});

test("a folder path is a target of its own, with or without a trailing separator", () => {
  assert.deepEqual(parseMarkdownFileHref("/tmp/suocode-test/project/src"), {
    path: "/tmp/suocode-test/project/src",
    line: undefined,
    column: undefined,
  });
  assert.deepEqual(parseMarkdownFileHref("file:///tmp/suocode-test/My%20Project/"), {
    path: "/tmp/suocode-test/My Project/",
    line: undefined,
    column: undefined,
  });
});
