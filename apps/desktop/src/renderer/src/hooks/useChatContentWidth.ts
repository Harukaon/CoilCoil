import { useCallback, useEffect, useMemo, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

export const CHAT_WIDTH_KEY = "coilcoil.chat-content-width";
export const DEFAULT_CHAT_WIDTH = 820;
export const MINIMUM_CHAT_WIDTH = 480;
export const MAXIMUM_CHAT_WIDTH = 1200;

export function clampChatContentWidth(value: number, viewportWidth: number): number {
  const maximum = Math.max(MINIMUM_CHAT_WIDTH, Math.min(MAXIMUM_CHAT_WIDTH, viewportWidth - 96));
  return Math.max(MINIMUM_CHAT_WIDTH, Math.min(maximum, value));
}

export function readStoredChatContentWidth(storage: Pick<Storage, "getItem"> = window.localStorage): number {
  const value = Number(storage.getItem(CHAT_WIDTH_KEY));
  return Number.isFinite(value) && value >= MINIMUM_CHAT_WIDTH
    ? Math.min(MAXIMUM_CHAT_WIDTH, value)
    : DEFAULT_CHAT_WIDTH;
}

/**
 * Prefer the user's chosen width, but never exceed the current viewport.
 * Shrinking the window must not permanently overwrite the preferred width.
 */
export function effectiveChatContentWidth(preferredWidth: number, viewportWidth: number): number {
  return Math.min(preferredWidth, clampChatContentWidth(preferredWidth, viewportWidth));
}

export function useChatContentWidth(): {
  chatContentWidth: number;
  beginChatWidthResize: (edge: "left" | "right", event: ReactPointerEvent<HTMLDivElement>) => void;
} {
  const [preferredWidth, setPreferredWidth] = useState(readStoredChatContentWidth);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);

  useEffect(() => {
    const onResize = (): void => setViewportWidth(window.innerWidth);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const chatContentWidth = useMemo(
    () => effectiveChatContentWidth(preferredWidth, viewportWidth),
    [preferredWidth, viewportWidth],
  );

  const beginChatWidthResize = useCallback((edge: "left" | "right", event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;
    const startWidth = chatContentWidth;
    let finalWidth = startWidth;
    const pane = event.currentTarget.closest(".conversation-pane") as HTMLElement | null;
    document.body.classList.add("resizing-panels");
    const move = (pointer: PointerEvent): void => {
      const delta = edge === "right" ? pointer.clientX - startX : startX - pointer.clientX;
      // Dragging either edge expands/contracts symmetrically around center.
      const next = Math.round(startWidth + delta * 2);
      finalWidth = clampChatContentWidth(next, window.innerWidth);
      // CSS-only live update — commit React state on pointerup.
      pane?.style.setProperty("--chat-content-width", `${finalWidth}px`);
    };
    const stop = (): void => {
      document.body.classList.remove("resizing-panels");
      window.removeEventListener("pointermove", move);
      setPreferredWidth(finalWidth);
      window.localStorage.setItem(CHAT_WIDTH_KEY, String(finalWidth));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }, [chatContentWidth]);

  return { chatContentWidth, beginChatWidthResize };
}
