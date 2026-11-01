import { createHash } from "node:crypto";
import { open, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export const WORKSPACE_MEMORY_OWNER_FILE = ".coilcoil-workspace.json";

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === "ENOENT"; }
async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) { if (missing(error)) return false; throw error; }
}
async function canonical(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) { if (missing(error)) return resolve(path); throw error; }
}
async function jsonFile(path: string): Promise<Record<string, unknown> | undefined> {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (missing(error) || error instanceof SyntaxError) return undefined; throw error; }
}

/** Read only the session header; conversation bodies may be many megabytes. */
async function sessionOwner(path: string): Promise<string | undefined> {
  let file;
  try {
    file = await open(path, "r");
    const bytes = Buffer.alloc(64 * 1024);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const first = bytes.subarray(0, bytesRead).toString("utf8").split("\n", 1)[0];
    const header = JSON.parse(first);
    return header?.type === "session" && typeof header.cwd === "string" ? canonical(header.cwd) : undefined;
  } catch (error) {
    if (missing(error) || error instanceof SyntaxError) return undefined;
    throw error;
  } finally { await file?.close(); }
}

async function legacyOwner(directory: string): Promise<string | undefined> {
  const owner = await jsonFile(join(directory, WORKSPACE_MEMORY_OWNER_FILE));
  if (owner) return owner.version === 1 && typeof owner.projectRoot === "string" ? canonical(owner.projectRoot) : undefined;
  const state = await jsonFile(join(directory, ".coilcoil-memory-state.json"));
  const references = state?.processedSessions;
  if (!Array.isArray(references) || !references.length || references.some((path) => typeof path !== "string")) return undefined;
  const owners = new Set<string>();
  for (const path of references) {
    const project = await sessionOwner(path);
    if (!project) return undefined;
    owners.add(project);
    if (owners.size > 1) return undefined;
  }
  return [...owners][0];
}

/** Different canonical workspaces never share a basename-only memory directory. */
export async function workspaceMemoryDirectory(storageRoot: string, projectRoot: string, projectName: string): Promise<{
  projectMemoryDir: string; legacyMemoryDir?: string; migrationNotice?: string;
}> {
  const digest = createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
  const projectMemoryDir = join(storageRoot, `${projectName.slice(0, 48)}--${digest}`);
  const legacy = join(storageRoot, projectName);
  if (!await exists(legacy)) return { projectMemoryDir };
  const owner = await legacyOwner(legacy);
  if (!await exists(legacy)) return { projectMemoryDir };
  if (owner && owner !== projectRoot) return { projectMemoryDir };
  if (owner === projectRoot && !await exists(projectMemoryDir)) {
    try {
      await writeFile(join(legacy, WORKSPACE_MEMORY_OWNER_FILE),
        `${JSON.stringify({ version: 1, projectRoot, projectName }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
    }
    // Saved prompts and running workers can still reference this exact path.
    return { projectMemoryDir: legacy };
  }
  return {
    projectMemoryDir,
    legacyMemoryDir: legacy,
    migrationNotice: `旧记忆目录 ${legacy} ${owner ? "与当前工作区的新记忆目录同时存在" : "没有唯一、可核实的工作区归属"}，已原样保留且不会自动注入。请核对后将需要的内容导入当前工作区记忆。`,
  };
}
