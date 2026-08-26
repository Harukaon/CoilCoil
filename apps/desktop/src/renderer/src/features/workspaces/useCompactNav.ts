import { useEffect, useState, type RefObject } from "react";

/**
 * Roughly what the one-row nav gives back: three 34px buttons and their gaps
 * become one row. Used as the hysteresis threshold, so it only has to be close.
 */
export const NAV_COMPACT_SAVING = 72;
/** Extra slack required before going back, so a list sitting at the boundary does not flip. */
const RESTORE_MARGIN = 24;

/**
 * Whether the sidebar's three primary buttons should collapse into one row.
 *
 * They are worth their height while the sidebar is mostly empty. Once enough
 * workspaces are mounted that the list scrolls, that stack is three rows of
 * conversations the user has to scroll past on every visit, so the buttons give
 * up their labels instead.
 *
 * Going back needs more room than staying compact, otherwise expanding the nav
 * would re-create the overflow that compacted it and the layout would oscillate
 * on every render.
 */
export function shouldCompactNav(current: boolean, scrollHeight: number, clientHeight: number): boolean {
  if (clientHeight <= 0) return current;
  const overflow = scrollHeight - clientHeight;
  if (!current) return overflow > 0;
  return overflow > -(NAV_COMPACT_SAVING + RESTORE_MARGIN);
}

/**
 * Track whether the scrolling list in `ref` has outgrown its space.
 *
 * Both the container's size and its contents move the answer - a window resize,
 * a workspace expanding, a conversation arriving - so both are watched, and the
 * measurement is deferred to an animation frame to keep the reads out of the
 * observer callbacks that triggered them.
 */
export function useCompactNav(ref: RefObject<HTMLElement | null>): boolean {
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame = 0;
    const measure = (): void => {
      frame = 0;
      setCompact((current) => shouldCompactNav(current, element.scrollHeight, element.clientHeight));
    };
    const schedule = (): void => {
      if (frame) return;
      frame = requestAnimationFrame(measure);
    };
    schedule();
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    const mutation = new MutationObserver(schedule);
    mutation.observe(element, { childList: true, subtree: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
    };
  }, [ref]);

  return compact;
}
