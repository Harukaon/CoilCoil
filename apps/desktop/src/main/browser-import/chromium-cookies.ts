import type { ChromiumBrowserDescriptor } from "./browser-catalog";
import { cookieDatabasePath } from "./browser-catalog";
import { decryptChromiumValue, readSafeStorageKey } from "./chromium-crypto";
import type { CookieHarvest, ImportedCookie } from "./cookie-record";
import { chromiumTimeToUnixSeconds, withDatabaseCopy } from "./sqlite-snapshot";

interface CookieRow {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Uint8Array;
  path: string;
  expires_utc: number | bigint;
  is_secure: number;
  is_httponly: number;
  is_persistent: number;
  samesite: number;
}

/** Chromium's SameSite enum, which is not the string Electron wants. */
function sameSiteOf(value: number): ImportedCookie["sameSite"] {
  if (value === 0) return "no_restriction";
  if (value === 1) return "lax";
  if (value === 2) return "strict";
  return "unspecified";
}

/** How many cookies a profile holds — cheap, and needs no keychain access. */
export function countChromiumCookies(profilePath: string): number | undefined {
  const database = cookieDatabasePath(profilePath);
  if (!database) return undefined;
  try {
    return withDatabaseCopy(database, (connection) => {
      const row = connection.prepare("SELECT COUNT(*) AS total FROM cookies").get() as { total: number | bigint } | undefined;
      return Number(row?.total ?? 0);
    });
  } catch {
    return undefined;
  }
}

export async function readChromiumCookies(
  browser: ChromiumBrowserDescriptor,
  profilePath: string,
): Promise<CookieHarvest> {
  const database = cookieDatabasePath(profilePath);
  if (!database) return { cookies: [], unreadable: 0 };
  const key = await readSafeStorageKey(browser);
  return withDatabaseCopy(database, (connection) => {
    const rows = connection
      .prepare(
        "SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, is_persistent, samesite FROM cookies",
      )
      .all() as unknown as CookieRow[];
    const cookies: ImportedCookie[] = [];
    let unreadable = 0;
    for (const row of rows) {
      const encrypted = Buffer.from(row.encrypted_value ?? new Uint8Array());
      // Very old records were written before encryption and keep the plaintext
      // in `value`; anything else has to go through the safe-storage key.
      const value = encrypted.length > 0 ? decryptChromiumValue(encrypted, row.host_key, key) : row.value;
      if (value === undefined) {
        unreadable += 1;
        continue;
      }
      const expiresAt = chromiumTimeToUnixSeconds(row.expires_utc);
      cookies.push({
        host: row.host_key,
        name: row.name,
        value,
        path: row.path || "/",
        secure: row.is_secure === 1,
        httpOnly: row.is_httponly === 1,
        expiresAt: row.is_persistent === 1 && expiresAt > 0 ? expiresAt : undefined,
        sameSite: sameSiteOf(row.samesite),
      });
    }
    return { cookies, unreadable };
  });
}
