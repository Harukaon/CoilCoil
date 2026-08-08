import { useCallback, useEffect, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

const CHAT_WIDTH_KEY = "suocode.chat-content-width";
const DEFAULT_CHAT_WIDTH = 820;
const MINIMUM_CHAT_WIDTH = 480;
const MAXIMUM_CHAT_WIDTH = 1200;

function storedWidth(): number {
  const value = Number(window.localStorage.getItem(CHAT_WIDTH_KEY));
  return Number.isFinite(value) && value >= MINIMUM_CHAT_WIDTH
    ? Math.min(MAXIMUM_CHAT_WIDTH, value)
    : DEFAULT_CHAT_WIDTH;
}

export function useChatContentWidth(): {
  chatContentWidth: number;
  beginChatWidthResize: (edge: "left" | "right", event: ReactPointerEvent<HTMLDivElement>) => void;
} {
  const [chatContentWidth, setChatContentWidth] = useState(storedWidth);

  useEffect(() => {
    const fit = (): void => {
      const maximum = Math.max(MINIMUM_CHAT_WIDTH, Math.min(MAXIMUM_CHAT_WIDTH, window.innerWidth - 96));
      setChatContentWidth((current) => Math.min(current, maximum));
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

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
      const maximum = Math.max(MINIMUM_CHAT_WIDTH, Math.min(MAXIMUM_CHAT_WIDTH, window.innerWidth - 96));
      finalWidth = Math.max(MINIMUM_CHAT_WIDTH, Math.min(maximum, next));
      // CSS-only live update — commit React state on pointerup.
      pane?.style.setProperty("--chat-content-width", `${finalWidth}px`);
    };
    const stop = (): void => {
      document.body.classList.remove("resizing-panels");
      window.removeEventListener("pointermove", move);
      setChatContentWidth(finalWidth);
      window.localStorage.setItem(CHAT_WIDTH_KEY, String(finalWidth));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }, [chatContentWidth]);

  return { chatContentWidth, beginChatWidthResize };
}
