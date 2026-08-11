import assert from "node:assert/strict";
import test from "node:test";
import type { FileNode } from "@suocode/runtime-protocol";
import {
  absoluteProjectPath,
  relativeProjectPath,
  removeTreeNode,
  replaceDirectoryChildren,
} from "../src/renderer/src/features/files/filePaths.ts";

test("文件面板在绝对路径与项目相对路径之间稳定转换", () => {
  assert.equal(absoluteProjectPath("/workspace", "src/index.ts"), "/workspace/src/index.ts");
  assert.equal(absoluteProjectPath("/workspace/", "/outside/file.ts"), "/outside/file.ts");
  assert.equal(relativeProjectPath("/workspace", "/workspace/src/index.ts"), "src/index.ts");
  assert.equal(relativeProjectPath("/workspace", "/outside/file.ts"), "/outside/file.ts");
});

test("目录懒加载只替换目标目录的子节点", () => {
  const tree: FileNode[] = [
    { name: "src", path: "src", kind: "directory" },
    { name: "README.md", path: "README.md", kind: "file" },
  ];
  const children: FileNode[] = [{ name: "index.ts", path: "src/index.ts", kind: "file" }];
  const next = replaceDirectoryChildren(tree, "src", children);
  assert.deepEqual(next[0]?.children, children);
  assert.equal(next[1], tree[1]);
});

test("移除目录时会同时移除其整棵子树", () => {
  const tree: FileNode[] = [{
    name: "src",
    path: "src",
    kind: "directory",
    children: [{ name: "index.ts", path: "src/index.ts", kind: "file" }],
  }];
  assert.deepEqual(removeTreeNode(tree, "src"), []);
});
