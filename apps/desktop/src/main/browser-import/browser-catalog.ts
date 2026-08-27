import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ImportableBrowserId, ImportableProfile } from "../../shared/desktop-api";

/**
 * Where the browsers a user might already be signed in to keep their profiles.
 *
 * Every Chromium fork keeps the same layout under a different application
 * directory, and each one encrypts its cookies with a key stored in the login
 * keychain under its own service name. Those two strings are the whole
 * difference between them, so a table is enough — no per-browser code.
 *
 * Safari is not Chromium and shares nothing but the intent, so it is described
 * here only to keep one list of what the user can import from.
 */
export interface ChromiumBrowserDescriptor {
  id: ImportableBrowserId;
  name: string;
  /** Relative to ~/Library/Application Support. */
  userDataDirectory: string;
  /** `security find-generic-password -s <service> -a <account>`. */
  keychainService: string;
  keychainAccount: string;
}

export const CHROMIUM_BROWSERS: readonly ChromiumBrowserDescriptor[] = [
  { id: "chrome", name: "Google Chrome", userDataDirectory: "Google/Chrome", keychainService: "Chrome Safe Storage", keychainAccount: "Chrome" },
  { id: "chrome-beta", name: "Chrome Beta", userDataDirectory: "Google/Chrome Beta", keychainService: "Chrome Safe Storage", keychainAccount: "Chrome" },
  { id: "chrome-canary", name: "Chrome Canary", userDataDirectory: "Google/Chrome Canary", keychainService: "Chromium Safe Storage", keychainAccount: "Chromium" },
  { id: "chromium", name: "Chromium", userDataDirectory: "Chromium", keychainService: "Chromium Safe Storage", keychainAccount: "Chromium" },
  { id: "edge", name: "Microsoft Edge", userDataDirectory: "Microsoft Edge", keychainService: "Microsoft Edge Safe Storage", keychainAccount: "Microsoft Edge" },
  { id: "brave", name: "Brave", userDataDirectory: "BraveSoftware/Brave-Browser", keychainService: "Brave Safe Storage", keychainAccount: "Brave" },
  { id: "vivaldi", name: "Vivaldi", userDataDirectory: "Vivaldi", keychainService: "Vivaldi Safe Storage", keychainAccount: "Vivaldi" },
  { id: "arc", name: "Arc", userDataDirectory: "Arc/User Data", keychainService: "Arc Safe Storage", keychainAccount: "Arc" },
];

export function applicationSupport(): string {
  return join(homedir(), "Library", "Application Support");
}

export function browserDescriptor(id: ImportableBrowserId): ChromiumBrowserDescriptor | undefined {
  return CHROMIUM_BROWSERS.find((browser) => browser.id === id);
}

/** Absolute path of one profile directory inside a Chromium install. */
export function profileDirectory(browser: ChromiumBrowserDescriptor, profileId: string): string {
  return join(applicationSupport(), browser.userDataDirectory, profileId);
}

/**
 * Chrome's own name for a profile — "工作", "个人" — plus the signed-in account.
 *
 * This is the only thing that makes profiles distinguishable to the user: the
 * directories are called `Default`, `Profile 1`, `Profile 2`, which say nothing
 * about which persona is signed in where. Chrome keeps the display names in
 * `Local State`, so a missing or unreadable file degrades to the raw directory
 * name rather than failing the whole listing.
 */
interface ProfileLabels {
  name?: string;
  email?: string;
}

function readProfileLabels(userDataRoot: string): Map<string, ProfileLabels> {
  const labels = new Map<string, ProfileLabels>();
  try {
    const parsed = JSON.parse(readFileSync(join(userDataRoot, "Local State"), "utf8")) as {
      profile?: { info_cache?: Record<string, { name?: string; gaia_name?: string; user_name?: string }> };
    };
    for (const [directory, info] of Object.entries(parsed.profile?.info_cache ?? {})) {
      labels.set(directory, { name: info.name ?? info.gaia_name, email: info.user_name });
    }
  } catch {
    // No Local State, or a shape we do not recognise: fall back to directory names.
  }
  return labels;
}

/** A directory is a profile when it holds the file we came for. */
function isProfileDirectory(path: string): boolean {
  return existsSync(join(path, "Cookies")) || existsSync(join(path, "Network", "Cookies"));
}

/**
 * The cookie database moved into a `Network` subdirectory in Chrome 96; both
 * locations still appear in the wild, so try the current one first.
 */
export function cookieDatabasePath(profilePath: string): string | undefined {
  for (const candidate of [join(profilePath, "Network", "Cookies"), join(profilePath, "Cookies")]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function passwordDatabasePath(profilePath: string): string | undefined {
  const candidate = join(profilePath, "Login Data");
  return existsSync(candidate) ? candidate : undefined;
}

export function listChromiumProfiles(browser: ChromiumBrowserDescriptor): ImportableProfile[] {
  const root = join(applicationSupport(), browser.userDataDirectory);
  if (!existsSync(root)) return [];
  const labels = readProfileLabels(root);
  const profiles: ImportableProfile[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const path = join(root, entry);
    try {
      if (!statSync(path).isDirectory() || !isProfileDirectory(path)) continue;
    } catch {
      continue;
    }
    const label = labels.get(entry);
    profiles.push({
      browser: browser.id,
      browserName: browser.name,
      id: entry,
      name: label?.name ?? (entry === "Default" ? "默认" : entry),
      email: label?.email || undefined,
      available: true,
    });
  }
  // Chrome lists `Default` first and then numbers; readdir order is arbitrary.
  return profiles.sort((left, right) => (left.id === "Default" ? -1 : right.id === "Default" ? 1 : left.id.localeCompare(right.id)));
}

/**
 * Safari keeps one cookie jar for the whole application inside its sandbox
 * container, so it has exactly one importable profile no matter how many
 * Safari profiles the user created in the UI.
 */
export function safariCookiePath(): string {
  return join(homedir(), "Library", "Containers", "com.apple.Safari", "Data", "Library", "Cookies", "Cookies.binarycookies");
}
