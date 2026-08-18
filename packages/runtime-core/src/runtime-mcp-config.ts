import {
  type McpConfigurationSnapshot,
  type McpImportConfiguration,
  type McpJsonDocument,
  type McpServerConfiguration,
  validateMcpJsonText,
} from "@suocode/runtime-protocol";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  join,
} from "node:path";
import {
  McpAdapterConfigModule,
  loadMcpAdapterConfigModule,
  mcpImportKind,
  mcpServerDefinitions,
} from "./browser-mcp.js";
import { RuntimeInspectionMcp } from "./runtime-inspection-mcp.js";
import {
  isRecord,
  recordOfStrings,
  stringArray,
} from "./runtime-utils.js";

export abstract class RuntimeMcpConfig extends RuntimeInspectionMcp {
  protected removedMcpServersPath(): string {
    return join(this.agentDir, "mcp-removed-servers.json");
  }

  protected disabledMcpServersPath(): string {
    return join(this.agentDir, "mcp-disabled-servers.json");
  }

  protected readNamedMcpServerSet(path: string): Set<string> {
    if (!existsSync(path)) return new Set();
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      const list = isRecord(parsed) && Array.isArray(parsed.servers)
        ? parsed.servers
        : Array.isArray(parsed) ? parsed : [];
      return new Set(list.filter((name): name is string => typeof name === "string" && Boolean(name.trim())).map((name) => name.trim()));
    } catch {
      return new Set();
    }
  }

  protected writeNamedMcpServerSet(path: string, names: Set<string>): void {
    mkdirSync(this.agentDir, { recursive: true });
    const servers = [...names].sort((left, right) => left.localeCompare(right));
    writeFileSync(path, `${JSON.stringify({ servers }, null, 2)}\n`, "utf8");
  }

  protected readRemovedMcpServers(): Set<string> {
    return this.readNamedMcpServerSet(this.removedMcpServersPath());
  }

  protected writeRemovedMcpServers(names: Set<string>): void {
    this.writeNamedMcpServerSet(this.removedMcpServersPath(), names);
  }

  protected readDisabledMcpServers(): Set<string> {
    return this.readNamedMcpServerSet(this.disabledMcpServersPath());
  }

  protected writeDisabledMcpServers(names: Set<string>): void {
    this.writeNamedMcpServerSet(this.disabledMcpServersPath(), names);
  }

  protected markMcpServerRemovedLocally(name: string): void {
    const removed = this.readRemovedMcpServers();
    removed.add(name);
    this.writeRemovedMcpServers(removed);
    // Deletion and disablement are different product states. A deleted import
    // stays in this private exclusion set, but must not linger in the user-
    // visible disabled set or in Pi's effective configuration.
    this.setMcpServerOptOut(name, false);
  }

  protected clearMcpServerRemovedLocally(name: string): void {
    const removed = this.readRemovedMcpServers();
    if (!removed.delete(name)) return;
    this.writeRemovedMcpServers(removed);
  }

  protected setMcpServerOptOut(name: string, disabled: boolean): void {
    const optOut = this.readDisabledMcpServers();
    if (disabled) optOut.add(name);
    else optOut.delete(name);
    this.writeDisabledMcpServers(optOut);
  }

  protected removeBareMcpServerTombstone(configPath: string, name: string): boolean {
    if (!existsSync(configPath)) return false;
    try {
      const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
      if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) return false;
      const entry = parsed.mcpServers[name];
      if (!isRecord(entry) || entry.disabled !== true || Object.keys(entry).some((key) => key !== "disabled")) return false;
      delete parsed.mcpServers[name];
      const temporaryPath = `${configPath}.${process.pid}.tmp`;
      writeFileSync(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
      renameSync(temporaryPath, configPath);
      return true;
    } catch {
      return false;
    }
  }

  protected cleanRemovedMcpServerState(adapter: McpAdapterConfigModule, cwd?: string): boolean {
    const removed = this.readRemovedMcpServers();
    if (removed.size === 0) return false;
    let changed = false;
    const disabled = this.readDisabledMcpServers();
    for (const name of removed) if (disabled.delete(name)) changed = true;
    if (changed) this.writeDisabledMcpServers(disabled);

    const globalConfigPath = adapter.getPiGlobalConfigPath(join(this.agentDir, "mcp.json"));
    const projectConfigPath = cwd ? adapter.getProjectPiConfigPath(cwd) : undefined;
    for (const name of removed) {
      if (this.removeBareMcpServerTombstone(globalConfigPath, name)) changed = true;
      if (projectConfigPath && this.removeBareMcpServerTombstone(projectConfigPath, name)) changed = true;
    }
    return changed;
  }

  protected async syncMcpOptOutDisabledState(cwd?: string): Promise<boolean> {
    if (!cwd) return false;
    const adapter = await loadMcpAdapterConfigModule();
    const globalConfigPath = adapter.getPiGlobalConfigPath(join(this.agentDir, "mcp.json"));
    const resolvedCwd = this.mcpCwd(cwd);
    const config = adapter.loadMcpConfig(globalConfigPath, resolvedCwd);
    const disabled = this.readDisabledMcpServers();
    const removed = this.readRemovedMcpServers();
    let changed = false;
    for (const name of Object.keys(config.mcpServers)) {
      if (removed.has(name)) continue;
      const result = adapter.writeProjectServerDisabledOverride(globalConfigPath, resolvedCwd, name, disabled.has(name));
      if (result.changed) changed = true;
    }
    return changed;
  }

  async getMcpConfiguration(cwd?: string): Promise<McpConfigurationSnapshot> {
    const adapter = await loadMcpAdapterConfigModule();
    const configPath = adapter.getPiGlobalConfigPath(join(this.agentDir, "mcp.json"));
    const resolvedCwd = this.mcpCwd(cwd);
    const cleaned = this.cleanRemovedMcpServerState(adapter, resolvedCwd);
    const synchronized = await this.syncMcpOptOutDisabledState(cwd);
    if (cleaned || synchronized) this.reloadMcpExtension();
    const projectConfigPath = cwd ? adapter.getProjectPiConfigPath(resolvedCwd) : undefined;
    const config = adapter.loadMcpConfig(configPath, resolvedCwd);
    const discovery = adapter.getMcpDiscoverySummary(configPath, resolvedCwd);
    const provenance = adapter.getServerProvenance(configPath, resolvedCwd);
    const projectDefinitions = mcpServerDefinitions(projectConfigPath);
    const enabledImports = new Set(config.imports ?? []);
    const removed = this.readRemovedMcpServers();
    const optedOut = this.readDisabledMcpServers();
    return {
      configPath,
      projectConfigPath,
      imports: discovery.imports.map((entry) => ({ ...entry, enabled: enabledImports.has(entry.kind) })),
      servers: Object.entries(config.mcpServers).filter(([name]) => !removed.has(name)).map(([name, raw]) => {
        const source = provenance.get(name);
        return {
          name,
          // A project file may contain only { disabled: true } for a global or
          // imported server. That override changes enablement, not ownership.
          scope: source?.kind === "project" && projectDefinitions.has(name) ? "project" : "global",
          transport: typeof raw.url === "string" ? "http" : "stdio",
          command: typeof raw.command === "string" ? raw.command : undefined,
          args: stringArray(raw.args),
          env: recordOfStrings(raw.env),
          cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
          url: typeof raw.url === "string" ? raw.url : undefined,
          headers: recordOfStrings(raw.headers),
          auth: raw.auth === "oauth" || raw.auth === "bearer" || raw.auth === false ? raw.auth : undefined,
          bearerTokenEnv: typeof raw.bearerTokenEnv === "string" ? raw.bearerTokenEnv : undefined,
          lifecycle: raw.lifecycle === "keep-alive" || raw.lifecycle === "eager" ? raw.lifecycle : "lazy",
          idleTimeout: typeof raw.idleTimeout === "number" ? raw.idleTimeout : undefined,
          requestTimeoutMs: typeof raw.requestTimeoutMs === "number" ? raw.requestTimeoutMs : undefined,
          exposeResources: raw.exposeResources !== false,
          directTools: raw.directTools === true ? true : stringArray(raw.directTools),
          excludeTools: stringArray(raw.excludeTools),
          debug: raw.debug === true,
          disabled: raw.disabled === true || optedOut.has(name),
          source: source?.path,
          sourceKind: source?.kind,
          importKind: mcpImportKind(source?.importKind),
        } satisfies McpServerConfiguration;
      }).sort((left, right) => left.name.localeCompare(right.name)),
    };
  }

  protected async mcpJsonPath(): Promise<string> {
    const adapter = await loadMcpAdapterConfigModule();
    return adapter.getPiGlobalConfigPath(join(this.agentDir, "mcp.json"));
  }

  async getMcpJson(): Promise<McpJsonDocument> {
    const path = await this.mcpJsonPath();
    if (!existsSync(path)) {
      return { path, content: `${JSON.stringify({ mcpServers: {} }, null, 2)}\n` };
    }
    return { path, content: readFileSync(path, "utf8") };
  }

  async saveMcpJson(content: string, cwd?: string): Promise<McpConfigurationSnapshot> {
    const validated = validateMcpJsonText(content);
    if (!validated.ok) throw new Error(validated.error);
    const path = await this.mcpJsonPath();
    mkdirSync(dirname(path), { recursive: true });
    const normalized = `${JSON.stringify(validated.value, null, 2)}\n`;
    const temporaryPath = `${path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, normalized, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
    const removed = this.readRemovedMcpServers();
    let removedChanged = false;
    for (const name of mcpServerDefinitions(path)) if (removed.delete(name)) removedChanged = true;
    if (removedChanged) this.writeRemovedMcpServers(removed);
    await this.reloadMcpExtensionNow();
    return this.getMcpConfiguration(cwd);
  }

  async saveMcpServer(server: McpServerConfiguration, previousName?: string, cwd?: string): Promise<McpConfigurationSnapshot> {
    const name = server.name.trim();
    if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) throw new Error("MCP 名称只能包含字母、数字、点、下划线和连字符。");
    if (server.transport === "stdio" && !server.command?.trim()) throw new Error("stdio MCP 需要填写启动命令。");
    if (server.transport === "http" && !server.url?.trim()) throw new Error("HTTP MCP 需要填写服务器地址。");
    if (server.scope === "project" && !cwd) throw new Error("项目级 MCP 需要当前工作区。");
    if (server.idleTimeout !== undefined && (!Number.isFinite(server.idleTimeout) || server.idleTimeout < 0)) throw new Error("空闲超时必须是大于等于 0 的分钟数。");
    if (server.requestTimeoutMs !== undefined && (!Number.isFinite(server.requestTimeoutMs) || server.requestTimeoutMs < 0)) throw new Error("请求超时必须是大于等于 0 的毫秒数。");
    const adapter = await loadMcpAdapterConfigModule();
    const globalConfigPath = adapter.getPiGlobalConfigPath(join(this.agentDir, "mcp.json"));
    const resolvedCwd = this.mcpCwd(cwd);
    const configPath = server.scope === "project" ? adapter.getProjectPiConfigPath(resolvedCwd) : globalConfigPath;
    if (previousName) {
      const previous = (await this.getMcpConfiguration(cwd)).servers.find((item) => item.name === previousName);
      const previousPath = previous?.scope === "project" ? adapter.getProjectPiConfigPath(resolvedCwd) : globalConfigPath;
      if (previousName !== name || previousPath !== configPath) this.removeMcpServerFromFile(previousPath, previousName);
    }
    const definition: Record<string, unknown> = server.transport === "http"
      ? { url: server.url?.trim(), ...(Object.keys(server.headers).length ? { headers: server.headers } : {}), ...(server.auth !== undefined ? { auth: server.auth } : {}) }
      : { command: server.command?.trim(), ...(server.args.length ? { args: server.args } : {}), ...(Object.keys(server.env).length ? { env: server.env } : {}), ...(server.cwd?.trim() ? { cwd: server.cwd.trim() } : {}) };
    definition.lifecycle = server.lifecycle;
    if (server.bearerTokenEnv?.trim()) definition.bearerTokenEnv = server.bearerTokenEnv.trim();
    if (server.idleTimeout !== undefined) definition.idleTimeout = server.idleTimeout;
    if (server.requestTimeoutMs !== undefined) definition.requestTimeoutMs = server.requestTimeoutMs;
    if (!server.exposeResources) definition.exposeResources = false;
    if (server.directTools === true || (Array.isArray(server.directTools) && server.directTools.length)) definition.directTools = server.directTools;
    if (server.excludeTools.length) definition.excludeTools = server.excludeTools;
    if (server.debug) definition.debug = true;
    if (server.disabled) definition.disabled = true;
    adapter.writeSharedServerEntry(configPath, name, definition);
    this.clearMcpServerRemovedLocally(name);
    if (previousName && previousName !== name) {
      this.clearMcpServerRemovedLocally(previousName);
      this.setMcpServerOptOut(previousName, true);
    }
    // Saving keeps the current state: a server is available unless explicitly 停用.
    this.setMcpServerOptOut(name, server.disabled === true);
    if (cwd) {
      adapter.writeProjectServerDisabledOverride(globalConfigPath, resolvedCwd, name, server.disabled === true);
    }
    await this.reloadMcpExtensionNow();
    return this.getMcpConfiguration(cwd);
  }

  protected removeMcpServerFromFile(configPath: string, name: string): boolean {
    if (!existsSync(configPath)) return false;
    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const servers = parsed.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers) || !(name in servers)) return false;
    delete (servers as Record<string, unknown>)[name];
    const temporaryPath = `${configPath}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, configPath);
    return true;
  }

  async removeMcpServer(name: string, scope: "global" | "project" = "global", cwd?: string): Promise<McpConfigurationSnapshot> {
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error("缺少 MCP Server 名称。");
    const adapter = await loadMcpAdapterConfigModule();
    const globalConfigPath = adapter.getPiGlobalConfigPath(join(this.agentDir, "mcp.json"));
    const resolvedCwd = cwd ? this.mcpCwd(cwd) : undefined;
    if (scope === "project" && !resolvedCwd) throw new Error("项目级 MCP 需要当前工作区。");
    const projectConfigPath = resolvedCwd ? adapter.getProjectPiConfigPath(resolvedCwd) : undefined;
    const before = await this.getMcpConfiguration(cwd);
    if (!before.servers.some((server) => server.name === normalizedName)) {
      throw new Error(`MCP Server 不存在：${normalizedName}`);
    }

    const tryRemove = (configPath?: string): void => {
      if (!configPath) return;
      this.removeMcpServerFromFile(configPath, normalizedName);
    };

    // Only mutate SuoCode-owned files. Never delete Cursor/Claude/Codex imports or shared `.mcp.json`.
    tryRemove(globalConfigPath);
    tryRemove(projectConfigPath);
    const provenance = adapter.getServerProvenance(globalConfigPath, resolvedCwd ?? process.cwd());
    const source = provenance.get(normalizedName);
    if (source?.path && (source.kind === "user" || source.kind === "project") && (source.path === globalConfigPath || source.path === projectConfigPath)) {
      tryRemove(source.path);
    }

    // External/shared definitions belong to another application, so SuoCode
    // does not mutate their source file. The private exclusion is permanent
    // from SuoCode's perspective and is never exposed to Pi or the Settings UI.
    const stillPresent = Boolean(adapter.loadMcpConfig(globalConfigPath, resolvedCwd ?? process.cwd()).mcpServers[normalizedName]);
    if (stillPresent) {
      this.markMcpServerRemovedLocally(normalizedName);
    } else {
      this.clearMcpServerRemovedLocally(normalizedName);
      this.setMcpServerOptOut(normalizedName, false);
    }

    await this.reloadMcpExtensionNow();
    return this.getMcpConfiguration(cwd);
  }

  async setMcpServerEnabled(name: string, enabled: boolean, cwd: string): Promise<McpConfigurationSnapshot> {
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error("缺少 MCP Server 名称。");
    const adapter = await loadMcpAdapterConfigModule();
    const resolvedCwd = this.mcpCwd(cwd);
    const globalConfigPath = adapter.getPiGlobalConfigPath(join(this.agentDir, "mcp.json"));
    const effective = adapter.loadMcpConfig(globalConfigPath, resolvedCwd);
    if (!effective.mcpServers[normalizedName]) throw new Error(`MCP Server 不存在：${normalizedName}`);
    this.setMcpServerOptOut(normalizedName, !enabled);
    adapter.writeProjectServerDisabledOverride(globalConfigPath, resolvedCwd, normalizedName, !enabled);
    await this.reloadMcpExtensionNow();
    return this.getMcpConfiguration(resolvedCwd);
  }

  async enableMcpImports(imports: McpImportConfiguration["kind"][], cwd?: string): Promise<McpConfigurationSnapshot> {
    const adapter = await loadMcpAdapterConfigModule();
    adapter.ensureCompatibilityImports(imports, join(this.agentDir, "mcp.json"));
    await this.reloadMcpExtensionNow();
    return this.getMcpConfiguration(cwd);
  }
}
