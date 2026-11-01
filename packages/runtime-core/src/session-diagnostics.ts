import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { AgentDiagnosticRecorder, type DiagnosticLog } from "@coilcoil/diagnostics";

export function subscribeSessionDiagnostics(session: AgentSession, log: DiagnosticLog, cwd: string, onEvent: (event: AgentSessionEvent) => void): () => void {
  const diagnostics = new AgentDiagnosticRecorder(log, () => ({
    sessionId: session.sessionId, sessionPath: session.sessionFile, cwd, role: "main",
    provider: session.model?.provider, model: session.model?.id,
  }));
  log.info("session", "opened", { sessionId: session.sessionId, cwd, provider: session.model?.provider,
    model: session.model?.id, historyEntries: session.sessionManager.getBranch().length }, { sessionPath: session.sessionFile });
  const unsubscribe = session.subscribe((event) => { diagnostics.record(event); onEvent(event); });
  return () => {
    unsubscribe();
    log.info("session", "detached", { sessionId: session.sessionId, cwd }, { sessionPath: session.sessionFile });
  };
}
