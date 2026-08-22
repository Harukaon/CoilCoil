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

/** Where every process writes, relative to the agent directory. */
export const DIAGNOSTIC_LOG_DIRECTORY = "logs";

/** Overrides the default `info` level in every process. */
export const DIAGNOSTIC_LEVEL_ENV = "COILCOIL_LOG_LEVEL";
