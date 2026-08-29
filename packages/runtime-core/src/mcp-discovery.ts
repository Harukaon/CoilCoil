/**
 * 「发现别的工具里已经配好的 MCP」——按需导入，而不是整包接管。
 *
 * 以前只有一个「导入检测到的配置」按钮：按下去就把 Cursor、Claude Code、Codex…
 * 每一个来源整包挂上，来源里以后新增的服务器也会跟着自动出现。用户要的是先看
 * 见都发现了什么，再自己勾几个。
 *
 * 怎么知道某个来源里都有哪些服务器：不自己解析各家的格式（Codex 是 TOML、
 * opencode 的字段叫 mcp、VS Code 又是另一套，而且各家还在改），而是让适配器自己
 * 解析两次再求差——
 *
 *   基线：一份空的临时配置，只启用 imports: []
 *   探针：同一份临时配置，只启用 imports: [某个来源]
 *
 * 探针里多出来的那些服务器，就正好是这个来源带进来的。工作区级、共享级那些配置
 * 两边都会被合进来，相减之后自然抵消掉。适配器以后支持新的来源，这里不用改。
 *
 * 导入时把选中的定义原样抄进 CoilCoil 自己的 mcp.json，而不是把来源整个挂上：
 * 抄过来的那一份归用户所有，可以改、可以停用、可以删；来源那边以后怎么变也不会
 * 悄悄影响这里。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscoveredMcpServer, McpDiscoveryResult, McpImportConfiguration } from "@coilcoil/runtime-protocol";

/** 发现只需要适配器的这两个能力，测试里给个假的就行。 */
export interface McpDiscoveryAdapter {
  getMcpDiscoverySummary(overridePath?: string, cwd?: string): {
    imports: Array<{ kind: McpImportConfiguration["kind"]; path: string; serverCount: number }>;
  };
  loadMcpConfig(overridePath?: string, cwd?: string): { mcpServers: Record<string, Record<string, unknown>> };
}

export interface DiscoverMcpServersOptions {
  cwd?: string;
  /** CoilCoil 里已经存在的服务器名，用来标出「已经装过了」。 */
  existingNames: Set<string>;
  /** 临时探针配置放哪儿。留空就开一个临时目录，用完删掉。 */
  scratchDirectory?: string;
}

function probeConfig(imports: McpImportConfiguration["kind"][]): string {
  return `${JSON.stringify({ mcpServers: {}, imports }, null, 2)}\n`;
}

/** 一个服务器定义看起来是 stdio 还是 http，弹窗里要一眼分得出来。 */
function describe(name: string, definition: Record<string, unknown>): Pick<DiscoveredMcpServer, "transport" | "command" | "args" | "url"> {
  const url = typeof definition.url === "string" ? definition.url : undefined;
  return {
    transport: url ? "http" : "stdio",
    command: typeof definition.command === "string" ? definition.command : undefined,
    args: Array.isArray(definition.args) ? definition.args.filter((value): value is string => typeof value === "string") : undefined,
    url,
  };
}

export function discoverImportableMcpServers(
  adapter: McpDiscoveryAdapter,
  options: DiscoverMcpServersOptions,
): McpDiscoveryResult {
  const owned = options.scratchDirectory === undefined;
  const scratch = options.scratchDirectory ?? mkdtempSync(join(tmpdir(), "coilcoil-mcp-discovery-"));
  try {
    const baselinePath = join(scratch, "baseline.json");
    writeFileSync(baselinePath, probeConfig([]), "utf8");
    const baseline = new Set(Object.keys(adapter.loadMcpConfig(baselinePath, options.cwd).mcpServers));

    const servers: DiscoveredMcpServer[] = [];
    const emptyOrigins: McpDiscoveryResult["emptyOrigins"] = [];
    for (const source of adapter.getMcpDiscoverySummary(baselinePath, options.cwd).imports) {
      const probePath = join(scratch, `probe-${source.kind}.json`);
      let introduced: Array<[string, Record<string, unknown>]>;
      try {
        writeFileSync(probePath, probeConfig([source.kind]), "utf8");
        introduced = Object.entries(adapter.loadMcpConfig(probePath, options.cwd).mcpServers)
          .filter(([name]) => !baseline.has(name));
      } catch (error) {
        // 一个来源的配置坏掉不该把整次发现带崩——把它单独列出来说明原因就行。
        emptyOrigins.push({ kind: source.kind, path: source.path, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if (!introduced.length) {
        emptyOrigins.push({
          kind: source.kind,
          path: source.path,
          // 数得出服务器却一个都没多出来，说明那些名字这边已经有了。
          reason: source.serverCount > 0 ? "里面的服务器 CoilCoil 都已经有了" : "文件在，但没有配置任何服务器",
        });
        continue;
      }
      for (const [name, definition] of introduced) {
        servers.push({
          origin: source.kind,
          originPath: source.path,
          name,
          ...describe(name, definition),
          definition,
          alreadyPresent: options.existingNames.has(name),
        });
      }
    }
    servers.sort((left, right) => left.origin.localeCompare(right.origin) || left.name.localeCompare(right.name));
    return { servers, emptyOrigins };
  } finally {
    if (owned) {
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {
        // 临时目录删不掉不值得报错，系统重启会清。
      }
    }
  }
}
