import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHttpPool } from "../src/http-pool.ts";

/** A server that counts how many TCP connections were opened against it. */
async function countingServer(): Promise<{ url: string; connections: () => number; close: () => Promise<void> }> {
  let connections = 0;
  const server: Server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" }).end("ok");
  });
  server.on("connection", () => { connections += 1; });
  await new Promise<void>((resolvePromise) => server.listen(0, "127.0.0.1", () => resolvePromise()));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    connections: () => connections,
    close: () => new Promise<void>((resolvePromise) => {
      server.closeAllConnections?.();
      server.close(() => resolvePromise());
    }),
  };
}

test("同一个服务器的多个请求共用一条连接", async (t) => {
  // 这就是那 15 秒的来源：用户机器上一次 TLS 握手要 5 秒，而握手之后的请求
  // 只要 0.3 秒。每个请求重开一次连接，就是每个请求都付一次 5 秒。
  const server = await countingServer();
  const pool = createHttpPool({});
  t.after(async () => { await pool.close(); await server.close(); });

  for (let index = 0; index < 12; index += 1) {
    const response = await pool.fetch(server.url);
    assert.equal(await response.text(), "ok");
  }
  // 要紧的是连接数不随请求数增长，而不是恰好等于一：连接池允许留几条备用，
  // 但十二个请求开十二条连接就是每个请求都在重付那 5 秒。
  assert.ok(server.connections() <= 4, `12 个请求开了 ${server.connections()} 条连接`);
});

test("关掉之后不再占着连接", async (t) => {
  const server = await countingServer();
  t.after(() => server.close());
  const pool = createHttpPool({});
  await (await pool.fetch(server.url)).text();
  await pool.close();
  // 关掉的池子不能再用；socket 也跟着一起还回去了。
  await assert.rejects(() => pool.fetch(server.url));
});

test("每个连接一个池子，关掉一个不影响另一个", async (t) => {
  // 一个 MCP 服务器断开，不该顺手掐掉另一个服务器正开着的连接。
  const server = await countingServer();
  const first = createHttpPool({});
  const second = createHttpPool({});
  t.after(async () => { await second.close(); await server.close(); });

  await (await first.fetch(server.url)).text();
  await (await second.fetch(server.url)).text();
  await first.close();
  assert.equal(await (await second.fetch(server.url)).text(), "ok");
});

test("设了代理环境变量就走代理，没设就直连", async (t) => {
  // 主进程解析完系统代理会把 HTTPS_PROXY 传给运行时。自建的 Agent 默认不认这些
  // 变量，真需要代理的人那里就不是慢，而是直接连不上。
  const proxied = createHttpPool({ HTTPS_PROXY: "http://127.0.0.1:9" });
  const direct = createHttpPool({});
  t.after(async () => { await proxied.close(); await direct.close(); });

  const server = await countingServer();
  t.after(() => server.close());

  // 代理指向一个必然打不开的端口：请求失败就说明它确实去走代理了。
  await assert.rejects(() => proxied.fetch("http://example.invalid/"), "配了代理却没走代理");
  // 直连的那个照常能用——同一个地址在本机是通的。
  assert.equal(await (await direct.fetch(server.url)).text(), "ok");
});
