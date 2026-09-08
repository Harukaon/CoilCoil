import type { RuntimeEvent, ToolRun } from "@coilcoil/runtime-protocol";
import { isRecord, stringValue } from "./runtime-utils.js";
import type { ToolRunIds } from "./tool-run-ids.js";

/**
 * Put a tool's card on screen while its arguments are still arriving.
 *
 * A tool call reaches us in three parts: the provider announces it with an id
 * and a name, streams the arguments as JSON text, then closes it. Only the last
 * of those used to be acted on — the card appeared when Pi was ready to *run*
 * the tool, which is after every argument has landed.
 *
 * For most tools that gap is imperceptible. For `edit` and `write` it is the
 * whole wait: their arguments carry the new file content, so a large change
 * spends thousands of tokens streaming with nothing on screen saying a file is
 * being written. The interface said "组织回答中" and told jokes while the model
 * was, in fact, well into the edit.
 *
 * Nothing here is a new kind of card. It is the same running tool row with the
 * same spinner that a bash command already gets; it simply starts when the call
 * starts rather than when it finishes streaming.
 */

/** The keys worth showing in a label. All are top-level strings in their schema. */
const LABEL_KEYS = new Set(["path", "command", "pattern", "action", "file_path"]);

export interface StreamingToolCall {
  id: string;
  name: string;
  /** Whatever arguments have arrived complete so far; usually just the path. */
  args: Record<string, string>;
}

/**
 * Read the string arguments that have fully arrived in a partial JSON payload.
 *
 * Mid-stream the text is a truncated object, so this cannot be `JSON.parse`d.
 * It scans instead, and only records a pair once both its key and its value are
 * closed — a half-arrived path would otherwise flicker through the label one
 * character at a time.
 *
 * Only depth 1 counts. `edit` nests its replacements as `{path, edits: [{oldText,
 * newText}]}`, and lifting a nested `oldText` up as though it were a top-level
 * argument would label the card with a fragment of the file being edited.
 */
export function partialJsonStrings(text: string): Record<string, string> {
  const found: Record<string, string> = {};
  let depth = 0;
  let index = 0;

  const readString = (): string | undefined => {
    if (text[index] !== '"') return undefined;
    index += 1;
    let value = "";
    while (index < text.length) {
      const character = text[index];
      if (character === "\\") {
        const escaped = text[index + 1];
        if (escaped === undefined) return undefined;
        value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
        index += 2;
        continue;
      }
      if (character === '"') {
        index += 1;
        return value;
      }
      value += character;
      index += 1;
    }
    // Ran off the end: the value is still arriving, so it is not usable yet.
    return undefined;
  };

  while (index < text.length) {
    const character = text[index];
    if (character === "{" || character === "[") {
      depth += 1;
      index += 1;
      continue;
    }
    if (character === "}" || character === "]") {
      depth -= 1;
      index += 1;
      continue;
    }
    if (character !== '"') {
      index += 1;
      continue;
    }
    const key = readString();
    if (key === undefined) break;
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (text[index] !== ":") continue;
    index += 1;
    while (index < text.length && /\s/.test(text[index])) index += 1;
    if (text[index] !== '"') continue;
    const value = readString();
    if (value === undefined) break;
    if (depth === 1 && LABEL_KEYS.has(key)) found[key] = value;
  }
  return found;
}

/** The tool call a `toolcall_start`/`toolcall_delta` update is about, if it is usable. */
export function streamingToolCall(update: unknown): StreamingToolCall | undefined {
  if (!isRecord(update)) return undefined;
  const partial = update.partial;
  if (!isRecord(partial) || !Array.isArray(partial.content)) return undefined;
  const contentIndex = update.contentIndex;
  const block = typeof contentIndex === "number" ? partial.content[contentIndex] : undefined;
  if (!isRecord(block) || block.type !== "toolCall") return undefined;
  const id = stringValue(block.id);
  const name = stringValue(block.name);
  // Without both there is nothing to draw: an unnamed card that later renames
  // itself is worse than the card arriving a moment later.
  if (!id || !name) return undefined;
  const partialJson = stringValue(block.partialJson);
  const args = partialJson ? partialJsonStrings(partialJson) : {};
  // Some providers fill `arguments` progressively instead of exposing the raw
  // text; take whatever strings are already there too.
  if (isRecord(block.arguments)) {
    for (const [key, value] of Object.entries(block.arguments)) {
      if (LABEL_KEYS.has(key) && typeof value === "string" && value) args[key] = value;
    }
  }
  return { id, name, args };
}

export interface StreamingToolTarget {
  tools: Map<string, ToolRun>;
  toolRunIds: ToolRunIds;
  nextTimelineOrder: number;
}

/**
 * Create or refresh the card for a call whose arguments are still streaming.
 *
 * The run id comes from the same `begin` the finished call will use, so when
 * `tool_execution_start` arrives with the complete arguments it lands on this
 * card instead of opening a second one. Returns the event to emit, or nothing
 * when the card already says everything it can.
 */
export function beginStreamingToolRun(
  target: StreamingToolTarget,
  update: unknown,
  label: (name: string, args: Record<string, unknown>, toolCallId: string) => string,
): RuntimeEvent | undefined {
  const streaming = streamingToolCall(update);
  if (!streaming) return undefined;
  const id = target.toolRunIds.begin(streaming.id);
  const existing = target.tools.get(id);
  // A finished card must never be dragged back to running by a late delta.
  if (existing && existing.status !== "running") return undefined;
  const args = { ...(existing?.args ?? {}), ...streaming.args };
  const tool: ToolRun = {
    id,
    order: existing?.order ?? target.nextTimelineOrder++,
    name: streaming.name,
    label: label(streaming.name, args, streaming.id),
    args,
    output: existing?.output ?? "",
    status: "running",
    startedAt: existing?.startedAt ?? Date.now(),
  };
  // Nothing changed but the clock: stay quiet rather than re-rendering the row
  // on every delta of a long argument stream.
  if (existing && existing.label === tool.label && existing.name === tool.name) return undefined;
  target.tools.set(id, tool);
  return { type: existing ? "tool_updated" : "tool_started", tool: { ...tool } };
}
