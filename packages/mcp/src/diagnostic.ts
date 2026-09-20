/**
 * The MCP package does not own a log file. The runtime supplies this small
 * sink so the package can record protocol decisions without depending on the
 * desktop logging implementation.
 */
export type McpDiagnosticLevel = "info" | "warn" | "error";

export type McpDiagnosticLogger = (
  level: McpDiagnosticLevel,
  event: string,
  data?: Record<string, unknown>,
  error?: unknown,
) => void;
