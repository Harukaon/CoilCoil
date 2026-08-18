import { useLayoutEffect } from "react";
import type { MutableRefObject, RefObject } from "react";
import type { ChatMessage, ToolRun } from "@suocode/runtime-protocol";

export function useConversationViewport({
  timelineRef,
  shouldAutoScrollRef,
  messages,
  tools,
  running,
  settingsOpen,
  conversationVisible,
}: {
  timelineRef: RefObject<HTMLDivElement | null>;
  shouldAutoScrollRef: MutableRefObject<boolean>;
  messages: ChatMessage[];
  tools: ToolRun[];
  running: boolean;
  settingsOpen: boolean;
  conversationVisible: boolean;
}): void {
  useLayoutEffect(() => {
    const viewport = timelineRef.current;
    if (viewport && shouldAutoScrollRef.current) viewport.scrollTop = viewport.scrollHeight;
  }, [messages, running, shouldAutoScrollRef, timelineRef, tools]);

  useLayoutEffect(() => {
    if (settingsOpen || !conversationVisible) return;
    const frame = window.requestAnimationFrame(() => {
      const viewport = timelineRef.current;
      if (viewport && shouldAutoScrollRef.current) viewport.scrollTop = viewport.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [conversationVisible, settingsOpen, shouldAutoScrollRef, timelineRef]);

}
