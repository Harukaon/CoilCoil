import assert from "node:assert/strict";
import test from "node:test";
import { routableHostUrl } from "../src/main/host-navigation.ts";
import { markdownBrowserUrl } from "../src/renderer/src/features/browser/useInAppBrowserLinks.ts";

test("HTTP Markdown links route to the in-app browser", () => {
  assert.equal(markdownBrowserUrl("https://example.com/docs?q=1"), "https://example.com/docs?q=1");
  assert.equal(markdownBrowserUrl("http://127.0.0.1:8765/test"), "http://127.0.0.1:8765/test");
});

test("non-web Markdown links cannot replace the application renderer", () => {
  assert.equal(markdownBrowserUrl("file:///tmp/report.html"), undefined);
  assert.equal(markdownBrowserUrl("javascript:alert(1)"), undefined);
  assert.equal(markdownBrowserUrl("not a url"), undefined);
});

test("the host navigation fallback only forwards HTTP URLs", () => {
  assert.equal(routableHostUrl("https://example.com"), "https://example.com/");
  assert.equal(routableHostUrl("file:///tmp/report.html"), undefined);
});
