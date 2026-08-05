#!/usr/bin/env node
import { SuoCodeRuntime } from "@suocode/runtime-core";
import type { RuntimeConfiguration, RuntimeEvent, ThinkingLevel } from "@suocode/runtime-protocol";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

interface CliOptions {
  cwd: string;
  fresh: boolean;
  help: boolean;
  version: boolean;
  provider?: string;
  modelId?: string;
  apiKey?: string;
  thinkingLevel: ThinkingLevel;
}

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const VERSION = "0.1.0";

function argumentValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  let cwd = process.cwd();
  let fresh = false;
  let help = false;
  let version = false;
  let provider: string | undefined;
  let modelId: string | undefined;
  let apiKey: string | undefined;
  let thinkingLevel: ThinkingLevel = "medium";

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") help = true;
    else if (value === "--version" || value === "-v") version = true;
    else if (value === "--new") fresh = true;
    else if (value === "--provider") provider = argumentValue(argv, index++, value);
    else if (value === "--model") modelId = argumentValue(argv, index++, value);
    else if (value === "--api-key") apiKey = argumentValue(argv, index++, value);
    else if (value === "--thinking") {
      const level = argumentValue(argv, index++, value);
      if (!THINKING_LEVELS.has(level as ThinkingLevel)) {
        throw new Error(`Invalid thinking level: ${level}`);
      }
      thinkingLevel = level as ThinkingLevel;
    }
    else if (value.startsWith("-")) throw new Error(`Unknown option: ${value}`);
    else if (!value.startsWith("-")) cwd = resolve(value);
  }
  if (Boolean(provider) !== Boolean(modelId)) {
    throw new Error("--provider and --model must be provided together.");
  }
  return { cwd, fresh, help, version, provider, modelId, apiKey: apiKey ?? process.env.SUOCODE_API_KEY, thinkingLevel };
}

function printHelp(): void {
  stdout.write(
    [
      `SuoCode ${VERSION}`,
      "",
      "Usage: suocode [project] [options]",
      "",
      "Options:",
      "  --new                        start with a fresh session",
      "  --provider <provider>        configure the initial provider",
      "  --model <model>              configure the initial model",
      "  --api-key <key>              provider API key (SUOCODE_API_KEY is preferred)",
      "  --thinking <level>           off|minimal|low|medium|high|xhigh|max",
      "  -h, --help                   show this help",
      "  -v, --version                show the version",
      "",
      "Commands:",
      "  /new                         start a new session",
      "  /sessions                    list saved sessions",
      "  /open <number>               open a listed session",
      "  /model <provider> <model>    select a model",
      "  /abort                       stop the current run",
      "  /help                        show this help",
      "  /exit                        quit SuoCode",
      "",
      "Messages entered while the Agent is running steer the current run.",
      "",
    ].join("\n"),
  );
}

function eventPrinter(event: RuntimeEvent): void {
  if (event.type === "message_delta" && event.field === "text") {
    stdout.write(event.delta);
  } else if (event.type === "tool_started") {
    stdout.write(`\n\x1b[2m› ${event.tool.label}\x1b[0m\n`);
  } else if (event.type === "message_finished" && event.message.role === "assistant") {
    stdout.write("\n");
  } else if (event.type === "runtime_error") {
    stdout.write(`\n\x1b[31m${event.message}\x1b[0m\n`);
  }
}

async function ensureModel(
  runtime: SuoCodeRuntime,
  configuration: RuntimeConfiguration,
  options: CliOptions,
): Promise<RuntimeConfiguration> {
  if (options.provider && options.modelId) {
    return runtime.configureModel({
      provider: options.provider,
      modelId: options.modelId,
      apiKey: options.apiKey,
      thinkingLevel: options.thinkingLevel,
    });
  }
  if (
    configuration.provider &&
    configuration.modelId &&
    configuration.configuredProviders.includes(configuration.provider)
  ) {
    return configuration;
  }

  const configuredModel = configuration.models.find((model) => model.configured);
  if (configuredModel) {
    return runtime.configureModel({
      provider: configuredModel.provider,
      modelId: configuredModel.id,
      thinkingLevel: options.thinkingLevel,
    });
  }

  throw new Error(
    "No model credential is configured. Run with --provider, --model and --api-key, or configure SuoCode Desktop first.",
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  if (options.version) {
    stdout.write(`${VERSION}\n`);
    return;
  }
  if (!existsSync(options.cwd)) throw new Error(`Project does not exist: ${options.cwd}`);
  const dataRoot = resolve(process.env.SUOCODE_DATA_DIR ?? join(homedir(), ".suocode"));
  let running = false;
  const runtime = new SuoCodeRuntime({
    agentDir: join(dataRoot, "agent"),
    sessionDir: join(dataRoot, "sessions"),
    onEvent: (event) => {
      eventPrinter(event);
      if (event.type === "run_state") running = event.running;
    },
  });
  const terminal = createInterface({ input: stdin, output: stdout });

  try {
    const bootstrap = await runtime.initialize();
    await ensureModel(runtime, bootstrap.configuration, options);
    let sessions = await runtime.listSessions(options.cwd);
    if (!options.fresh && sessions[0]) await runtime.openSession(options.cwd, sessions[0].path);
    else await runtime.createSession(options.cwd);

    stdout.write(`\nSuoCode · ${basename(options.cwd)}\nType /help for commands.\n\n`);
    for (;;) {
      const input = (await terminal.question(running ? "↳ " : "› ")).trim();
      if (!input) continue;
      if (input === "/exit" || input === "/quit") break;
      if (input === "/help") {
        printHelp();
        continue;
      }
      if (input === "/new") {
        await runtime.createSession(options.cwd);
        stdout.write("Started a new session.\n");
        continue;
      }
      if (input === "/sessions") {
        sessions = await runtime.listSessions(options.cwd);
        sessions.forEach((session, index) => stdout.write(`${index + 1}. ${session.title}\n`));
        continue;
      }
      if (input.startsWith("/open ")) {
        sessions = await runtime.listSessions(options.cwd);
        const index = Number.parseInt(input.slice(6).trim(), 10) - 1;
        const selected = sessions[index];
        if (!selected) stdout.write("Session not found.\n");
        else await runtime.openSession(options.cwd, selected.path);
        continue;
      }
      if (input.startsWith("/model ")) {
        const [provider, modelId] = input.slice(7).trim().split(/\s+/, 2);
        if (!provider || !modelId) stdout.write("Usage: /model <provider> <model>\n");
        else await runtime.configureModel({ provider, modelId, thinkingLevel: options.thinkingLevel });
        continue;
      }
      if (input === "/abort") {
        await runtime.abort();
        continue;
      }

      const wasRunning = running;
      await runtime.prompt(input);
      running = true;
      if (!wasRunning) stdout.write("\x1b[2mType a message to steer, or /abort to stop.\x1b[0m\n");
    }
  } finally {
    terminal.close();
    await runtime.dispose();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`SuoCode: ${message}\n`);
  process.exitCode = 1;
});
