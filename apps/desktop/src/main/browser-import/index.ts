import { existsSync, statSync } from "node:fs";
import type {
  BrowserDataStats,
  BrowserImportSummary,
  ImportBrowserCookiesInput,
  ImportableProfile,
  SavedLoginSummary,
} from "../../shared/desktop-api";
import { CHROMIUM_BROWSERS, browserDescriptor, listChromiumProfiles, profileDirectory, safariCookiePath } from "./browser-catalog";
import { countChromiumCookies, readChromiumCookies } from "./chromium-cookies";
import { countChromiumLogins, readChromiumLogins } from "./chromium-passwords";
import type { CookieHarvest } from "./cookie-record";
import { browserSession, writeCookies } from "./cookie-store";
import { clearSavedLogins, listSavedLogins, saveLogins, vaultAvailable } from "./password-vault";
import { SafariAccessDeniedError, readSafariCookies } from "./safari-cookies";

export { fillSavedCredentials } from "./password-autofill";

/**
 * Importing another browser's signed-in state, and wiping our own.
 *
 * The built-in browser starts every session logged out of everything, which
 * makes the agent useless on any site the user is already signed in to. Every
 * browser ships an importer for exactly this reason; this is ours. The
 * counterpart matters just as much: what was imported must be droppable in one
 * click, because the user is handing an agent their sessions and needs a way back.
 *
 * macOS only for now. Chrome 127 moved Windows to app-bound encryption, which
 * another application cannot read at all, so the UI says so there rather than
 * offering a button that fails.
 */
export function importSupported(): boolean {
  return process.platform === "darwin";
}

function safariProfile(): ImportableProfile | undefined {
  const path = safariCookiePath();
  if (!existsSync(path)) return undefined;
  let available = true;
  let problem: string | undefined;
  try {
    statSync(path);
  } catch {
    available = false;
    problem = "需要「完全磁盘访问权限」";
  }
  return { browser: "safari", browserName: "Safari", id: "default", name: "默认", available, problem };
}

export function listImportableProfiles(): ImportableProfile[] {
  if (!importSupported()) return [];
  const profiles: ImportableProfile[] = [];
  for (const browser of CHROMIUM_BROWSERS) {
    for (const profile of listChromiumProfiles(browser)) {
      const path = profileDirectory(browser, profile.id);
      profiles.push({
        ...profile,
        cookieCount: countChromiumCookies(path),
        passwordCount: countChromiumLogins(path),
      });
    }
  }
  const safari = safariProfile();
  if (safari) profiles.push(safari);
  return profiles;
}

async function harvestCookies(input: ImportBrowserCookiesInput): Promise<CookieHarvest> {
  if (input.browser === "safari") return readSafariCookies(safariCookiePath());
  const browser = browserDescriptor(input.browser);
  if (!browser) throw new Error("不认识这个浏览器。");
  const path = profileDirectory(browser, input.profile);
  if (!existsSync(path)) throw new Error("这个浏览器配置文件已经不在了，请刷新列表。");
  return readChromiumCookies(browser, path);
}

/**
 * Safari's passwords are not in a file this can read: they are individual
 * keychain items, each of which macOS gates behind its own prompt. There is no
 * batch export, so saying so is the only honest answer.
 */
async function harvestLogins(input: ImportBrowserCookiesInput): Promise<{ saved: number; unreadable: number; note?: string }> {
  if (input.browser === "safari") {
    return { saved: 0, unreadable: 0, note: "Safari 的密码存在钥匙串里，macOS 不允许整批导出，已跳过。" };
  }
  if (!vaultAvailable()) {
    return { saved: 0, unreadable: 0, note: "这台电脑无法加密保存密码，已跳过密码导入。" };
  }
  const browser = browserDescriptor(input.browser);
  if (!browser) return { saved: 0, unreadable: 0 };
  const { logins, unreadable } = await readChromiumLogins(browser, profileDirectory(browser, input.profile));
  return { saved: saveLogins(logins), unreadable };
}

export async function importBrowserCookies(input: ImportBrowserCookiesInput): Promise<BrowserImportSummary> {
  const empty = { imported: 0, skipped: 0, failed: 0, unreadable: 0, hosts: 0, passwords: 0 };
  if (!importSupported()) return { ...empty, error: "目前只支持在 macOS 上导入。" };
  try {
    const { cookies, unreadable } = await harvestCookies(input);
    const written = await writeCookies(cookies);
    // The keychain has already been unlocked for the cookies by this point, so
    // the passwords cost the user no second prompt.
    const logins = input.includePasswords ? await harvestLogins(input) : { saved: 0, unreadable: 0, note: undefined };
    return {
      ...written,
      unreadable: unreadable + logins.unreadable,
      passwords: logins.saved,
      note: logins.note,
    };
  } catch (error) {
    const message = error instanceof SafariAccessDeniedError || error instanceof Error ? error.message : String(error);
    return { ...empty, error: message };
  }
}

export async function browserDataStats(): Promise<BrowserDataStats> {
  const cookies = await browserSession().cookies.get({});
  const hosts = new Set(cookies.map((cookie) => (cookie.domain ?? "").replace(/^\./, "")));
  return { cookies: cookies.length, hosts: hosts.size, savedLogins: listSavedLogins().length };
}

export function savedLogins(): SavedLoginSummary[] {
  return listSavedLogins();
}

/**
 * Everything the built-in browser remembers about the user, removed.
 *
 * `clearStorageData` alone leaves the HTTP cache and the credentials of any
 * authenticated proxy behind, and both can keep a site recognising the user
 * after a "clear". The four calls together are what "signed out of everything"
 * actually takes.
 */
export async function clearBrowserData(): Promise<BrowserDataStats> {
  const store = browserSession();
  await store.clearStorageData();
  await store.clearCache();
  await store.clearAuthCache();
  clearSavedLogins();
  return browserDataStats();
}
