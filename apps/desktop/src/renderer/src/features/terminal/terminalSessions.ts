/**
 * Open a shell for `cwd` and name it.
 *
 * `createTerminal` answers with the whole store rather than the shell it just
 * spawned, and main resolves the cwd it was handed, so the entries are matched
 * on the resolved path when that works and fall back to the newest entry
 * overall — which is the one this call created either way, because main sorts
 * by start time.
 */
export async function openTerminalSession(cwd: string): Promise<string | undefined> {
  const sessions = await window.coilcoil.createTerminal(cwd);
  const forCwd = sessions.filter((item) => item.cwd === cwd);
  return (forCwd.length ? forCwd : sessions).at(-1)?.id;
}
