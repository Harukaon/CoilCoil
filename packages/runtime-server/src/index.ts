import { SuoCodeRuntime, type SuoCodeRuntimeOptions } from "@suocode/runtime-core";
import {
  isRuntimeCommandEnvelope,
  type RuntimeCommand,
  type RuntimeCommandEnvelope,
  type RuntimeEvent,
  type RuntimeResponseEnvelope,
  type SessionSnapshot,
  type RuntimeWireMessage,
} from "@suocode/runtime-protocol";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

type WireSink = (message: RuntimeWireMessage) => void;
type RuntimeFactory = (options: SuoCodeRuntimeOptions) => SuoCodeRuntime;

export interface RuntimeServerDependencies {
  createRuntime?: RuntimeFactory;
  createRuntimeId?: () => string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class RuntimeServer {
  readonly runtime: SuoCodeRuntime;
  private readonly send: WireSink;
  private readonly options: SuoCodeRuntimeOptions;
  private readonly createRuntime: RuntimeFactory;
  private readonly createRuntimeId: () => string;
  private readonly runtimes = new Map<string, SuoCodeRuntime>();
  private readonly sessionPaths = new Map<string, string>();
  private defaultRuntimeId?: string;

  constructor(options: SuoCodeRuntimeOptions, send: WireSink, dependencies: RuntimeServerDependencies = {}) {
    this.send = send;
    this.options = options;
    this.createRuntime = dependencies.createRuntime ?? ((runtimeOptions) => new SuoCodeRuntime(runtimeOptions));
    this.createRuntimeId = dependencies.createRuntimeId ?? randomUUID;
    this.runtime = this.createManagedRuntime();
  }

  async handle(envelope: RuntimeCommandEnvelope): Promise<RuntimeResponseEnvelope> {
    try {
      const result = await this.dispatch(envelope.command, envelope.runtimeId);
      return { id: envelope.id, ok: true, result };
    } catch (error) {
      return { id: envelope.id, ok: false, error: errorMessage(error) };
    }
  }

  private createManagedRuntime(runtimeId?: string, modelRuntimePromise?: SuoCodeRuntimeOptions["modelRuntimePromise"]): SuoCodeRuntime {
    return this.createRuntime({
      ...this.options,
      modelRuntimePromise,
      onEvent: (event) => this.sendRuntimeEvent(runtimeId, event),
    });
  }

  private sendRuntimeEvent(runtimeId: string | undefined, event: RuntimeEvent): void {
    const scopedEvent = runtimeId && event.type === "session_snapshot"
      ? { ...event, snapshot: this.decorateSnapshot(runtimeId, event.snapshot) }
      : event;
    this.send(runtimeId ? { runtimeId, event: scopedEvent } : { event: scopedEvent });
  }

  private decorateSnapshot(runtimeId: string, snapshot: SessionSnapshot): SessionSnapshot {
    const decorated = { ...snapshot, runtimeId };
    if (snapshot.session.path) this.sessionPaths.set(resolve(snapshot.session.path), runtimeId);
    return decorated;
  }

  private runtimeById(runtimeId: string): SuoCodeRuntime {
    const runtime = this.runtimes.get(runtimeId);
    if (!runtime) throw new Error("所选会话运行时已失效，请重新打开会话。");
    return runtime;
  }

  private selectedRuntime(runtimeId?: string): SuoCodeRuntime {
    if (runtimeId) return this.runtimeById(runtimeId);
    if (this.defaultRuntimeId) return this.runtimeById(this.defaultRuntimeId);
    return this.runtime;
  }

  private async createSession(cwd: string): Promise<SessionSnapshot> {
    const runtimeId = this.createRuntimeId();
    const runtime = this.createManagedRuntime(runtimeId, this.runtime.sharedModelRuntime());
    this.runtimes.set(runtimeId, runtime);
    this.defaultRuntimeId = runtimeId;
    try {
      return this.decorateSnapshot(runtimeId, await runtime.createSession(cwd));
    } catch (error) {
      this.runtimes.delete(runtimeId);
      if (this.defaultRuntimeId === runtimeId) this.defaultRuntimeId = undefined;
      await runtime.dispose().catch(() => undefined);
      throw error;
    }
  }

  private async openSession(cwd: string, sessionPath: string): Promise<SessionSnapshot> {
    const normalizedPath = resolve(sessionPath);
    const existingId = this.sessionPaths.get(normalizedPath);
    if (existingId && this.runtimes.has(existingId)) {
      this.defaultRuntimeId = existingId;
      return this.decorateSnapshot(existingId, await this.runtimeById(existingId).snapshot());
    }

    const runtimeId = this.createRuntimeId();
    const runtime = this.createManagedRuntime(runtimeId, this.runtime.sharedModelRuntime());
    this.runtimes.set(runtimeId, runtime);
    this.defaultRuntimeId = runtimeId;
    try {
      return this.decorateSnapshot(runtimeId, await runtime.openSession(cwd, sessionPath));
    } catch (error) {
      this.runtimes.delete(runtimeId);
      if (this.defaultRuntimeId === runtimeId) this.defaultRuntimeId = undefined;
      await runtime.dispose().catch(() => undefined);
      throw error;
    }
  }

  private async releaseSession(sessionPath: string): Promise<void> {
    const normalizedPath = resolve(sessionPath);
    const runtimeId = this.sessionPaths.get(normalizedPath);
    if (!runtimeId) return;
    this.sessionPaths.delete(normalizedPath);
    const runtime = this.runtimes.get(runtimeId);
    this.runtimes.delete(runtimeId);
    if (this.defaultRuntimeId === runtimeId) this.defaultRuntimeId = this.runtimes.keys().next().value;
    await runtime?.dispose();
  }

  private async dispatch(command: RuntimeCommand, runtimeId?: string): Promise<unknown> {
    if (command.type === "create_session") return this.createSession(command.cwd);
    if (command.type === "open_session") return this.openSession(command.cwd, command.sessionPath);

    const alwaysControl = command.type === "bootstrap"
      || command.type === "list_sessions"
      || command.type === "list_archived_sessions"
      || command.type === "archive_session"
      || command.type === "restore_session";
    const runtime = alwaysControl ? this.runtime : this.selectedRuntime(runtimeId);
    const result = await this.dispatchTo(runtime, command);
    if (command.type === "archive_session") await this.releaseSession(command.sessionPath);
    return result;
  }

  private dispatchTo(runtime: SuoCodeRuntime, command: Exclude<RuntimeCommand, { type: "create_session" } | { type: "open_session" }>): Promise<unknown> {
    switch (command.type) {
      case "bootstrap":
        return runtime.initialize();
      case "get_configuration":
        return runtime.getConfiguration();
      case "configure_model":
        return runtime.configureModel(command);
      case "remove_provider_auth":
        return runtime.removeProviderAuth(command.provider);
      case "get_mcp_configuration":
        return runtime.getMcpConfiguration(command.cwd);
      case "get_mcp_status":
        return runtime.getMcpStatus();
      case "save_mcp_server":
        return runtime.saveMcpServer(command.server, command.previousName, command.cwd);
      case "remove_mcp_server":
        return runtime.removeMcpServer(command.name, command.scope, command.cwd);
      case "set_mcp_server_enabled":
        return runtime.setMcpServerEnabled(command.name, command.enabled, command.cwd);
      case "enable_mcp_imports":
        return runtime.enableMcpImports(command.imports, command.cwd);
      case "connect_mcp_server":
        return runtime.connectMcpServer(command.name);
      case "start_mcp_auth":
        return runtime.startMcpAuth(command.name);
      case "complete_mcp_auth":
        return runtime.completeMcpAuth(command.name, command.input);
      case "logout_mcp_server":
        return runtime.logoutMcpServer(command.name);
      case "stop_subagent":
        return runtime.stopSubagent(command.id, command.background);
      case "list_sessions":
        return runtime.listSessions(command.cwd);
      case "list_archived_sessions":
        return runtime.listArchivedSessions(command.cwd);
      case "archive_session":
        return runtime.archiveSession(command.cwd, command.sessionPath);
      case "restore_session":
        return runtime.restoreSession(command.cwd, command.sessionPath);
      case "prompt":
        return runtime.prompt(command.text, command.images);
      case "rewind_prompt":
        return runtime.rewindPrompt(command.entryId, command.text, command.images);
      case "steer":
        return runtime.steer(command.text, command.images);
      case "abort":
        return runtime.abort();
      case "refresh_project":
        return runtime.refreshProject();
      case "list_directory":
        return runtime.listProjectDirectory(command.path);
      case "read_file":
        return runtime.readProjectFile(command.path, command.maxBytes);
    }
  }

  async receive(value: unknown): Promise<void> {
    if (!isRuntimeCommandEnvelope(value)) return;
    this.send(await this.handle(value));
  }

  async warmup(): Promise<void> {
    await this.runtime.initialize();
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([
      this.runtime.dispose(),
      ...[...this.runtimes.values()].map((runtime) => runtime.dispose()),
    ]);
    this.runtimes.clear();
    this.sessionPaths.clear();
    this.defaultRuntimeId = undefined;
  }
}

export function runtimeOptionsFromEnvironment(): SuoCodeRuntimeOptions {
  const agentDir = process.env.SUOCODE_AGENT_DIR;
  const sessionDir = process.env.SUOCODE_SESSION_DIR;
  if (!agentDir || !sessionDir) {
    throw new Error("SUOCODE_AGENT_DIR and SUOCODE_SESSION_DIR are required.");
  }
  return {
    agentDir,
    sessionDir,
    workflowDir: process.env.SUOCODE_WORKFLOW_DIR,
    legacyAgentDir: process.env.SUOCODE_LEGACY_AGENT_DIR,
  };
}

export function attachProcessIpc(options = runtimeOptionsFromEnvironment()): RuntimeServer {
  if (typeof process.send !== "function") throw new Error("The runtime process requires an IPC channel.");
  const server = new RuntimeServer(options, (message) => process.send?.(message));
  void server.warmup().catch((error) => {
    process.stderr.write(`[suocode-runtime] warmup failed: ${errorMessage(error)}\n`);
  });
  process.on("message", (message) => {
    void server.receive(message);
  });
  const shutdown = (): void => {
    void server.dispose().finally(() => process.exit(0));
  };
  process.once("disconnect", shutdown);
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return server;
}

export function attachJsonlStdio(options = runtimeOptionsFromEnvironment()): RuntimeServer {
  const server = new RuntimeServer(options, (message) => {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  });
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    try {
      void server.receive(JSON.parse(line));
    } catch (error) {
      process.stdout.write(
        `${JSON.stringify({ id: "invalid", ok: false, error: `Invalid JSON: ${errorMessage(error)}` })}\n`,
      );
    }
  });
  input.once("close", () => {
    void server.dispose();
  });
  return server;
}
