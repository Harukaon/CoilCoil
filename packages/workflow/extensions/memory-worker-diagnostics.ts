import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentDiagnosticRecorder, DiagnosticLog, DIAGNOSTIC_LEVEL_ENV, DIAGNOSTIC_LOG_DIRECTORY,
  installProcessErrorHandlers, levelFromEnvironment, type AgentDiagnosticContext } from "@coilcoil/diagnostics";
import { installRequestDiagnostics } from "./request-diagnostics.ts";

/** The isolated curator has no desktop event bus, so it writes the shared diagnostic format directly. */
export default function memoryWorkerDiagnostics(pi: ExtensionAPI, options: {
  env?: NodeJS.ProcessEnv; log?: DiagnosticLog;
} = {}): void {
  const env = options.env ?? process.env;
  const log = options.log ?? new DiagnosticLog({ directory: join(getAgentDir(), DIAGNOSTIC_LOG_DIRECTORY),
    process: "memory", level: levelFromEnvironment(env[DIAGNOSTIC_LEVEL_ENV]) });
  const removeProcessHandlers = installProcessErrorHandlers(log, { exitOnUncaught: true });
  const association = { memoryAttemptId: env.PI_MEMORY_WORKER_ATTEMPT_ID, workspace: env.PI_MEMORY_WORKER_WORKSPACE,
    sourceSessionPath: env.PI_MEMORY_WORKER_SESSION_FILE };
  installRequestDiagnostics(pi, log, { ...association, role: "memory" });
  let context: AgentDiagnosticContext = { role: "memory", cwd: env.PI_MEMORY_WORKER_WORKSPACE };
  const recorder = new AgentDiagnosticRecorder({ log: (level, scope, event, data, requestContext) => {
    log.log(level, scope, event, { ...association, ...data }, requestContext);
  } }, () => context);
  const record = (event: { type: string }, ctx: ExtensionContext): void => {
    context = { role: "memory", cwd: env.PI_MEMORY_WORKER_WORKSPACE ?? ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(), sessionPath: ctx.sessionManager.getSessionFile(),
      provider: ctx.model?.provider, model: ctx.model?.id };
    recorder.record({ ...event });
  };
  pi.on("agent_start", record);
  pi.on("agent_settled", record);
  pi.on("turn_start", record);
  pi.on("message_update", record);
  pi.on("message_end", record);
  pi.on("tool_execution_start", record);
  pi.on("tool_execution_end", record);
  pi.on("session_start", (_event, ctx) => {
    log.info("memory", "worker_ready", { ...association, provider: ctx.model?.provider, model: ctx.model?.id, pid: process.pid },
      { sessionPath: ctx.sessionManager.getSessionFile() });
  });
  pi.on("session_shutdown", async () => {
    log.info("memory", "worker_shutdown", association, { sessionPath: context.sessionPath });
    await log.flush();
    removeProcessHandlers();
  });
}
