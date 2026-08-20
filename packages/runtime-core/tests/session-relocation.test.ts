import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { rewriteSessionHeaderCwd } from "../src/session-relocation.js";

function sessionFile(lines: string[]): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "coilcoil-relocation-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(path, lines.map((line) => `${line}\n`).join(""), "utf8");
  return { dir, path };
}

test("rewriteSessionHeaderCwd repoints the header and keeps every other entry", () => {
  const { dir, path } = sessionFile([
    JSON.stringify({ type: "session", version: 3, id: "abc", cwd: "/projects/old", timestamp: "t" }),
    JSON.stringify({ type: "message", message: { role: "user", content: "你好" } }),
    JSON.stringify({ type: "custom", customType: "coilcoil-response-metrics", data: { outputTokens: 12 } }),
  ]);
  try {
    rewriteSessionHeaderCwd(path, "/projects/new");
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    assert.equal(lines.length, 3);

    const header = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.equal(header.cwd, "/projects/new");
    // Session identity has to survive: archived and pinned maps are keyed by
    // session path, and the renderer matches the moved session by id.
    assert.equal(header.id, "abc");
    assert.equal(header.version, 3);
    assert.equal(header.timestamp, "t");

    assert.equal(lines[1], JSON.stringify({ type: "message", message: { role: "user", content: "你好" } }));
    assert.equal(lines[2], JSON.stringify({ type: "custom", customType: "coilcoil-response-metrics", data: { outputTokens: 12 } }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rewriteSessionHeaderCwd rejects a file whose first entry is not a header", () => {
  const { dir, path } = sessionFile([JSON.stringify({ type: "message", message: { role: "user" } })]);
  try {
    assert.throws(() => rewriteSessionHeaderCwd(path, "/projects/new"), /会话头/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rewriteSessionHeaderCwd rejects an unparsable header", () => {
  const { dir, path } = sessionFile(["{not json"]);
  try {
    assert.throws(() => rewriteSessionHeaderCwd(path, "/projects/new"), /损坏/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rewriteSessionHeaderCwd handles a header-only session with no trailing entries", () => {
  const { dir, path } = sessionFile([
    JSON.stringify({ type: "session", version: 3, id: "solo", cwd: "/projects/old" }),
  ]);
  try {
    rewriteSessionHeaderCwd(path, "/projects/new");
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    assert.equal(lines.length, 1);
    assert.equal((JSON.parse(lines[0]) as { cwd: string }).cwd, "/projects/new");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
