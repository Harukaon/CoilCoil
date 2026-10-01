import type { ChromiumBrowserDescriptor } from "./browser-catalog";
import { cookieDatabasePath } from "./browser-catalog";
import { decryptChromiumValue, readSafeStorageKey } from "./chromium-crypto";
import type { CookieHarvest, ImportedCookie } from "./cookie-record";
import { chromiumTimeToUnixSeconds, withDatabaseCopy } from "./sqlite-snapshot";
import { decryptWindowsChromiumValue, type WindowsChromiumKeys } from "./windows-chromium-crypto";

/**
 * Every integer arrives as a BigInt.
 *
 * Chromium stores timestamps as microseconds since 1601, which passed
 * `Number.MAX_SAFE_INTEGER` in 1885 — `node:sqlite` refuses to narrow those to a
 * JavaScript number and throws. Reading the whole row as BigInt is the only way
 * to get the cookie at all; the small columns are narrowed back below.
 */
interface CookieRow {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Uint8Array;
  path: string;
  expires_utc: bigint;
  is_secure: bigint;
  is_httponly: bigint;
  is_persistent: bigint;
  samesite: bigint;
}

/** Chromium's SameSite enum, which is not the string Electron wants. */
function sameSiteOf(value: bigint): ImportedCookie["sameSite"] {
  if (value === 0n) return "no_restriction";
  if (value === 1n) return "lax";
  if (value === 2n) return "strict";
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
  providedKeys?: Buffer | WindowsChromiumKeys,
): Promise<CookieHarvest> {
  const database = cookieDatabasePath(profilePath);
  if (!database) return { cookies: [], unreadable: 0 };
  return cookiesFromDatabase(database, providedKeys ?? await readSafeStorageKey(browser));
}

/** Split from the reader above so the row handling can be tested without a keychain. */
export function cookiesFromDatabase(database: string, keys: Buffer | WindowsChromiumKeys): CookieHarvest {
  return withDatabaseCopy(database, (connection) => {
    const statement = connection.prepare(
      "SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, is_persistent, samesite FROM cookies",
    );
    statement.setReadBigInts(true);
    const rows = statement.all() as unknown as CookieRow[];
    const cookies: ImportedCookie[] = [];
    const unreadableHosts = new Set<string>();
    let unreadable = 0;
    for (const row of rows) {
      const encrypted = Buffer.from(row.encrypted_value ?? new Uint8Array());
      // Very old records were written before encryption and keep the plaintext
      // in `value`; anything else has to go through the safe-storage key.
      const value = encrypted.length > 0
        ? Buffer.isBuffer(keys)
          ? decryptChromiumValue(encrypted, row.host_key, keys)
          : decryptWindowsChromiumValue(encrypted, row.host_key, keys)
        : row.value;
      if (value === undefined) {
        unreadable += 1;
        unreadableHosts.add(row.host_key);
        continue;
      }
      const expiresAt = chromiumTimeToUnixSeconds(row.expires_utc);
      cookies.push({
        host: row.host_key,
        name: row.name,
        value,
        path: row.path || "/",
        secure: row.is_secure === 1n,
        httpOnly: row.is_httponly === 1n,
        expiresAt: row.is_persistent === 1n && expiresAt > 0 ? expiresAt : undefined,
        sameSite: sameSiteOf(row.samesite),
      });
    }
    return { cookies, unreadable, unreadableHosts: [...unreadableHosts] };
  });
}
