import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManagedTerminal } from "./types.ts";
import { isRunning } from "./output.ts";
import { signalName } from "./process-cleanup.ts";

export function serializeSession(session: ManagedTerminal): Record<string, unknown> {
  const normalizedSignal = signalName(session.signal);
  const running = isRunning(session);
  return {
    id: session.id,
    background_shell_id: session.id,
    name: session.name,
    pid: session.pid,
    status: session.status,
    background: session.background,
    is_running_in_background: running && session.background,
    running_for_ms: (session.endedAt ?? Date.now()) - session.startedAt,
    cwd: session.cwd,
    command: session.command,
    startedAt: new Date(session.startedAt).toISOString(),
    endedAt: session.endedAt ? new Date(session.endedAt).toISOString() : undefined,
    exitCode: normalizedSignal ? null : session.exitCode,
    signal: normalizedSignal,
    rawSignal: session.signal || undefined,
    cleanup: session.cleanup,
    outputMode: session.outputMode,
    output_location: session.outputPath,
    secretHandles: session.secretHandles,
    cursor: session.outputEnd,
  };
}

export function outputPathFor(id: string): string {
  const root = process.env.PI_CODING_AGENT_DIR?.trim()
    || join(tmpdir(), "suocode", String(process.pid));
  const directory = join(root, "terminal-output");
  mkdirSync(directory, { recursive: true });
  return join(directory, `${id}.log`);
}

export function toolResult(details: unknown): {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
} {
  return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
}
