import { SuoCodeRuntime, type SuoCodeRuntimeOptions } from "@suocode/runtime-core";
import {
  isRuntimeCommandEnvelope,
  type RuntimeCommand,
  type RuntimeCommandEnvelope,
  type RuntimeResponseEnvelope,
  type RuntimeWireMessage,
} from "@suocode/runtime-protocol";
import { createInterface } from "node:readline";

type WireSink = (message: RuntimeWireMessage) => void;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class RuntimeServer {
  readonly runtime: SuoCodeRuntime;
  private readonly send: WireSink;

  constructor(options: SuoCodeRuntimeOptions, send: WireSink) {
    this.send = send;
    this.runtime = new SuoCodeRuntime({
      ...options,
      onEvent: (event) => this.send({ event }),
    });
  }

  async handle(envelope: RuntimeCommandEnvelope): Promise<RuntimeResponseEnvelope> {
    try {
      const result = await this.dispatch(envelope.command);
      return { id: envelope.id, ok: true, result };
    } catch (error) {
      return { id: envelope.id, ok: false, error: errorMessage(error) };
    }
  }

  private dispatch(command: RuntimeCommand): Promise<unknown> {
    switch (command.type) {
      case "bootstrap":
        return this.runtime.initialize();
      case "get_configuration":
        return this.runtime.getConfiguration();
      case "configure_model":
        return this.runtime.configureModel(command);
      case "remove_provider_auth":
        return this.runtime.removeProviderAuth(command.provider);
      case "get_mcp_configuration":
        return this.runtime.getMcpConfiguration(command.cwd);
      case "save_mcp_server":
        return this.runtime.saveMcpServer(command.server, command.previousName, command.cwd);
      case "remove_mcp_server":
        return this.runtime.removeMcpServer(command.name, command.cwd);
      case "enable_mcp_imports":
        return this.runtime.enableMcpImports(command.imports, command.cwd);
      case "stop_subagent":
        return this.runtime.stopSubagent(command.id, command.background);
      case "list_sessions":
        return this.runtime.listSessions(command.cwd);
      case "list_archived_sessions":
        return this.runtime.listArchivedSessions(command.cwd);
      case "archive_session":
        return this.runtime.archiveSession(command.cwd, command.sessionPath);
      case "restore_session":
        return this.runtime.restoreSession(command.cwd, command.sessionPath);
      case "create_session":
        return this.runtime.createSession(command.cwd);
      case "open_session":
        return this.runtime.openSession(command.cwd, command.sessionPath);
      case "prompt":
        return this.runtime.prompt(command.text, command.images);
      case "rewind_prompt":
        return this.runtime.rewindPrompt(command.entryId, command.text, command.images);
      case "steer":
        return this.runtime.steer(command.text, command.images);
      case "abort":
        return this.runtime.abort();
      case "refresh_project":
        return this.runtime.refreshProject();
      case "list_directory":
        return this.runtime.listProjectDirectory(command.path);
      case "read_file":
        return this.runtime.readProjectFile(command.path, command.maxBytes);
    }
  }

  async receive(value: unknown): Promise<void> {
    if (!isRuntimeCommandEnvelope(value)) return;
    this.send(await this.handle(value));
  }

  async dispose(): Promise<void> {
    await this.runtime.dispose();
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
