import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const LEGACY_MAC_DATA_ROOT = "@suocode";
const LEGACY_APP_DIRECTORY = "SuoCode";
const MIGRATION_MARKER = ".coilcoil-data-migration.json";
const SKIPPED_AGENT_DIRECTORIES = new Set(["runtime-bin", "terminal-output"]);
const SKIPPED_AGENT_FILES = new Set(["suocode-settings.json"]);
const SKIPPED_BUNDLED_SKILLS_DIRECTORY = "skill";
const TEXT_EXTENSIONS = new Set([".json", ".jsonl", ".md", ".txt", ".yaml", ".yml"]);

export interface LegacyDataMigrationResult {
  migrated: boolean;
  source?: string;
  copied: string[];
  skipped: string[];
}

function legacyUserDataCandidates(currentUserData: string): string[] {
  const current = resolve(currentUserData);
  const parent = dirname(current);
  const parentName = basename(parent);
  const candidates: string[] = [];

  // macOS electron-builder data roots use the scoped directory derived from the
  // application id, followed by the app's data namespace.
  if (basename(current) === "desktop" && parentName.startsWith("@")) {
    candidates.push(join(dirname(parent), LEGACY_MAC_DATA_ROOT, "desktop"));
  }
  // Linux/Windows use the product name directly as the userData directory.
  candidates.push(join(dirname(current), LEGACY_APP_DIRECTORY));
  return [...new Set(candidates)];
}

function copyIfAbsent(source: string, target: string, copied: string[], skipped: string[]): void {
  if (existsSync(target)) {
    const sourceStat = lstatSync(source);
    const targetStat = lstatSync(target);
    if (sourceStat.isDirectory() && targetStat.isDirectory()) {
      for (const entry of readdirSync(source)) {
        copyIfAbsent(join(source, entry), join(target, entry), copied, skipped);
      }
    } else {
      skipped.push(target);
    }
    return;
  }

  mkdirSync(dirname(target), { recursive: true });
  cpSync(source, target, { recursive: true, force: false, errorOnExist: true });
  copied.push(target);
}

function copyAgent(source: string, target: string, copied: string[], skipped: string[]): void {
  if (!existsSync(source)) return;
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source)) {
    if (SKIPPED_AGENT_DIRECTORIES.has(entry) || SKIPPED_AGENT_FILES.has(entry)) continue;
    if (entry === "skills") {
      const sourceSkills = join(source, entry);
      const targetSkills = join(target, entry);
      mkdirSync(targetSkills, { recursive: true });
      for (const skill of readdirSync(sourceSkills)) {
        if (skill === SKIPPED_BUNDLED_SKILLS_DIRECTORY) continue;
        copyIfAbsent(join(sourceSkills, skill), join(targetSkills, skill), copied, skipped);
      }
      continue;
    }
    copyIfAbsent(join(source, entry), join(target, entry), copied, skipped);
  }

  // A newly-created app has an empty auth object. It is not a real user
  // configuration, so allow the old credentials to seed it once.
  const sourceAuth = join(source, "auth.json");
  const targetAuth = join(target, "auth.json");
  if (existsSync(sourceAuth) && existsSync(targetAuth)) {
    try {
      const current = JSON.parse(readFileSync(targetAuth, "utf8")) as unknown;
      if (current && typeof current === "object" && !Array.isArray(current) && Object.keys(current).length === 0) {
        cpSync(sourceAuth, targetAuth, { force: true });
        copied.push(targetAuth);
      }
    } catch {
      // Leave a malformed target untouched; startup can report its own error.
    }
  }

  // This setting was renamed with the product. Keep the persisted preference
  // while avoiding a permanent old-brand filename in the new data root.
  const legacySettings = join(source, "suocode-settings.json");
  const currentSettings = join(target, "coilcoil-settings.json");
  if (existsSync(legacySettings) && !existsSync(currentSettings)) {
    copyIfAbsent(legacySettings, currentSettings, copied, skipped);
  }
}

function rewriteText(path: string, replacements: readonly [string, string][]): void {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension)) return;
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    return;
  }
  let next = content;
  for (const [from, to] of replacements) next = next.replaceAll(from, to);
  if (next !== content) writeFileSync(path, next, "utf8");
}

function rewriteTree(root: string, replacements: readonly [string, string][]): void {
  if (!existsSync(root)) return;
  const stat = lstatSync(root);
  if (!stat.isDirectory()) {
    rewriteText(root, replacements);
    return;
  }
  for (const entry of readdirSync(root)) rewriteTree(join(root, entry), replacements);
}

function rewriteSessionPaths(sessionDir: string, oldRoot: string, newRoot: string): void {
  rewriteTree(sessionDir, [[oldRoot, newRoot]]);
}

function migrateMemoryState(memoryDir: string, oldRoot: string, newRoot: string): void {
  rewriteTree(memoryDir, [[oldRoot, newRoot]]);
  if (!existsSync(memoryDir)) return;
  for (const project of readdirSync(memoryDir)) {
    const oldState = join(memoryDir, project, ".suocode-memory-state.json");
    const newState = join(memoryDir, project, ".coilcoil-memory-state.json");
    if (existsSync(oldState) && !existsSync(newState)) renameSync(oldState, newState);
  }
}

export function migrateLegacyUserData(currentUserData: string): LegacyDataMigrationResult {
  const current = resolve(currentUserData);
  if (!existsSync(current)) mkdirSync(current, { recursive: true });
  const marker = join(current, MIGRATION_MARKER);
  if (existsSync(marker)) return { migrated: false, copied: [], skipped: [] };

  const source = legacyUserDataCandidates(current).find((candidate) => (
    resolve(candidate) !== current && existsSync(candidate) && existsSync(join(candidate, "sessions"))
  ));
  if (!source) return { migrated: false, copied: [], skipped: [] };

  const copied: string[] = [];
  const skipped: string[] = [];
  copyAgent(join(source, "agent"), join(current, "agent"), copied, skipped);
  for (const directory of ["sessions", "Home", "browser-artifacts"]) {
    const from = join(source, directory);
    if (existsSync(from)) copyIfAbsent(from, join(current, directory), copied, skipped);
  }

  rewriteSessionPaths(join(current, "sessions"), source, current);
  rewriteSessionPaths(join(current, "agent", "archived-sessions.json"), source, current);
  rewriteSessionPaths(join(current, "agent", "pinned-sessions.json"), source, current);
  migrateMemoryState(join(current, "agent", "memory"), source, current);

  writeFileSync(marker, `${JSON.stringify({ version: 1, source, migratedAt: new Date().toISOString() }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return { migrated: true, source, copied, skipped };
}

export function legacyUserDataPathsForTesting(currentUserData: string): string[] {
  return legacyUserDataCandidates(currentUserData);
}
