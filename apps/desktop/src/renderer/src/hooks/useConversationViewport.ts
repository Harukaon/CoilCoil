import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { MutableRefObject, RefObject } from "react";
import type { ChatMessage, ToolRun } from "@coilcoil/runtime-protocol";

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
}: {
  distanceFromBottom: number;
  msSinceGesture: number;
  following: boolean;
}): boolean {
  if (distanceFromBottom <= 1) return true;
  if (msSinceGesture > GESTURE_WINDOW_MS) return following;
  return false;
}

/**
 * Does this gesture mean "let me read what scrolled past"?
 *
 * Scroll events cannot answer that on their own while a reply streams: the
 * reader's wheel and the app's own pin-to-bottom land in the same frame, the
 * browser coalesces them into a single scroll event, and by the time it fires
 * the viewport is back at the bottom with no trace of the reader's move. The
 * gesture itself is the only honest signal, so it stops the follow directly.
 */
export function gestureLeavesBottom(event: Event, previousTouchY?: number): boolean {
  if (event.type === "wheel") return (event as WheelEvent).deltaY < 0;
  if (event.type === "touchmove") {
    const touch = (event as TouchEvent).touches[0];
    // Dragging the finger down pulls earlier messages into view.
    return Boolean(touch && previousTouchY !== undefined && touch.clientY > previousTouchY);
  }
  if (event.type === "keydown") {
    return ["ArrowUp", "PageUp", "Home"].includes((event as KeyboardEvent).key);
  }
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
  const lastTouchY = useRef<number | undefined>(undefined);
  const pointerHeld = useRef(false);

  const pinToBottom = useCallback((): void => {
    const viewport = timelineRef.current;
    if (!viewport) return;
    // A held pointer is a reader mid-gesture — dragging the scrollbar, sweeping
    // a selection. Yanking the viewport out from under them reads as a fight.
    if (pointerHeld.current) return;
    const bottom = viewport.scrollHeight - viewport.clientHeight;
    if (Math.abs(viewport.scrollTop - bottom) < 1) return;
    viewport.scrollTop = bottom;
  }, [timelineRef]);

  // Listen on the document: the conversation pane unmounts whenever the skills
  // or memory workspace takes over, and listeners bound to the old node would
  // never see another gesture — which silently welds the timeline to the bottom.
  useEffect(() => {
    const inTimeline = (event: Event): boolean => {
      const viewport = timelineRef.current;
      return Boolean(viewport && event.target instanceof Node && viewport.contains(event.target));
    };
    const markGesture = (event: Event): void => {
      if (!inTimeline(event)) return;
      lastGestureAt.current = performance.now();
      if (gestureLeavesBottom(event, lastTouchY.current)) shouldAutoScrollRef.current = false;
      if (event.type === "touchmove") lastTouchY.current = (event as TouchEvent).touches[0]?.clientY;
    };
    const onPointerDown = (event: Event): void => {
      if (!inTimeline(event)) return;
      pointerHeld.current = true;
      lastGestureAt.current = performance.now();
    };
    const releasePointer = (): void => { pointerHeld.current = false; };
    // A scrollbar drag can outlast the gesture window, and the press alone is
    // the only mark it would otherwise leave.
    const onPointerMove = (): void => {
      if (pointerHeld.current) lastGestureAt.current = performance.now();
    };
    const onTouchStart = (event: Event): void => {
      lastTouchY.current = inTimeline(event) ? (event as TouchEvent).touches[0]?.clientY : undefined;
    };
    const options = { capture: true, passive: true } as const;
    document.addEventListener("wheel", markGesture, options);
    document.addEventListener("touchstart", onTouchStart, options);
    document.addEventListener("touchmove", markGesture, options);
    document.addEventListener("keydown", markGesture, { capture: true });
    document.addEventListener("pointerdown", onPointerDown, options);
    document.addEventListener("pointermove", onPointerMove, options);
    document.addEventListener("pointerup", releasePointer, options);
    document.addEventListener("pointercancel", releasePointer, options);
    // A button released outside the window never reports its pointerup here.
    window.addEventListener("blur", releasePointer);
    return () => {
      document.removeEventListener("wheel", markGesture, options);
      document.removeEventListener("touchstart", onTouchStart, options);
      document.removeEventListener("touchmove", markGesture, options);
      document.removeEventListener("keydown", markGesture, { capture: true });
      document.removeEventListener("pointerdown", onPointerDown, options);
      document.removeEventListener("pointermove", onPointerMove, options);
      document.removeEventListener("pointerup", releasePointer, options);
      document.removeEventListener("pointercancel", releasePointer, options);
      window.removeEventListener("blur", releasePointer);
    };
  }, [shouldAutoScrollRef, timelineRef]);

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
    shouldAutoScrollRef.current = autoFollowAfterScroll({
      distanceFromBottom: viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight,
      msSinceGesture: performance.now() - lastGestureAt.current,
      following: shouldAutoScrollRef.current,
    });
  }, [shouldAutoScrollRef, timelineRef]);

  return { handleTimelineScroll };
}
