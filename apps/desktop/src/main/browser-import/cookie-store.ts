import { readdirSync } from "node:fs";
import { join } from "node:path";
import { app, session } from "electron";
import type { Session } from "electron";
import { BROWSER_PARTITION } from "../browser-page-policy";
import { toElectronCookie, type ImportedCookie } from "./cookie-record";

/**
 * The jar everything here writes to: the built-in browser's, never the app's own.
 *
 * Takes the partition because there is one jar per workspace now — the caller
 * (main, which knows which folder the window has open) says which.
 */
export function browserSession(partition: string = BROWSER_PARTITION): Session {
  return session.fromPartition(partition);
}

/**
 * 内置浏览器开过的每一份 cookie jar。
 *
 * 「清空」只能按一个分区来做的时候，它清的是当前工作区那一份——而登录状态是按
 * 工作区分开存的，所以用户在别的工作区里登的 Google、GitHub 一条都没动，界面却
 * 说「已退出全部登录」。按钮承诺的是全部，那就得真的是全部。
 *
 * 从磁盘上枚举而不是从内存里的会话列表：要清掉的恰恰是那些当前没开着的工作区，
 * 它们的分区此刻一个 Session 对象都没有。目录名就是 `persist:` 后面那一截，所以
 * 前缀一对就能把内置浏览器的分区和应用自己的会话分开。
 */
export function browserPartitions(): string[] {
  const partitions = new Set<string>([BROWSER_PARTITION]);
  try {
    for (const entry of readdirSync(join(app.getPath("userData"), "Partitions"), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const partition = `persist:${entry.name}`;
      if (partition === BROWSER_PARTITION || partition.startsWith(`${BROWSER_PARTITION}-`)) partitions.add(partition);
    }
  } catch {
    // 还没有任何工作区开过页面，那就只有默认那一份。
  }
  return [...partitions];
}

export interface CookieWriteResult {
  imported: number;
  skipped: number;
  failed: number;
  hosts: number;
  /** Sites the built-in browser refused a cookie for, so a report can name them. */
  failedHosts: string[];
}

/**
 * Write harvested cookies into the built-in browser.
 *
 * Failures are counted rather than propagated: a jar of several thousand
 * cookies always holds a few Electron will not accept (malformed hosts left by
 * extensions, `__Host-` prefixes whose attributes no longer satisfy the rule),
 * and losing the other several thousand over them would be absurd.
 */
export async function writeCookies(
  cookies: readonly ImportedCookie[],
  partition?: string,
): Promise<CookieWriteResult> {
  const store = browserSession(partition).cookies;
  const now = Math.floor(Date.now() / 1000);
  const hosts = new Set<string>();
  const failedHosts = new Set<string>();
  let imported = 0;
  let skipped = 0;
  let failed = 0;

  const pending: ImportedCookie[] = [];
  for (const cookie of cookies) {
    if (!cookie.host || !cookie.name) {
      skipped += 1;
      continue;
    }
    // An expired cookie carries no session and would be dropped on write anyway.
    if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
      skipped += 1;
      continue;
    }
    pending.push(cookie);
  }

  // The cookie store is one async call per record; a bounded window keeps a
  // large jar from opening thousands of concurrent requests at once.
  const WINDOW = 32;
  for (let index = 0; index < pending.length; index += WINDOW) {
    const slice = pending.slice(index, index + WINDOW);
    const results = await Promise.allSettled(slice.map(async (cookie) => {
      await store.set(toElectronCookie(cookie));
      hosts.add(cookie.host.replace(/^\./, ""));
    }));
    results.forEach((result, offset) => {
      if (result.status === "fulfilled") imported += 1;
      else {
        failed += 1;
        failedHosts.add(slice[offset].host);
      }
    });
  }
  return { imported, skipped, failed, hosts: hosts.size, failedHosts: [...failedHosts] };
}
