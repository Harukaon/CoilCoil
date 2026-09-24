import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { browserScopeId } from "../src/renderer/src/features/browser/useBrowserTabs.ts";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

function sourceFiles(...roots: string[]): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "out" || entry.name === "release" || entry.name === "dist") continue;
      const full = resolve(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) found.push(full);
    }
  };
  for (const root of roots) walk(resolve(repositoryRoot, root));
  return found;
}

function read(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

/**
 * 内置浏览器按**会话**分，cookie 按**工作区**分。
 *
 * 一个会话一批标签页，换会话就换一批，Agent 开的页面不会窜到别的会话里去。同一个
 * 工作区的会话共用一份 cookie，登录状态不用每个会话重来一遍。
 *
 * 作用域取会话 id，不取 runtimeId。更早按会话分的那一版用的是 runtimeId：同一个
 * 会话重新打开会换运行时，标签页就对不上了；闲置运行时被回收时还会连带关掉标签页，
 * 用户正看着的页面也跟着没了。会话 id 在重新打开时不变。
 */
test("界面这一侧的浏览器作用域是会话 id", () => {
  const snapshot = { runtimeId: "runtime-7", session: { id: "session-a" } };
  assert.equal(browserScopeId(snapshot, "/work/项目 A"), "session-a", "取会话 id，不取 runtimeId，也不取工作区");
  assert.equal(browserScopeId(undefined, "/work/项目 A"), "/work/项目 A", "还没有会话时先落在工作区这一份上");
  assert.equal(browserScopeId(undefined, undefined), "default");
});

test("右侧栏用 browserScopeId 算作用域", () => {
  const line = read("apps/desktop/src/renderer/src/features/inspector/WorkspaceInspector.tsx")
    .split("\n")
    .find((text) => /const scopeId\s*=/.test(text));
  assert.ok(line, "WorkspaceInspector 里找不到 scopeId 的定义");
  assert.match(line, /browserScopeId\(snapshot, projectPath\)/);
});

test("Agent 用浏览器时，按会话 id 判断是不是当前会话", () => {
  const source = read("apps/desktop/src/renderer/src/App.tsx");
  const handler = /onBrowserAgentActivated\(\(scopeId\) => \{([\s\S]*?)\}\)/.exec(source);
  assert.ok(handler, "App.tsx 里找不到 onBrowserAgentActivated 的处理");
  const code = handler[1].split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
  assert.match(code, /session\.id/, "作用域是会话 id，要拿它比");
  assert.doesNotMatch(code, /runtimeId/, "拿 runtimeId 比永远对不上");
});

test("主进程按会话 id 记下它所在的工作区，cookie 才落对地方", () => {
  const source = read("apps/desktop/src/main/index.ts");
  assert.match(source, /const \{ id, cwd \} = event\.snapshot\.session;/);
  assert.match(source, /noteScopeWorkspace\(id, cwd\)/);
});

test("新会话建好时接手草稿里开的标签页，两条请求路径都要做", () => {
  // 新对话要等第一条消息才有会话，在那之前界面落在工作区路径这一份作用域上。
  const source = read("apps/desktop/src/main/index.ts");
  assert.match(source, /browser\.adoptScope\(command\.cwd, session\.id,/, "从 create_session 的 cwd（草稿作用域）交给新会话");
  // 桌面窗口：按发起请求的那个窗口取浏览器，气泡窗口没有浏览器，不会拿走主窗口的页面。
  assert.match(source, /handDraftTabsToNewSession\(browserRuntimes\.get\(event\.sender\.id\), payload\.command, value\)/);
  // 远程访问：和手机共用的是主窗口那一个浏览器。
  assert.match(source, /handDraftTabsToNewSession\(primaryBrowserRuntime, payload\.command, value\)/);
});

test("运行时服务不给浏览器指定作用域", () => {
  // runtime-server 只认得 runtimeId。作用域要在 runtime-core 里按当前会话算，
  // 这里一旦插手，就又回到按运行时分的老路上。
  const offenders = sourceFiles("packages/runtime-server/src")
    .filter((file) => /browserScope/i.test(readFileSync(file, "utf8")))
    .map((file) => file.slice(repositoryRoot.length + 1));
  assert.deepEqual(offenders, []);
});

test("会话结束或运行时回收时不关它的标签页", () => {
  // 标签页一直留到退出 App：切回那个会话，页面还要在。
  const offenders = sourceFiles("apps/desktop/src")
    .filter((file) => /releaseScope|runtime_released[\s\S]{0,200}closeTab/.test(readFileSync(file, "utf8")))
    .map((file) => file.slice(repositoryRoot.length + 1));
  assert.deepEqual(offenders, []);
});
