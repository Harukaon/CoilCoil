import {
  cleanupSessionResources,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  type EventBusController,
  ModelRuntime,
  configureHttpDispatcher,
} from "@earendil-works/pi-coding-agent";
import type { McpManager } from "@coilcoil/mcp";
import {
  type McpConfigurationSnapshot,
  type ProjectSnapshot,
  type RuntimeBootstrap,
  type RuntimeConfiguration,
  type RuntimeInspectionSnapshot,
  type SessionSnapshot,
  type SubagentActivity,
} from "@coilcoil/runtime-protocol";
import {
  mkdirSync,
} from "node:fs";
import {
  join,
  resolve,
} from "node:path";
import {
  McpAdapterConfigModule,
} from "./browser-mcp.js";
import {
  resolvePackageDirectory,
} from "./package-resolution.js";
import {
  bundledRuntimeResources,
  migrateLegacyResponsesWsIdentity,
  resolveWorkflowDirectory,
  seedLegacyConfiguration,
} from "./project-helpers.js";
import {
  ProviderAuthFlow,
} from "./provider-helpers.js";
import {
  EventSink,
} from "./runtime-constants.js";
import {
  ActiveSession,
  ReconstructedSessionState,
  CoilCoilRuntimeOptions,
} from "./runtime-state.js";
import { installModelOverrides } from "./model-overrides.js";
import {
  DIAGNOSTIC_LEVEL_ENV,
  DIAGNOSTIC_LOG_DIRECTORY,
  DiagnosticLog,
  levelFromEnvironment,
} from "@coilcoil/diagnostics";
import {
  setGlobalToolPurposeAuditEnabled,
} from "./session-values.js";

export abstract class RuntimeBase {
  readonly agentDir: string;

  /**
   * Where this runtime records what it did.
   *
   * Every session runtime in the process shares one file, so a symptom that
   * spans a session switch still reads as a single timeline.
   */
  readonly log: DiagnosticLog;

  readonly sessionDir: string;

  readonly workflowDir: string;


  protected readonly emitEvent: EventSink;

  protected readonly extensionPaths: string[];

  protected readonly skillPaths: string[];

  protected readonly promptPaths: string[];

  protected modelRuntime?: ModelRuntime;

  protected modelRuntimePromise?: Promise<ModelRuntime>;

  protected active?: ActiveSession;

  protected migratedLegacyCredentials = false;

  protected projectRefreshTimer?: ReturnType<typeof setTimeout>;

  protected mcpReloadTimer?: ReturnType<typeof setTimeout>;

  protected resourceReloadTimer?: ReturnType<typeof setTimeout>;

  protected runtimeInspectionRefresh?: Promise<void>;

  protected modelTransition?: Promise<void>;

  protected promptStarting = false;

  protected readonly providerAuthFlows = new Map<string, ProviderAuthFlow>();

  constructor(options: CoilCoilRuntimeOptions) {
    // The Pi CLI configures its Undici dispatcher before provider SDKs run.
    // Embedded SDK consumers must do the same or Node's default dispatcher can
    // negotiate HTTP/2 and surface idle stream errors as uncaught exceptions.
    configureHttpDispatcher();
    this.agentDir = resolve(options.agentDir);
    this.sessionDir = resolve(options.sessionDir);
    this.log = options.log ?? new DiagnosticLog({
      directory: join(this.agentDir, DIAGNOSTIC_LOG_DIRECTORY),
      process: "runtime",
      level: levelFromEnvironment(process.env[DIAGNOSTIC_LEVEL_ENV]),
    });
    setGlobalToolPurposeAuditEnabled(this.readToolPurposeAuditSetting());
    this.workflowDir = resolveWorkflowDirectory(options.workflowDir);
    const resources = bundledRuntimeResources(this.workflowDir);
    this.extensionPaths = [...resources.extensions, ...options.additionalExtensionPaths ?? []];
    this.skillPaths = resources.skills;
    this.promptPaths = resources.prompts;
    this.emitEvent = options.onEvent ?? (() => undefined);
    this.modelRuntime = options.modelRuntime ? this.withModelOverrides(options.modelRuntime) : undefined;
    if (!this.modelRuntime && options.modelRuntimePromise) {
      this.modelRuntimePromise = options.modelRuntimePromise.then((runtime) => {
        this.modelRuntime = this.withModelOverrides(runtime);
        return this.modelRuntime;
      });
    }
    const codingAgentRoot = resolvePackageDirectory("@earendil-works/pi-coding-agent");
    process.env.PI_CODING_AGENT_DIR = this.agentDir;
    process.env.PI_MEMORY_WORKER_ENTRY = join(codingAgentRoot, "dist", "cli.js");
    this.migratedLegacyCredentials = options.legacyAgentDir
      ? seedLegacyConfiguration(this.agentDir, resolve(options.legacyAgentDir))
      : false;
    migrateLegacyResponsesWsIdentity(this.agentDir);
    mkdirSync(this.sessionDir, { recursive: true });
  }

  /**
   * Say whether this session is busy, and record what decided it.
   *
   * Nine places used to answer this question independently, and a composer that
   * kept spinning after a reply had visibly ended could not be pinned on any of
   * them from the outside — the event carries a boolean and nothing else. They
   * all come through here now, so the log always names the last thing that
   * changed the answer and what it saw when it did.
   */
  protected publishRunning(
    running: boolean,
    reason: string,
    detail?: { aborting?: boolean } & Record<string, unknown>,
  ): void {
    const { aborting, ...rest } = detail ?? {};
    this.log.info("run-state", "run_state", { running, reason, ...(aborting === undefined ? {} : { aborting }), ...rest });
    this.emitEvent({ type: "run_state", running, ...(aborting === undefined ? {} : { aborting }) });
  }

  abstract getConfiguration(): Promise<RuntimeConfiguration>;

  protected abstract readToolPurposeAuditSetting(): boolean;

  protected abstract modelWithRuntimeOptions<T extends { provider: string; id: string; contextWindow: number; }>(model: T): T;

  /** CoilCoil's per-model runtime metadata, which Pi's registry does not hold. */
  protected abstract readModelRuntimeOptions(): Record<string, Record<string, { contextWindow?: number; }>>;

  protected abstract refreshAgentMcpConfiguration(eventBus: EventBusController, cwd: string): Promise<void>;

  protected abstract canReloadActiveSession(active: ActiveSession): boolean;

  protected abstract reloadActiveSessionResources(errorLabel?: string): void;

  protected abstract refreshRuntimeInspectionSources(active: ActiveSession): Promise<void>;

  protected abstract readRemovedMcpServers(): Set<string>;

  protected abstract readDisabledMcpServers(): Set<string>;

  protected abstract cleanRemovedMcpServerState(adapter: McpAdapterConfigModule, cwd?: string): boolean;

  /** Lay the workspace's own MCP servers, stored in the agent directory, over the shared ones. */
  protected abstract withWorkspaceMcpServers<T extends { mcpServers: Record<string, Record<string, unknown>> }>(
    configuration: T,
    cwd?: string,
  ): T;

  abstract getMcpConfiguration(cwd?: string): Promise<McpConfigurationSnapshot>;

  /** The runtime's own MCP client; see `runtime-inspection-mcp.ts`. */
  protected abstract mcpManager(): McpManager;

  protected abstract reconstructState(session: AgentSession): ReconstructedSessionState;

  protected abstract mergeSubagentActivities(activities: SubagentActivity[]): void;

  protected abstract handleSessionEvent(event: AgentSessionEvent): void;

  protected abstract requireActive(): ActiveSession;

  abstract refreshProject(): Promise<ProjectSnapshot>;

  protected abstract publishProjectFromMemory(): void;

  protected abstract scheduleProjectRefresh(): void;

  abstract snapshot(reconstructedState?: ReconstructedSessionState): Promise<SessionSnapshot>;

  protected abstract runtimeInspection(active: ActiveSession): RuntimeInspectionSnapshot;

  protected abstract publishRuntimeInspection(active: ActiveSession): void;

  /** Cancel a summarization a stop already in flight is waiting on. */
  protected abstract cancelSummarizationForStop(active: ActiveSession): void;

  async initialize(): Promise<RuntimeBootstrap> {
    await this.ready();
    // MCP 管理器一造出来就会在后台把启用的服务器都连上。以前它是等第一次查状态
    // 才被造出来，而第一次查状态发生在打开会话之后——等于「开机预连」要等用户先
    // 点开一个对话，白白错过了启动到第一次用之间的那段时间。这里只是把它造出来，
    // 连接仍然是后台跑的，披露给 Agent 也仍然按需。
    try { this.mcpManager(); } catch { /* 起不来就算了，不该拖住运行时 */ }
    const configuration = await this.getConfiguration();
    this.emitEvent({ type: "runtime_ready", configuration });
    return { configuration, activeSession: this.active ? await this.snapshot() : undefined };
  }

  /**
   * Apply CoilCoil's per-model overrides at the registry, once per instance.
   *
   * A runtime may be handed a ModelRuntime someone else already created — every
   * session runtime shares one — so this is idempotent.
   */
  protected withModelOverrides(runtime: ModelRuntime): ModelRuntime {
    return installModelOverrides(runtime, (provider, id) => this.readModelRuntimeOptions()[provider]?.[id]);
  }

  protected async ready(): Promise<ModelRuntime> {
    if (this.modelRuntime) return this.modelRuntime;
    this.modelRuntimePromise ??= ModelRuntime.create({
      authPath: join(this.agentDir, "auth.json"),
      modelsPath: join(this.agentDir, "models.json"),
      allowModelNetwork: false,
    }).then((runtime) => {
      this.modelRuntime = this.withModelOverrides(runtime);
      return this.modelRuntime;
    }).catch((error) => {
      this.modelRuntimePromise = undefined;
      throw error;
    });
    return this.modelRuntimePromise;
  }

  async sharedModelRuntime(): Promise<ModelRuntime> {
    return this.ready();
  }

  refreshSessionModelFromRegistry(): void {
    const active = this.active;
    if (!active) return;
    const current = active.session.model;
    if (!current) return;
    // Pooled provider connections are keyed by session id alone — not by URL,
    // key or protocol — so a socket opened against the old configuration would
    // otherwise be reused until it idles out. Drop them before rebinding.
    try {
      cleanupSessionResources(active.session.sessionId);
    } catch (error) {
      console.error("[runtime] 释放会话连接失败", error);
    }
    active.session.refreshModelFromRegistry();
    // Context-window overrides are CoilCoil runtime metadata rather than Pi
    // registry data, so the refresh above discards them. Re-apply directly on
    // the agent state: setModel() would append a model_change entry and make it
    // look like the user switched models, and skipping the refresh entirely
    // left the session pinned to the old endpoint and protocol.
    const refreshed = active.session.model;
    if (!refreshed) return;
    const withOverride = this.modelWithRuntimeOptions(refreshed);
    if (withOverride !== refreshed) active.session.agent.state.model = withOverride;
  }
}
