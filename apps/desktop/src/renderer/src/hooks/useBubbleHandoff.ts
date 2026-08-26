import { useEffect, useRef } from "react";
import type { ProjectSelection, SessionSummary } from "@coilcoil/runtime-protocol";
import type { BubbleSessionTarget } from "../../../shared/desktop-api";

/**
 * Open the conversation the floating bubble handed over.
 *
 * The bubble and the workspace share one runtime, so this is a navigation and
 * not a transfer: whatever was streaming keeps streaming, and the workspace only
 * has to point itself at the same session. The conversation was usually created
 * moments ago in the home project, so the sidebar's cached list may not know it
 * yet - hence the reload before giving up.
 */
export function useBubbleHandoff({ projects, sessionsByProject, openConversation, onError }: {
  projects: ProjectSelection[];
  sessionsByProject: Record<string, SessionSummary[]>;
  openConversation(owner: ProjectSelection, session: SessionSummary): Promise<void>;
  onError(message: string): void;
}): void {
  const latest = useRef({ projects, sessionsByProject, openConversation, onError });
  latest.current = { projects, sessionsByProject, openConversation, onError };

  useEffect(() => {
    return window.coilcoil.onOpenBubbleSession((target: BubbleSessionTarget) => {
      void (async () => {
        const { projects: known, sessionsByProject: cached, openConversation: open, onError: report } = latest.current;
        try {
          const owner = known.find((project) => project.path === target.cwd) ?? await window.coilcoil.homeProject();
          const fromCache = (cached[owner.path] ?? []).find((session) => session.path === target.sessionPath);
          if (fromCache) {
            await open(owner, fromCache);
            return;
          }
          const sessions = await window.coilcoil.request<SessionSummary[]>({ type: "list_sessions", cwd: owner.path });
          const session = sessions.find((item) => item.path === target.sessionPath);
          if (!session) throw new Error("这个会话已经不在了。");
          await open(owner, session);
        } catch (caught) {
          report(caught instanceof Error ? caught.message : String(caught));
        }
      })();
    });
  }, []);
}
