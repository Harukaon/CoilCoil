/** Session-local wait state shared by background monitors and loop drivers. */
export const BACKGROUND_WAIT_STATE_CHANNEL = "coilcoil:background-wait:state:v1";
export const BACKGROUND_WAIT_CANCEL_CHANNEL = "coilcoil:background-wait:cancel:v1";
export const BACKGROUND_WAKE_FAILURE_CHANNEL = "coilcoil:background-wait:wake-failed:v1";

export interface BackgroundWaitState {
  waiting: boolean;
  monitorIds: readonly string[];
}

/** The monitor owner acknowledges cancellation synchronously, then finishes cleanup. */
export interface BackgroundWaitCancelRequest {
  cancelled?: boolean;
  completion?: Promise<void>;
}

export interface BackgroundWakeFailure {
  error: string;
}
