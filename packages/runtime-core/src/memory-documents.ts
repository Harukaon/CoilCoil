import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryDocumentSnapshot } from "@coilcoil/runtime-protocol";

/** The index file every project's memory starts from, inside its own folder of the store. */
export const PROJECT_MEMORY_FILE = "MEMORY.md";

/** Memory bodies live one file each in this subfolder; the index only points at them. */
export const PROJECT_MEMORY_ENTRIES_DIR = "memories";

/** Uncurated notes are shown separately from the long-term index and bodies. */
export function listMemoryJottings(directory: string, projectName: string): MemoryDocumentSnapshot[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
    .map((entry) => entry.name).sort()
    .map((name) => readMemoryDocument("project", name.replace(/\.md$/i, ""), join(directory, name),
      directory, 0, undefined, projectName, "jotting"));
}

/** Where the background summarizer keeps its per-project turn counter. */
const PROJECT_MEMORY_STATE_FILE = ".coilcoil-memory-state.json";

/** Read one memory file into the shape the UI edits. A missing file is an empty document. */
export function readMemoryDocument(
  scope: MemoryDocumentSnapshot["scope"],
  label: string,
  filePath: string,
  directory: string,
  maxChars: number,
  projectRoot?: string,
  projectName?: string,
  kind: MemoryDocumentSnapshot["kind"] = "index",
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
    kind,
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
 * Turns counted for one project since its last background summary, 0 when unknown.
 *
 * The counter is what makes the summarizer run every N turns instead of every
 * turn, so the panel that configures N also shows how far along the count is.
 */
export function readMemoryTurnCount(projectDirectory: string): number {
  try {
    const parsed = JSON.parse(readFileSync(join(projectDirectory, PROJECT_MEMORY_STATE_FILE), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return 0;
    const turns = (parsed as { turnsSinceSummary?: unknown }).turnsSinceSummary;
    return typeof turns === "number" && Number.isFinite(turns) && turns > 0 ? Math.floor(turns) : 0;
  } catch {
    return 0;
  }
}

/** The memory bodies one project holds, each its own editable document. */
function projectMemoryEntries(
  directory: string,
  projectName: string,
  projectRoot?: string,
): MemoryDocumentSnapshot[] {
  const entriesDirectory = join(directory, PROJECT_MEMORY_ENTRIES_DIR);
  let names: string[] = [];
  try {
    names = readdirSync(entriesDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".md"))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right, "zh-Hans"));
  } catch {
    return [];
  }
  // A body file has no character budget: keeping detail out of the injected
  // index is the whole point, so only the index is measured against a limit.
  return names.map((name) => readMemoryDocument(
    "project",
    name.replace(/\.md$/i, ""),
    join(entriesDirectory, name),
    entriesDirectory,
    0,
    projectRoot,
    projectName,
    "entry",
  ));
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
    let projectName = name;
    let projectRoot: string | undefined;
    const ownerFile = join(directory, ".coilcoil-workspace.json");
    if (existsSync(ownerFile)) {
      const owner = JSON.parse(readFileSync(ownerFile, "utf8")) as { version?: number; projectRoot?: string; projectName?: string };
      if (owner.version === 1 && typeof owner.projectRoot === "string") {
        projectRoot = owner.projectRoot;
        if (typeof owner.projectName === "string" && owner.projectName.trim()) projectName = owner.projectName;
      }
    }
    const document = readMemoryDocument(
      "project",
      projectName,
      join(directory, PROJECT_MEMORY_FILE),
      directory,
      maxChars,
      projectRoot,
      projectName,
    );
    if (document.exists) byPath.set(document.filePath, document);
    // Bodies follow their own index so the panel keeps showing everything the
    // store holds, not just the summaries that stayed in the index file.
    for (const entry of projectMemoryEntries(directory, projectName, projectRoot)) byPath.set(entry.filePath, entry);
  }
  if (current) byPath.set(current.filePath, current);
  return [...byPath.values()].sort((left, right) => (
    (left.projectName ?? left.label).localeCompare(right.projectName ?? right.label, "zh-Hans")
  ));
}
