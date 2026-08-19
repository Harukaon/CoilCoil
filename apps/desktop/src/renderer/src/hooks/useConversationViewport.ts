import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { MutableRefObject, RefObject } from "react";
import type { ChatMessage, ToolRun } from "@suocode/runtime-protocol";

/**
 * How long after a real gesture a scroll event still counts as user-driven.
 *
 * Momentum scrolling keeps firing scroll events well after the wheel or the
 * finger stops, and every one of them has to keep counting as the user's.
 */
const GESTURE_WINDOW_MS = 900;

/**
 * Decide whether the timeline keeps following the newest message after a scroll.
 *
 * Reaching the bottom always resumes following. Leaving it only stops following
 * when the user caused the scroll: React replacing the timeline resets
 * `scrollTop` and fires a scroll event nobody asked for, and treating that as
 * intent is what used to strand a freshly opened conversation at the top.
 */
export function autoFollowAfterScroll({
  distanceFromBottom,
  msSinceGesture,
  following,
  programmatic = false,
}: {
  distanceFromBottom: number;
  msSinceGesture: number;
  following: boolean;
  /** This scroll came from `pinToBottom`, not from the reader. */
  programmatic?: boolean;
}): boolean {
  // A scroll the app performed itself says nothing about what the reader wants.
  // While a reply streams, pinToBottom runs on every delta; counting its own
  // landing as "the reader is at the bottom" re-armed following a frame after
  // the reader had scrolled up, and dragged them back down.
  if (programmatic) return following;
  if (distanceFromBottom <= 1) return true;
  if (msSinceGesture > GESTURE_WINDOW_MS) return following;
  return false;
}

export interface ConversationViewport {
  /** Attach to the scrolling element's `onScroll`. */
  handleTimelineScroll: () => void;
}

/**
 * Keep the conversation pinned to the newest message unless the user scrolled away.
 *
 * Two rules carry this. Opening a conversation — and finishing its load — always
 * lands at the bottom, because content mounts after the messages arrive and no
 * message change follows to trigger a scroll. And auto-follow is only ever
 * switched off by a scroll the user actually caused: replacing the timeline
 * resets `scrollTop` and fires a scroll event of its own, which used to read as
 * "the user scrolled up" and left the freshly opened conversation at the top.
 */
export function useConversationViewport({
  timelineRef,
  shouldAutoScrollRef,
  messages,
  tools,
  running,
  settingsOpen,
  conversationVisible,
  conversationKey,
  loading,
}: {
  timelineRef: RefObject<HTMLDivElement | null>;
  shouldAutoScrollRef: MutableRefObject<boolean>;
  messages: ChatMessage[];
  tools: ToolRun[];
  running: boolean;
  settingsOpen: boolean;
  conversationVisible: boolean;
  /** Identity of the open conversation; a change re-pins the viewport. */
  conversationKey?: string;
  loading: boolean;
}): ConversationViewport {
  const lastGestureAt = useRef(0);
  const programmaticScroll = useRef(false);

  const pinToBottom = useCallback((): void => {
    const viewport = timelineRef.current;
    if (!viewport) return;
    const bottom = viewport.scrollHeight - viewport.clientHeight;
    // Only flag a move that will actually emit a scroll event, or the flag would
    // outlive this call and swallow the reader's next real scroll.
    if (Math.abs(viewport.scrollTop - bottom) < 1) return;
    programmaticScroll.current = true;
    viewport.scrollTop = bottom;
  }, [timelineRef]);

  useEffect(() => {
    const viewport = timelineRef.current;
    if (!viewport) return;
    const markGesture = (): void => { lastGestureAt.current = performance.now(); };
    viewport.addEventListener("wheel", markGesture, { passive: true });
    viewport.addEventListener("touchmove", markGesture, { passive: true });
    viewport.addEventListener("pointerdown", markGesture, { passive: true });
    viewport.addEventListener("keydown", markGesture);
    return () => {
      viewport.removeEventListener("wheel", markGesture);
      viewport.removeEventListener("touchmove", markGesture);
      viewport.removeEventListener("pointerdown", markGesture);
      viewport.removeEventListener("keydown", markGesture);
    };
  }, [timelineRef]);

  // Opening a conversation, and the moment its content replaces the loader.
  useLayoutEffect(() => {
    shouldAutoScrollRef.current = true;
    if (loading || settingsOpen || !conversationVisible) return;
    pinToBottom();
    // Markdown, code blocks, and images settle a frame later and grow the list.
    const frame = window.requestAnimationFrame(() => {
      if (shouldAutoScrollRef.current) pinToBottom();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [conversationKey, conversationVisible, loading, pinToBottom, settingsOpen, shouldAutoScrollRef]);

  useLayoutEffect(() => {
    if (shouldAutoScrollRef.current) pinToBottom();
  }, [messages, pinToBottom, running, shouldAutoScrollRef, tools]);

  const handleTimelineScroll = useCallback((): void => {
    const viewport = timelineRef.current;
    if (!viewport) return;
    const programmatic = programmaticScroll.current;
    programmaticScroll.current = false;
    shouldAutoScrollRef.current = autoFollowAfterScroll({
      distanceFromBottom: viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight,
      msSinceGesture: performance.now() - lastGestureAt.current,
      following: shouldAutoScrollRef.current,
      programmatic,
    });
  }, [shouldAutoScrollRef, timelineRef]);

  return { handleTimelineScroll };
}
