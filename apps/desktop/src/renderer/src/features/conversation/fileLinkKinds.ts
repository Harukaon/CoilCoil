import { useEffect, useState } from "react";
import type { PathKind } from "../../../../shared/desktop-api";

/**
 * What every absolute path seen so far turned out to be.
 *
 * A transcript repeats the same paths across many messages, so the answer is
 * cached for the life of the window and every render after the first is free.
 */
const known = new Map<string, PathKind>();
const listeners = new Set<() => void>();
let pending = new Set<string>();
let inFlight: Promise<void> | undefined;

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** Test seam: preload answers without touching the main process. */
export function primeFileLinkKinds(entries: Record<string, PathKind>): void {
  for (const [path, kind] of Object.entries(entries)) known.set(path, kind);
  notify();
}

export function resetFileLinkKinds(): void {
  known.clear();
  pending = new Set();
  inFlight = undefined;
}

export function fileLinkKind(path: string): PathKind | undefined {
  return known.get(path);
}

/**
 * Ask for the paths queued since the last flush, in one round trip.
 *
 * Classification runs on a microtask boundary so one message full of links
 * costs a single call rather than one per link.
 */
function scheduleClassification(): void {
  if (inFlight) return;
  inFlight = Promise.resolve().then(async () => {
    const paths = [...pending];
    pending = new Set();
    inFlight = undefined;
    if (!paths.length) return;
    try {
      const result = await window.suocode.classifyPaths(paths);
      for (const path of paths) known.set(path, result[path] ?? "missing");
    } catch {
      // Leave the paths unknown: the link still works, it just keeps the
      // neutral file icon until something asks again.
      for (const path of paths) known.delete(path);
    }
    notify();
  });
}

export function requestFileLinkKind(path: string): void {
  if (known.has(path) || pending.has(path)) return;
  pending.add(path);
  scheduleClassification();
}

/** The kind of one path, resolved in the background after the first render. */
export function useFileLinkKind(path: string): PathKind | undefined {
  const [kind, setKind] = useState(() => known.get(path));
  useEffect(() => {
    const sync = (): void => setKind(known.get(path));
    listeners.add(sync);
    sync();
    requestFileLinkKind(path);
    return () => { listeners.delete(sync); };
  }, [path]);
  return kind;
}
