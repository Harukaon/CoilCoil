import assert from "node:assert/strict";
import test from "node:test";
import readCacheExtension from "../extensions/read-cache.ts";

test("repeat Read reuses only identical, still-visible results; edits, ranges, clearing and compaction restore full text", async () => {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  readCacheExtension({ on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => { handlers.set(name, handler); } } as never);
  const ctx = { cwd: "/tmp/project" };
  const content = [{ type: "text", text: "original file contents\n".repeat(30) }];
  const read = (toolCallId: string, extra: Record<string, unknown> = {}) => handlers.get("tool_result")!({
    toolName: "read", toolCallId, input: { path: "a.ts" }, content, isError: false, ...extra,
  }, ctx) as { content: typeof content; details: unknown } | undefined;
  const first = read("read1")!;
  assert.deepEqual(first.content, content);
  const visible = { role: "toolResult", toolName: "read", toolCallId: "read1", ...first };
  handlers.get("context")!({ messages: [visible] }, ctx);
  assert.match(read("read2")!.content[0].text, /File unchanged/);
  const changed = [{ type: "text", text: "external edit" }];
  assert.deepEqual(read("edited", { content: changed })!.content, changed);
  assert.deepEqual(read("range", { input: { path: "a.ts", offset: 50 } })!.content, content);
  handlers.get("context")!({ messages: [{ ...visible, content: [{ type: "text", text: "cleared" }] }] }, ctx);
  assert.deepEqual(read("after-clear")!.content, content);
  handlers.get("context")!({ messages: [visible] }, ctx);
  handlers.get("session_compact")!({}, ctx);
  assert.deepEqual(read("after-compact")!.content, content);
  assert.equal(read("partial", { details: { truncation: { truncated: true } } }), undefined);
  assert.equal(read("error", { isError: true }), undefined);
  assert.equal(read("image", { content: [{ type: "image", data: "offline", mimeType: "image/png" }] }), undefined);
  const small = read("small", { content: [{ type: "text", text: "tiny" }] })!;
  handlers.get("context")!({ messages: [{ role: "toolResult", toolCallId: "small", ...small }] }, ctx);
  assert.equal(read("small-again", { content: [{ type: "text", text: "tiny" }] })!.content[0].text, "tiny",
    "deduplication must not replace a tiny file with a larger notice");
});
