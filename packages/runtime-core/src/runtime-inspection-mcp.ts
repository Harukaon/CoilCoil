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
  McpCredentialStore,
  McpManager,
  defaultCredentialFile,
} from "@coilcoil/mcp";
import {
  bundledBrowserServerConfiguration,
  withoutRivalBrowserConfigurations,
} from "./browser-mcp.js";
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

  /**
   * CoilCoil's MCP client, owned by the runtime rather than by a session.
   *
   * This is the whole point of dropping pi-mcp-adapter. That adapter was a Pi
   * extension, so everything about MCP lived inside a conversation: with no
   * session open the settings panel could not report a status, could not
   * connect, and answered 请先打开项目并创建会话 to someone who only wanted to
   * check a server. One manager per runtime is up whenever the app is.
   */
  protected mcpManager(): McpManager {
    if (this.mcpManagerInstance) return this.mcpManagerInstance;
    this.mcpManagerInstance = new McpManager({
      loadServers: async () => {
        const configured = (await this.getMcpConfiguration(this.active?.cwd)).servers;
        const browser = bundledBrowserServerConfiguration(process.env, this.browserScopeId);
        // The built-in browser is not in the workspace's MCP file — it is wired
        // up by the desktop app — so it has to be added here or the Agent never
        // sees it. Which is exactly what happened when this client replaced the
        // old adapter: the adapter got it from a different path.
        return browser ? [...withoutRivalBrowserConfigurations(configured), browser] : configured;
      },
      store: new McpCredentialStore(defaultCredentialFile(this.agentDir)),
      // The renderer opens the authorization page itself, so that it can show
      // the dialog and the browser in the right order; the manager only has to
      // arm the loopback listener before handing the address back.
      openAuthorization: () => undefined,
    });
    // 「启动时」这一档只在客户端刚起来的时候兑现一次，而不是每次配置刷新都重来；
    // 失败不该拖住任何东西，所以是放出去不等。
    void this.mcpManagerInstance.startEagerServers().catch(() => undefined);
    return this.mcpManagerInstance;
  }

  private mcpManagerInstance?: McpManager;

  async getMcpStatus(): Promise<McpRuntimeStatus> {
    const status = await this.mcpManager().status();
    this.recordMcpTrouble(status.servers);
    return status;
  }

  /**
   * Wrap one manager call as the panel's `McpActionResult`.
   *
   * Failures are values here, not exceptions: a refused credential and an
   * unreachable address are answers the panel shows verbatim, and the secrets
   * that routinely live in an MCP address never reach the renderer.
   */
  private async mcpAction(
    mode: string,
    server: string,
    run: () => Promise<McpServerRuntimeStatus>,
    describe: (status: McpServerRuntimeStatus) => string,
  ): Promise<McpActionResult> {
    const secrets = await this.mcpSensitiveValues();
    try {
      const outcome = await run();
      const status = await this.getMcpStatus();
      if (outcome.status === "failed") {
        const failure = this.mcpManager().failure(server);
        const message = redactSensitiveText(failure ?? `MCP Server「${server}」连不上。`, secrets);
        return { text: message, details: { mode, error: "connect_failed", message, server }, status };
      }
      if (outcome.status === "needs-auth") {
        // An answer, not a fault: the panel turns this straight into the
        // authorization dialog rather than showing an error.
        const message = `${server} 需要认证。`;
        return { text: message, details: { mode, error: "auth_required", message, server }, status };
      }
      return { text: describe(outcome), details: { mode, server, status: outcome.status }, status };
    } catch (error) {
      const message = redactSensitiveText(errorMessage(error), secrets);
      this.log.error("mcp", "mcp_action_failed", message, { mode, server });
      return { text: message, details: { mode, error: "action_failed", message, server } };
    }
  }

  async connectMcpServer(name: string): Promise<McpActionResult> {
    if (!name.trim()) throw new Error("缺少 MCP Server 名称。");
    const server = name.trim();
    return this.mcpAction(
      "connect",
      server,
      () => this.mcpManager().connect(server),
      (status) => status.status === "connected"
        ? `${server} 已连接${status.toolCount ? ` · ${status.toolCount} 个工具` : ""}`
        : status.status === "needs-auth"
          ? `${server} 需要认证。`
          : status.status === "disabled"
            ? `${server} 已停用。`
            : `${server} 未连接。`,
    );
  }

  /**
   * Open a browser authorization and report where it got to.
   *
   * The loopback listener is armed inside `startAuth`, before this returns, so
   * an approval that comes back faster than the renderer can call
   * `awaitMcpAuth` is still captured rather than dropped.
   */
  async startMcpAuth(name: string): Promise<McpActionResult> {
    if (!name.trim()) throw new Error("缺少 MCP Server 名称。");
    const server = name.trim();
    const secrets = await this.mcpSensitiveValues();
    try {
      const started = await this.mcpManager().startAuth(server);
      const status = await this.getMcpStatus();
      if (started.error) {
        const message = redactSensitiveText(started.error, secrets);
        return { text: message, details: { mode: "auth-start", error: "auth_start_failed", message, server }, status };
      }
      if (started.authenticated) {
        return { text: `${server} 已经完成认证。`, details: { mode: "auth-start", authenticated: true, server }, status };
      }
      return {
        text: `${server} 需要在浏览器里完成授权。`,
        details: {
          mode: "auth-start",
          server,
          authorizationUrl: started.authorizationUrl,
          awaitingCallback: started.awaitingCallback,
        },
        status,
      };
    } catch (error) {
      const message = redactSensitiveText(errorMessage(error), secrets);
      this.log.error("mcp", "mcp_auth_start_failed", message, { server });
      return { text: message, details: { mode: "auth-start", error: "auth_start_failed", message, server } };
    }
  }

  async awaitMcpAuth(name: string): Promise<McpActionResult> {
    if (!name.trim()) throw new Error("缺少 MCP Server 名称。");
    const server = name.trim();
    return this.mcpAction("auth-await", server, () => this.mcpManager().awaitAuth(server), () => `${server} 已完成认证。`);
  }

  /** Give up on a browser authorization the user walked away from. */
  async cancelMcpAuth(name: string): Promise<McpActionResult> {
    if (!name.trim()) throw new Error("缺少 MCP Server 名称。");
    const server = name.trim();
    this.mcpManager().cancelAuth(server);
    return { text: `${server} 的授权已取消。`, details: { mode: "auth-cancel", server }, status: await this.getMcpStatus() };
  }

  async completeMcpAuth(name: string, input: string): Promise<McpActionResult> {
    if (!name.trim()) throw new Error("缺少 MCP Server 名称。");
    if (!input.trim()) throw new Error("缺少 OAuth 回调内容。");
    const server = name.trim();
    return this.mcpAction(
      "auth-complete",
      server,
      () => this.mcpManager().completeAuth(server, input),
      () => `${server} 已完成认证。`,
    );
  }

  async logoutMcpServer(name: string): Promise<McpActionResult> {
    if (!name.trim()) throw new Error("缺少 MCP Server 名称。");
    const server = name.trim();
    const result = await this.mcpAction("logout", server, () => this.mcpManager().logout(server), () => `${server} 的登录信息已清除。`);
    // The panel reports "signed out" off this flag rather than off the text.
    if (!result.details?.error) result.details = { ...result.details, loggedOut: true };
    return result;
  }

  /**
   * Hide a server from the Agent for this conversation only.
   *
   * Unlike the rest of the MCP surface this genuinely is session-scoped, so it
   * still needs an open session — that is the thing being changed, not an
   * implementation detail leaking into the panel.
   */
  async setSessionMcpServerEnabled(name: string, enabled: boolean): Promise<RuntimeInspectionSnapshot> {
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error("缺少 MCP Server 名称。");
    const active = this.requireActive();
    this.mcpManager().setSessionEnabled(normalizedName, enabled);
    active.mcpStatus = await this.getMcpStatus();
    const inspection = this.runtimeInspection(active);
    this.emitEvent({ type: "runtime_inspection_updated", inspection });
    return inspection;
  }

  /** Let go of every MCP connection when the runtime goes down. */
  async closeMcp(): Promise<void> {
    const manager = this.mcpManagerInstance;
    this.mcpManagerInstance = undefined;
    await manager?.close();
  }
}
