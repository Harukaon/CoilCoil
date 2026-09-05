import {
  type McpActionResult,
  type McpRuntimeStatus,
  type McpServerRuntimeStatus,
  type ProjectMemoryRuntimeStatus,
  type RuntimeInspectionSnapshot,
  type SubagentConfiguration,
  type SubagentConfigurationInput,
} from "@coilcoil/runtime-protocol";
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
  ORIGINAL_SESSION_MUTATION_UNSUPPORTED,
  RUNTIME_BRIDGE_COMMAND_EVENT,
  RUNTIME_BRIDGE_REPLY_PREFIX,
  projectMemoryStatusByCwd,
} from "./runtime-constants.js";
import { RuntimeResourcesController } from "./runtime-resources.js";
import {
  ActiveSession,
  RuntimeBridgeState,
  mergeWorkspaceMemoryStatus,
  runtimeBridgeState,
} from "./runtime-state.js";
import {
  errorMessage,
  isRecord,
  safeRealPath,
  sensitiveConfigurationKey,
  stringValue,
} from "./runtime-utils.js";
import {
  redactSensitiveText,
  redactSensitiveValue,
} from "./session-values.js";

/** Kept in step with the MCP extension's own RPC surface in @coilcoil/workflow. */
type McpRpcMethod =
  | "status"
  | "connect"
  | "auth-start"
  | "auth-await"
  | "auth-cancel"
  | "auth-complete"
  | "logout"
  | "session-enable";

export abstract class RuntimeInspectionMcp extends RuntimeResourcesController {
  private subagentSettingsPath(): string {
    return join(this.agentDir, "subagent-settings.json");
  }

  private normalizeSubagentConfiguration(value: unknown): SubagentConfiguration {
    const record = value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
    const models = record.models && typeof record.models === "object" && !Array.isArray(record.models)
      ? record.models as Record<string, unknown>
      : {};
    // Migrate the short-lived single-model format by preserving its original
    // meaning: that model applied to all three built-in profiles.
    const legacyModel = typeof record.model === "string" ? record.model : "";
    const normalizeModel = (model: unknown): string => (
      typeof model === "string" ? model.trim().slice(0, 200) : legacyModel.trim().slice(0, 200)
    );
    return {
      models: {
        explore: normalizeModel(models.explore),
        worker: normalizeModel(models.worker),
        reviewer: normalizeModel(models.reviewer),
      },
    };
  }

  protected readSubagentConfiguration(): SubagentConfiguration {
    const path = this.subagentSettingsPath();
    if (!existsSync(path)) return this.normalizeSubagentConfiguration(undefined);
    try {
      return this.normalizeSubagentConfiguration(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      return this.normalizeSubagentConfiguration(undefined);
    }
  }

  async getSubagentConfiguration(): Promise<SubagentConfiguration> {
    return this.readSubagentConfiguration();
  }

  async saveSubagentConfiguration(input: SubagentConfigurationInput): Promise<SubagentConfiguration> {
    const models = input && typeof input === "object" && input.models && typeof input.models === "object"
      ? input.models
      : undefined;
    if (
      !models
      || typeof models.explore !== "string"
      || typeof models.worker !== "string"
      || typeof models.reviewer !== "string"
    ) {
      throw new Error("子代理配置无效。");
    }
    const configuration = this.normalizeSubagentConfiguration(input);
    const path = this.subagentSettingsPath();
    mkdirSync(dirname(path), { recursive: true });
    const temporaryPath = `${path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(configuration, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, path);
    return configuration;
  }

  protected runtimeBridgeRpc(
    method: "get" | "set-system-prompt" | "set-skill-enabled",
    params: Record<string, unknown> = {},
  ): Promise<RuntimeBridgeState> {
    const active = this.requireActive();
    const requestId = `coilcoil-runtime-${method}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const replyChannel = `${RUNTIME_BRIDGE_REPLY_PREFIX}${requestId}`;
    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        callback();
      };
      const unsubscribe = active.eventBus.on(replyChannel, (raw) => {
        if (!isRecord(raw)) return;
        if (raw.ok === true) {
          const state = runtimeBridgeState(raw.state);
          if (!state) {
            finish(() => rejectPromise(new Error("运行时桥接返回了无效状态。")));
            return;
          }
          finish(() => resolvePromise(state));
          return;
        }
        finish(() => rejectPromise(new Error(stringValue(raw.error) || "运行时桥接请求失败。")));
      });
      const timer = setTimeout(() => finish(() => rejectPromise(new Error("运行时桥接请求超时。"))), 8_000);
      active.eventBus.emit(RUNTIME_BRIDGE_COMMAND_EVENT, {
        version: 1,
        requestId,
        method,
        ...params,
      });
    });
  }

  protected refreshRuntimeInspectionSources(active: ActiveSession): Promise<void> {
    if (this.runtimeInspectionRefresh) return this.runtimeInspectionRefresh;
    const refresh = Promise.allSettled([
      this.getSkillConfiguration(active.cwd),
      this.getMcpStatus(),
      this.runtimeBridgeRpc("get"),
    ]).then(([skills, mcp, bridge]) => {
      if (this.active !== active) return;
      if (skills.status === "fulfilled") active.skillConfiguration = skills.value;
      if (mcp.status === "fulfilled") active.mcpStatus = mcp.value;
      if (bridge.status === "fulfilled") active.bridgeState = bridge.value;
      this.publishRuntimeInspection(active);
    }).finally(() => {
      if (this.runtimeInspectionRefresh === refresh) this.runtimeInspectionRefresh = undefined;
    });
    this.runtimeInspectionRefresh = refresh;
    return refresh;
  }

  async getRuntimeInspection(): Promise<RuntimeInspectionSnapshot> {
    const active = this.requireActive();
    void this.refreshRuntimeInspectionSources(active);
    return this.runtimeInspection(active);
  }

  async setSessionSystemPrompt(prompt?: string): Promise<RuntimeInspectionSnapshot> {
    const active = this.requireActive();
    active.bridgeState = await this.runtimeBridgeRpc("set-system-prompt", { prompt });
    const inspection = this.runtimeInspection(active);
    this.emitEvent({ type: "runtime_inspection_updated", inspection });
    return inspection;
  }

  async setSessionSkillEnabled(filePath: string, enabled: boolean): Promise<RuntimeInspectionSnapshot> {
    if (!filePath.trim()) throw new Error("缺少 Skill 路径。");
    const active = this.requireActive();
    active.bridgeState = await this.runtimeBridgeRpc("set-skill-enabled", { filePath: filePath.trim(), enabled });
    const inspection = this.runtimeInspection(active);
    this.emitEvent({ type: "runtime_inspection_updated", inspection });
    return inspection;
  }

  protected publishManualMemoryStatus(
    active: ActiveSession,
    state: ProjectMemoryRuntimeStatus["state"],
    message: string,
    error?: string,
  ): ProjectMemoryRuntimeStatus {
    const shared = projectMemoryStatusByCwd.get(safeRealPath(active.cwd));
    const previous = active.memoryStatus ?? shared;
    const now = Date.now();
    const next: ProjectMemoryRuntimeStatus = {
      ...previous,
      cwd: active.cwd,
      updatedAt: now,
      attemptId: `manual-${now}-${Math.random().toString(36).slice(2, 8)}`,
      state,
      source: "manual",
      exists: previous?.exists ?? false,
      injected: previous?.injected ?? false,
      processedSessions: previous?.processedSessions ?? [],
      startedAt: state === "running" ? now : previous?.startedAt,
      completedAt: state === "failed" ? now : undefined,
      durationMs: undefined,
      message,
      error,
    };
    active.memoryStatus = next;
    const memoryKey = safeRealPath(active.cwd);
    projectMemoryStatusByCwd.set(
      memoryKey,
      mergeWorkspaceMemoryStatus(projectMemoryStatusByCwd.get(memoryKey), next),
    );
    this.publishRuntimeInspection(active);
    this.emitEvent({
      type: "runtime_notice",
      level: state === "failed" ? "error" : "info",
      message: error || message,
    });
    return next;
  }

  async runMemoryNow(): Promise<{ accepted: true; }> {
    const active = this.requireActive();
    if (this.modelTransition) await this.modelTransition;
    if (active.session.isStreaming) {
      const message = "当前回复仍在运行，请结束后再整理项目记忆。";
      this.publishManualMemoryStatus(active, "busy", message);
      throw new Error(message);
    }
    if (this.promptStarting) throw new Error("上一条消息正在启动，请稍候。");
    const sharedMemory = projectMemoryStatusByCwd.get(safeRealPath(active.cwd));
    if (sharedMemory?.state === "running") {
      const message = "当前工作区已有记忆整理正在运行。";
      this.publishManualMemoryStatus(active, "busy", message);
      throw new Error(message);
    }
    if (!active.session.model) {
      const message = "当前没有可用于记忆整理的模型。";
      this.publishManualMemoryStatus(active, "failed", message, message);
      throw new Error(message);
    }
    if (
      active.session.messages.length === 0
      || !active.session.sessionFile
      || !existsSync(active.session.sessionFile)
    ) {
      const message = "当前会话还没有可供整理的历史记录。";
      this.publishManualMemoryStatus(active, "failed", message, message);
      throw new Error(message);
    }
    this.publishManualMemoryStatus(active, "running", "正在启动当前项目的记忆整理…");
    this.promptStarting = true;
    try {
      await active.session.prompt("/memory", {
        preflightResult: () => { this.promptStarting = false; },
      });
    } catch (error) {
      this.promptStarting = false;
      const message = errorMessage(error);
      this.publishManualMemoryStatus(active, "failed", "项目记忆整理启动失败", message);
      throw error;
    }
    return { accepted: true };
  }

  async removeOriginalSessionItem(_entryId: string): Promise<never> {
    throw new Error(ORIGINAL_SESSION_MUTATION_UNSUPPORTED);
  }

  protected mcpRpc(method: McpRpcMethod, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const active = this.requireActive();
    const requestId = `coilcoil-mcp-${method}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const replyChannel = `coilcoil:mcp:rpc:v1:reply:${requestId}`;
    // pi-mcp-adapter performs a first-run metadata bootstrap before its proxy
    // tool becomes ready. That bootstrap can legitimately consume a server's
    // configured request timeout, so the GUI bridge must not abandon the
    // extension at the old eight-second boundary.
    // `auth-await` is parked on a person finishing a login in their browser.
    // pi's loopback listener gives them five minutes; abandoning the request
    // first would report a failure while the flow is still perfectly alive.
    const timeoutMs = method === "status" ? 30_000 : method === "auth-await" ? 360_000 : 120_000;
    return new Promise((resolvePromise, rejectPromise) => {
      let settled = false;
      const finish = (callback: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        callback();
      };
      const unsubscribe = active.eventBus.on(replyChannel, (raw) => {
        if (!isRecord(raw)) return;
        if (raw.success === true && isRecord(raw.data)) {
          const data = raw.data;
          finish(() => resolvePromise(data));
          return;
        }
        const rpcError = isRecord(raw.error) ? stringValue(raw.error.message) : "MCP 扩展请求失败。";
        finish(() => rejectPromise(new Error(rpcError || "MCP 扩展请求失败。")));
      });
      const timer = setTimeout(() => finish(() => rejectPromise(new Error("MCP 扩展请求超时。"))), timeoutMs);
      active.eventBus.emit("coilcoil:mcp:rpc:v1:request", {
        version: 1,
        requestId,
        method,
        params,
        source: { client: "coilcoil-desktop" },
      });
    });
  }

  protected mcpStatusFromDetails(details: unknown): McpRuntimeStatus | undefined {
    if (isRecord(details) && (details.error === "not_initialized" || details.error === "init_failed")) return undefined;
    if (!isRecord(details) || details.mode !== "status" || !Array.isArray(details.servers)) {
      const shape = isRecord(details)
        ? `{ mode: ${JSON.stringify(details.mode)}, servers: ${Array.isArray(details.servers) ? "array" : typeof details.servers} }`
        : String(details);
      throw new Error(`pi-mcp-adapter 返回了无效的状态数据：${shape}`);
    }
    const statuses = new Set<McpServerRuntimeStatus["status"]>(["connected", "needs-auth", "failed", "cached", "not connected", "disabled"]);
    const servers = details.servers.map((raw) => {
      if (!isRecord(raw)) throw new Error("pi-mcp-adapter 返回了无效的 Server 状态。");
      const rawStatus = stringValue(raw.status);
      const status = (rawStatus === "not-connected" ? "not connected" : rawStatus) as McpServerRuntimeStatus["status"];
      if (!statuses.has(status)) throw new Error(`未知的 MCP Server 状态：${status || "empty"}`);
      return {
        name: stringValue(raw.name),
        status,
        toolCount: typeof raw.toolCount === "number" && Number.isFinite(raw.toolCount) ? raw.toolCount : 0,
        resourceCount: typeof raw.resourceCount === "number" && Number.isFinite(raw.resourceCount) ? raw.resourceCount : 0,
        failedAgo: typeof raw.failedAgoSeconds === "number" ? raw.failedAgoSeconds : typeof raw.failedAgo === "number" ? raw.failedAgo : null,
        disabled: raw.disabled === true || status === "disabled",
        sessionDisabled: raw.sessionDisabled === true,
      } satisfies McpServerRuntimeStatus;
    });
    return {
      servers,
      totalTools: typeof details.totalTools === "number" && Number.isFinite(details.totalTools) ? details.totalTools : 0,
      totalResources: typeof details.totalResources === "number" && Number.isFinite(details.totalResources) ? details.totalResources : servers.reduce((sum, server) => sum + server.resourceCount, 0),
      connectedCount: typeof details.connectedCount === "number" && Number.isFinite(details.connectedCount) ? details.connectedCount : 0,
      disabledCount: typeof details.disabledCount === "number" && Number.isFinite(details.disabledCount) ? details.disabledCount : servers.filter((server) => server.disabled).length,
      sessionDisabledCount: typeof details.sessionDisabledCount === "number" && Number.isFinite(details.sessionDisabledCount)
        ? details.sessionDisabledCount
        : servers.filter((server) => server.sessionDisabled).length,
      state: "ready",
    };
  }

  protected async mcpSensitiveValues(cwd?: string): Promise<string[]> {
    const configuration = await this.getMcpConfiguration(cwd);
    const secrets: string[] = [];
    for (const server of configuration.servers) {
      for (const [key, value] of [...Object.entries(server.env), ...Object.entries(server.headers)]) {
        if (sensitiveConfigurationKey(key) && value && !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)) secrets.push(value);
      }
      if (server.url) {
        try {
          const parsed = new URL(server.url);
          if (parsed.username) secrets.push(decodeURIComponent(parsed.username));
          if (parsed.password) secrets.push(decodeURIComponent(parsed.password));
          for (const [key, value] of parsed.searchParams) if (sensitiveConfigurationKey(key) && value) secrets.push(value);
        } catch {
          // Invalid URLs are rejected when saved; imported malformed entries have no safe structured secrets to inspect.
        }
      }
    }
    return secrets;
  }

  /**
   * What was last reported as wrong, so a steady failure is logged once.
   *
   * Status is refreshed on every inspection, and a server that cannot connect
   * stays that way — logging each refresh would bury everything else.
   */
  private lastMcpTrouble?: string;

  /**
   * Record MCP trouble where the user can retrieve it.
   *
   * A server that will not connect shows in the panel as a status word and
   * nothing more, and the reason — a refused connection, a missing native
   * credential store, a rejected token — never left the process. That is
   * answerable only on the machine it happens on, which may not be this one.
   *
   * Server names and statuses only. The diagnostic has already been through
   * `redactSensitiveText`, and the URL never comes near this: these servers
   * routinely carry their credential inside the address.
   */
  protected recordMcpTrouble(servers: McpServerRuntimeStatus[], diagnostic?: string): void {
    const failing = servers
      .filter((server) => !server.disabled && server.status !== "connected")
      .map((server) => `${server.name}:${server.status}`);
    const signature = `${failing.join(",")}|${diagnostic ?? ""}`;
    if (signature === this.lastMcpTrouble) return;
    this.lastMcpTrouble = signature;
    if (!failing.length && !diagnostic) return;
    this.log.warn("mcp", "mcp_not_connected", {
      failing,
      diagnostic,
      connected: servers.filter((server) => server.status === "connected").map((server) => server.name),
    });
  }

  protected async normalizeMcpStatus(
    reported: McpRuntimeStatus | undefined,
    fallbackState: McpRuntimeStatus["state"],
    diagnostic?: string,
  ): Promise<McpRuntimeStatus> {
    // Pass the active cwd: `loadMcpConfig` resolves project overrides against it
    // either way, so omitting it would read those overrides without first
    // reconciling them — leaving the inspector and Settings disagreeing.
    const configuration = await this.getMcpConfiguration(this.active?.cwd);
    const reportedByName = new Map((reported?.servers ?? []).map((server) => [server.name, server]));
    const servers = configuration.servers.map((server) => {
      const live = reportedByName.get(server.name);
      return {
        name: server.name,
        status: server.disabled ? "disabled" as const : live?.status ?? "not connected" as const,
        toolCount: live?.toolCount ?? 0,
        resourceCount: live?.resourceCount ?? 0,
        failedAgo: live?.failedAgo ?? null,
        disabled: server.disabled,
        sessionDisabled: live?.sessionDisabled ?? false,
      } satisfies McpServerRuntimeStatus;
    });
    const visible = servers.filter((server) => !server.disabled && !server.sessionDisabled);
    this.recordMcpTrouble(servers, diagnostic);
    return {
      servers,
      totalTools: visible.reduce((sum, server) => sum + server.toolCount, 0),
      totalResources: visible.reduce((sum, server) => sum + server.resourceCount, 0),
      connectedCount: visible.filter((server) => server.status === "connected").length,
      disabledCount: servers.filter((server) => server.disabled).length,
      sessionDisabledCount: servers.filter((server) => server.sessionDisabled).length,
      state: reported ? "ready" : fallbackState,
      diagnostic: reported ? undefined : diagnostic,
    };
  }

  async getMcpStatus(): Promise<McpRuntimeStatus> {
    const secrets = await this.mcpSensitiveValues();
    let result: Record<string, unknown>;
    try {
      result = await this.mcpRpc("status");
    } catch (error) {
      const message = redactSensitiveText(errorMessage(error), secrets);
      this.log.error("mcp", "mcp_status_failed", message);
      throw new Error(message);
    }
    const details = isRecord(result.details) ? result.details : {};
    return this.normalizeMcpStatus(
      this.mcpStatusFromDetails(result.details),
      details.error === "init_failed" ? "unavailable" : "initializing",
      redactSensitiveText(stringValue(details.message) || stringValue(result.text), secrets) || undefined,
    );
  }

  protected async mcpAction(method: Exclude<McpRpcMethod, "status" | "session-enable">, params: Record<string, unknown>): Promise<McpActionResult> {
    const secrets = await this.mcpSensitiveValues();
    let result: Record<string, unknown>;
    try {
      result = await this.mcpRpc(method, params);
    } catch (error) {
      const message = redactSensitiveText(errorMessage(error), secrets);
      // `params.server` is a name, never an address: these servers routinely
      // carry their credential inside the URL.
      this.log.error("mcp", "mcp_action_failed", message, { method, server: params.server });
      throw new Error(message);
    }
    let status: McpRuntimeStatus | undefined;
    try {
      status = await this.getMcpStatus();
    } catch {
      status = undefined;
    }
    return {
      text: redactSensitiveText(stringValue(result.text), secrets),
      details: isRecord(result.details) ? redactSensitiveValue(result.details, secrets) as Record<string, unknown> : undefined,
      status,
    };
  }

  async connectMcpServer(name: string): Promise<McpActionResult> {
    if (!name.trim()) throw new Error("缺少 MCP Server 名称。");
    return this.mcpAction("connect", { server: name.trim() });
  }

  async startMcpAuth(name: string): Promise<McpActionResult> {
    if (!name.trim()) throw new Error("缺少 MCP Server 名称。");
    return this.mcpAction("auth-start", { server: name.trim() });
  }

  /**
   * Wait for the browser to hand the authorization back.
   *
   * Started right after `startMcpAuth`, so the MCP extension's waiter on pi's
   * loopback listener is already armed: this call resolves once the redirect
   * lands and the token exchange has been done, without anyone copying a URL.
   */
  async awaitMcpAuth(name: string): Promise<McpActionResult> {
    if (!name.trim()) throw new Error("缺少 MCP Server 名称。");
    return this.mcpAction("auth-await", { server: name.trim() });
  }

  /** Give up on a browser authorization the user walked away from. */
  async cancelMcpAuth(name: string): Promise<McpActionResult> {
    if (!name.trim()) throw new Error("缺少 MCP Server 名称。");
    return this.mcpAction("auth-cancel", { server: name.trim() });
  }

  async completeMcpAuth(name: string, input: string): Promise<McpActionResult> {
    if (!name.trim()) throw new Error("缺少 MCP Server 名称。");
    if (!input.trim()) throw new Error("缺少 OAuth 回调内容。");
    return this.mcpAction("auth-complete", { server: name.trim(), input: input.trim() });
  }

  async logoutMcpServer(name: string): Promise<McpActionResult> {
    if (!name.trim()) throw new Error("缺少 MCP Server 名称。");
    return this.mcpAction("logout", { server: name.trim() });
  }

  async setSessionMcpServerEnabled(name: string, enabled: boolean): Promise<RuntimeInspectionSnapshot> {
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error("缺少 MCP Server 名称。");
    const active = this.requireActive();
    const result = await this.mcpRpc("session-enable", { server: normalizedName, enabled });
    const reported = this.mcpStatusFromDetails(result.details);
    if (!reported) throw new Error("MCP 扩展没有返回当前会话状态。");
    active.mcpStatus = await this.normalizeMcpStatus(reported, "ready");
    const inspection = this.runtimeInspection(active);
    this.emitEvent({ type: "runtime_inspection_updated", inspection });
    return inspection;
  }
}
