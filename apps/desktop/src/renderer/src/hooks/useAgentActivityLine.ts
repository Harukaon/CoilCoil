import { useEffect, useState } from "react";
import {
  agentActivityLine,
  startQuipRotation,
  type AgentPhase,
} from "../features/conversation/agentActivity";

/**
 * The status line under the composer.
 *
 * A run that finishes quickly only ever shows its phase — 思考中, 动手处理中 —
 * so the fast path stays as sober as it was. Once the wait is long enough to
 * notice, a quip joins the phase word and rotates slowly enough to read. The
 * bag is per-run: every wait starts from a fresh shuffle instead of resuming
 * wherever the last one stopped.
 */
export function useAgentActivityLine(running: boolean, phase?: AgentPhase): string {
  const [quip, setQuip] = useState<string>();

  useEffect(() => {
    if (!running) {
      setQuip(undefined);
      return;
    }
    return startQuipRotation(setQuip, window);
  }, [running]);

  return agentActivityLine(phase, quip);
}
