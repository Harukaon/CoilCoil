import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { normalizeBrowserUrl } from "../src/main/browser-navigation.ts";
import { isReusableBlankTab } from "../src/main/browser-runtime-types.ts";

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

test("桥垫出来的那张空白页会被 agent 的新标签页接管，不再两张起步", () => {
  // 客户端一连上来就问浏览器版本、列目标，桥得先垫一张空白页才答得出来。agent
  // 紧接着 new_page，于是每个会话都是「一张没人要的空白页 + 一张真正在用的页」。
  assert.equal(isReusableBlankTab({ implicit: true, phase: "ready" }, "about:blank"), true);
  assert.equal(isReusableBlankTab({ implicit: true, phase: "ready" }, ""), true);
  assert.equal(isReusableBlankTab({ implicit: true, phase: "ready" }, undefined), true);
  // 已经在用的页不能被拿走：那会把用户正看着的东西换掉。
  assert.equal(isReusableBlankTab({ implicit: true, phase: "ready" }, "https://example.com"), false);
  // 用户自己按「+」开的空白页也不算——他刚开的，不该被替他导航走。
  assert.equal(isReusableBlankTab({ implicit: false, phase: "ready" }, "about:blank"), false);
  // 还没就绪的没有 WebContents 可导航。
  assert.equal(isReusableBlankTab({ implicit: true, phase: "loading" }, "about:blank"), false);
});
