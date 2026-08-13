import type { BrowserViewBounds } from "../shared/desktop-api";

export interface NativeContentSize {
  width: number;
  height: number;
}

/**
 * Renderer DOM rectangles are expressed in CSS pixels. WebContentsView bounds
 * are expressed in the owning BrowserWindow's device-independent pixels.
 * Electron's page zoom changes the ratio between those two coordinate spaces.
 */
export function browserCssBoundsToDip(
  bounds: BrowserViewBounds,
  zoomFactor: number,
  content: NativeContentSize,
): BrowserViewBounds {
  const scale = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const contentWidth = Math.max(0, Math.round(Number.isFinite(content.width) ? content.width : 0));
  const contentHeight = Math.max(0, Math.round(Number.isFinite(content.height) ? content.height : 0));
  const scaledX = Math.round(bounds.x * scale);
  const scaledY = Math.round(bounds.y * scale);
  const x = Math.max(0, Math.min(scaledX, Math.max(0, contentWidth - 1)));
  const y = Math.max(0, Math.min(scaledY, Math.max(0, contentHeight - 1)));
  const availableWidth = Math.max(0, contentWidth - x);
  const availableHeight = Math.max(0, contentHeight - y);
  const scaledWidth = Math.max(0, Math.round(bounds.width * scale));
  const scaledHeight = Math.max(0, Math.round(bounds.height * scale));
  return {
    x,
    y,
    width: Math.min(scaledWidth, availableWidth),
    height: Math.min(scaledHeight, availableHeight),
    visible: bounds.visible,
  };
}
