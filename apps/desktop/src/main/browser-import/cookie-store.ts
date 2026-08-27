import { session } from "electron";
import type { Session } from "electron";
import { BROWSER_PARTITION } from "../browser-webview-policy";
import { toElectronCookie, type ImportedCookie } from "./cookie-record";

/** Everything here targets the built-in browser's jar, never the app's own. */
export function browserSession(): Session {
  return session.fromPartition(BROWSER_PARTITION);
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
export async function writeCookies(cookies: readonly ImportedCookie[]): Promise<CookieWriteResult> {
  const store = browserSession().cookies;
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
