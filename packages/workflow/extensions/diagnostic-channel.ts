import type { DiagnosticLog } from "@coilcoil/diagnostics";

export const WORKFLOW_DIAGNOSTIC_PUBLISHER_REQUEST = "coilcoil:diagnostics:publisher:v1";
export type WorkflowDiagnosticLog = Pick<DiagnosticLog, "log">;
export interface WorkflowDiagnosticPublisherRequest { log?: WorkflowDiagnosticLog }

/** Keep the runtime-owned sink after extension reload; never retain an ExtensionContext. */
export function workflowDiagnosticLog(events: { emit(channel: string, value: unknown): void }): WorkflowDiagnosticLog {
  let sink: WorkflowDiagnosticLog | undefined;
  let requested = false;
  return {
    log(...args) {
      if (!requested) {
        requested = true;
        const request: WorkflowDiagnosticPublisherRequest = {};
        events.emit(WORKFLOW_DIAGNOSTIC_PUBLISHER_REQUEST, request);
        sink = request.log;
      }
      sink?.log(...args);
    },
  };
}
