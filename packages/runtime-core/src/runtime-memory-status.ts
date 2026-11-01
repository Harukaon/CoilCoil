import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { ProjectMemoryRuntimeStatus, RuntimeEvent } from "@coilcoil/runtime-protocol";
import { MEMORY_STATUS_PUBLISHER_REQUEST, type MemoryStatusPublisherRequest } from "@coilcoil/workflow/extensions/memory-status-channel.js";
import { PROJECT_MEMORY_STATUS_EVENT, projectMemoryStatusByCwd } from "./runtime-constants.js";
import { hydrateProjectMemoryStatus, mergeWorkspaceMemoryStatus, projectMemoryStatus, type ActiveSession } from "./runtime-state.js";
import { isRecord, safeRealPath } from "./runtime-utils.js";

interface MemoryStatusHost {
  cwd: string;
  installedActive(): ActiveSession | undefined;
  currentActive(): ActiveSession | undefined;
  publishInspection(active: ActiveSession): void;
  emitNotice(event: Extract<RuntimeEvent, { type: "runtime_notice" }>): void;
}

/** Background jobs own this callback; neither extension reload nor bus.clear retires it. */
export function installMemoryStatusChannel(eventBus: EventBus, host: MemoryStatusHost): {
  getStatus(): ProjectMemoryRuntimeStatus | undefined;
} {
  let status: ProjectMemoryRuntimeStatus | undefined;
  const publish = (value: unknown): void => {
    const parsed = projectMemoryStatus(value);
    const next = parsed ? hydrateProjectMemoryStatus({ ...parsed, cwd: parsed.cwd || host.cwd }) : undefined;
    if (!next) return;
    status = next;
    const key = safeRealPath(next.cwd);
    const previous = projectMemoryStatusByCwd.get(key);
    const shared = mergeWorkspaceMemoryStatus(previous, next);
    projectMemoryStatusByCwd.set(key, shared);
    // The job can outlive its entire conversation. Refresh only the current
    // conversation in this workspace; never call a disposed session's UI.
    const active = host.currentActive();
    if (!active || safeRealPath(active.cwd) !== key) return;
    if (active === host.installedActive()) active.memoryStatus = next;
    host.publishInspection(active);
    if (shared.source !== "manual" || (previous?.state === shared.state && previous.attemptId === shared.attemptId)) return;
    if (shared.state === "running") host.emitNotice({ type: "runtime_notice", level: "info", message: shared.message || "正在整理当前项目记忆…" });
    else if (shared.state === "succeeded") host.emitNotice({ type: "runtime_notice", level: "success", message: shared.message || "项目记忆整理完成" });
    else if (shared.state === "busy") host.emitNotice({ type: "runtime_notice", level: "info", message: shared.message || "当前项目已有记忆整理正在运行" });
    else if (shared.state === "failed") host.emitNotice({ type: "runtime_notice", level: "error", message: shared.error || "项目记忆整理失败" });
  };
  eventBus.on(PROJECT_MEMORY_STATUS_EVENT, publish);
  eventBus.on(MEMORY_STATUS_PUBLISHER_REQUEST, (request) => {
    if (isRecord(request)) (request as MemoryStatusPublisherRequest).publish = publish;
  });
  return { getStatus: () => status };
}
