import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { app, safeStorage } from "electron";
import type { ImportedLogin } from "./chromium-passwords";
import { BROWSER_PARTITION } from "../browser-webview-policy";

/**
 * Where imported logins live.
 *
 * Cookies go straight into the built-in browser's own jar because Chromium owns
 * that store; passwords have no such home — Electron has no password manager —
 * so CoilCoil keeps its own, encrypted with the operating system's key through
 * `safeStorage` (the login keychain on macOS). The file is useless on another
 * machine and unreadable to any other user account on this one.
 *
 * Passwords never reach the model: nothing here is exposed to the agent, to a
 * tool, or over the remote-control bridge. The only consumer is the autofill
 * that runs inside the built-in browser's own page.
 */
export interface VaultEntry {
  origin: string;
  username: string;
  password: string;
  importedAt: number;
}

/** What may be shown on screen: everything except the secret. */
export interface SavedLoginSummary {
  origin: string;
  username: string;
  importedAt: number;
}

/**
 * One vault per cookie jar, i.e. one per workspace.
 *
 * Cookies are already kept apart by workspace; passwords have to follow, or the
 * separation is a half-measure — an account imported for one project would keep
 * autofilling in every other, and "清空" in one would empty them all.
 *
 * The default jar keeps the original filename, so the logins imported before
 * this split stay exactly where they were.
 */
function vaultPath(partition?: string): string {
  const suffix = partition && partition !== BROWSER_PARTITION
    ? `-${partition.slice(partition.lastIndexOf("-") + 1)}`
    : "";
  return join(app.getPath("userData"), `browser-credentials${suffix}.bin`);
}

function readVault(partition?: string): VaultEntry[] {
  const path = vaultPath(partition);
  if (!existsSync(path)) return [];
  try {
    if (!safeStorage.isEncryptionAvailable()) return [];
    return JSON.parse(safeStorage.decryptString(readFileSync(path))) as VaultEntry[];
  } catch {
    // A vault written by another machine, or a corrupted file. Treat it as empty
    // rather than failing the browser: the user can import again.
    return [];
  }
}

function writeVault(entries: VaultEntry[], partition?: string): void {
  const path = vaultPath(partition);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, safeStorage.encryptString(JSON.stringify(entries)), { mode: 0o600 });
}

export function vaultAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

/**
 * Merge imported logins into the vault, newest wins.
 *
 * Re-importing the same profile after changing a password on the site must end
 * with the new password, so an existing (origin, username) pair is replaced
 * rather than duplicated.
 */
export function saveLogins(logins: readonly ImportedLogin[], partition?: string): number {
  if (logins.length === 0) return 0;
  const byKey = new Map(readVault(partition).map((entry) => [`${entry.origin} ${entry.username}`, entry]));
  const now = Date.now();
  for (const login of logins) {
    byKey.set(`${login.origin} ${login.username}`, {
      origin: login.origin,
      username: login.username,
      password: login.password,
      importedAt: now,
    });
  }
  writeVault([...byKey.values()], partition);
  return logins.length;
}

export function listSavedLogins(partition?: string): SavedLoginSummary[] {
  return readVault(partition)
    .map(({ origin, username, importedAt }) => ({ origin, username, importedAt }))
    .sort((left, right) => left.origin.localeCompare(right.origin));
}

/** Credentials for one origin, for the autofill only. */
export function loginsForOrigin(origin: string, partition?: string): VaultEntry[] {
  return readVault(partition).filter((entry) => entry.origin === origin);
}

export function clearSavedLogins(partition?: string): void {
  rmSync(vaultPath(partition), { force: true });
}
