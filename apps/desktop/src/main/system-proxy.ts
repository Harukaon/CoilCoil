import { connect } from "node:net";
import { session } from "electron";

/**
 * Hand the runtime child the proxy the rest of the Mac is already using.
 *
 * Electron's own network stack follows the system proxy settings; Node's does
 * not. The runtime child is Node, so every model request and every WebSocket it
 * opens went out directly, working only as long as a VPN was transparently
 * capturing the traffic. The moment anything else claimed the default route —
 * Tailscale being the case that surfaced this — those direct connections broke
 * while the proxy at 127.0.0.1 kept working for everything else, and the
 * WebSocket transport failed with a bare network error.
 *
 * Passing the system proxy down fixes that for good: a loopback proxy is
 * reachable no matter which tunnel owns the routing table. `NODE_USE_ENV_PROXY`
 * is what makes Node honour the variables for `fetch` *and* for the global
 * `WebSocket` — the WebSocket takes the global dispatcher, so nothing else is
 * needed to route the Codex WS transport through the proxy.
 */
const PROBE_URL = "https://api.openai.com/";

/** Left alone when the user has already chosen a proxy for themselves. */
const USER_PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];

let cached: Record<string, string> = {};

export function proxyEnvironment(): Record<string, string> {
  return cached;
}

/**
 * Parse one entry of Chromium's proxy list, e.g. `PROXY 127.0.0.1:7897`.
 *
 * SOCKS is deliberately not translated: Node's env-proxy support speaks HTTP
 * CONNECT only, and pointing it at a SOCKS port would break a setup that works
 * today. Such a system falls back to the direct connection it already had.
 */
function parseProxyRule(rules: string): string | undefined {
  for (const entry of rules.split(";")) {
    const [scheme, address] = entry.trim().split(/\s+/, 2);
    if (!address) continue;
    const kind = scheme.toUpperCase();
    if (kind === "PROXY" || kind === "HTTP") return `http://${address}`;
    if (kind === "HTTPS") return `https://${address}`;
  }
  return undefined;
}

/**
 * Is anything actually listening on that proxy?
 *
 * macOS keeps the proxy switch on in Network settings whether or not the client
 * behind it is running, so "a proxy is configured" is not the same as "a proxy
 * works". Adopting a dead one would break the direct connection that works
 * today, so a refused connection means we stay direct.
 */
async function proxyReachable(proxy: string): Promise<boolean> {
  let target: URL;
  try {
    target = new URL(proxy);
  } catch {
    return false;
  }
  const port = Number.parseInt(target.port, 10) || (target.protocol === "https:" ? 443 : 80);
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host: target.hostname, port });
    const settle = (reachable: boolean): void => {
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(400, () => settle(false));
    socket.once("connect", () => settle(true));
    socket.once("error", () => settle(false));
  });
}

export async function refreshProxyEnvironment(
  log?: (event: string, data: Record<string, unknown>) => void,
): Promise<void> {
  if (USER_PROXY_KEYS.some((key) => (process.env[key] ?? "").trim())) {
    cached = {};
    return;
  }
  let rules: string;
  try {
    rules = await session.defaultSession.resolveProxy(PROBE_URL);
  } catch {
    return;
  }
  const configured = parseProxyRule(rules);
  const proxy = configured && (await proxyReachable(configured)) ? configured : undefined;
  const next: Record<string, string> = proxy
    ? {
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      // The runtime talks to itself and to the built-in browser over loopback;
      // sending that through the proxy would be both slower and fragile.
      NO_PROXY: "localhost,127.0.0.1,::1",
      NODE_USE_ENV_PROXY: "1",
    }
    : {};
  const changed = JSON.stringify(next) !== JSON.stringify(cached);
  cached = next;
  if (changed) log?.("system_proxy_resolved", { rules, proxy: proxy ?? "direct", configured: configured ?? "none" });
}
