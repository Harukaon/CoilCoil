import type { ChromiumBrowserDescriptor } from "./browser-catalog";
import { passwordDatabasePath } from "./browser-catalog";
import { decryptChromiumValue, readSafeStorageKey } from "./chromium-crypto";
import { withDatabaseCopy } from "./sqlite-snapshot";

/** A saved login, as the source browser stored it. */
export interface ImportedLogin {
  /** The site the credential belongs to, e.g. `https://github.com`. */
  origin: string;
  /** Where the form lived, kept so a fill can tell two forms on one site apart. */
  formUrl: string;
  username: string;
  password: string;
}

export interface LoginHarvest {
  logins: ImportedLogin[];
  unreadable: number;
}

interface LoginRow {
  origin_url: string;
  action_url: string | null;
  username_value: string | null;
  password_value: Uint8Array | null;
  signon_realm: string;
  blacklisted_by_user: number;
}

/**
 * Chromium's `signon_realm` is a URL for web logins and a scheme-less realm for
 * HTTP auth. Only the first kind can be filled into a page, and reducing it to
 * an origin is what makes lookup by the address bar possible.
 */
function originOf(row: LoginRow): string | undefined {
  try {
    return new URL(row.signon_realm || row.origin_url).origin;
  } catch {
    return undefined;
  }
}

/** How many logins a profile holds — no keychain access required. */
export function countChromiumLogins(profilePath: string): number | undefined {
  const database = passwordDatabasePath(profilePath);
  if (!database) return undefined;
  try {
    return withDatabaseCopy(database, (connection) => {
      const row = connection
        .prepare("SELECT COUNT(*) AS total FROM logins WHERE blacklisted_by_user = 0")
        .get() as { total: number | bigint } | undefined;
      return Number(row?.total ?? 0);
    });
  } catch {
    return undefined;
  }
}

export async function readChromiumLogins(
  browser: ChromiumBrowserDescriptor,
  profilePath: string,
): Promise<LoginHarvest> {
  const database = passwordDatabasePath(profilePath);
  if (!database) return { logins: [], unreadable: 0 };
  const key = await readSafeStorageKey(browser);
  return withDatabaseCopy(database, (connection) => {
    const rows = connection
      .prepare(
        "SELECT origin_url, action_url, username_value, password_value, signon_realm, blacklisted_by_user FROM logins",
      )
      .all() as unknown as LoginRow[];
    const logins: ImportedLogin[] = [];
    let unreadable = 0;
    for (const row of rows) {
      // A blacklisted entry records that the user refused to save a password for
      // that site. It holds nothing to import and must not be resurrected.
      if (row.blacklisted_by_user === 1) continue;
      const origin = originOf(row);
      if (!origin || !row.password_value || row.password_value.length === 0) continue;
      // Passwords carry no host binding, so the empty host key disables that step.
      const password = decryptChromiumValue(Buffer.from(row.password_value), "", key);
      if (password === undefined) {
        unreadable += 1;
        continue;
      }
      logins.push({
        origin,
        formUrl: row.action_url || row.origin_url,
        username: row.username_value ?? "",
        password,
      });
    }
    return { logins, unreadable };
  });
}
