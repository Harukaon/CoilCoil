import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

const LEFT_WIDTH_KEY = "suocode.left-panel-width";
const RIGHT_WIDTH_KEY = "suocode.right-panel-width";
const MINIMUM_CONVERSATION_WIDTH = 315;
const MINIMUM_PANEL_WIDTH = 40;

function storedWidth(key: string, fallback: number): number {
  const value = Number(window.localStorage.getItem(key));
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function usePanelLayout(): {
  leftOpen: boolean;
  rightOpen: boolean;
  leftWidth: number;
  rightWidth: number;
  setLeftOpen: (open: boolean) => void;
  setRightOpen: (open: boolean) => void;
  beginResize: (side: "left" | "right", event: ReactPointerEvent<HTMLDivElement>) => void;
} {
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(false);
  const [leftWidth, setLeftWidth] = useState(() => storedWidth(LEFT_WIDTH_KEY, 268));
  const [rightWidth, setRightWidth] = useState(() => storedWidth(RIGHT_WIDTH_KEY, 352));
  const preferredLeftWidthRef = useRef(leftWidth);
  const preferredRightWidthRef = useRef(rightWidth);

  useEffect(() => {
    const fitPanelsToWindow = (): void => {
      const compact = window.innerWidth <= 700 && !rightOpen;
      const leftIsTiled = leftOpen && !compact;
      const rightIsTiled = rightOpen;
      let nextLeftWidth = preferredLeftWidthRef.current;
      let nextRightWidth = preferredRightWidthRef.current;
      let deficit = Math.max(
        0,
        (leftIsTiled ? nextLeftWidth : 0)
          + (rightIsTiled ? nextRightWidth : 0)
          + MINIMUM_CONVERSATION_WIDTH
          - window.innerWidth,
      );

      if (deficit > 0 && rightIsTiled) {
        const reduction = Math.min(deficit, Math.max(0, nextRightWidth - MINIMUM_PANEL_WIDTH));
        nextRightWidth -= reduction;
        deficit -= reduction;
      }
      if (deficit > 0 && leftIsTiled) {
        const reduction = Math.min(deficit, Math.max(0, nextLeftWidth - MINIMUM_PANEL_WIDTH));
        nextLeftWidth -= reduction;
      }

      setLeftWidth(Math.round(leftIsTiled ? nextLeftWidth : preferredLeftWidthRef.current));
      setRightWidth(Math.round(rightIsTiled ? nextRightWidth : preferredRightWidthRef.current));
      void window.suocode.setWindowMinimumWidth(
        MINIMUM_CONVERSATION_WIDTH
          + (leftIsTiled ? MINIMUM_PANEL_WIDTH : 0)
          + (rightIsTiled ? MINIMUM_PANEL_WIDTH : 0),
      );
    };
    fitPanelsToWindow();
    window.addEventListener("resize", fitPanelsToWindow);
    return () => window.removeEventListener("resize", fitPanelsToWindow);
  }, [leftOpen, rightOpen]);

  const beginResize = useCallback((side: "left" | "right", event: ReactPointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = side === "left" ? leftWidth : rightWidth;
    let finalWidth = startWidth;
    const shell = event.currentTarget.closest(".app-shell") as HTMLElement | null;
    const cssVar = side === "left" ? "--sidebar-width" : "--inspector-width";
    document.body.classList.add("resizing-panels");
    const move = (pointer: PointerEvent): void => {
      const raw = side === "left" ? startWidth + pointer.clientX - startX : startWidth + startX - pointer.clientX;
      const oppositeWidth = side === "left"
        ? (rightOpen ? rightWidth : 0)
        : (leftOpen ? leftWidth : 0);
      const maximum = Math.max(MINIMUM_PANEL_WIDTH, window.innerWidth - oppositeWidth - MINIMUM_CONVERSATION_WIDTH);
      const width = Math.round(Math.max(MINIMUM_PANEL_WIDTH, Math.min(maximum, raw)));
      finalWidth = width;
      // Update layout via CSS only — avoid React re-rendering the chat tree every frame.
      shell?.style.setProperty(cssVar, `${width}px`);
    };
    const stop = (): void => {
      document.body.classList.remove("resizing-panels");
      window.removeEventListener("pointermove", move);
      if (side === "left") {
        preferredLeftWidthRef.current = finalWidth;
        setLeftWidth(finalWidth);
      } else {
        preferredRightWidthRef.current = finalWidth;
        setRightWidth(finalWidth);
      }
      window.localStorage.setItem(side === "left" ? LEFT_WIDTH_KEY : RIGHT_WIDTH_KEY, String(finalWidth));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }, [leftOpen, leftWidth, rightOpen, rightWidth]);

  return { leftOpen, rightOpen, leftWidth, rightWidth, setLeftOpen, setRightOpen, beginResize };
}
