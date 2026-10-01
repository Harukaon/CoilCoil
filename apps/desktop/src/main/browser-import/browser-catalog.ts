import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import type { ImportableBrowserId, ImportableProfile } from "../../shared/desktop-api";

/**
 * Where the browsers a user might already be signed in to keep their profiles.
 *
 * Chromium forks share a profile layout but not the same OS directory or
 * encryption key. Windows paths are explicitly listed only for browsers whose
 * Windows import we intend to support; other macOS sources must not leak into
 * the Windows picker.
 *
 * Safari is not Chromium and has its own reader.
 */
export interface ChromiumBrowserDescriptor {
  id: ImportableBrowserId;
  name: string;
  /** Relative to ~/Library/Application Support on macOS. */
  userDataDirectory: string;
  /** Relative to %LOCALAPPDATA% on Windows. Only set for supported sources. */
  windowsUserDataDirectory?: string;
  /** `security find-generic-password -s <service> -a <account>` on macOS. */
  keychainService: string;
  keychainAccount: string;
}

export const CHROMIUM_BROWSERS: readonly ChromiumBrowserDescriptor[] = [
  { id: "chrome", name: "Google Chrome", userDataDirectory: "Google/Chrome", windowsUserDataDirectory: "Google/Chrome/User Data", keychainService: "Chrome Safe Storage", keychainAccount: "Chrome" },
  { id: "chrome-beta", name: "Chrome Beta", userDataDirectory: "Google/Chrome Beta", keychainService: "Chrome Safe Storage", keychainAccount: "Chrome" },
  { id: "chrome-canary", name: "Chrome Canary", userDataDirectory: "Google/Chrome Canary", keychainService: "Chromium Safe Storage", keychainAccount: "Chromium" },
  { id: "chromium", name: "Chromium", userDataDirectory: "Chromium", keychainService: "Chromium Safe Storage", keychainAccount: "Chromium" },
  { id: "edge", name: "Microsoft Edge", userDataDirectory: "Microsoft Edge", windowsUserDataDirectory: "Microsoft/Edge/User Data", keychainService: "Microsoft Edge Safe Storage", keychainAccount: "Microsoft Edge" },
  { id: "brave", name: "Brave", userDataDirectory: "BraveSoftware/Brave-Browser", keychainService: "Brave Safe Storage", keychainAccount: "Brave" },
  { id: "vivaldi", name: "Vivaldi", userDataDirectory: "Vivaldi", keychainService: "Vivaldi Safe Storage", keychainAccount: "Vivaldi" },
  { id: "arc", name: "Arc", userDataDirectory: "Arc/User Data", keychainService: "Arc Safe Storage", keychainAccount: "Arc" },
];

export function applicationSupport(home: string = homedir()): string {
  return posix.join(home, "Library", "Application Support");
}

export function chromiumBrowsersForPlatform(platform: NodeJS.Platform = process.platform): readonly ChromiumBrowserDescriptor[] {
  if (platform === "darwin") return CHROMIUM_BROWSERS;
  if (platform === "win32") return CHROMIUM_BROWSERS.filter((browser) => browser.windowsUserDataDirectory !== undefined);
  return [];
}

export function browserDescriptor(id: ImportableBrowserId, platform: NodeJS.Platform = process.platform): ChromiumBrowserDescriptor | undefined {
  return chromiumBrowsersForPlatform(platform).find((browser) => browser.id === id);
}

/** The source browser's root, not CoilCoil's Electron userData directory. */
export function browserUserDataRoot(
  browser: ChromiumBrowserDescriptor,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  localAppData: string | undefined = process.env.LOCALAPPDATA,
): string | undefined {
  if (platform === "darwin") return posix.join(applicationSupport(home), browser.userDataDirectory);
  if (platform !== "win32" || !browser.windowsUserDataDirectory) return undefined;
  return win32.join(localAppData || win32.join(home, "AppData", "Local"), browser.windowsUserDataDirectory);
}

/** A profile ID comes from a browser's directory list, never an arbitrary path. */
export function profileDirectory(
  browser: ChromiumBrowserDescriptor,
  profileId: string,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  localAppData: string | undefined = process.env.LOCALAPPDATA,
): string {
  if (!profileId || profileId === "." || profileId === ".." || /[/\\\0]/.test(profileId)) {
    throw new Error("浏览器配置目录无效，请重新选择。");
  }
  const root = browserUserDataRoot(browser, platform, home, localAppData);
  if (!root) throw new Error("这个浏览器在当前系统上不支持导入。");
  return platform === "win32" ? win32.join(root, profileId) : posix.join(root, profileId);
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

/**
 * 一个 Chromium 安装现在是什么状况。
 *
 * 必须把「没装」和「没权限」分开，因为在 macOS 上它们长得一模一样，而以前这里
 * 把两者都当成了「没装」。
 *
 * macOS 27 起，别的 App 在 `~/Library/Application Support` 下的数据目录受系统
 * 保护。没拿到权限时 `stat` 仍然**成功**（所以 existsSync 返回 true，「装没装」
 * 的检查完全过得去），但**列目录会抛 EPERM**，打开 cookie 文件也会失败。以前
 * readdir 的异常是被 catch 掉然后返回空数组的，于是整个浏览器从列表里消失，用户
 * 看到的就是「Chrome 的选项没了，只剩 Safari」，完全不知道发生了什么。
 *
 * Safari 没受影响是因为它的 cookie 文件是所有人可读的，压根碰不到这道墙。
 */
export type ChromiumListing =
  | { kind: "absent" }
  | { kind: "denied" }
  | { kind: "profiles"; profiles: ImportableProfile[] };

/** 这个错误是不是「系统不让读」，而不是「东西不在」。 */
export function isPermissionDenied(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM" || code === "EACCES";
}

export function listChromiumProfiles(
  browser: ChromiumBrowserDescriptor,
  root: string | undefined = browserUserDataRoot(browser),
): ChromiumListing {
  if (!root) return { kind: "absent" };
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch (error) {
    // 装没装看的是这一步分类的结果，不再用 existsSync —— 它对「没权限」返回 true。
    return isPermissionDenied(error) ? { kind: "denied" } : { kind: "absent" };
  }
  const labels = readProfileLabels(root);
  const profiles: ImportableProfile[] = [];
  let deniedEntries = 0;
  for (const entry of entries) {
    const path = join(root, entry);
    try {
      if (!statSync(path).isDirectory() || !isProfileDirectory(path)) continue;
    } catch (error) {
      if (isPermissionDenied(error)) deniedEntries += 1;
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
  // 一个目录在、却一个配置都没读出来，多半也是被挡住了（读到一半才被拒）。
  if (profiles.length === 0 && deniedEntries > 0) return { kind: "denied" };
  // Chrome lists `Default` first and then numbers; readdir order is arbitrary.
  profiles.sort((left, right) => (left.id === "Default" ? -1 : right.id === "Default" ? 1 : left.id.localeCompare(right.id)));
  return { kind: "profiles", profiles };
}

/**
 * Safari keeps one cookie jar for the whole application inside its sandbox
 * container, so it has exactly one importable profile no matter how many
 * Safari profiles the user created in the UI.
 */
export function safariCookiePath(): string {
  return join(homedir(), "Library", "Containers", "com.apple.Safari", "Data", "Library", "Cookies", "Cookies.binarycookies");
}
