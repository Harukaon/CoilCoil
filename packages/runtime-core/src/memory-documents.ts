import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryDocumentSnapshot } from "@suocode/runtime-protocol";

/** The file every project's memory is kept in, inside its own folder of the store. */
export const PROJECT_MEMORY_FILE = "MEMORY.md";

/** Read one memory file into the shape the UI edits. A missing file is an empty document. */
export function readMemoryDocument(
  scope: MemoryDocumentSnapshot["scope"],
  label: string,
  filePath: string,
  directory: string,
  maxChars: number,
  projectRoot?: string,
  projectName?: string,
): MemoryDocumentSnapshot {
  const exists = existsSync(filePath);
  let content = "";
  if (exists) {
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      content = "";
    }
  }
  return {
    scope,
    label,
    filePath,
    directory,
    exists,
    content,
    contentChars: Array.from(content).length,
    maxChars,
    projectRoot,
    projectName,
  };
}

/**
 * Every project the memory store holds, not just the open one.
 *
 * The store is one folder per project, so the folder listing *is* the list of
 * projects that have a memory — including projects that are not open right now,
 * and whose local path this machine may no longer know. The open project is
 * always included even before its file exists, because it is the one the user is
 * most likely to write first, and its entry is the richer one (it knows its
 * checkout path) so it wins over the folder scan.
 */
export function listProjectMemoryDocuments(
  storageRoot: string,
  maxChars: number,
  current?: MemoryDocumentSnapshot,
): MemoryDocumentSnapshot[] {
  let names: string[] = [];
  try {
    names = readdirSync(storageRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    names = [];
  }
  const byPath = new Map<string, MemoryDocumentSnapshot>();
  for (const name of names) {
    const directory = join(storageRoot, name);
    const document = readMemoryDocument(
      "project",
      name,
      join(directory, PROJECT_MEMORY_FILE),
      directory,
      maxChars,
      undefined,
      name,
    );
    if (document.exists) byPath.set(document.filePath, document);
  }
  if (current) byPath.set(current.filePath, current);
  return [...byPath.values()].sort((left, right) => (
    (left.projectName ?? left.label).localeCompare(right.projectName ?? right.label, "zh-Hans")
  ));
}
