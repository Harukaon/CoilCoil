import { useEffect, type RefObject } from "react";

/**
 * Keep an element's window-drag region in step with its size.
 *
 * Chromium hands Electron a list of draggable rectangles and only rebuilds it
 * when some element's `-webkit-app-region` actually changes. A rectangle that
 * merely moves or resizes - a pane opening, the window being resized, a header
 * growing a second line - leaves a stale rectangle behind, and the title bar
 * stops responding to drags until something else happens to dirty the list.
 * This is Electron's long-standing behaviour (electron/electron#21034, where a
 * fixed-height header survives horizontal resizes but not vertical ones).
 *
 * Toggling the property off and back on is what marks the list dirty, so the
 * region is rebuilt at the element's new size. It costs one style write per
 * resize and nothing at rest.
 */
export function useDraggableRegion(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      if (frame) return;
      element.style.setProperty("-webkit-app-region", "no-drag");
      frame = requestAnimationFrame(() => {
        frame = 0;
        element.style.removeProperty("-webkit-app-region");
      });
    });
    observer.observe(element);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
      element.style.removeProperty("-webkit-app-region");
    };
  }, [ref]);
}
