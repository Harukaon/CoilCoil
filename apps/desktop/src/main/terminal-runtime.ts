import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { spawn, type IPty } from "node-pty";
import type { TerminalSessionSnapshot } from "../shared/desktop-api";

const MAX_TERMINAL_OUTPUT = 500_000;

interface TerminalRecord {
  pty: IPty;
  snapshot: TerminalSessionSnapshot;
}

export class TerminalRuntimeManager {
  private readonly records = new Map<string, TerminalRecord>();
  private readonly onState: (state: TerminalSessionSnapshot[]) => void;
  private readonly onData: (id: string, data: string) => void;

  constructor(onState: (state: TerminalSessionSnapshot[]) => void, onData: (id: string, data: string) => void) {
    this.onState = onState;
    this.onData = onData;
  }

  state(): TerminalSessionSnapshot[] {
    return [...this.records.values()]
      .map((record) => ({ ...record.snapshot }))
      .sort((left, right) => left.startedAt - right.startedAt);
  }

  create(cwd: string): TerminalSessionSnapshot[] {
    const resolvedCwd = resolve(cwd);
    const running = [...this.records.values()].find((record) => (
      record.snapshot.cwd === resolvedCwd && record.snapshot.status === "running"
    ));
    if (running) return this.state();
    if (!existsSync(resolvedCwd) || !statSync(resolvedCwd).isDirectory()) {
      throw new Error("终端工作目录不存在。");
    }
    const id = randomUUID();
    const shell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : process.env.SHELL || "/bin/zsh";
    const snapshot: TerminalSessionSnapshot = {
      id,
      cwd: resolvedCwd,
      output: "",
      status: "running",
      startedAt: Date.now(),
    };
    const pty = spawn(shell, process.platform === "win32" ? [] : ["-l"], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: resolvedCwd,
      env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
    });
    const record: TerminalRecord = { pty, snapshot };
    this.records.set(id, record);
    pty.onData((data) => {
      snapshot.output = `${snapshot.output}${data}`.slice(-MAX_TERMINAL_OUTPUT);
      this.onData(id, data);
    });
    pty.onExit(({ exitCode }) => {
      if (this.records.get(id) !== record) return;
      snapshot.status = "exited";
      snapshot.endedAt = Date.now();
      snapshot.exitCode = exitCode;
      this.publish();
    });
    this.publish();
    return this.state();
  }

  write(id: string, data: string): void {
    const record = this.records.get(id);
    if (record?.snapshot.status === "running") record.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    const record = this.records.get(id);
    if (record?.snapshot.status !== "running") return;
    record.pty.resize(Math.max(20, Math.floor(cols)), Math.max(4, Math.floor(rows)));
  }

  close(id: string): TerminalSessionSnapshot[] {
    const record = this.records.get(id);
    if (!record) return this.state();
    this.records.delete(id);
    if (record.snapshot.status === "running") record.pty.kill();
    this.publish();
    return this.state();
  }

  dispose(): void {
    for (const record of this.records.values()) {
      if (record.snapshot.status === "running") record.pty.kill();
    }
    this.records.clear();
  }

  private publish(): void {
    this.onState(this.state());
  }
}
