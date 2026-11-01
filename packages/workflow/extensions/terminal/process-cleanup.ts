import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CLEANUP_POLL_MS, CLEANUP_VERIFY_MS, type CleanupReport, type CleanupSignal, type ManagedTerminal, type ProcessIdentity, type ProcessRecord, type ProcessScan } from "./types.ts";
import { isRunning } from "./output.ts";
import { waitForExit } from "./wait.ts";

const execFileAsync = promisify(execFile);

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function processIsAlive(record: ProcessRecord | undefined): boolean {
  return record !== undefined && !record.state.includes("Z");
}

/** Darwin's `sess` is a masked kernel pointer, not a POSIX session id. */
export function parseProcessTable(output: string): Map<number, ProcessRecord> {
  const table = new Map<number, ProcessRecord>();
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+?)\s*$/);
    if (!match) throw new Error("无法解析终端进程身份。");
    const [, pid, ppid, pgid, state, tty, rawBirth] = match;
    const birth = rawBirth.replace(/\s+/g, " ").trim();
    if (!Number.isFinite(Date.parse(`${birth} UTC`))) throw new Error("无法读取终端进程创建时间。");
    table.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), state, tty, birth });
  }
  return table;
}

async function readProcessTable(pids?: number[]): Promise<Map<number, ProcessRecord>> {
  if (process.platform === "win32" || pids?.length === 0) return new Map();
  const selection = pids ? ["-p", pids.join(","), "-o"] : [process.platform === "darwin" ? "-axo" : "-eo"];
  try {
    const { stdout } = await execFileAsync("/bin/ps", [...selection, "pid=,ppid=,pgid=,stat=,tty=,lstart="], {
      encoding: "utf8", timeout: 2_000, maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    });
    return parseProcessTable(String(stdout));
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    // ps uses exit 1 when all explicitly selected processes have already exited.
    if (pids && failure.code === 1 && !failure.stdout?.trim() && !failure.stderr?.trim()) return new Map();
    throw error;
  }
}

function sameProcess(record: ProcessRecord, identity: ProcessIdentity): boolean {
  return record.pid === identity.pid && record.birth === identity.birth
    && record.pgid === identity.pgid && record.tty === identity.tty;
}

function processIdentity(record: ProcessRecord): ProcessIdentity {
  return { pid: record.pid, birth: record.birth, pgid: record.pgid, tty: record.tty };
}

export function initialRootIdentity(root: ProcessRecord | undefined, pid: number, startedAt: number, exited: boolean): ProcessIdentity | undefined {
  if (exited || !processIsAlive(root) || root!.pid !== pid || root!.ppid !== process.pid || root!.pgid !== pid
    || root!.tty === "?" || root!.tty === "??") return undefined;
  // The spawn helper can appear before acquiring its controlling TTY. Wait for
  // that transition instead of freezing its temporary "??" terminal identity.
  const bornAt = Date.parse(`${root!.birth} UTC`);
  return Math.abs(bornAt - startedAt) < 1_000 ? processIdentity(root!) : undefined;
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

/** Only a verified process generation may seed the descendant walk. */
export function collectOwnedProcesses(
  table: Map<number, ProcessRecord>,
  rootPid: number,
  rootIdentity: ProcessIdentity | undefined,
  descendants: ReadonlyMap<number, ProcessIdentity>,
  rootExited = false,
): ProcessScan {
  const ownedPids = new Set<number>();
  const unverifiedPids = new Set<number>();
  const root = table.get(rootPid);
  const rootAlive = processIsAlive(root) && !rootExited && rootIdentity !== undefined && sameProcess(root!, rootIdentity);
  if (processIsAlive(root) && !rootAlive && !(rootExited && rootIdentity && sameProcess(root!, rootIdentity))) unverifiedPids.add(rootPid);
  for (const [pid, identity] of descendants) {
    if (pid <= 1 || pid === process.pid || pid === rootPid) continue;
    const record = table.get(pid);
    if (!processIsAlive(record)) continue;
    if (sameProcess(record!, identity)) ownedPids.add(pid);
    else unverifiedPids.add(pid);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of table.values()) {
      if (!processIsAlive(record) || record.pid <= 1 || record.pid === process.pid || record.pid === rootPid
        || ownedPids.has(record.pid)) continue;
      if ((rootAlive && record.ppid === rootPid) || ownedPids.has(record.ppid)) {
        ownedPids.add(record.pid);
        unverifiedPids.delete(record.pid); // Its current parent chain independently proves ownership.
        changed = true;
      }
    }
  }
  const owned = [...ownedPids].map((pid) => table.get(pid)!)
    .sort((a, b) => processDepth(b, table, rootPid) - processDepth(a, table, rootPid));
  return { table, owned, rootAlive, unverifiedPids: [...unverifiedPids] };
}

export function scanTerminalProcesses(
  session: ManagedTerminal,
  trackedPids: Set<number>,
  readTable: (pids?: number[]) => Promise<Map<number, ProcessRecord>> = readProcessTable,
): Promise<ProcessScan> {
  // Initial discovery and Stop can arrive together. Share one observation so a
  // slower, older ps result cannot replace identities already learned by Stop.
  const pending = session.processScanPromise ??= scanTerminalProcessesNow(session, readTable).finally(() => {
    session.processScanPromise = undefined;
  });
  return pending.then((scan) => {
    for (const record of scan.owned) trackedPids.add(record.pid);
    return scan;
  });
}

async function scanTerminalProcessesNow(
  session: ManagedTerminal,
  readTable: (pids?: number[]) => Promise<Map<number, ProcessRecord>>,
): Promise<ProcessScan> {
  let table = await readTable();
  let root = table.get(session.pid);
  if (!session.processIdentity) {
    const deadline = Date.now() + 250;
    while (true) {
      session.processIdentity ??= initialRootIdentity(root, session.pid, session.startedAt, session.endedAt !== undefined);
      if (session.processIdentity || session.endedAt !== undefined || !processIsAlive(root) || root!.ppid !== process.pid
        || (root!.tty !== "?" && root!.tty !== "??") || Date.now() >= deadline) break;
      await delay(10);
      table = await readTable();
      root = table.get(session.pid);
    }
    if (session.processIdentity) session.tty = session.processIdentity.tty;
  }
  if (session.endedAt !== undefined && processIsAlive(root)) {
    // onExit may arrive while ps is returning a snapshot taken just before exit.
    const currentRoot = (await readTable([session.pid])).get(session.pid);
    if (currentRoot) table.set(session.pid, currentRoot);
    else table.delete(session.pid);
  }
  const descendants = session.processDescendants ??= new Map<number, ProcessIdentity>();
  const scan = collectOwnedProcesses(table, session.pid, session.processIdentity, descendants, session.endedAt !== undefined);
  for (const record of scan.owned) {
    descendants.set(record.pid, processIdentity(record));
  }
  return scan;
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

function unixFallbackReport(force: boolean, error: unknown): CleanupReport {
  return {
    forceRequested: force, gracefulAttempted: false, gracefulSucceeded: false,
    escalatedToSigkill: false, descendantsFound: 0, targetedPids: [], terminatedPids: [],
    sigkillPids: [], residualPids: [], verified: false,
    enumerationError: error instanceof Error ? error.message : String(error),
  };
}

async function cleanupUnixTerminal(session: ManagedTerminal, force: boolean, timeoutMs: number): Promise<CleanupReport> {
  const trackedPids = new Set<number>();
  const targetedPids = new Set<number>();
  const termSignaledPids = new Set<number>();
  const sigkillTargetPids = new Set<number>();
  const unverifiedPids = new Set<number>();
  const enumerationErrors = new Set<string>();
  const startedAt = Date.now();
  let signalUsed: CleanupSignal | undefined;
  let latestScan: ProcessScan;
  const recordEnumerationFailure = (error: unknown): void => {
    enumerationErrors.add(error instanceof Error ? error.message : String(error));
  };
  const scanAndTrack = async (): Promise<ProcessScan> => {
    try {
      const scan = await scanTerminalProcesses(session, trackedPids);
      for (const record of scan.owned) { targetedPids.add(record.pid); unverifiedPids.delete(record.pid); }
      for (const pid of scan.unverifiedPids) unverifiedPids.add(pid);
      if (scan.rootAlive) {
        targetedPids.add(session.pid);
        unverifiedPids.delete(session.pid);
      }
      latestScan = scan;
      return scan;
    } catch (error) {
      recordEnumerationFailure(error);
      if (!latestScan) throw error;
      for (const pid of targetedPids) unverifiedPids.add(pid);
      return { table: new Map(), owned: [], rootAlive: false, unverifiedPids: [...unverifiedPids] };
    }
  };
  const joiningStartupScan = session.processScanPromise !== undefined;
  try {
    latestScan = await scanAndTrack();
    // Startup discovery may have sampled before this command spawned its
    // children. Learn its identities, then take a new Stop-time snapshot before
    // signalling the root; otherwise detached children can be orphaned unseen.
    if (joiningStartupScan) latestScan = await scanAndTrack();
  }
  catch (error) { return unixFallbackReport(force, error); }

  // Re-read only our candidates immediately before signalling. A PID observed
  // in the earlier scan may already have exited and been assigned to somebody else.
  const verifyCandidates = async (candidates: ProcessRecord[]): Promise<ProcessRecord[]> => {
    if (!candidates.length) return [];
    let fresh: Map<number, ProcessRecord>;
    try { fresh = await readProcessTable(candidates.map((record) => record.pid)); }
    catch (error) {
      recordEnumerationFailure(error);
      for (const record of candidates) unverifiedPids.add(record.pid);
      return [];
    }
    return candidates.filter((identity) => {
      const current = fresh.get(identity.pid);
      if (!processIsAlive(current)) return false;
      if (!sameProcess(current!, identity)) {
        unverifiedPids.add(identity.pid);
        return false;
      }
      if (identity.pid === session.pid && session.endedAt !== undefined) return false;
      return true;
    });
  };
  const signalOwned = async (scan: ProcessScan, signal: "SIGTERM" | "SIGKILL", includeRoot = false): Promise<void> => {
    const candidates = [...scan.owned];
    if (includeRoot && scan.rootAlive) candidates.push(scan.table.get(session.pid)!);
    for (const record of await verifyCandidates(candidates)) {
      if (signal === "SIGTERM" && termSignaledPids.has(record.pid)) continue;
      if (!sendProcessSignal(record.pid, signal)) continue;
      if (signal === "SIGTERM") termSignaledPids.add(record.pid);
      else sigkillTargetPids.add(record.pid);
      if (signalUsed !== "SIGKILL") signalUsed = signal;
    }
  };
  const interruptRoot = async (scan: ProcessScan): Promise<void> => {
    if (!scan.rootAlive) return;
    if (!(await verifyCandidates([scan.table.get(session.pid)!])).length) return;
    if (sendProcessSignal(session.pid, "SIGINT")) signalUsed ??= "SIGINT";
  };
  const pollUntil = async (deadline: number, signalNew: "SIGTERM" | "SIGKILL"): Promise<ProcessScan> => {
    let scan = await scanAndTrack();
    while (true) {
      await signalOwned(scan, signalNew, signalNew === "SIGKILL");
      if (scan.owned.length === 0 && !scan.rootAlive) return scan;
      if (Date.now() >= deadline) return scan;
      await delay(Math.min(CLEANUP_POLL_MS, deadline - Date.now()));
      scan = await scanAndTrack();
    }
  };
  if (force) {
    await signalOwned(latestScan, "SIGKILL", true);
  } else {
    await signalOwned(latestScan, "SIGTERM");
    await interruptRoot(latestScan);
    const interruptDeadline = Math.min(startedAt + timeoutMs, Date.now() + Math.min(1_000, Math.max(250, Math.floor(timeoutMs / 3))));
    latestScan = await pollUntil(interruptDeadline, "SIGTERM");
    if (latestScan.rootAlive) await signalOwned({ ...latestScan, owned: [] }, "SIGTERM", true);
    latestScan = await pollUntil(startedAt + timeoutMs, "SIGTERM");
  }
  if (!force && (latestScan.owned.length > 0 || latestScan.rootAlive)) await signalOwned(latestScan, "SIGKILL", true);
  latestScan = await pollUntil(Date.now() + CLEANUP_VERIFY_MS, "SIGKILL");
  const residualPids = new Set<number>([...latestScan.owned.map((record) => record.pid), ...(latestScan.rootAlive ? [session.pid] : [])]);
  const verified = enumerationErrors.size === 0 && unverifiedPids.size === 0;
  const escalatedToSigkill = sigkillTargetPids.size > 0;
  const terminatedPids = [...targetedPids].filter((pid) => !sigkillTargetPids.has(pid) && !residualPids.has(pid) && !unverifiedPids.has(pid));
  const sigkillPids = [...sigkillTargetPids].filter((pid) => !residualPids.has(pid) && !unverifiedPids.has(pid));
  return {
    forceRequested: force, gracefulAttempted: !force,
    gracefulSucceeded: !force && verified && !escalatedToSigkill && residualPids.size === 0,
    escalatedToSigkill, signal: signalUsed,
    descendantsFound: [...targetedPids].filter((pid) => pid !== session.pid).length,
    targetedPids: [...targetedPids].sort((a, b) => a - b),
    terminatedPids: terminatedPids.sort((a, b) => a - b), sigkillPids: sigkillPids.sort((a, b) => a - b),
    residualPids: [...residualPids].sort((a, b) => a - b), verified,
    ...(unverifiedPids.size ? { unverifiedPids: [...unverifiedPids].sort((a, b) => a - b) } : {}),
    ...(enumerationErrors.size ? { enumerationError: [...enumerationErrors].join("; ") } : {}),
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
