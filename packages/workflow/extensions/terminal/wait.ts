import type { ManagedTerminal, WaitOutcome } from "./types.ts";
import { isRunning, outputSince } from "./output.ts";

export async function waitForTerminalExit(
  session: ManagedTerminal,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<WaitOutcome> {
  if (!isRunning(session)) return "exit";
  if (timeoutMs <= 0) return "timeout";
  return new Promise<WaitOutcome>((resolveWait) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: WaitOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      session.listeners.delete(onChange);
      signal?.removeEventListener("abort", onAbort);
      resolveWait(outcome);
    };
    const onChange = (): void => {
      if (!isRunning(session)) finish("exit");
    };
    const onAbort = (): void => finish("aborted");
    timer = setTimeout(() => finish("timeout"), timeoutMs);
    session.listeners.add(onChange);
    signal?.addEventListener("abort", onAbort, { once: true });
    onChange();
  });
}

export async function waitForTerminal(
  session: ManagedTerminal,
  cursor: number,
  waitFor: string | undefined,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<WaitOutcome> {
  const check = (): WaitOutcome | undefined => {
    const output = outputSince(session, cursor);
    if (waitFor && output.includes(waitFor)) return "matched";
    if (!waitFor && output.length > 0) return "output";
    if (!isRunning(session)) return "exit";
    if (signal?.aborted) return "aborted";
    return undefined;
  };
  const immediate = check();
  if (immediate) return immediate;
  if (timeoutMs <= 0) return "timeout";
  return new Promise<WaitOutcome>((resolveWait) => {
    let settled = false;
    const finish = (outcome: WaitOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.listeners.delete(onChange);
      signal?.removeEventListener("abort", onAbort);
      resolveWait(outcome);
    };
    const onChange = (): void => {
      const outcome = check();
      if (outcome) finish(outcome);
    };
    const onAbort = (): void => finish("aborted");
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    session.listeners.add(onChange);
    signal?.addEventListener("abort", onAbort, { once: true });
    onChange();
  });
}

export async function waitForExit(session: ManagedTerminal, timeoutMs: number): Promise<boolean> {
  if (!isRunning(session)) return true;
  const outcome = await waitForTerminal(
    session,
    session.outputEnd,
    "\u0000__never_matches__",
    timeoutMs,
    undefined,
  );
  return outcome === "exit";
}
