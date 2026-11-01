import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { shutdownAgentSession } from "./runtime-state.js";
import { expectCacheChange } from "./session-request-policy.js";

const LEGACY_BROWSER_TOOLS = new Set(["browser_open", "browser_navigate", "browser_click", "browser_type", "browser_tabs"]);

/** Upgrade bundled capabilities on session restore, before starting a new turn. */
export async function configureSessionTools(
  session: AgentSession,
  effectiveModel: (model: NonNullable<AgentSession["model"]>) => NonNullable<AgentSession["model"]>,
): Promise<void> {
  if (session.model) {
    const model = effectiveModel(session.model);
    if (model !== session.model) await session.setModel(model);
  }
  if (!session.getToolDefinition("monitor")) {
    await shutdownAgentSession(session, "quit").catch(() => undefined);
    throw new Error("CoilCoil workflow did not register required tools: monitor");
  }
  const previous = session.getActiveToolNames();
  const upgraded = new Set(previous.filter((name) => name !== "find" && !LEGACY_BROWSER_TOOLS.has(name)
    && !name.startsWith("mcp__coilcoil_browser__")));
  upgraded.add("monitor");
  if (session.getToolDefinition("browser")) upgraded.add("browser");
  if (previous.length !== upgraded.size || previous.some((name) => !upgraded.has(name))) {
    // This application upgrade was requested by the user; it changes declarations
    // once, while the saved messages and system-prompt snapshot stay intact.
    expectCacheChange(session, "user_tools_changed");
  }
  session.setActiveToolsByName([...upgraded]);
  const active = new Set(session.getActiveToolNames());
  const required = ["read", "bash", "edit", "write", "grep", "ls", "terminal", "monitor", "mcp"];
  if (process.platform === "win32") required.push("powershell");
  const missing = required.filter((name) => !active.has(name));
  if (missing.length) {
    await shutdownAgentSession(session, "quit").catch(() => undefined);
    throw new Error(`CoilCoil workflow did not activate required tools: ${missing.join(", ")}`);
  }
}
