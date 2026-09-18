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
import { browserPartitions, browserSession, writeCookies } from "./cookie-store";
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
    problem = "没有读取权限，点这里去开";
  }
  return { browser: "safari", browserName: "Safari", id: "default", name: "默认", available, problem, ...(available ? {} : { fix: "full-disk-access" as const }) };
}

export function listImportableProfiles(): ImportableProfile[] {
  if (!importSupported()) return [];
  const profiles: ImportableProfile[] = [];
  for (const browser of CHROMIUM_BROWSERS) {
    const listing = listChromiumProfiles(browser);
    if (listing.kind === "absent") continue;
    // 没权限的时候照样把它列出来，并且说清楚为什么。以前这里和「没装」走同一条路，
    // 浏览器直接消失，用户只看得到 Safari，问不出任何原因。见 browser-catalog.ts。
    if (listing.kind === "denied") {
      profiles.push({
        browser: browser.id,
        browserName: browser.name,
        id: "default",
        name: "全部配置",
        available: false,
        problem: "没有读取权限，点这里去开",
        fix: "full-disk-access",
      });
      continue;
    }
    for (const profile of listing.profiles) {
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
async function harvestLogins(
  input: ImportBrowserCookiesInput,
  partition?: string,
): Promise<{ saved: number; unreadable: number; note?: string }> {
  if (input.browser === "safari") {
    return { saved: 0, unreadable: 0, note: "Safari 的密码存在钥匙串里，macOS 不允许整批导出，已跳过。" };
  }
  if (!vaultAvailable()) {
    return { saved: 0, unreadable: 0, note: "这台电脑无法加密保存密码，已跳过密码导入。" };
  }
  const browser = browserDescriptor(input.browser);
  if (!browser) return { saved: 0, unreadable: 0 };
  const { logins, unreadable } = await readChromiumLogins(browser, profileDirectory(browser, input.profile));
  return { saved: saveLogins(logins, partition), unreadable };
}

export async function importBrowserCookies(
  input: ImportBrowserCookiesInput,
  partition?: string,
): Promise<BrowserImportSummary> {
  const empty = { imported: 0, skipped: 0, failed: 0, unreadable: 0, hosts: 0, passwords: 0, problemHosts: [] };
  if (!importSupported()) return { ...empty, error: "目前只支持在 macOS 上导入。" };
  try {
    const { cookies, unreadable, unreadableHosts } = await harvestCookies(input);
    const written = await writeCookies(cookies, partition);
    // The keychain has already been unlocked for the cookies by this point, so
    // the passwords cost the user no second prompt.
    const logins = input.includePasswords
      ? await harvestLogins(input, partition)
      : { saved: 0, unreadable: 0, note: undefined };
    // Naming the sites is the difference between "19 条读不出来" and knowing
    // whether the one site that mattered came over.
    const problemHosts = [...new Set([...(unreadableHosts ?? []), ...written.failedHosts])]
      .map((host) => host.replace(/^\./, ""))
      .sort();
    return {
      ...written,
      unreadable: unreadable + logins.unreadable,
      passwords: logins.saved,
      problemHosts,
      note: logins.note,
    };
  } catch (error) {
    const message = error instanceof SafariAccessDeniedError || error instanceof Error ? error.message : String(error);
    return { ...empty, error: message };
  }
}

export async function browserDataStats(partition?: string): Promise<BrowserDataStats> {
  const cookies = await browserSession(partition).cookies.get({});
  const hosts = new Set(cookies.map((cookie) => (cookie.domain ?? "").replace(/^\./, "")));
  return { cookies: cookies.length, hosts: hosts.size, savedLogins: listSavedLogins(partition).length };
}

export function savedLogins(partition?: string): SavedLoginSummary[] {
  return listSavedLogins(partition);
}

/** How long any one clearing step may take before it is reported as stuck. */
const CLEAR_STEP_TIMEOUT_MS = 10_000;

export type ClearStepLogger = (event: string, data: Record<string, unknown>) => void;

/**
 * Run one clearing step under a deadline.
 *
 * Chromium's storage teardown can block on a database that is busy or damaged,
 * and an `await` that never settles leaves the user watching a spinner with
 * nothing to act on. A step that overruns is reported by name instead, so the
 * rest of the clearing still happens and the log says which store is at fault.
 */
async function clearStep(label: string, work: () => Promise<unknown>, log?: ClearStepLogger, partition?: string): Promise<string | undefined> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} 超时`)), CLEAR_STEP_TIMEOUT_MS);
      }),
    ]);
    log?.("browser_clear_step", { step: label, partition, elapsedMs: Date.now() - started });
    return undefined;
  } catch (error) {
    log?.("browser_clear_step_failed", {
      step: label,
      partition,
      elapsedMs: Date.now() - started,
      reason: error instanceof Error ? error.message : String(error),
    });
    return label;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Everything the built-in browser remembers about the user, removed.
 *
 * `clearStorageData` alone leaves the HTTP cache and the credentials of any
 * authenticated proxy behind, and both can keep a site recognising the user
 * after a "clear". The four steps together are what "signed out of everything"
 * actually takes.
 *
 * And it takes every jar, not the one the window happens to be looking at.
 * Logins are stored per workspace, so a clear scoped to the current workspace
 * left the user signed in everywhere else while the dialog said 全部 — and the
 * log dutifully reported 0 条 Cookie because it had counted that one jar too.
 */
export async function clearBrowserData(log?: ClearStepLogger): Promise<BrowserDataStats> {
  const partitions = browserPartitions();
  log?.("browser_clear_started", { partitions: partitions.length });
  const stuck = new Set<string>();
  for (const partition of partitions) {
    const store = browserSession(partition);
    for (const [label, work] of [
      ["cookies", () => store.clearStorageData({ storages: ["cookies"] })],
      ["storage", () => store.clearStorageData()],
      ["cache", () => store.clearCache()],
      ["auth", () => store.clearAuthCache()],
    ] as [string, () => Promise<unknown>][]) {
      const failed = await clearStep(label, work, log, partition);
      if (failed) stuck.add(failed);
    }
    clearSavedLogins(partition);
  }
  const stats = (await Promise.all(partitions.map((partition) => browserDataStats(partition))))
    .reduce((total, one) => ({
      cookies: total.cookies + one.cookies,
      hosts: total.hosts + one.hosts,
      savedLogins: total.savedLogins + one.savedLogins,
    }), { cookies: 0, hosts: 0, savedLogins: 0 });
  log?.("browser_clear_finished", { ...stats, partitions: partitions.length, stuck: [...stuck] });
  if (stuck.size > 0 && stats.cookies > 0) {
    throw new Error(`清空没有完成：${[...stuck].join("、")} 这一步没有响应，浏览器里还剩 ${stats.cookies} 条 Cookie。`);
  }
  return stats;
}
