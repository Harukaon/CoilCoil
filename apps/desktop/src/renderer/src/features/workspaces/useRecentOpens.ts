import { useCallback, useState } from "react";
import { loadRecentOpens, recordRecentOpen, saveRecentOpens, type RecentOpens } from "./recentSessions";

export interface RecentOpensController {
  recentOpens: RecentOpens;
  /** Call when a conversation is opened, so the sidebar can offer it as recent. */
  noteConversationOpened: (sessionPath: string) => void;
}

/**
 * Track which conversations were opened, across restarts.
 *
 * Reading a conversation never moves its `updatedAt`, so without this the
 * sidebar's recent list would lose exactly the conversation just looked at.
 */
export function useRecentOpens(): RecentOpensController {
  const [recentOpens, setRecentOpens] = useState<RecentOpens>(loadRecentOpens);
  const noteConversationOpened = useCallback((sessionPath: string): void => {
    setRecentOpens((current) => {
      const next = recordRecentOpen(current, sessionPath);
      saveRecentOpens(next);
      return next;
    });
  }, []);
  return { recentOpens, noteConversationOpened };
}
