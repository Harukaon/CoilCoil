import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IPty } from "node-pty";
import { spawn } from "node-pty";
import type {
  CreateTerminalInput,
  DesktopTerminalEvent,
  DesktopTerminalSession,
  TerminalLaunchKind,
} from "../shared/desktop-api";

const require = createRequire(import.meta.url);
const MAX_BUFFER_LENGTH = 1024 * 1024;

interface TerminalRecord {
  session: DesktopTerminalSession;
  pty: IPty;
}

interface PiResources {
  cliPath: string;
  extensions: string[];
  skills: string[];
  prompts: string[];
}

function packageDirectory(name: string): string {
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    // Packages with export maps often hide package.json; resolve their ESM entry instead.
  }
  let entryPath: string;
  try {
    entryPath = require.resolve(name);
  } catch {
    entryPath = fileURLToPath(import.meta.resolve(name));
  }
  let directory = dirname(entryPath);
  while (directory !== dirname(directory)) {
    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name?: string };
      if (manifest.name === name) return directory;
    }
    directory = dirname(directory);
  }
  throw new Error(`无法定位内置依赖：${name}`);
}

function packageResources(name: string): { extensions: string[]; skills: string[]; prompts: string[] } {
  const directory = packageDirectory(name);
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
    pi?: { extensions?: string[]; skills?: string[]; prompts?: string[] };
  };
  return {
    extensions: (manifest.pi?.extensions ?? []).map((value) => resolve(directory, value)),
    skills: (manifest.pi?.skills ?? []).map((value) => resolve(directory, value)),
    prompts: (manifest.pi?.prompts ?? []).map((value) => resolve(directory, value)),
  };
}

function bundledPiResources(): PiResources {
  const codingAgentDirectory = packageDirectory("@earendil-works/pi-coding-agent");
  const resources = [packageResources("@suocode/workflow"), packageResources("pi-subagents")];
  return {
    cliPath: join(codingAgentDirectory, "dist", "cli.js"),
    extensions: resources.flatMap((entry) => entry.extensions),
    skills: resources.flatMap((entry) => entry.skills),
    prompts: resources.flatMap((entry) => entry.prompts),
  };
}

function terminalTitle(kind: TerminalLaunchKind, sequence: number): string {
  const label = kind === "shell" ? "终端" : kind === "pi" ? "SuoCode Pi" : kind === "claude" ? "Claude Code" : "Codex";
  return `${label} ${sequence}`;
}

function sanitizeDimension(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(2, Math.min(500, Math.floor(value ?? fallback)));
}

function loginShell(): string {
  if (process.platform === "win32") return process.env.COMSPEC || "powershell.exe";
  return process.env.SHELL || (existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash");
}

function shellArguments(kind: TerminalLaunchKind): string[] {
  if (kind === "shell") return process.platform === "win32" ? [] : ["-l"];
  const command = kind === "claude" ? "claude" : "codex";
  if (process.platform === "win32") {
    return basename(loginShell()).toLowerCase().includes("powershell")
      ? ["-NoLogo", "-NoExit", "-Command", command]
      : ["/K", command];
  }
  return ["-lic", `exec ${command}`];
}

export class TerminalManager {
  private readonly records = new Map<string, TerminalRecord>();
  private sequence = 0;
  private piResources?: PiResources;

  constructor(
    private readonly userDataDirectory: string,
    private readonly nodeExecutable: string,
    private readonly emit: (event: DesktopTerminalEvent) => void,
  ) {}

  list(): DesktopTerminalSession[] {
    return [...this.records.values()]
      .map((record) => ({ ...record.session }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  private async safeDirectory(value: string): Promise<string> {
    if (typeof value !== "string" || !value.trim()) throw new Error("终端缺少工作目录。");
    const path = await realpath(value);
    if (!(await stat(path)).isDirectory()) throw new Error("终端工作目录不是文件夹。");
    return path;
  }

  async create(input: CreateTerminalInput): Promise<DesktopTerminalSession> {
    const cwd = await this.safeDirectory(input.cwd);
    const kind = input.kind;
    if (!["shell", "claude", "codex", "pi"].includes(kind)) throw new Error("不支持的终端启动类型。");
    const cols = sanitizeDimension(input.cols, 100);
    const rows = sanitizeDimension(input.rows, 30);
    const agentDir = join(this.userDataDirectory, "agent");
    const sessionDir = join(this.userDataDirectory, "sessions");
    await Promise.all([mkdir(agentDir, { recursive: true }), mkdir(sessionDir, { recursive: true })]);

    let executable = loginShell();
    let args = shellArguments(kind);
    const env: Record<string, string | undefined> = {
      ...process.env,
      TERM: process.env.TERM || "xterm-256color",
      COLORTERM: process.env.COLORTERM || "truecolor",
    };
    if (kind === "pi") {
      this.piResources ??= bundledPiResources();
      executable = this.nodeExecutable;
      args = [
        this.piResources.cliPath,
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--exclude-tools",
        "find",
        ...this.piResources.extensions.flatMap((path) => ["--extension", path]),
        ...this.piResources.skills.flatMap((path) => ["--skill", path]),
        ...this.piResources.prompts.flatMap((path) => ["--prompt-template", path]),
      ];
      env.ELECTRON_RUN_AS_NODE = "1";
      env.PI_CODING_AGENT_DIR = agentDir;
      env.SUOCODE_AGENT_DIR = agentDir;
      env.SUOCODE_SESSION_DIR = sessionDir;
      env.SUOCODE_NODE_EXEC_PATH = this.nodeExecutable;
      env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT = packageDirectory("@earendil-works/pi-coding-agent");
      env.PI_MEMORY_WORKER_ENTRY = this.piResources.cliPath;
    }

    const pty = spawn(executable, args, {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env,
      encoding: "utf8",
      ...(process.platform === "win32" ? { useConpty: true } : {}),
    });
    const id = randomUUID();
    const session: DesktopTerminalSession = {
      id,
      cwd,
      title: terminalTitle(kind, ++this.sequence),
      kind,
      pid: pty.pid,
      running: true,
      createdAt: Date.now(),
      buffer: "",
    };
    this.records.set(id, { session, pty });
    pty.onData((data) => {
      const record = this.records.get(id);
      if (!record) return;
      record.session.buffer = `${record.session.buffer}${data}`.slice(-MAX_BUFFER_LENGTH);
      this.emit({ type: "data", id, data });
    });
    pty.onExit(({ exitCode, signal }) => {
      const record = this.records.get(id);
      if (!record) return;
      record.session.running = false;
      record.session.exitCode = exitCode;
      record.session.signal = signal;
      this.emit({ type: "exit", id, exitCode, signal });
    });
    this.emit({ type: "created", session: { ...session } });
    return { ...session };
  }

  write(id: string, data: string): void {
    const record = this.records.get(id);
    if (!record) throw new Error("终端会话不存在。");
    if (!record.session.running) throw new Error("终端进程已经退出。");
    if (typeof data !== "string" || data.length > 1024 * 1024) throw new Error("终端输入无效。");
    record.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const record = this.records.get(id);
    if (!record || !record.session.running) return;
    record.pty.resize(sanitizeDimension(cols, 100), sanitizeDimension(rows, 30));
  }

  close(id: string): void {
    const record = this.records.get(id);
    if (!record) return;
    this.records.delete(id);
    if (record.session.running) record.pty.kill();
    this.emit({ type: "closed", id });
  }

  stop(): void {
    for (const id of [...this.records.keys()]) this.close(id);
  }
}
