import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { shutdownAgentSession } from "./runtime-state.js";

/** Validate the same loadout for a new or restored conversation. */
export async function configureSessionTools(
  session: AgentSession,
  effectiveModel: (model: NonNullable<AgentSession["model"]>) => NonNullable<AgentSession["model"]>,
): Promise<void> {
  if (session.model) {
    const model = effectiveModel(session.model);
    if (model !== session.model) await session.setModel(model);
  }
  session.setActiveToolsByName(session.getActiveToolNames().filter((name) => name !== "find"));
  const active = new Set(session.getActiveToolNames());
  const required = ["read", "bash", "edit", "write", "grep", "ls", "terminal", "monitor", "mcp"];
  if (process.platform === "win32") required.push("powershell");
  const missing = required.filter((name) => !active.has(name));
  if (missing.length) {
    await shutdownAgentSession(session, "quit").catch(() => undefined);
    throw new Error(`CoilCoil workflow did not activate required tools: ${missing.join(", ")}`);
  }
}
