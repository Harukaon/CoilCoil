import { randomUUID } from "node:crypto";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { diagnosticValueSummary, type DiagnosticLog } from "@coilcoil/diagnostics";

interface RequestAssociation {
  role?: "main" | "subagent" | "memory";
  parentSessionId?: string;
  memoryAttemptId?: string;
  workspace?: string;
  sourceSessionPath?: string;
}

/** Read-only observers: never retain a request body or write to provider payloads/headers. */
export function installRequestDiagnostics(pi: ExtensionAPI, log: Pick<DiagnosticLog, "log">, association: RequestAssociation = {}): void {
  let requestId: string | undefined;
  let startedAt = 0;
  pi.on("before_provider_request", (event, ctx) => {
    requestId = randomUUID(); startedAt = Date.now();
    const size = diagnosticValueSummary(event.payload);
    log.log("info", "model", "request_prepared", { ...association, requestId, sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd,
      provider: ctx.model?.provider, model: ctx.model?.id, requestContentBytes: size.bytes,
      requestFingerprint: size.fingerprint, measurementBounded: size.bounded }, { sessionPath: ctx.sessionManager.getSessionFile() });
  });
  pi.on("after_provider_response", (event, ctx) => {
    const headers = event.headers;
    log.log(event.status >= 400 ? "error" : "info", "model", "response_headers", {
      ...association, requestId, sessionId: ctx.sessionManager.getSessionId(), status: event.status,
      elapsedMs: startedAt ? Date.now() - startedAt : undefined,
      upstreamRequestId: headers["request-id"] ?? headers["x-request-id"], retryAfter: headers["retry-after"],
    }, { sessionPath: ctx.sessionManager.getSessionFile() });
  });
}

export function requestDiagnosticExtension(log: Pick<DiagnosticLog, "log">, association: RequestAssociation = {}): InlineExtension {
  return { name: "coilcoil-request-diagnostics", hidden: true, factory: (pi) => installRequestDiagnostics(pi, log, association) };
}
