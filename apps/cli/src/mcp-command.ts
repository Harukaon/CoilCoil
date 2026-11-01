import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseMcpAccessRequest } from "@coilcoil/runtime-protocol";
import { discoverLocalMcpInstances, requestLocalMcp } from "@coilcoil/runtime-server/local-mcp-client";
import { MCP_DOCS } from "./mcp-docs.js";

export const MCP_HELP = `Usage: coilcoil mcp <command> [options]

Commands:
  docs                            Print a short integration guide (no runtime required)
  instances                       List running CoilCoil processes
  contexts                        List open session runtime IDs and workspaces
  list                            List configured, enabled MCP servers
  tools <server>                  List one server's tools and input schemas
  call <server> <tool>             Call a tool and return its original MCP result

Options:
  --cwd <directory>               Workspace (defaults to the current directory)
  --instance <id>                 Select a process from 'instances' (required if several run)
  --runtime-id <id>               Select a session from 'contexts'
  --args <json>                   Tool arguments as a JSON object (default: {})
  --args-file <path|->            Read arguments from a file or standard input
  --timeout <milliseconds>        Request timeout (default: 300000)
  -h, --help                      Show this help

MCP access requires a running CoilCoil Desktop or CLI. docs and --help print text;
other commands return JSON on stdout. Errors are JSON on stderr with a nonzero
exit code. Credentials stay in the owning runtime. An MCP call returning isError
also sets a nonzero exit code.

Desktop browser: tools coilcoil-browser; call coilcoil-browser list_pages.
Browser calls require an open desktop window. See docs for workspace/session selection.
`;

export function parseMcpCommand(argv: string[]) {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  const supported = new Set(["--cwd", "--instance", "--runtime-id", "--args", "--args-file", "--timeout"]);
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--help" || value === "-h") return { help: true as const };
    if (value.startsWith("--")) {
      if (!supported.has(value)) throw new Error(`Unknown MCP option: ${value}`);
      const argument = argv[++index];
      if (!argument || argument.startsWith("--") || flags.has(value)) throw new Error(`Provide ${value} once with a value.`);
      flags.set(value, argument);
    } else if (value.startsWith("-")) throw new Error(`Unknown MCP option: ${value}`);
    else positional.push(value);
  }
  const [action, server, tool] = positional;
  if (!action) return { help: true as const };
  const expected = action === "call" ? 3 : action === "tools" ? 2 : 1;
  if (!["docs", "instances", "contexts", "list", "tools", "call"].includes(action) || positional.length !== expected) {
    throw new Error("Usage: coilcoil mcp docs|instances|contexts|list|tools <server>|call <server> <tool>");
  }
  if (flags.has("--args") && flags.has("--args-file")) throw new Error("Use --args or --args-file once.");
  if (action !== "call" && (flags.has("--args") || flags.has("--args-file"))) throw new Error("Tool arguments require the call command.");
  const timeout = Number(flags.get("--timeout") ?? 300_000);
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 2_147_483_647) throw new Error("--timeout must be 1..2147483647 milliseconds.");
  const argsFile = flags.get("--args-file");
  const argsText = argsFile ? readFileSync(argsFile === "-" ? 0 : argsFile, "utf8") : flags.get("--args") ?? "{}";
  const request = action === "instances" || action === "docs" ? undefined : parseMcpAccessRequest({
    action, server, tool, args: action === "call" ? JSON.parse(argsText) : undefined,
    cwd: resolve(flags.get("--cwd") ?? process.cwd()), runtimeId: flags.get("--runtime-id"),
  });
  return { help: false as const, action, request, instanceId: flags.get("--instance"), timeout };
}

export async function runMcpCommand(argv: string[]): Promise<void> {
  const options = parseMcpCommand(argv);
  if (options.help) { process.stdout.write(MCP_HELP); return; }
  if (options.action === "docs") { process.stdout.write(MCP_DOCS); return; }
  const instances = await discoverLocalMcpInstances();
  if (options.action === "instances") {
    process.stdout.write(`${JSON.stringify({ instances: instances.map(({ instanceId, pid, dataDir }) => ({ instanceId, pid, dataDir })) })}\n`);
    return;
  }
  const selected = options.instanceId ? instances.filter((entry) => entry.instanceId === options.instanceId || String(entry.pid) === options.instanceId) : instances;
  if (!selected.length) throw new Error(options.instanceId ? "没有找到指定的运行时，请运行 coilcoil mcp instances。" : "未找到运行中的 CoilCoil。请启动更新后的 CoilCoil Desktop 或 CLI。");
  if (selected.length !== 1) throw new Error("发现多个 CoilCoil 运行时。请用 coilcoil mcp instances 查看，再用 --instance <id> 选择。");
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("MCP 请求已中断。"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(options.timeout)]);
    const result = await requestLocalMcp(selected[0], options.request!, signal);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result && typeof result === "object") {
      const value = result as { isError?: boolean; status?: string };
      if (value.isError || value.status && value.status !== "connected") process.exitCode = 1;
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

export function reportMcpError(error: unknown): void {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exitCode = 1;
}
