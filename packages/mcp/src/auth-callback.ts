/**
 * The loopback listener an authorization server redirects back to.
 *
 * OAuth for a desktop app ends with the browser being sent to
 * `http://127.0.0.1:<port>/callback?code=…&state=…`, and something has to be
 * listening or the login silently goes nowhere. CoilCoil used to depend on
 * pi's listener, which is part of why authorization only worked while a session
 * was alive; this one belongs to the runtime and is up whenever the app is.
 *
 * The port is deliberately fixed rather than ephemeral. The redirect URI is
 * part of what gets registered with the authorization server, so a port that
 * moved between restarts would invalidate every registration and quietly turn
 * a returning user into a first-time one.
 *
 * A redirect is filed under its `state`, which is also the only thing that
 * makes it safe: a callback whose state nobody is waiting for is a stray — or a
 * forgery — and is refused rather than matched to whichever login happens to be
 * in flight.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

export interface McpAuthCallback {
  code: string;
  /** RFC 9207 issuer, passed through when the server sends one. */
  iss?: string;
}

interface Waiter {
  resolve: (callback: McpAuthCallback) => void;
  reject: (error: Error) => void;
}

/** Tried in order, so a busy port does not take authorization down with it. */
const CANDIDATE_PORTS = [7842, 7843, 7844, 7845, 0];
const CALLBACK_PATH = "/callback";

const DONE_PAGE = `<!doctype html><meta charset="utf-8"><title>CoilCoil</title>
<body style="font:14px -apple-system,system-ui,sans-serif;padding:48px;text-align:center">
<h1 style="font-size:17px;font-weight:600">授权完成</h1>
<p style="color:#666">可以关掉这个页面，回到 CoilCoil 了。</p>`;

const FAILED_PAGE = `<!doctype html><meta charset="utf-8"><title>CoilCoil</title>
<body style="font:14px -apple-system,system-ui,sans-serif;padding:48px;text-align:center">
<h1 style="font-size:17px;font-weight:600">这次回调没人在等</h1>
<p style="color:#666">多半是这次授权已经取消或者超时了，回 CoilCoil 重新发起一次。</p>`;

export class McpAuthCallbackServer {
  private server?: Server;
  private port?: number;
  /** The listen in flight, so concurrent callers share one listener. */
  private starting?: Promise<string>;
  private readonly waiters = new Map<string, Waiter>();

  /**
   * @param ports Which ports to try, in order. The default keeps the redirect
   *   URI stable across restarts; tests pass `[0]` so each one gets its own
   *   origin and cannot inherit a pooled connection from a previous server.
   */
  constructor(private readonly ports: readonly number[] = CANDIDATE_PORTS) {}

  /**
   * Start listening, or return the address already being listened on.
   *
   * Guarded against being called concurrently. Several servers connecting at
   * once all reach for the listener in the same tick, and without this each one
   * bound its own port, leaked every listener but the last, and left the
   * recorded address pointing at whichever finished last — so a redirect could
   * arrive at a listener nobody was waiting on.
   */
  async listen(): Promise<string> {
    if (this.server && this.port !== undefined) return this.redirectUrl;
    this.starting ??= this.startListening().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async startListening(): Promise<string> {
    if (this.server && this.port !== undefined) return this.redirectUrl;
    const server = createServer((request, response) => this.handle(request, response));
    server.on("error", () => undefined);
    for (const candidate of this.ports) {
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: Error): void => { server.off("listening", onListening); reject(error); };
          const onListening = (): void => { server.off("error", onError); resolve(); };
          server.once("error", onError);
          server.once("listening", onListening);
          server.listen(candidate, "127.0.0.1");
        });
        this.server = server;
        this.port = (server.address() as AddressInfo).port;
        return this.redirectUrl;
      } catch {
        // Port in use — another CoilCoil, or something else entirely. Next one.
      }
    }
    throw new Error("没有可用的本地端口来接收授权回调。");
  }

  get redirectUrl(): string {
    if (this.port === undefined) throw new Error("授权回调服务还没有启动。");
    return `http://127.0.0.1:${this.port}${CALLBACK_PATH}`;
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    let url: URL;
    try {
      url = new URL(request.url ?? "/", `http://127.0.0.1:${this.port}`);
    } catch {
      response.writeHead(400).end();
      return;
    }
    if (url.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end();
      return;
    }
    const state = url.searchParams.get("state") ?? "";
    const waiter = state ? this.waiters.get(state) : undefined;
    if (!waiter) {
      // Never guess. Matching an unexpected redirect onto whatever login is in
      // flight is exactly the confusion `state` exists to prevent.
      response.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(FAILED_PAGE);
      return;
    }
    this.waiters.delete(state);
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code") ?? "";
    const settle = error
      ? (): void => {
        const description = url.searchParams.get("error_description");
        waiter.reject(new Error(description ? `${error}：${description}` : error));
      }
      : code
        ? (): void => waiter.resolve({ code, iss: url.searchParams.get("iss") ?? undefined })
        : (): void => waiter.reject(new Error("授权服务器没有返回授权码。"));
    // The browser is served first, on purpose. Settling the waiter can take the
    // app straight into tearing this listener down, and a socket closed midway
    // leaves the person staring at a connection error instead of the page that
    // tells them the login worked.
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(DONE_PAGE, settle);
  }

  /**
   * Arm the listener for one login before the browser is opened.
   *
   * Order matters: an approval can come back faster than the caller expects,
   * and arming afterwards is how a redirect gets dropped by a listener that was
   * not yet watching for it.
   */
  expect(state: string, timeoutMs: number): Promise<McpAuthCallback> {
    return new Promise<McpAuthCallback>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(state);
        reject(new Error("等待浏览器授权超时。"));
      }, timeoutMs);
      // `unref` so a forgotten login never keeps the process alive.
      timer.unref?.();
      this.waiters.set(state, {
        resolve: (callback) => { clearTimeout(timer); resolve(callback); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
  }

  /** Whether a login is currently being waited on. */
  awaiting(state: string): boolean {
    return this.waiters.has(state);
  }

  /** The user closed the dialog; stop holding the redirect for them. */
  cancel(state: string): void {
    const waiter = this.waiters.get(state);
    if (!waiter) return;
    this.waiters.delete(state);
    waiter.reject(new Error("授权已取消。"));
  }

  async close(): Promise<void> {
    for (const state of [...this.waiters.keys()]) this.cancel(state);
    const server = this.server;
    this.server = undefined;
    this.port = undefined;
    if (!server) return;
    // A browser leaves its keep-alive socket open, and `close` alone waits for
    // it: without this, quitting the app hangs on a tab nobody is looking at.
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
