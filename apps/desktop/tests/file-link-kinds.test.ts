import assert from "node:assert/strict";
import test from "node:test";
import type { PathKind } from "../src/shared/desktop-api.ts";
import {
  fileLinkKind,
  primeFileLinkKinds,
  requestFileLinkKind,
  resetFileLinkKinds,
} from "../src/renderer/src/features/conversation/fileLinkKinds.ts";

function stubClassify(answers: Record<string, PathKind>, calls: string[][]): void {
  (globalThis as Record<string, any>).window = {
    coilcoil: {
      classifyPaths: async (paths: string[]) => {
        calls.push(paths);
        return Object.fromEntries(paths.map((path) => [path, answers[path] ?? "missing"]));
      },
    },
  };
}

test("every path in one render is classified in a single round trip", async (t) => {
  t.after(() => resetFileLinkKinds());
  resetFileLinkKinds();
  const calls: string[][] = [];
  stubClassify({ "/p/src": "directory", "/p/App.tsx": "file" }, calls);

  requestFileLinkKind("/p/src");
  requestFileLinkKind("/p/App.tsx");
  requestFileLinkKind("/p/src");
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.deepEqual(calls, [["/p/src", "/p/App.tsx"]]);
  assert.equal(fileLinkKind("/p/src"), "directory");
  assert.equal(fileLinkKind("/p/App.tsx"), "file");
});

test("an answered path is never asked about again", async (t) => {
  t.after(() => resetFileLinkKinds());
  resetFileLinkKinds();
  const calls: string[][] = [];
  stubClassify({ "/p/src": "directory" }, calls);

  requestFileLinkKind("/p/src");
  await new Promise((resolve) => setTimeout(resolve, 10));
  requestFileLinkKind("/p/src");
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(calls.length, 1);
});

test("a path that does not exist is remembered as missing, not retried forever", async (t) => {
  t.after(() => resetFileLinkKinds());
  resetFileLinkKinds();
  const calls: string[][] = [];
  stubClassify({}, calls);

  requestFileLinkKind("/p/gone");
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(fileLinkKind("/p/gone"), "missing");
  assert.equal(calls.length, 1);
});

test("primed answers are used without asking", () => {
  resetFileLinkKinds();
  primeFileLinkKinds({ "/p/docs": "directory" });
  assert.equal(fileLinkKind("/p/docs"), "directory");
});
