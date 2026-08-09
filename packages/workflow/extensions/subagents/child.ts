import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

export const DEFAULT_CHILD_TOOLS = ["read", "bash", "edit", "write", "grep", "ls"];
export const CHILD_SESSION_SUBDIR = "subagents";

export interface CreateChildSessionOptions {
  cwd: string;
  agentDir: string;
  parentSessionDir: string;
  model?: Model<never>;
  tools?: string[];
  onEvent: (event: AgentSessionEvent) => void;
}

export interface ChildSessionHandle {
  session: AgentSession;
  sessionFile?: string;
  dispose: () => Promise<void>;
}

export async function createChildSession(options: CreateChildSessionOptions): Promise<ChildSessionHandle> {
  const childSessionDir = join(options.parentSessionDir, CHILD_SESSION_SUBDIR);
  const sessionManager = SessionManager.create(options.cwd, childSessionDir);
  const settingsManager = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: true });
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    noExtensions: true,
    noThemes: true,
  });
  await loader.reload();
  const created = await createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    sessionManager,
    resourceLoader: loader,
    model: options.model,
    tools: options.tools ?? DEFAULT_CHILD_TOOLS,
    excludeTools: ["subagent"],
  });
  await created.session.bindExtensions({});
  const unsubscribe = created.session.subscribe(options.onEvent);
  const session = created.session;
  return {
    session,
    sessionFile: session.sessionFile,
    dispose: async () => {
      unsubscribe();
      await session.abort().catch(() => undefined);
      session.dispose();
    },
  };
}
