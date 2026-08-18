import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CLEANUP_POLL_MS, CLEANUP_VERIFY_MS, type CleanupReport, type CleanupSignal, type ManagedTerminal, type ProcessRecord, type ProcessScan } from "./types.ts";
import { isRunning } from "./output.ts";
import { waitForExit } from "./wait.ts";

const execFileAsync = promisify(execFile);

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function processIsAlive(record: ProcessRecord | undefined): boolean {
  return record !== undefined && !record.state.includes("Z");
}

async function readProcessTable(): Promise<Map<number, ProcessRecord>> {
  if (process.platform === "win32") return new Map();
  const sessionKeyword = process.platform === "darwin" ? "sess" : "sid";
  const selection = process.platform === "darwin" ? "-axo" : "-eo";
  const { stdout } = await execFileAsync(
    "/bin/ps",
    [selection, `pid=,ppid=,pgid=,${sessionKeyword}=,stat=,tty=`],
    { encoding: "utf8", timeout: 2_000, maxBuffer: 10 * 1024 * 1024 },
  );
  const table = new Map<number, ProcessRecord>();
  for (const line of String(stdout).split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)/);
    if (!match) continue;
    const [, pid, ppid, pgid, sessionId, state, tty] = match;
    const record: ProcessRecord = {
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      sessionId: Number(sessionId),
      state,
      tty,
    };
    table.set(record.pid, record);
  }
  return table;
}

function processDepth(record: ProcessRecord, table: Map<number, ProcessRecord>, rootPid: number): number {
  let depth = 0;
  let current = record;
  const seen = new Set<number>();
  while (current.pid !== rootPid && current.ppid > 1 && !seen.has(current.pid)) {
    seen.add(current.pid);
    depth += 1;
    const parent = table.get(current.ppid);
    if (!parent) break;
    current = parent;
  }
  return depth;
}

function collectOwnedProcesses(
  table: Map<number, ProcessRecord>,
  rootPid: number,
  trackedPids: Set<number>,
  processSessionId: number | undefined,
  tty: string | undefined,
): ProcessRecord[] {
  const ownedPids = new Set<number>();
  const hasUsableSessionId = processSessionId !== undefined && processSessionId > 1;
  const hasUsableTty = tty !== undefined && tty !== "?" && tty !== "??";
  for (const record of table.values()) {
    if (
      record.pid !== rootPid
      && ((hasUsableSessionId && record.sessionId === processSessionId) || (hasUsableTty && record.tty === tty))
    ) ownedPids.add(record.pid);
  }
  for (const pid of trackedPids) if (pid !== rootPid && table.has(pid)) ownedPids.add(pid);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of table.values()) {
      if (record.pid === rootPid || record.pid <= 1 || record.pid === process.pid || ownedPids.has(record.pid)) continue;
      if (record.ppid === rootPid || ownedPids.has(record.ppid)) {
        ownedPids.add(record.pid);
        changed = true;
      }
    }
  }
  return [...ownedPids]
    .map((pid) => table.get(pid))
    .filter((record): record is ProcessRecord => processIsAlive(record))
    .sort((a, b) => processDepth(b, table, rootPid) - processDepth(a, table, rootPid));
}

export async function scanTerminalProcesses(
  session: ManagedTerminal,
  trackedPids: Set<number>,
): Promise<ProcessScan> {
  const table = await readProcessTable();
  const rootRecord = table.get(session.pid);
  if (rootRecord) {
    if (rootRecord.sessionId > 1) session.processSessionId = rootRecord.sessionId;
    if (rootRecord.tty !== "?" && rootRecord.tty !== "??") session.tty = rootRecord.tty;
  }
  const owned = collectOwnedProcesses(table, session.pid, trackedPids, session.processSessionId, session.tty);
  for (const record of owned) trackedPids.add(record.pid);
  return { table, owned, rootAlive: processIsAlive(table.get(session.pid)) };
}

function sendProcessSignal(pid: number, signal: CleanupSignal): boolean {
  if (pid <= 1 || pid === process.pid) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function sendRootSignal(session: ManagedTerminal, signal: "SIGTERM" | "SIGKILL"): boolean {
  if (sendProcessSignal(session.pid, signal)) return true;
  try {
    session.pty.kill(signal);
    return true;
  } catch {
    return false;
  }
}

function unixFallbackReport(force: boolean, error: unknown): CleanupReport {
  return {
    forceRequested: force,
    gracefulAttempted: !force,
    gracefulSucceeded: false,
    escalatedToSigkill: force,
    signal: force ? "SIGKILL" : undefined,
    descendantsFound: 0,
    targetedPids: [],
    terminatedPids: [],
    sigkillPids: [],
    residualPids: [],
    verified: false,
    enumerationError: error instanceof Error ? error.message : String(error),
  };
}

async function cleanupUnixTerminal(
  session: ManagedTerminal,
  force: boolean,
  timeoutMs: number,
): Promise<CleanupReport> {
  const trackedPids = new Set<number>();
  const targetedPids = new Set<number>();
  const termSignaledPids = new Set<number>();
  const sigkillTargetPids = new Set<number>();
  const startedAt = Date.now();
  let signalUsed: CleanupSignal | undefined;
  let latestScan: ProcessScan;
  const scanAndTrack = async (): Promise<ProcessScan> => {
    const scan = await scanTerminalProcesses(session, trackedPids);
    for (const record of scan.owned) targetedPids.add(record.pid);
    if (scan.rootAlive) targetedPids.add(session.pid);
    latestScan = scan;
    return scan;
  };
  try {
    latestScan = await scanAndTrack();
  } catch (error) {
    const report = unixFallbackReport(force, error);
    if (!force) {
      try {
        session.pty.write("\u0003");
        report.signal = "SIGINT";
      } catch {}
      await waitForExit(session, Math.min(750, timeoutMs));
      if (isRunning(session)) {
        sendRootSignal(session, "SIGTERM");
        report.signal = "SIGTERM";
        await waitForExit(session, Math.max(0, timeoutMs - 750));
      }
    }
    if (force || isRunning(session)) {
      sendRootSignal(session, "SIGKILL");
      report.escalatedToSigkill = true;
      report.signal = "SIGKILL";
      await waitForExit(session, CLEANUP_VERIFY_MS);
    }
    return report;
  }
  const signalNewDescendants = (scan: ProcessScan, signal: "SIGTERM" | "SIGKILL"): void => {
    for (const record of scan.owned) {
      targetedPids.add(record.pid);
      if (signal === "SIGTERM" && termSignaledPids.has(record.pid)) continue;
      if (!sendProcessSignal(record.pid, signal)) continue;
      if (signal === "SIGTERM") {
        termSignaledPids.add(record.pid);
        if (signalUsed !== "SIGKILL") signalUsed = "SIGTERM";
      } else {
        sigkillTargetPids.add(record.pid);
        signalUsed = "SIGKILL";
      }
    }
  };
  const pollUntil = async (deadline: number, signalNew: "SIGTERM" | "SIGKILL"): Promise<ProcessScan> => {
    let scan = await scanAndTrack();
    while (true) {
      signalNewDescendants(scan, signalNew);
      if (signalNew === "SIGKILL" && scan.rootAlive && sendRootSignal(session, "SIGKILL")) {
        sigkillTargetPids.add(session.pid);
        signalUsed = "SIGKILL";
      }
      if (scan.owned.length === 0 && !scan.rootAlive) return scan;
      if (Date.now() >= deadline) return scan;
      await delay(Math.min(CLEANUP_POLL_MS, deadline - Date.now()));
      scan = await scanAndTrack();
    }
  };
  if (force) {
    signalNewDescendants(latestScan, "SIGKILL");
    if (latestScan.rootAlive && sendRootSignal(session, "SIGKILL")) {
      sigkillTargetPids.add(session.pid);
      signalUsed = "SIGKILL";
    }
  } else {
    signalNewDescendants(latestScan, "SIGTERM");
    try {
      session.pty.write("\u0003");
      signalUsed ??= "SIGINT";
    } catch {}
    const interruptDeadline = Math.min(
      startedAt + timeoutMs,
      Date.now() + Math.min(1_000, Math.max(250, Math.floor(timeoutMs / 3))),
    );
    latestScan = await pollUntil(interruptDeadline, "SIGTERM");
    if (latestScan.rootAlive && sendRootSignal(session, "SIGTERM") && signalUsed !== "SIGKILL") signalUsed = "SIGTERM";
    latestScan = await pollUntil(startedAt + timeoutMs, "SIGTERM");
  }
  const aliveBeforeKill = new Set<number>([
    ...latestScan.owned.map((record) => record.pid),
    ...(latestScan.rootAlive ? [session.pid] : []),
  ]);
  let escalatedToSigkill = force || aliveBeforeKill.size > 0;
  if (!force && aliveBeforeKill.size > 0) {
    signalNewDescendants(latestScan, "SIGKILL");
    if (latestScan.rootAlive && sendRootSignal(session, "SIGKILL")) {
      sigkillTargetPids.add(session.pid);
      signalUsed = "SIGKILL";
    }
  }
  latestScan = await pollUntil(Date.now() + CLEANUP_VERIFY_MS, "SIGKILL");
  escalatedToSigkill ||= sigkillTargetPids.size > 0;
  const residualPids = new Set<number>([
    ...latestScan.owned.map((record) => record.pid),
    ...(latestScan.rootAlive ? [session.pid] : []),
  ]);
  const terminatedPids = [...targetedPids].filter((pid) => !sigkillTargetPids.has(pid) && !residualPids.has(pid));
  const sigkillPids = [...sigkillTargetPids].filter((pid) => !residualPids.has(pid));
  return {
    forceRequested: force,
    gracefulAttempted: !force,
    gracefulSucceeded: !force && !escalatedToSigkill && residualPids.size === 0,
    escalatedToSigkill,
    signal: signalUsed,
    descendantsFound: [...targetedPids].filter((pid) => pid !== session.pid).length,
    targetedPids: [...targetedPids].sort((a, b) => a - b),
    terminatedPids: terminatedPids.sort((a, b) => a - b),
    sigkillPids: sigkillPids.sort((a, b) => a - b),
    residualPids: [...residualPids].sort((a, b) => a - b),
    verified: true,
  };
}

async function cleanupWindowsTerminal(
  session: ManagedTerminal,
  force: boolean,
  timeoutMs: number,
): Promise<CleanupReport> {
  const report: CleanupReport = {
    forceRequested: force,
    gracefulAttempted: !force,
    gracefulSucceeded: false,
    escalatedToSigkill: force,
    signal: force ? "SIGKILL" : "SIGINT",
    descendantsFound: 0,
    targetedPids: [session.pid],
    terminatedPids: [],
    sigkillPids: [],
    residualPids: [],
    verified: false,
  };
  if (!force) {
    try { session.pty.write("\u0003"); } catch {}
    if (await waitForExit(session, Math.min(750, timeoutMs))) {
      report.gracefulSucceeded = true;
      report.terminatedPids = [session.pid];
      return report;
    }
  }
  try {
    await execFileAsync("taskkill", ["/PID", String(session.pid), "/T", "/F"], {
      timeout: Math.max(1_000, timeoutMs),
    });
    report.escalatedToSigkill = true;
    report.signal = "SIGKILL";
    report.sigkillPids = [session.pid];
    await waitForExit(session, CLEANUP_VERIFY_MS);
  } catch (error) {
    report.enumerationError = error instanceof Error ? error.message : String(error);
  }
  return report;
}

export async function stopTerminal(
  session: ManagedTerminal,
  force: boolean,
  timeoutMs: number,
): Promise<CleanupReport> {
  if (session.cleanup?.verified && session.cleanup.residualPids.length === 0) return session.cleanup;
  if (session.cleanupPromise) return session.cleanupPromise;
  session.stopRequested = true;
  const cleanup = process.platform === "win32"
    ? cleanupWindowsTerminal(session, force, timeoutMs)
    : cleanupUnixTerminal(session, force, timeoutMs);
  session.cleanupPromise = cleanup;
  try {
    const report = await cleanup;
    session.cleanup = report;
    await waitForExit(session, CLEANUP_VERIFY_MS);
    if (!report.verified || report.residualPids.length > 0) session.status = "cleanup_failed";
    else if (isRunning(session)) {
      session.status = "stopped";
      session.endedAt ??= Date.now();
    }
    return report;
  } finally {
    session.cleanupPromise = undefined;
  }
}

export function signalName(signal: number | undefined): string | undefined {
  if (!signal) return undefined;
  const known: Record<number, string> = {
    1: "SIGHUP", 2: "SIGINT", 3: "SIGQUIT", 6: "SIGABRT", 9: "SIGKILL", 15: "SIGTERM",
  };
  return known[signal] ?? `SIGNAL_${signal}`;
}
