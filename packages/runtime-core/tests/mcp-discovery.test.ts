import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverImportableMcpServers, type McpDiscoveryAdapter } from "../src/mcp-discovery.js";

/*
 * MCP 发现。要守住的是「按需」这件事本身：
 * 每个来源带来的服务器必须能单独指认出来，而不是笼统地说「一共 N 个」。
 */

/**
 * 假适配器。行为和真的 pi-mcp-adapter 一致的那部分：loadMcpConfig 读探针文件里的
 * imports 数组，把这些来源的服务器和「每一层都会有的那些」合在一起返回。
 */
function fakeAdapter(sources: Record<string, Record<string, Record<string, unknown>>>, options: {
  /** 无论启用哪个来源都会出现的服务器，用来验证差集把它们减掉了。 */
  always?: Record<string, Record<string, unknown>>;
  /** 这些来源在读取时抛错。 */
  broken?: string[];
} = {}): McpDiscoveryAdapter {
  return {
    getMcpDiscoverySummary: () => ({
      imports: Object.entries(sources).map(([kind, servers]) => ({
        kind: kind as never,
        path: `/fake/${kind}.json`,
        serverCount: Object.keys(servers).length,
      })),
    }),
    loadMcpConfig: (overridePath) => {
      const imports = (JSON.parse(readFileSync(overridePath as string, "utf8")) as { imports: string[] }).imports;
      const mcpServers: Record<string, Record<string, unknown>> = { ...(options.always ?? {}) };
      for (const kind of imports) {
        if (options.broken?.includes(kind)) throw new Error(`${kind} 的配置文件坏了`);
        Object.assign(mcpServers, sources[kind] ?? {});
      }
      return { mcpServers };
    },
  };
}

const scratch = (): string => mkdtempSync(join(tmpdir(), "coilcoil-discovery-test-"));

test("每个服务器都指认得出是哪个来源带来的", () => {
  const adapter = fakeAdapter({
    cursor: { linear: { command: "npx", args: ["-y", "linear-mcp"] } },
    codex: { postgres: { url: "https://db.example.com/mcp" } },
  });
  const result = discoverImportableMcpServers(adapter, { existingNames: new Set(), scratchDirectory: scratch() });
  assert.deepEqual(result.servers.map((server) => [server.origin, server.name]), [
    ["codex", "postgres"],
    ["cursor", "linear"],
  ]);
  const linear = result.servers.find((server) => server.name === "linear");
  assert.equal(linear?.transport, "stdio");
  assert.equal(linear?.command, "npx");
  assert.deepEqual(linear?.args, ["-y", "linear-mcp"]);
  assert.equal(result.servers.find((server) => server.name === "postgres")?.transport, "http");
});

test("差集把「每一层都在」的服务器减掉，不会当成某个来源的收获", () => {
  // 这些来自工作区配置或共享配置，启不启用来源都在，不该出现在导入清单里。
  const adapter = fakeAdapter({ cursor: { linear: { command: "npx" } } }, {
    always: { "coilcoil-browser": { command: "builtin" }, shared: { command: "shared" } },
  });
  const result = discoverImportableMcpServers(adapter, { existingNames: new Set(), scratchDirectory: scratch() });
  assert.deepEqual(result.servers.map((server) => server.name), ["linear"]);
});

test("导入时原样带上定义，且已经装过的会标出来而不是藏起来", () => {
  const definition = { command: "npx", args: ["-y", "linear-mcp"], env: { TOKEN: "x" }, lifecycle: "keep-alive" };
  const adapter = fakeAdapter({ cursor: { linear: definition, sentry: { command: "sentry" } } });
  const result = discoverImportableMcpServers(adapter, { existingNames: new Set(["sentry"]), scratchDirectory: scratch() });
  // 藏起来会让人以为没发现，然后反复重扫。
  assert.deepEqual(result.servers.map((server) => [server.name, server.alreadyPresent]), [
    ["linear", false],
    ["sentry", true],
  ]);
  // env、lifecycle 这些字段要一起抄过去，不能只留命令行。
  assert.deepEqual(result.servers[0]?.definition, definition);
});

test("一个来源读坏了不会把整次发现带崩，会单独说明原因", () => {
  const adapter = fakeAdapter(
    { cursor: { linear: { command: "npx" } }, codex: { broken: { command: "x" } } },
    { broken: ["codex"] },
  );
  const result = discoverImportableMcpServers(adapter, { existingNames: new Set(), scratchDirectory: scratch() });
  assert.deepEqual(result.servers.map((server) => server.name), ["linear"]);
  const skipped = result.emptyOrigins.find((origin) => origin.kind === "codex");
  assert.match(skipped?.reason ?? "", /坏了/);
});

test("扫到了文件却没有可导入内容时，要分清是「空的」还是「已经有了」", () => {
  const adapter = fakeAdapter({ cursor: {}, codex: { linear: { command: "npx" } } }, {
    // codex 里那个服务器每一层都已经在了，差集之后什么都不剩。
    always: { linear: { command: "npx" } },
  });
  const result = discoverImportableMcpServers(adapter, { existingNames: new Set(), scratchDirectory: scratch() });
  assert.equal(result.servers.length, 0);
  assert.match(result.emptyOrigins.find((origin) => origin.kind === "cursor")?.reason ?? "", /没有配置任何服务器/);
  assert.match(result.emptyOrigins.find((origin) => origin.kind === "codex")?.reason ?? "", /都已经有了/);
});
