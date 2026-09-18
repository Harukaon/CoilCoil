import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

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

/**
 * 内置浏览器只按**工作区**分，不按会话分。
 *
 * 一个工作区一个浏览器：同一个工作区里换一个会话，标签页必须还是那一批，而且用户
 * 和 Agent 共用同一批。不同工作区才各自一份，各存各的 cookie。
 *
 * 以前作用域取的是会话 id（`browserScopeId: runtimeId`，界面那边是
 * `snapshot?.runtimeId ?? projectPath`），于是每个会话各有一份浏览器：Agent 在后台
 * 会话里开的页面对用户成了「别人的」，而每个会话第一次连上 CDP 又各垫一张空白页，
 * 用户看到的就是一堆 about:blank，旧会话结束时那一批还会被连带关掉。
 */
test("浏览器作用域不许再按会话取", () => {
  const offenders = sourceFiles("apps/desktop/src", "packages/runtime-core/src", "packages/runtime-server/src")
    .filter((file) => readFileSync(file, "utf8").includes("browserScopeId"))
    .map((file) => file.slice(repositoryRoot.length + 1));
  assert.deepEqual(offenders, [], "browserScopeId 是按会话取作用域的那条路，已经废掉了");
});

test("界面这一侧的浏览器作用域来自工作区，不是会话", () => {
  const source = readFileSync(
    resolve(repositoryRoot, "apps/desktop/src/renderer/src/features/inspector/WorkspaceInspector.tsx"),
    "utf8",
  );
  const line = source.split("\n").find((text) => /const scopeId\s*=/.test(text));
  assert.ok(line, "WorkspaceInspector 里找不到 scopeId 的定义");
  assert.match(line, /projectPath/, "作用域要取工作区路径");
  assert.doesNotMatch(line, /runtimeId/, "作用域不能再看会话 id");
});

test("agent 这一侧把工作区路径交给内置浏览器的 MCP", () => {
  const source = readFileSync(resolve(repositoryRoot, "packages/runtime-core/src/runtime-resources.ts"), "utf8");
  const call = /withBundledBrowserMcp\(([\s\S]*?)\n\s*\)\);/.exec(source);
  assert.ok(call, "runtime-resources 里找不到 withBundledBrowserMcp 的调用");
  // 最后一个实参就是作用域。传 cwd 才能和界面那一侧对上。
  assert.match(call[1], /\n\s*cwd,\s*$/, "作用域这一位要传会话的 cwd（也就是工作区）");
});
