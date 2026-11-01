import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { shutdownAgentSession } from "./runtime-state.js";

/** Validate installed capabilities while preserving the transcript's restored loadout. */
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
  // New sessions activate monitor by default. Restored sessions retain their saved
  // declarations: adding a tool during restore would change their cached prefix.
  if (!session.getToolDefinition("monitor")) {
    await shutdownAgentSession(session, "quit").catch(() => undefined);
    throw new Error("CoilCoil workflow did not register required tools: monitor");
  }
  const required = ["read", "bash", "edit", "write", "grep", "ls", "terminal", "mcp"];
  if (process.platform === "win32") required.push("powershell");
  const missing = required.filter((name) => !active.has(name));
  if (missing.length) {
    await shutdownAgentSession(session, "quit").catch(() => undefined);
    throw new Error(`CoilCoil workflow did not activate required tools: ${missing.join(", ")}`);
  }
}
