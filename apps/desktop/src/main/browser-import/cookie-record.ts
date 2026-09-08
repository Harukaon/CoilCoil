/** One cookie, in the shape Electron's cookie store accepts. */
export interface ImportedCookie {
  /** Chromium's `host_key`: a leading dot means the cookie covers subdomains. */
  host: string;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  /** Unix seconds. Absent for a session cookie, which dies with the browser. */
  expiresAt?: number;
  sameSite: "unspecified" | "no_restriction" | "lax" | "strict";
}

export interface CookieHarvest {
  cookies: ImportedCookie[];
  /** Records that could not be decrypted or parsed; reported, never thrown. */
  unreadable: number;
  /** Which sites those records belonged to, so a report can name them. */
  unreadableHosts?: string[];
}

/** The subset of Electron's `cookies.set` input this import produces. */
export interface ElectronCookieInput {
  url: string;
  name: string;
  value: string;
  /** Omitted for a host-only cookie; see `toElectronCookie`. */
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
  sameSite: ImportedCookie["sameSite"];
}

/**
 * Translate one harvested cookie into the shape Electron accepts.
 *
 * Electron addresses a cookie by the URL it would have been set from, while
 * Chromium stores the host key directly.
 *
 * The leading dot is the whole distinction. `.example.com` is a domain cookie —
 * it covers subdomains, and that belongs in `domain`. `example.com` is
 * **host-only**, and for those `domain` must be left out entirely: Electron
 * normalizes whatever it is given by prefixing a dot, so supplying it turns a
 * host-only cookie into a subdomain-wide one.
 *
 * That silent widening is also why imports lost cookies. A `__Host-` cookie is
 * only accepted when it carries no Domain attribute at all, so passing one made
 * the browser reject every single `__Host-` record — which is exactly the family
 * Google's sign-in relies on.
 */
export function toElectronCookie(cookie: ImportedCookie): ElectronCookieInput {
  const domainCookie = cookie.host.startsWith(".");
  const host = domainCookie ? cookie.host.slice(1) : cookie.host;
  const path = cookie.path.startsWith("/") ? cookie.path : `/${cookie.path}`;
  return {
    url: `${cookie.secure ? "https" : "http"}://${host}${path}`,
    name: cookie.name,
    value: cookie.value,
    ...(domainCookie ? { domain: cookie.host } : {}),
    path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    expirationDate: cookie.expiresAt,
    // SameSite=None is only legal on a secure cookie; Electron rejects the pair
    // outright, so an insecure one keeps the browser default instead.
    sameSite: cookie.sameSite === "no_restriction" && !cookie.secure ? "unspecified" : cookie.sameSite,
  };
}
