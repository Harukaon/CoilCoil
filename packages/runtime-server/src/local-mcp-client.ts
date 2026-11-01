import { request as httpRequest } from "node:http";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpAccessRequest } from "@coilcoil/runtime-protocol";

export interface LocalMcpInstance {
  version: 1;
  instanceId: string;
  pid: number;
  dataDir: string;
  port: number;
  token: string;
}

export function localMcpRegistryDirectory(): string {
  return process.env.COILCOIL_RUNTIME_DIR ?? join(homedir(), ".coilcoil", "runtimes");
}

/** Always connects directly to loopback; descriptors cannot redirect clients to another host. */
export function localMcpHttp(instance: LocalMcpInstance, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const request = httpRequest({
      hostname: "127.0.0.1", port: instance.port, path,
      method: payload === undefined ? "GET" : "POST", signal,
      headers: {
        authorization: `Bearer ${instance.token}`,
        ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("error", reject);
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 64 * 1024 * 1024) {
          response.destroy(new Error("MCP 返回内容超过 64 MiB，请缩小请求范围。"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (response.statusCode !== 200) throw new Error(value.error ?? `运行时返回 HTTP ${response.statusCode}。`);
          resolve(value);
        } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.end(payload);
  });
}

export async function discoverLocalMcpInstances(directory = localMcpRegistryDirectory()): Promise<LocalMcpInstance[]> {
  let files: string[];
  try { files = await readdir(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const found = await Promise.all(files.filter((file) => file.endsWith(".json")).map(async (file) => {
    try {
      const entry = JSON.parse(await readFile(join(directory, file), "utf8")) as LocalMcpInstance;
      if (entry.version !== 1 || typeof entry.instanceId !== "string" || typeof entry.dataDir !== "string"
        || !Number.isInteger(entry.pid) || entry.pid <= 0 || !Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535
        || typeof entry.token !== "string" || !/^[a-f0-9]{64}$/.test(entry.token)) return undefined;
      // Crashed runtimes can leave descriptors behind. Never select one based only on a file.
      const health = await localMcpHttp(entry, "/health", undefined, AbortSignal.timeout(1_000)) as { instanceId?: string };
      return health.instanceId === entry.instanceId ? entry : undefined;
    } catch { return undefined; }
  }));
  return found.filter((entry): entry is LocalMcpInstance => entry !== undefined).sort((a, b) => a.instanceId.localeCompare(b.instanceId));
}

export async function requestLocalMcp(instance: LocalMcpInstance, input: McpAccessRequest, signal?: AbortSignal): Promise<unknown> {
  const reply = await localMcpHttp(instance, "/mcp", input, signal) as { ok: boolean; result?: unknown; error?: string };
  if (!reply.ok) throw new Error(reply.error ?? "运行时 MCP 请求失败。");
  return reply.result;
}
