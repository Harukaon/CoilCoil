import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve as resolvePath } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { DesktopPlatform } from "../../shared/desktop-api";
import { isTrustedAddress, RemoteAuth } from "./remote-auth";
import { bridgeScript, pairingPage, REMOTE_INVOKE_CHANNELS } from "./remote-client";

const COOKIE = "coilcoil_remote";
const BRIDGE_PATH = "/__remote/bridge.js";
const PAIR_PATH = "/__remote/pair";
const SIGN_IN_PATH = "/__remote/sign-in";
const WS_PATH = "/__remote/ws";
/** Close code the client reads as "someone else took over", not "reconnect". */
const DISPLACED_CODE = 4000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

export interface RemoteServerOptions {
  host: string;
  port: number;
  platform: DesktopPlatform;
  /** Set while `npm run dev` is serving the renderer; the app is proxied from there. */
  rendererUrl?: string;
  /** Built renderer directory, used when there is no dev server. */
  rendererDir: string;
  authFile: string;
  /**
   * Skip the login screen for connections that arrive from the user's own
   * network — a tailnet or a LAN. Never applies to loopback: the reverse-proxy
   * tunnel lands there, and trusting it would admit the whole internet.
   */
  trustLocalNetwork(): boolean;
  invoke(channel: string, args: unknown[]): Promise<unknown>;
  log(level: "info" | "warn" | "error", event: string, data?: Record<string, unknown>): void;
  /** Fired whenever a controller connects or drops, so settings can show it. */
  onClientsChanged?(): void;
}

interface RequestFrame {
  id?: unknown;
  channel?: unknown;
  args?: unknown;
}

function cookieToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === COOKIE) return decodeURIComponent(rest.join("="));
  }
  return undefined;
}

function readBody(request: IncomingMessage, limit = 4096): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > limit) {
        rejectBody(new Error("请求体过大。"));
        request.destroy();
      }
    });
    request.on("end", () => resolveBody(body));
    request.on("error", rejectBody);
  });
}

function send(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    // The remote app is same-origin only; nothing here should be framed or sniffed.
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  });
  response.end(body);
}

/**
 * The network entry point that turns a phone into a remote control.
 *
 * It serves the same renderer the desktop window runs and relays the bridge
 * calls behind it, so a paired phone drives the Mac's own CoilCoil rather than
 * a second copy of it. Nothing executes here: every request is handed to the
 * main process, which is where the agent already lives.
 */
export class RemoteServer {
  private server?: Server;
  private sockets?: WebSocketServer;
  private readonly clients = new Set<WebSocket>();
  readonly auth: RemoteAuth;

  constructor(private readonly options: RemoteServerOptions) {
    this.auth = new RemoteAuth(options.authFile);
  }

  async start(): Promise<string> {
    const server = createServer((request, response) => {
      void this.handle(request, response).catch((error: unknown) => {
        this.options.log("error", "remote_request_failed", { message: String(error) });
        if (!response.headersSent) send(response, 500, "text/plain; charset=utf-8", "内部错误");
        else response.end();
      });
    });
    const sockets = new WebSocketServer({ noServer: true });
    server.on("upgrade", (request, socket, head) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname !== WS_PATH || !this.allowed(request)) {
        socket.destroy();
        return;
      }
      sockets.handleUpgrade(request, socket, head, (client) => this.accept(client));
    });

    await new Promise<void>((ready, failed) => {
      server.once("error", failed);
      server.listen(this.options.port, this.options.host, () => {
        server.removeListener("error", failed);
        ready();
      });
    });

    this.server = server;
    this.sockets = sockets;
    // Port 0 asks the OS to choose, so the bound address is the only one that
    // is always right to report.
    const bound = server.address();
    const port = typeof bound === "object" && bound ? bound.port : this.options.port;
    const address = `http://${this.options.host}:${port}`;
    this.options.log("info", "remote_started", { address });
    return address;
  }

  private accept(client: WebSocket): void {
    // Exactly one remote controller at a time. A newer connection wins and the
    // older one is told why, so two devices can never drive the same session
    // into different states.
    for (const previous of this.clients) {
      this.clients.delete(previous);
      previous.close(DISPLACED_CODE, "displaced");
    }
    this.clients.add(client);
    this.options.log("info", "remote_client_connected", { clients: this.clients.size });
    this.options.onClientsChanged?.();
    client.on("close", () => {
      this.clients.delete(client);
      this.options.log("info", "remote_client_disconnected", { clients: this.clients.size });
      this.options.onClientsChanged?.();
    });
    client.on("message", (raw) => {
      let frame: RequestFrame;
      try {
        frame = JSON.parse(String(raw)) as RequestFrame;
      } catch {
        return;
      }
      const id = typeof frame.id === "string" ? frame.id : undefined;
      const channel = typeof frame.channel === "string" ? frame.channel : undefined;
      if (!id || !channel) return;
      if (!(REMOTE_INVOKE_CHANNELS as readonly string[]).includes(channel)) {
        client.send(JSON.stringify({ id, ok: false, error: `远程会话不支持 ${channel}。` }));
        return;
      }
      const args = Array.isArray(frame.args) ? frame.args : [];
      void this.options.invoke(channel, args).then(
        (value) => client.send(JSON.stringify({ id, ok: true, value })),
        (error: unknown) => client.send(JSON.stringify({
          id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })),
      );
    });
  }

  /** Push a main-process event to every paired client watching right now. */
  broadcast(channel: string, payload: unknown): void {
    if (this.clients.size === 0) return;
    const frame = JSON.stringify({ push: channel, payload });
    for (const client of this.clients) {
      if (client.readyState === client.OPEN) client.send(frame);
    }
  }

  connectedClients(): number {
    return this.clients.size;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === BRIDGE_PATH) {
      send(response, 200, MIME[".js"], bridgeScript(this.options.platform));
      return;
    }

    if (path === PAIR_PATH && request.method === "POST") {
      await this.handlePair(request, response);
      return;
    }

    if (path === SIGN_IN_PATH && request.method === "POST") {
      await this.handleSignIn(request, response);
      return;
    }

    if (!this.allowed(request)) {
      send(response, 200, MIME[".html"], pairingPage(this.auth.username()));
      return;
    }

    if (path === "/" || path === "/index.html") {
      send(response, 200, MIME[".html"], await this.appDocument());
      return;
    }

    await this.serveAsset(path, response);
  }

  /**
   * Whether this request may drive the Mac.
   *
   * A device token is the usual answer. The exception is a connection from the
   * user's own network — their tailnet or LAN — which they have already chosen
   * to treat as trusted; the peer address decides that, never a header, because
   * headers are written by whoever is calling.
   */
  private allowed(request: IncomingMessage): boolean {
    if (this.auth.verify(cookieToken(request.headers.cookie))) return true;
    if (!this.options.trustLocalNetwork()) return false;
    const peer = request.socket.remoteAddress;
    return !!peer && isTrustedAddress(peer);
  }

  private async handleSignIn(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.auth.lockedOut()) {
      send(response, 429, MIME[".json"], JSON.stringify({ error: "尝试次数过多，请稍后再试。" }));
      return;
    }
    let body: { username?: unknown; password?: unknown; name?: unknown };
    try {
      body = JSON.parse(await readBody(request)) as typeof body;
    } catch {
      send(response, 400, MIME[".json"], JSON.stringify({ error: "请求无效。" }));
      return;
    }
    const device = this.auth.signIn(
      typeof body.username === "string" ? body.username : "",
      typeof body.password === "string" ? body.password : "",
      typeof body.name === "string" ? body.name : "",
    );
    if (!device) {
      this.options.log("warn", "remote_sign_in_rejected", {});
      send(response, 403, MIME[".json"], JSON.stringify({ error: "用户名或密码不正确。" }));
      return;
    }
    this.options.log("info", "remote_sign_in_accepted", { name: device.name });
    this.grant(request, response, device.token);
  }

  /** Set the device cookie and report success. */
  private grant(request: IncomingMessage, response: ServerResponse, token: string): void {
    // Behind the VPS proxy the connection reaching this process is plain HTTP,
    // so the forwarded scheme is the only thing that knows whether the phone is
    // on TLS and the cookie can be marked Secure.
    const secure = String(request.headers["x-forwarded-proto"] ?? "").split(",")[0].trim() === "https";
    response.writeHead(200, {
      "content-type": MIME[".json"],
      "cache-control": "no-store",
      // One year, HttpOnly so no page script can read it, SameSite=Lax so it
      // still rides the WebSocket handshake this page opens itself.
      "set-cookie": `${COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
    });
    response.end(JSON.stringify({ ok: true }));
  }

  private async handlePair(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.auth.lockedOut()) {
      send(response, 429, MIME[".json"], JSON.stringify({ error: "尝试次数过多，请稍后再试。" }));
      return;
    }
    let body: { code?: unknown; name?: unknown };
    try {
      body = JSON.parse(await readBody(request)) as { code?: unknown; name?: unknown };
    } catch {
      send(response, 400, MIME[".json"], JSON.stringify({ error: "请求无效。" }));
      return;
    }
    const code = typeof body.code === "string" ? body.code : "";
    const name = typeof body.name === "string" ? body.name : "";
    const device = this.auth.pair(code, name);
    if (!device) {
      this.options.log("warn", "remote_pair_rejected", {});
      send(response, 403, MIME[".json"], JSON.stringify({ error: "配对码不正确。" }));
      return;
    }
    this.options.log("info", "remote_pair_accepted", { name: device.name });
    this.grant(request, response, device.token);
  }

  /** The renderer's own index.html with the bridge inserted ahead of its bundle. */
  private async appDocument(): Promise<string> {
    const html = this.options.rendererUrl
      ? await this.fetchDev("/index.html")
      : readFileSync(join(this.options.rendererDir, "index.html"), "utf8");
    const tag = `<script src="${BRIDGE_PATH}"></script>`;
    // A classic script runs before the module bundle regardless of order, but
    // putting it first keeps the intent obvious when reading the served page.
    return html.includes("<head>") ? html.replace("<head>", `<head>\n    ${tag}`) : `${tag}\n${html}`;
  }

  private fetchDev(path: string): Promise<string> {
    const target = new URL(path, this.options.rendererUrl);
    return new Promise((done, failed) => {
      const proxied = httpRequest(
        { hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: "GET" },
        (upstream) => {
          let body = "";
          upstream.setEncoding("utf8");
          upstream.on("data", (chunk: string) => { body += chunk; });
          upstream.on("end", () => done(body));
        },
      );
      proxied.on("error", failed);
      proxied.end();
    });
  }

  private async serveAsset(path: string, response: ServerResponse): Promise<void> {
    if (this.options.rendererUrl) {
      this.proxyAsset(path, response);
      return;
    }
    // Decode first so a percent-encoded `..` is caught by the same check as a
    // literal one, then let normalize collapse it before the prefix test.
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      send(response, 400, "text/plain; charset=utf-8", "路径无效");
      return;
    }
    const root = resolvePath(this.options.rendererDir);
    const file = resolvePath(join(root, normalize(decoded)));
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      send(response, 404, "text/plain; charset=utf-8", "未找到");
      return;
    }
    response.writeHead(200, {
      "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    createReadStream(file).pipe(response);
  }

  private proxyAsset(path: string, response: ServerResponse): void {
    const target = new URL(path, this.options.rendererUrl);
    const proxied = httpRequest(
      { hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: "GET" },
      (upstream) => {
        response.writeHead(upstream.statusCode ?? 200, upstream.headers);
        upstream.pipe(response);
      },
    );
    proxied.on("error", () => send(response, 502, "text/plain; charset=utf-8", "开发服务器不可用"));
    proxied.end();
  }

  stop(): void {
    for (const client of this.clients) client.close();
    this.clients.clear();
    this.sockets?.close();
    this.server?.close();
    this.server = undefined;
    this.sockets = undefined;
    this.auth.flush();
  }
}
