export interface DebuggerRelayGuest {
  isDestroyed(): boolean;
  debugger: {
    off(event: string, listener: (...args: unknown[]) => void): void;
  };
}

/**
 * Electron may destroy a WebContents before its lifecycle record is cleaned up.
 * Keep this teardown best-effort so a late `destroyed` event cannot become an
 * uncaught main-process exception.
 */
export function detachDebuggerListener(guest: DebuggerRelayGuest | undefined, listener: (...args: unknown[]) => void): void {
  if (!listener || !guest || guest.isDestroyed()) return;
  try {
    guest.debugger.off("message", listener);
  } catch (error) {
    // The WebContents was destroyed after the check; teardown is already safe.
    if (!guest.isDestroyed()) throw error;
  }
}
