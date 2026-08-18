import type { TerminalRun } from "@suocode/runtime-protocol";
import { isRecord, stringValue } from "./runtime-utils.js";

export const TERMINAL_RUN_ENTRY_TYPE = "suocode-terminal-run";

function resultDetails(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  return isRecord(value.details) ? value.details : value;
}

export function terminalIdFromResult(value: unknown): string | undefined {
  const details = resultDetails(value);
  return details ? stringValue(details.background_shell_id) || stringValue(details.id) || undefined : undefined;
}

export function terminalOutputFromResult(value: unknown): string | undefined {
  const details = resultDetails(value);
  return details && typeof details.output === "string" ? details.output : undefined;
}

export function terminalOwnerToolIdFromData(value: unknown): string | undefined {
  return isRecord(value) ? stringValue(value.ownerToolCallId) || undefined : undefined;
}

export function terminalStatusFromResult(
  value: unknown,
  isError: boolean,
): TerminalRun["status"] {
  if (isError) return "failed";
  const details = resultDetails(value);
  if (!details) return "succeeded";
  if (details.is_running_in_background === true) return "running";
  const status = stringValue(details.status);
  if (status === "running") return "running";
  if (status === "stopped") return "stopped";
  if (status === "failed" || status === "cleanup_failed") return "failed";
  return "succeeded";
}

export function terminalRunFromData(value: unknown): TerminalRun | undefined {
  if (!isRecord(value)) return undefined;
  const id = stringValue(value.id);
  const command = stringValue(value.command);
  const cwd = stringValue(value.cwd);
  const status = stringValue(value.status);
  const startedAt = typeof value.startedAt === "number" ? value.startedAt : undefined;
  if (!id || !command || !cwd || startedAt === undefined) return undefined;
  if (status !== "running" && status !== "succeeded" && status !== "failed" && status !== "stopped") return undefined;
  return {
    id,
    command,
    cwd,
    output: stringValue(value.output),
    status,
    startedAt,
    endedAt: typeof value.endedAt === "number" ? value.endedAt : undefined,
    exitCode: typeof value.exitCode === "number" ? value.exitCode : undefined,
  };
}
