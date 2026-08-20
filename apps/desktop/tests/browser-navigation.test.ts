import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { normalizeBrowserUrl } from "../src/main/browser-navigation.ts";

test("browser navigation keeps ordinary web URLs", () => {
  assert.equal(normalizeBrowserUrl("https://example.com/report"), "https://example.com/report");
  assert.equal(normalizeBrowserUrl("http://localhost:3000"), "http://localhost:3000/");
});

test("browser navigation accepts arbitrary local absolute paths", () => {
  const file = join(homedir(), "Documents", "local report.html");
  assert.equal(normalizeBrowserUrl(file), pathToFileURL(file).toString());
});

test("browser navigation expands home-relative paths", () => {
  const file = join(homedir(), "Downloads", "report.html");
  assert.equal(normalizeBrowserUrl("~/Downloads/report.html"), pathToFileURL(file).toString());
});

test("browser navigation keeps file and data URLs without an allowlist", () => {
  const fileUrl = pathToFileURL("/private/tmp/coilcoil browser test.html").toString();
  assert.equal(normalizeBrowserUrl(fileUrl), fileUrl);
  assert.equal(normalizeBrowserUrl("data:text/html,<h1>CoilCoil</h1>"), "data:text/html,<h1>CoilCoil</h1>");
});

test("browser navigation still treats plain text as a search", () => {
  assert.equal(
    normalizeBrowserUrl("测试本地浏览器"),
    `https://www.google.com/search?q=${encodeURIComponent("测试本地浏览器")}`,
  );
});
