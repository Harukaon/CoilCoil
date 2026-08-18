import {
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "./runtime-utils.js";

/**
 * Point a persisted session at another project directory.
 *
 * SuoCode gives every project the same flat session directory, and Pi's
 * `SessionManager.list(cwd, sessionDir)` decides which project a session
 * belongs to purely from the `cwd` recorded in its header. Rewriting that one
 * field is therefore a true move: the file name, session id, and the archived
 * and pinned maps keyed by session path all survive it, and no history is
 * duplicated the way `SessionManager.forkFrom` would.
 */
export function rewriteSessionHeaderCwd(sessionFile: string, targetCwd: string): void {
  const raw = readFileSync(sessionFile, "utf8");
  const newlineIndex = raw.indexOf("\n");
  const headerLine = newlineIndex === -1 ? raw : raw.slice(0, newlineIndex);
  const rest = newlineIndex === -1 ? "" : raw.slice(newlineIndex + 1);

  let header: unknown;
  try {
    header = JSON.parse(headerLine);
  } catch {
    throw new Error("会话文件已损坏：无法解析会话头。");
  }
  if (!isRecord(header) || header.type !== "session") {
    throw new Error("会话文件缺少会话头，无法移动。");
  }

  const nextHeader = { ...header, cwd: targetCwd };
  const contents = `${JSON.stringify(nextHeader)}\n${rest}`;
  // Write beside the original so a crash cannot leave a half-written session.
  const temporary = join(dirname(sessionFile), `.${Date.now()}-move.jsonl`);
  writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, sessionFile);
}
