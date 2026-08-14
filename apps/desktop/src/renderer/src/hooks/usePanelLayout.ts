import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

const LEFT_WIDTH_KEY = "suocode.left-panel-width";
const RIGHT_WIDTH_KEY = "suocode.right-panel-width";
export const MINIMUM_CONVERSATION_WIDTH = 315;
export const MINIMUM_LEFT_PANEL_WIDTH = 167;
export const MINIMUM_RIGHT_PANEL_WIDTH = 40;

function panelMinimumWidth(side: "left" | "right"): number {
  return side === "left" ? MINIMUM_LEFT_PANEL_WIDTH : MINIMUM_RIGHT_PANEL_WIDTH;
}

function storedWidth(key: string, fallback: number, minimum: number): number {
  const value = Number(window.localStorage.getItem(key));
  return Math.max(minimum, Number.isFinite(value) && value > 0 ? value : fallback);
}

export function clampPanelWidth(side: "left" | "right", raw: number, windowWidth: number, oppositeWidth: number): number {
  const minimum = panelMinimumWidth(side);
  const maximum = Math.max(minimum, windowWidth - oppositeWidth - MINIMUM_CONVERSATION_WIDTH);
  return Math.round(Math.max(minimum, Math.min(maximum, raw)));
}

export function minimumWindowWidth(leftOpen: boolean, rightOpen: boolean): number {
  return MINIMUM_CONVERSATION_WIDTH
    + (leftOpen ? MINIMUM_LEFT_PANEL_WIDTH : 0)
    + (rightOpen ? MINIMUM_RIGHT_PANEL_WIDTH : 0);
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
  const [leftWidth, setLeftWidth] = useState(() => storedWidth(LEFT_WIDTH_KEY, 268, MINIMUM_LEFT_PANEL_WIDTH));
  const [rightWidth, setRightWidth] = useState(() => storedWidth(RIGHT_WIDTH_KEY, 352, MINIMUM_RIGHT_PANEL_WIDTH));
  const preferredLeftWidthRef = useRef(leftWidth);
  const preferredRightWidthRef = useRef(rightWidth);

  useEffect(() => {
    const fitPanelsToWindow = (): void => {
      const leftIsTiled = leftOpen;
      const rightIsTiled = rightOpen;
      let nextLeftWidth = Math.max(MINIMUM_LEFT_PANEL_WIDTH, preferredLeftWidthRef.current);
      let nextRightWidth = Math.max(MINIMUM_RIGHT_PANEL_WIDTH, preferredRightWidthRef.current);
      let deficit = Math.max(
        0,
        (leftIsTiled ? nextLeftWidth : 0)
          + (rightIsTiled ? nextRightWidth : 0)
          + MINIMUM_CONVERSATION_WIDTH
          - window.innerWidth,
      );

      if (deficit > 0 && rightIsTiled) {
        const reduction = Math.min(deficit, Math.max(0, nextRightWidth - MINIMUM_RIGHT_PANEL_WIDTH));
        nextRightWidth -= reduction;
        deficit -= reduction;
      }
      if (deficit > 0 && leftIsTiled) {
        const reduction = Math.min(deficit, Math.max(0, nextLeftWidth - MINIMUM_LEFT_PANEL_WIDTH));
        nextLeftWidth -= reduction;
      }

      setLeftWidth(Math.round(leftIsTiled ? nextLeftWidth : preferredLeftWidthRef.current));
      setRightWidth(Math.round(rightIsTiled ? nextRightWidth : preferredRightWidthRef.current));
      void window.suocode.setWindowMinimumWidth(minimumWindowWidth(leftIsTiled, rightIsTiled));
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
      const width = clampPanelWidth(side, raw, window.innerWidth, oppositeWidth);
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
