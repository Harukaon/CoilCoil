import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

const LEFT_WIDTH_KEY = "coilcoil.left-panel-width";
const RIGHT_WIDTH_KEY = "coilcoil.right-panel-width";
export const MINIMUM_CONVERSATION_WIDTH = 315;
/**
 * The narrowest window that may host an open inspector without being moved.
 *
 * Above this the layout has room to give and opening the inspector costs the
 * conversation its width, never the window's position. Only a window narrower
 * than this grows to the right, and only far enough to reach this width.
 */
export const PANEL_OPEN_WINDOW_WIDTH = 840;
export const MINIMUM_LEFT_PANEL_WIDTH = 167;
/** Width of the sidebar until the user drags it. Mirrored by `--sidebar-width` for the first paint. */
export const DEFAULT_LEFT_PANEL_WIDTH = 235;
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

/**
 * How much wider the window has to get for a panel to open.
 *
 * The panel's own width does not enter into it. What matters is whether the
 * window is wide enough to host the panel at all: at or above the threshold the
 * conversation gives up the pixels and the window stays exactly where it is.
 */
export function panelOpenGrowth(windowWidth: number): number {
  return Math.max(0, Math.ceil(PANEL_OPEN_WINDOW_WIDTH - windowWidth));
}

/**
 * Share a window too narrow for every panel's preferred width.
 *
 * The conversation and the inspector aim for two columns of the same width, so
 * a window grown to the 840 threshold reads as an even split rather than a wide
 * chat beside a sliver. Splitting the *shortfall* evenly instead left the
 * conversation its 315px head start and came out 423 / 149. The conversation's
 * floor still wins when even that will not fit, and the sidebar is asked last.
 */
export function fitPanelWidths({ windowWidth, leftOpen, rightOpen, preferredLeftWidth, preferredRightWidth }: {
  windowWidth: number;
  leftOpen: boolean;
  rightOpen: boolean;
  preferredLeftWidth: number;
  preferredRightWidth: number;
}): { leftWidth: number; rightWidth: number } {
  let leftWidth = Math.max(MINIMUM_LEFT_PANEL_WIDTH, preferredLeftWidth);
  let rightWidth = Math.max(MINIMUM_RIGHT_PANEL_WIDTH, preferredRightWidth);

  if (rightOpen) {
    const shared = windowWidth - (leftOpen ? leftWidth : 0);
    rightWidth = Math.max(
      MINIMUM_RIGHT_PANEL_WIDTH,
      Math.min(rightWidth, Math.round(shared / 2), shared - MINIMUM_CONVERSATION_WIDTH),
    );
  }

  const deficit = Math.max(
    0,
    (leftOpen ? leftWidth : 0) + (rightOpen ? rightWidth : 0) + MINIMUM_CONVERSATION_WIDTH - windowWidth,
  );
  if (deficit > 0 && leftOpen) leftWidth -= Math.min(deficit, Math.max(0, leftWidth - MINIMUM_LEFT_PANEL_WIDTH));

  return { leftWidth: Math.round(leftWidth), rightWidth: Math.round(rightWidth) };
}

export function usePanelLayout(options: {
  rightOpen?: boolean;
  onRightOpenChange?: (open: boolean) => void;
} = {}): {
  leftOpen: boolean;
  rightOpen: boolean;
  leftWidth: number;
  rightWidth: number;
  setLeftOpen: (open: boolean) => void;
  setRightOpen: (open: boolean) => void;
  beginResize: (side: "left" | "right", event: ReactPointerEvent<HTMLDivElement>) => void;
} {
  const [leftOpen, setLeftOpen] = useState(true);
  const [localRightOpen, setLocalRightOpen] = useState(false);
  const rightOpen = options.rightOpen ?? localRightOpen;
  const setRightOpen = useCallback((open: boolean): void => {
    if (options.onRightOpenChange) options.onRightOpenChange(open);
    else setLocalRightOpen(open);
  }, [options.onRightOpenChange]);
  const [leftWidth, setLeftWidth] = useState(() => storedWidth(LEFT_WIDTH_KEY, DEFAULT_LEFT_PANEL_WIDTH, MINIMUM_LEFT_PANEL_WIDTH));
  const [rightWidth, setRightWidth] = useState(() => storedWidth(RIGHT_WIDTH_KEY, 352, MINIMUM_RIGHT_PANEL_WIDTH));
  const preferredLeftWidthRef = useRef(leftWidth);
  const preferredRightWidthRef = useRef(rightWidth);
  const rightWasOpenRef = useRef(rightOpen);

  // A window too narrow to host the inspector at all reaches for the pixels it
  // needs; every wider window pays for the panel out of the conversation.
  useEffect(() => {
    const justOpened = rightOpen && !rightWasOpenRef.current;
    rightWasOpenRef.current = rightOpen;
    if (!justOpened) return;
    const growth = panelOpenGrowth(window.innerWidth);
    if (growth > 0) void window.coilcoil.growWindowWidth(growth);
  }, [rightOpen]);

  useEffect(() => {
    const fitPanelsToWindow = (): void => {
      const fitted = fitPanelWidths({
        windowWidth: window.innerWidth,
        leftOpen,
        rightOpen,
        preferredLeftWidth: preferredLeftWidthRef.current,
        preferredRightWidth: preferredRightWidthRef.current,
      });
      setLeftWidth(leftOpen ? fitted.leftWidth : Math.round(preferredLeftWidthRef.current));
      setRightWidth(rightOpen ? fitted.rightWidth : Math.round(preferredRightWidthRef.current));
      void window.coilcoil.setWindowMinimumWidth(minimumWindowWidth(leftOpen, rightOpen));
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
