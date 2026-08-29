import { randomUUID } from "node:crypto";
import { rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import type { PreviewKind, SaveProjectFileInput, SaveProjectFileResult } from "../shared/desktop-api";

/**
 * Editing is capped at the size the preview already reads in full. Beyond it the
 * preview only holds the head of the file, and saving that back would silently
 * delete the rest — so a file this large stays read-only rather than becoming a
 * way to truncate it.
 */
export const EDITABLE_FILE_LIMIT = 2 * 1024 * 1024;

/** Only kinds whose preview content *is* the file's text can be written back. */
const EDITABLE_KINDS = new Set<PreviewKind>(["text", "markdown", "html"]);

/** How much of a file is sniffed before deciding it is not text. */
const BINARY_SNIFF_BYTES = 8192;

/**
 * A NUL byte never appears in UTF-8 text but is everywhere in binaries. Files
 * that reach the text preview by extension alone (`.log`, no extension at all)
 * can still be binary, and decoding one as UTF-8 and writing it back would
 * corrupt it, so the sniff gates editing rather than preview.
 */
export function looksBinary(buffer: Uint8Array): boolean {
  const end = Math.min(buffer.length, BINARY_SNIFF_BYTES);
  for (let index = 0; index < end; index += 1) {
    if (buffer[index] === 0) return true;
  }
  return false;
}

export interface EditableState {
  editable: boolean;
  /** Why a text file the user would expect to edit is read-only. */
  readOnlyReason?: string;
}

/** Whether an opened preview may be edited in place, and why not when it may not. */
export function editableState(kind: PreviewKind, buffer: Uint8Array, truncated: boolean): EditableState {
  if (!EDITABLE_KINDS.has(kind)) return { editable: false };
  if (truncated || buffer.length > EDITABLE_FILE_LIMIT) {
    return { editable: false, readOnlyReason: "文件超过 2 MB，只能查看，不能在这里编辑。" };
  }
  if (looksBinary(buffer)) {
    return { editable: false, readOnlyReason: "文件含二进制内容，只能查看，不能在这里编辑。" };
  }
  return { editable: true };
}

/**
 * Catch a broken JSON document before it reaches the disk. The agent and the app
 * both read these files back, and a half-typed brace saved over a working
 * `settings.json` breaks the next read instead of the current edit.
 */
export function jsonContentError(path: string, content: string): string | undefined {
  const extension = extname(path).toLowerCase();
  if (extension === ".json") {
    if (!content.trim()) return undefined;
    try {
      JSON.parse(content);
      return undefined;
    } catch (caught) {
      return `JSON 语法有误：${caught instanceof Error ? caught.message : String(caught)}`;
    }
  }
  // One JSON value per line; blank lines are ignored the way every reader does.
  if (extension === ".jsonl" || extension === ".ndjson") {
    const lines = content.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue;
      try {
        JSON.parse(line);
      } catch {
        return `第 ${index + 1} 行不是合法的 JSON。`;
      }
    }
    return undefined;
  }
  // `.jsonc` and friends allow comments, so they are deliberately not checked.
  return undefined;
}

/**
 * File timestamps survive an IPC round trip as doubles, but a file system may
 * report a coarser mtime after a write than the one it accepted, so the editor's
 * base version matches within a millisecond rather than exactly.
 */
export function mtimeMatches(left: number, right: number): boolean {
  return Math.abs(left - right) < 1;
}

/**
 * The scratch file a save is staged in: same directory, so the rename that
 * publishes it is atomic (a cross-device rename is a copy and can tear), and
 * dot-prefixed so a listing or a watcher does not present it as a real file.
 */
export function temporaryWritePath(path: string, token: string): string {
  return join(dirname(path), `.${basename(path)}.coilcoil-${token}.tmp`);
}

/** Write via a temporary file so an interrupted save leaves the original intact. */
async function writeFileAtomic(path: string, content: string, mode: number): Promise<number> {
  const temporary = temporaryWritePath(path, randomUUID().slice(0, 8));
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode });
    await rename(temporary, path);
  } catch (caught) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw caught;
  }
  return (await stat(path)).mtimeMs;
}

export type SaveProjectPathResolver = (
  input: Pick<SaveProjectFileInput, "root" | "path">,
) => Promise<{ root: string; path: string }>;

/**
 * Save an edited text file.
 *
 * Unlike preview, which deliberately opens any single path the agent cites, a
 * write must stay inside the workspace: the resolver is the one that contains it.
 * The version the editor started from is checked here too, so a file another
 * process rewrote in the meantime is never overwritten by accident — the editor
 * has to be told and re-base first.
 */
export async function saveProjectFile(
  input: SaveProjectFileInput,
  resolvePath: SaveProjectPathResolver,
): Promise<SaveProjectFileResult> {
  const target = await resolvePath(input);
  if (Buffer.byteLength(input.content, "utf8") > EDITABLE_FILE_LIMIT) {
    return { saved: false, reason: "too-large", message: "内容超过 2 MB，无法保存。" };
  }
  const syntaxError = jsonContentError(target.path, input.content);
  if (syntaxError) return { saved: false, reason: "invalid", message: syntaxError };
  const stats = await stat(target.path);
  if (!stats.isFile()) throw new Error("所选路径不是文件。");
  if (!mtimeMatches(stats.mtimeMs, input.expectedMtimeMs)) {
    return { saved: false, reason: "conflict", message: "文件已在磁盘上被改动，未覆盖。" };
  }
  return { saved: true, mtimeMs: await writeFileAtomic(target.path, input.content, stats.mode) };
}
