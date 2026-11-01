export {
  DEFAULT_MAX_BYTES,
  DiagnosticLog,
  levelFromEnvironment,
  type DiagnosticLogOptions,
} from "./log-file.js";
export {
  installProcessErrorHandlers,
  processStartupData,
  type ProcessErrorHandlerOptions,
} from "./install.js";
export { REDACTED, errorInfo, redact } from "./redact.js";
export {
  DEFAULT_MAX_TOTAL_BYTES, DEFAULT_RETENTION_DAYS, DEFAULT_ERROR_RETENTION_DAYS,
  listDiagnosticLogFiles, readDiagnosticLogFile, type DiagnosticLogFile,
} from "./archive.js";
export { AgentDiagnosticRecorder, type AgentDiagnosticContext } from "./agent-events.js";
export { diagnosticValueSummary, diagnosticToolTarget, diagnosticArgumentValues, omitArgumentEchoes } from "./metadata.js";

/** Where every process writes, relative to the agent directory. */
export const DIAGNOSTIC_LOG_DIRECTORY = "logs";

/** Overrides the default `info` level in every process. */
export const DIAGNOSTIC_LEVEL_ENV = "COILCOIL_LOG_LEVEL";
