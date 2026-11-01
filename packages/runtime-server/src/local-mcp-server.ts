import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseMcpAccessRequest, type McpAccessRequest } from "@coilcoil/runtime-protocol";
import { localMcpRegistryDirectory, type LocalMcpInstance } from "./local-mcp-client.js";

function send(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) throw new Error("MCP 请求超过 1 MiB。");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export interface LocalMcpServer {
  instance: LocalMcpInstance;
  close(): Promise<void>;
}

/** A small local runtime RPC transport. The existing manager owns every MCP connection. */
export async function startLocalMcpServer(options: {
  dataDir: string;
  registryDirectory?: string;
  handle(request: McpAccessRequest, signal: AbortSignal): Promise<unknown>;
}): Promise<LocalMcpServer> {
  const registry = options.registryDirectory ?? localMcpRegistryDirectory();
  const token = randomBytes(32).toString("hex");
  const instanceId = `${process.pid}-${randomUUID()}`;
  const descriptor = join(registry, `${instanceId}.json`);
  const controllers = new Set<AbortController>();
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const server = createServer((request, response) => {
    const auth = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (request.headers.origin !== undefined || auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      send(response, 403, { ok: false, error: "本地运行时认证失败。" });
      return;
    }
    if (closing) { send(response, 503, { ok: false, error: "CoilCoil 运行时正在关闭。" }); return; }
    if (request.url === "/health" && request.method === "GET") {
      send(response, 200, { instanceId });
      return;
    }
    if (request.url !== "/mcp" || request.method !== "POST") {
      send(response, 404, { ok: false, error: "未知的运行时接口。" });
      return;
    }
    const controller = new AbortController();
    controllers.add(controller);
    response.once("close", () => {
      if (!response.writableEnded) controller.abort(new Error("外部 Agent 已断开连接。"));
    });
    void (async () => {
      let input: McpAccessRequest;
      try { input = parseMcpAccessRequest(await readBody(request)); }
      catch (error) { send(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }); return; }
      controller.signal.throwIfAborted();
      const result = await options.handle(input, controller.signal);
      send(response, 200, { ok: true, result });
    })().catch((error: unknown) => {
      send(response, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }).finally(() => controllers.delete(controller));
  });
  server.requestTimeout = 15_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法读取本地运行时端口。");
  const instance: LocalMcpInstance = { version: 1, instanceId, pid: process.pid, dataDir: options.dataDir, port: address.port, token };
  try {
    await mkdir(registry, { recursive: true, mode: 0o700 });
    await writeFile(`${descriptor}.tmp`, `${JSON.stringify(instance)}\n`, { mode: 0o600, flag: "wx" });
    await rename(`${descriptor}.tmp`, descriptor);
  } catch (error) {
    server.close();
    await rm(`${descriptor}.tmp`, { force: true });
    throw error;
  }
  return {
    instance,
    close() {
      return closePromise ??= (async () => {
        closing = true;
        for (const controller of controllers) controller.abort(new Error("CoilCoil 运行时正在关闭。"));
        try { await rm(descriptor, { force: true }); }
        finally {
          const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
          server.closeAllConnections();
          await closed;
        }
      })();
    },
  };
}
