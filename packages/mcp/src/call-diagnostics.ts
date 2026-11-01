import { randomUUID } from "node:crypto";
import { diagnosticArgumentValues, diagnosticValueSummary, omitArgumentEchoes } from "@coilcoil/diagnostics";
import type { McpDiagnosticContext, McpDiagnosticLogger } from "./diagnostic.js";

/** Backend call accounting also covers local CLI access and calls made inside tools. */
export async function diagnoseMcpCall(
  log: McpDiagnosticLogger | undefined,
  context: McpDiagnosticContext,
  server: string,
  tool: string,
  args: Record<string, unknown>,
  call: () => Promise<unknown>,
): Promise<unknown> {
  if (!log) return call();
  const startedAt = Date.now();
  const summary = diagnosticValueSummary(args);
  const argumentValues = diagnosticArgumentValues(args);
  const meta = { ...context, invocationId: randomUUID(), server, tool,
    argumentBytes: summary.bytes, argumentFingerprint: summary.fingerprint, parameterShape: summary.shape };
  log("info", "mcp_tool_started", meta);
  try {
    const result = await call();
    const value = result && typeof result === "object" ? result as { isError?: boolean; content?: Array<{ type?: string; text?: string }> } : undefined;
    const resultSummary = diagnosticValueSummary(result);
    const textChars = value?.content?.reduce((sum, part) => sum + (part.type === "text" && typeof part.text === "string" ? part.text.length : 0), 0) ?? 0;
    const failed = value?.isError === true;
    const error = failed ? omitArgumentEchoes(value.content?.find((part) => part.type === "text" && typeof part.text === "string")?.text?.slice(0, 2_000) || "MCP tool returned an error", argumentValues) : undefined;
    log(failed ? "error" : "info", "mcp_tool_finished", { ...meta, succeeded: !failed, elapsedMs: Date.now() - startedAt,
      resultBytes: resultSummary.bytes, resultFingerprint: resultSummary.fingerprint, measurementBounded: resultSummary.bounded,
      textResultEstimatedTokens: Math.ceil(textChars / 4), tokenEstimateMethod: "text_chars_div_4" }, error);
    return result;
  } catch (error) {
    const diagnosticError = error instanceof Error ? { message: omitArgumentEchoes(error.message, argumentValues),
      stack: error.stack && omitArgumentEchoes(error.stack, argumentValues) } : omitArgumentEchoes(String(error), argumentValues);
    log("error", "mcp_tool_failed", { ...meta, elapsedMs: Date.now() - startedAt }, diagnosticError);
    throw error;
  }
}
