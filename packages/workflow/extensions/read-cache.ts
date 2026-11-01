import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { hash, object } from "#cache/wire";

const KEY = "coilcoilReadCache";
interface ReadReference { key: string; digest: string; toolCallId: string; full: boolean }

/** Avoid repeated file text only while its identical original result remains in the model context. */
export default function readCacheExtension(pi: ExtensionAPI): void {
  let visible = new Map<string, ReadReference>();
  pi.on("context", (event) => {
    const next = new Map<string, ReadReference>();
    for (const message of event.messages) {
      if (message.role !== "toolResult" || message.isError || !object(message.details)) continue;
      const reference = message.details[KEY];
      if (!object(reference) || reference.full !== true || typeof reference.key !== "string" || typeof reference.digest !== "string") continue;
      // Clearing or replacing this tool result invalidates its reference even if details survive.
      if (hash(message.content) !== reference.digest) continue;
      next.set(reference.key, { key: reference.key, digest: reference.digest, toolCallId: message.toolCallId, full: true });
      if (next.size > 5000) next.delete(next.keys().next().value!);
    }
    visible = next;
  });
  pi.on("tool_result", (event, ctx) => {
    if (event.toolName !== "read" || event.parentToolCallId || event.isError || !event.content.length
      || event.content.some((block) => block.type !== "text")) return;
    if (object(event.details) && event.details.truncation) return;
    const raw = event.input.path;
    if (typeof raw !== "string" || !raw.trim()) return;
    const path = raw.replace(/^@/, "").replace(/^~(?=\/|$)/, homedir());
    const key = hash([resolve(ctx.cwd, path), event.input.offset ?? 1, event.input.limit ?? null]);
    // The real Read has already executed: comparing its output catches external edits,
    // restored files, partial views and tool-specific transformations without trusting mtime.
    const digest = hash(event.content);
    const prior = visible.get(key);
    const notice = "File unchanged for this range. Refer to the earlier Read result for its contents.";
    const originalText = event.content.map((block) => block.type === "text" ? block.text : "").join("\n");
    const same = prior?.digest === digest && Buffer.byteLength(originalText) > Buffer.byteLength(notice) * 2;
    const reference: ReadReference = { key, digest, toolCallId: event.toolCallId, full: !same };
    return {
      content: same ? [{ type: "text" as const,
        text: notice }] : event.content,
      details: { ...(object(event.details) ? event.details : {}), [KEY]: reference },
    };
  });
  pi.on("session_start", () => { visible.clear(); });
  pi.on("session_tree", () => { visible.clear(); });
  pi.on("session_compact", () => { visible.clear(); });
  pi.on("session_shutdown", () => { visible.clear(); });
}
