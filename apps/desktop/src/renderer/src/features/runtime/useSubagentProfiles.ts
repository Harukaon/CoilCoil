import { useCallback, useEffect, useRef, useState } from "react";
import type { SubagentProfilesSnapshot } from "@coilcoil/runtime-protocol";

/**
 * The subagent profiles the open project can use, read off disk.
 *
 * They are not part of the live runtime snapshot: that snapshot is pushed on every tool
 * event, and the profiles (prompts included) are a few kilobytes read from files that only
 * change when the user edits them. So the panels ask for them when they open, and again
 * after they change something.
 */
export function useSubagentProfiles(runtimeId: string | undefined, cwd: string | undefined): {
  profiles: SubagentProfilesSnapshot["profiles"];
  availableTools: string[];
  loading: boolean;
  error?: string;
  reload: () => Promise<void>;
  replace: (snapshot: SubagentProfilesSnapshot) => void;
} {
  const [snapshot, setSnapshot] = useState<SubagentProfilesSnapshot>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  // An answer for a project the panel has since left must not overwrite the current one.
  const latest = useRef(0);

  const reload = useCallback(async (): Promise<void> => {
    const ticket = ++latest.current;
    setLoading(true);
    try {
      const result = await window.coilcoil.request<SubagentProfilesSnapshot>({ type: "list_subagent_profiles", cwd }, runtimeId);
      if (ticket !== latest.current) return;
      setSnapshot(result);
      setError(undefined);
    } catch (caught) {
      if (ticket !== latest.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
  }, [cwd, runtimeId]);

  useEffect(() => {
    void reload();
    return () => { latest.current += 1; };
  }, [reload]);

  const replace = useCallback((next: SubagentProfilesSnapshot): void => {
    latest.current += 1;
    setSnapshot(next);
    setError(undefined);
    setLoading(false);
  }, []);

  return { profiles: snapshot?.profiles ?? [], availableTools: snapshot?.availableTools ?? [], loading, error, reload, replace };
}
