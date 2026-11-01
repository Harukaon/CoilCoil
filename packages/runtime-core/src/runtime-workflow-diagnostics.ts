import type { EventBus } from "@earendil-works/pi-coding-agent";
import { WORKFLOW_DIAGNOSTIC_PUBLISHER_REQUEST, type WorkflowDiagnosticLog,
  type WorkflowDiagnosticPublisherRequest } from "@coilcoil/workflow/extensions/diagnostic-channel.ts";
import { isRecord } from "./runtime-utils.js";

/** Child sessions and background callbacks share the runtime's bounded, redacted log. */
export function installWorkflowDiagnostics(eventBus: EventBus, log: WorkflowDiagnosticLog): void {
  eventBus.on(WORKFLOW_DIAGNOSTIC_PUBLISHER_REQUEST, (value) => {
    if (isRecord(value)) (value as WorkflowDiagnosticPublisherRequest).log = log;
  });
}
