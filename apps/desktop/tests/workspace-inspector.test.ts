import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Files, Globe2, Terminal } from "lucide-react";
import {
  closeWorkspaceInspectorTab,
  EMPTY_WORKSPACE_INSPECTOR,
  openWorkspaceInspectorTab,
  updateWorkspaceInspectorState,
} from "../src/renderer/src/features/inspector/useWorkspaceInspector.ts";

test("right sidebar state is isolated by workspace", () => {
  let states = updateWorkspaceInspectorState({}, "/workspace/a", (state) => (
    openWorkspaceInspectorTab(state, {
      id: "browser",
      kind: "browser",
      label: "浏览器",
      icon: Globe2,
    })
  ));

  assert.equal(states["/workspace/a"]?.rightOpen, true);
  assert.equal(states["/workspace/b"], undefined);

  states = updateWorkspaceInspectorState(states, "/workspace/b", (state) => ({
    ...state,
    rightOpen: false,
  }));

  assert.equal(states["/workspace/a"]?.rightOpen, true);
  assert.deepEqual(states["/workspace/a"]?.tabs.map((tab) => tab.id), ["browser"]);
  assert.deepEqual(states["/workspace/b"], EMPTY_WORKSPACE_INSPECTOR);
});

test("closing one workspace tab does not affect another workspace", () => {
  const withFiles = openWorkspaceInspectorTab(EMPTY_WORKSPACE_INSPECTOR, {
    id: "files",
    kind: "files",
    label: "文件",
    icon: Files,
  });
  let states = {
    "/workspace/a": withFiles,
    "/workspace/b": openWorkspaceInspectorTab(EMPTY_WORKSPACE_INSPECTOR, {
      id: "browser",
      kind: "browser",
      label: "浏览器",
      icon: Globe2,
    }),
  };

  states = updateWorkspaceInspectorState(states, "/workspace/b", (state) => (
    closeWorkspaceInspectorTab(state, "browser")
  ));

  assert.deepEqual(states["/workspace/a"], withFiles);
  assert.deepEqual(states["/workspace/b"]?.tabs, []);
});

test("terminal is an ordinary workspace-isolated inspector tab", () => {
  const terminal = openWorkspaceInspectorTab(EMPTY_WORKSPACE_INSPECTOR, {
    id: "terminal",
    kind: "terminal",
    label: "终端",
    icon: Terminal,
  });
  assert.equal(terminal.rightOpen, true);
  assert.equal(terminal.activeTabId, "terminal");
  assert.deepEqual(terminal.tabs.map((tab) => tab.kind), ["terminal"]);
});

test("refactored App modules stay within the 600 line architecture limit", async () => {
  const sourceFiles = [
    "../src/renderer/src/App.tsx",
    "../src/renderer/src/AppView.tsx",
    "../src/renderer/src/appState.ts",
    "../src/renderer/src/hooks/useRuntimeEventHandler.ts",
    "../src/renderer/src/hooks/useConversationViewport.ts",
    "../src/renderer/src/features/inspector/useWorkspaceInspector.ts",
    "../src/renderer/src/features/inspector/WorkspaceInspector.tsx",
  ];
  for (const sourceFile of sourceFiles) {
    const source = await readFile(new URL(sourceFile, import.meta.url), "utf8");
    const lineCount = source.trimEnd().split("\n").length;
    assert.ok(lineCount <= 600, `${sourceFile} has ${lineCount} lines`);
  }
});
