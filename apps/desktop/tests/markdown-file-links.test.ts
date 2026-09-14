import assert from "node:assert/strict";
import test from "node:test";
import { defaultUrlTransform } from "react-markdown";
import { markdownUrlTransform, parseMarkdownFileHref } from "../src/renderer/src/features/conversation/markdownFileLinks.ts";

test("absolute Markdown paths expose file and source location", () => {
  assert.deepEqual(parseMarkdownFileHref("/tmp/coilcoil-test/project/App.tsx:42:7"), {
    path: "/tmp/coilcoil-test/project/App.tsx",
    line: 42,
    column: 7,
  });
  assert.deepEqual(parseMarkdownFileHref("/tmp/coilcoil-test/project/App.tsx#L12"), {
    path: "/tmp/coilcoil-test/project/App.tsx",
    line: 12,
    column: undefined,
  });
});

test("file URLs and encoded spaces become local file targets", () => {
  assert.deepEqual(parseMarkdownFileHref("file:///tmp/coilcoil-test/My%20Project/report.md:9"), {
    path: "/tmp/coilcoil-test/My Project/report.md",
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
  assert.deepEqual(parseMarkdownFileHref("/tmp/coilcoil-test/project/src"), {
    path: "/tmp/coilcoil-test/project/src",
    line: undefined,
    column: undefined,
  });
  assert.deepEqual(parseMarkdownFileHref("file:///tmp/coilcoil-test/My%20Project/"), {
    path: "/tmp/coilcoil-test/My Project/",
    line: undefined,
    column: undefined,
  });
});

test("file: 地址必须原样留下来——被清空的链接会把应用整页重载", () => {
  // 这一条盯的是 2026-09-14 那个 bug 的源头。react-markdown 默认只放行
  // http/https/mailto/tel，别的一律换成空字符串；而 href="" 的链接点下去，浏览器
  // 的默认行为是重新加载当前页，在 Electron 里当前页就是应用本身。用户点一条写进
  // 记忆的 file:// 链接，应用连着重启了四次。
  const real = "file:///Users/hao/Library/Application%20Support/@coilcoil/desktop/agent/memory/feedmob/binance-data-export-context.md";
  assert.equal(defaultUrlTransform(real), "", "先确认 react-markdown 的默认行为真的是清空——这条测试的前提");
  assert.equal(markdownUrlTransform(real), real, "我们必须把它留下来");
});

test("AI 写出来的那条链接，一路走下来仍然认得出是个文件", () => {
  // 端到端的那一段：地址处理 → 文件解析。中间断一环，链接就会退化成一个没人接管
  // 的 <a>，而那正是把应用冲掉的东西。
  const real = "file:///Users/hao/Library/Application%20Support/@coilcoil/desktop/agent/memory/feedmob/binance-data-export-context.md";
  const target = parseMarkdownFileHref(markdownUrlTransform(real));
  assert.equal(target?.path, "/Users/hao/Library/Application Support/@coilcoil/desktop/agent/memory/feedmob/binance-data-export-context.md");
});

test("会替别人执行东西的协议，一个都不留", () => {
  for (const bad of ["javascript:alert(1)", "JavaScript:alert(1)", "  javascript:alert(1)", "data:text/html,<script>", "vbscript:msgbox"]) {
    assert.equal(markdownUrlTransform(bad), "", `${bad} 不该留下`);
  }
});

test("其它自定义协议留着，右键才有东西可复制", () => {
  // 打不开不等于要把地址扔掉。用户对这种链接提的第一条要求就是「右键一定要有一个
  // 复制链接地址」。
  for (const other of ["vscode://file/x", "slack://channel?id=1", "mailto:a@b.c", "https://example.com"]) {
    assert.equal(markdownUrlTransform(other), other);
  }
});
