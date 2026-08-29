import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import {
  EDITABLE_FILE_LIMIT,
  editableState,
  jsonContentError,
  looksBinary,
  mtimeMatches,
  saveProjectFile,
  temporaryWritePath,
} from "../src/main/file-edit.ts";
import { previewKind } from "../src/main/file-preview.ts";
import { editAvailability, beginEdit, hasExternalChange, isDirty, rebaseEdit } from "../src/renderer/src/features/files/fileEditing.ts";
import { insideProject } from "../src/renderer/src/features/files/filePaths.ts";
import type { FilePreviewDocument } from "../src/shared/desktop-api.ts";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function document(overrides: Partial<FilePreviewDocument> = {}): FilePreviewDocument {
  return {
    id: "preview-1",
    path: "/work/project/notes.md",
    name: "notes.md",
    kind: "markdown",
    content: "hello",
    truncated: false,
    updatedAt: 1,
    mtimeMs: 1000,
    editable: true,
    ...overrides,
  };
}

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "coilcoil-file-edit-"));
}

/** The save handler is given an already-contained path, the way the app wires it. */
function resolver(root: string) {
  return async (input: { root: string; path: string }) => {
    assert.equal(input.root, root);
    return { root, path: input.path };
  };
}

test("the plain-text formats the user names are all previewable", () => {
  assert.equal(previewKind("data/rows.jsonl", false), "text");
  assert.equal(previewKind("data/rows.ndjson", false), "text");
  assert.equal(previewKind("config/app.properties", false), "text");
  assert.equal(previewKind("notes.txt", false), "text");
  assert.equal(previewKind("readme.md", false), "markdown");
});

test("only text documents inside the size limit can be edited", () => {
  assert.equal(editableState("text", bytes("hello"), false).editable, true);
  assert.equal(editableState("markdown", bytes("# hi"), false).editable, true);
  assert.equal(editableState("html", bytes("<p>hi</p>"), false).editable, true);
  assert.equal(editableState("image", bytes("binary-ish"), false).editable, false);
  assert.equal(editableState("pdf", bytes("%PDF"), false).editable, false);
});

test("an image or a PDF is read-only without an explanation, because nobody expects to type into one", () => {
  assert.equal(editableState("image", bytes(""), false).readOnlyReason, undefined);
  assert.equal(editableState("pdf", bytes(""), false).readOnlyReason, undefined);
});

test("a file too large to be read whole is read-only, so saving can never truncate it", () => {
  const truncated = editableState("text", bytes("head of the file"), true);
  assert.equal(truncated.editable, false);
  assert.match(truncated.readOnlyReason ?? "", /2 MB/);

  const oversized = editableState("text", new Uint8Array(EDITABLE_FILE_LIMIT + 1), false);
  assert.equal(oversized.editable, false);
  assert.match(oversized.readOnlyReason ?? "", /2 MB/);
});

test("a binary file that reached the text preview by extension stays read-only", () => {
  assert.equal(looksBinary(bytes("plain text\nsecond line")), false);
  assert.equal(looksBinary(new Uint8Array([0x50, 0x4b, 0x03, 0x00, 0x41])), true);

  const state = editableState("text", new Uint8Array([0x41, 0x00, 0x42]), false);
  assert.equal(state.editable, false);
  assert.match(state.readOnlyReason ?? "", /二进制/);
});

test("broken JSON is reported instead of being written", () => {
  assert.equal(jsonContentError("settings.json", '{"a": 1}'), undefined);
  assert.equal(jsonContentError("settings.json", "   "), undefined);
  assert.match(jsonContentError("settings.json", '{"a": }') ?? "", /JSON 语法有误/);
});

test("JSONL is checked line by line and names the line that is broken", () => {
  assert.equal(jsonContentError("rows.jsonl", '{"a":1}\n\n{"b":2}\n'), undefined);
  assert.equal(jsonContentError("rows.ndjson", '{"a":1}\n{"b":2}'), undefined);
  assert.equal(jsonContentError("rows.jsonl", '{"a":1}\n{"b":\n{"c":3}'), "第 2 行不是合法的 JSON。");
});

test("formats that allow comments are not checked as strict JSON", () => {
  assert.equal(jsonContentError("tsconfig.jsonc", "{ // a comment\n }"), undefined);
  assert.equal(jsonContentError("notes.md", "{ not json at all"), undefined);
});

test("the base version matches within the resolution a file system reports", () => {
  assert.equal(mtimeMatches(1700000000000, 1700000000000), true);
  assert.equal(mtimeMatches(1700000000000.4, 1700000000000), true);
  assert.equal(mtimeMatches(1700000000000, 1700000001000), false);
});

test("the staging file lives beside its target so the rename cannot cross devices", () => {
  const staged = temporaryWritePath("/work/project/notes.md", "abcd1234");
  assert.equal(dirname(staged), "/work/project");
  assert.ok(basename(staged).startsWith(".notes.md."));
  assert.ok(staged.endsWith(".tmp"));
});

test("a save replaces the file and leaves no staging file behind", async () => {
  const root = await workspace();
  const path = join(root, "notes.md");
  await writeFile(path, "before", "utf8");
  const before = await stat(path);

  const result = await saveProjectFile(
    { root, path, content: "after", expectedMtimeMs: before.mtimeMs },
    resolver(root),
  );

  assert.equal(result.saved, true);
  assert.equal(await readFile(path, "utf8"), "after");
  assert.deepEqual(await readdir(root), ["notes.md"]);
});

test("a file rewritten by someone else is never overwritten by a stale editor", async () => {
  const root = await workspace();
  const path = join(root, "notes.md");
  await writeFile(path, "before", "utf8");

  const result = await saveProjectFile(
    { root, path, content: "mine", expectedMtimeMs: 1 },
    resolver(root),
  );

  assert.equal(result.saved, false);
  assert.equal(result.saved === false && result.reason, "conflict");
  assert.equal(await readFile(path, "utf8"), "before");
});

test("a JSON file with a syntax error is refused before anything is written", async () => {
  const root = await workspace();
  const path = join(root, "settings.json");
  await writeFile(path, '{"a": 1}', "utf8");
  const before = await stat(path);

  const result = await saveProjectFile(
    { root, path, content: '{"a": }', expectedMtimeMs: before.mtimeMs },
    resolver(root),
  );

  assert.equal(result.saved, false);
  assert.equal(result.saved === false && result.reason, "invalid");
  assert.equal(await readFile(path, "utf8"), '{"a": 1}');
});

test("a save larger than the edit limit is refused", async () => {
  const root = await workspace();
  const path = join(root, "notes.md");
  await writeFile(path, "before", "utf8");
  const before = await stat(path);

  const result = await saveProjectFile(
    { root, path, content: "x".repeat(EDITABLE_FILE_LIMIT + 1), expectedMtimeMs: before.mtimeMs },
    resolver(root),
  );

  assert.equal(result.saved, false);
  assert.equal(result.saved === false && result.reason, "too-large");
  assert.equal(await readFile(path, "utf8"), "before");
});

test("a save outside the workspace never reaches the disk", async () => {
  const root = await workspace();
  const outside = join(await workspace(), "elsewhere.md");
  await writeFile(outside, "untouched", "utf8");

  await assert.rejects(
    saveProjectFile({ root, path: outside, content: "hijacked", expectedMtimeMs: 1 }, async () => {
      throw new Error("所选文件不在当前项目中。");
    }),
    /不在当前项目中/,
  );
  assert.equal(await readFile(outside, "utf8"), "untouched");
});

test("only a workspace file offers the edit button", () => {
  assert.equal(insideProject("/work/project", "/work/project/notes.md"), true);
  assert.equal(insideProject("/work/project/", "/work/project/src/app.ts"), true);
  assert.equal(insideProject("/work/project", "/work/other/notes.md"), false);
  assert.equal(insideProject("/work/project", "/work/project"), false);

  assert.equal(editAvailability(document(), "/work/project").canEdit, true);
  assert.equal(editAvailability(document({ path: "/etc/hosts" }), "/work/project").canEdit, false);
  assert.match(editAvailability(document({ path: "/etc/hosts" }), "/work/project").reason ?? "", /不在当前项目内/);
});

test("a document the main process marked read-only explains itself instead of offering edit", () => {
  const large = document({ editable: false, readOnlyReason: "文件超过 2 MB，只能查看，不能在这里编辑。" });
  assert.equal(editAvailability(large, "/work/project").canEdit, false);
  assert.equal(editAvailability(large, "/work/project").reason, large.readOnlyReason);
  assert.equal(editAvailability(document({ kind: "image", editable: false }), "/work/project").reason, undefined);
  assert.equal(editAvailability(undefined, "/work/project").canEdit, false);
  assert.equal(editAvailability(document(), undefined).canEdit, false);
});

test("an editing session starts clean and turns dirty only once the text differs", () => {
  const session = beginEdit(document({ content: "hello", mtimeMs: 7 }));
  assert.deepEqual(session, { baseContent: "hello", baseMtimeMs: 7, draft: "hello" });
  assert.equal(isDirty(session), false);
  assert.equal(isDirty({ ...session, draft: "hello!" }), true);
  assert.equal(isDirty(undefined), false);
});

test("a file rewritten on disk while it is open is noticed by its content", () => {
  const session = beginEdit(document({ content: "hello" }));
  assert.equal(hasExternalChange(session, document({ content: "hello" })), false);
  assert.equal(hasExternalChange(session, document({ content: "rewritten by the agent" })), true);
  assert.equal(hasExternalChange(undefined, document({ content: "anything" })), false);
});

test("the user chooses between the disk version and their own draft, and the notice clears either way", () => {
  const session = { baseContent: "hello", baseMtimeMs: 1, draft: "my edit" };
  const onDisk = document({ content: "agent edit", mtimeMs: 2 });

  const reloaded = rebaseEdit(session, onDisk, false);
  assert.equal(reloaded.draft, "agent edit");
  assert.equal(isDirty(reloaded), false);
  assert.equal(hasExternalChange(reloaded, onDisk), false);

  const kept = rebaseEdit(session, onDisk, true);
  assert.equal(kept.draft, "my edit");
  assert.equal(kept.baseMtimeMs, 2);
  assert.equal(isDirty(kept), true);
  assert.equal(hasExternalChange(kept, onDisk), false);
});
