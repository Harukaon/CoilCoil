import type { EventBusController } from "@earendil-works/pi-coding-agent";
import type { BackgroundWaitState, RuntimeEvent } from "@coilcoil/runtime-protocol";
import { BACKGROUND_WAIT_CANCEL_CHANNEL, BACKGROUND_WAIT_STATE_CHANNEL, BACKGROUND_WAKE_FAILURE_CHANNEL,
  type BackgroundWaitCancelRequest } from "@coilcoil/workflow/extensions/background-wait.js";
import type { ActiveSession } from "./runtime-state.js";
import { isRecord } from "./runtime-utils.js";

export function installBackgroundWaitState(eventBus: EventBusController, options: {
  installed: () => ActiveSession | undefined;
  current: () => ActiveSession | undefined;
  emit: (event: RuntimeEvent) => void;
}): { getState: () => BackgroundWaitState | undefined } {
  let state: BackgroundWaitState | undefined;
  eventBus.on(BACKGROUND_WAKE_FAILURE_CHANNEL, (value) => {
    const active = options.installed();
    if (active && options.current() === active && isRecord(value) && typeof value.error === "string") {
      options.emit({ type: "runtime_error", message: `后台监控失败：${value.error}` });
    }
  });
  eventBus.on(BACKGROUND_WAIT_STATE_CHANNEL, (value) => {
    if (!isRecord(value) || typeof value.waiting !== "boolean" || !Array.isArray(value.monitorIds)
      || !value.monitorIds.every((id) => typeof id === "string")) return;
    state = { waiting: value.waiting, monitorIds: [...value.monitorIds] };
    const active = options.installed();
    if (!active) return;
    active.backgroundWait = state;
    if (options.current() === active) options.emit({ type: "background_wait_updated",
      backgroundWait: { waiting: state.waiting, monitorIds: [...state.monitorIds] } });
  });
  return { getState: () => state };
}

/** Revoke watches and queued notices before yielding to any asynchronous stop. */
export function cancelBackgroundWait(active: ActiveSession, reportError: (error: unknown) => void): BackgroundWaitCancelRequest {
  const request: BackgroundWaitCancelRequest = {};
  active.eventBus.emit(BACKGROUND_WAIT_CANCEL_CHANNEL, request);
  // Observe cleanup failures immediately: stopping Goal may await its journal.
  if (request.completion) request.completion = request.completion.catch(reportError);
  return request;
}
