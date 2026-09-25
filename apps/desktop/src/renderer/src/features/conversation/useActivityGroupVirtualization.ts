import { useEffect } from "react";
import type { RefObject } from "react";

const GROUP_SELECTOR = "details.tool-activity";
export const OFFSCREEN_CLASS = "tool-activity-offscreen";
export const PLACEHOLDER_HEIGHT = "--tool-activity-placeholder-height";
/** Restore roughly one viewport before a summary can scroll into view. */
export const NEARBY_MARGIN = "800px 0px";

type ObserverConstructors = {
  IntersectionObserver: typeof IntersectionObserver;
  MutationObserver: typeof MutationObserver;
};

function isElement(node: unknown): node is Element {
  return typeof node === "object" && node !== null && (node as Node).nodeType === 1;
}

function activityGroupsIn(node: Node): HTMLDetailsElement[] {
  if (!isElement(node)) return [];
  const groups: HTMLDetailsElement[] = [];
  if (node.matches(GROUP_SELECTOR)) groups.push(node as HTMLDetailsElement);
  groups.push(...node.querySelectorAll<HTMLDetailsElement>(GROUP_SELECTOR));
  return groups;
}

/**
 * Keep the hundreds of collapsed activity summaries in a long transcript from
 * all joining every width reflow. Groups near the viewport stay completely
 * normal; distant closed groups keep their measured block height but skip their
 * subtree. Returns the cleanup that restores every group it touched.
 *
 * Invariant: a closed group is a single `nowrap` summary line, so its height does
 * not depend on its text or width and a parked placeholder never goes stale when
 * the summary updates while streaming.
 *
 * Trade-off: a parked summary is skipped by Tab and in-page find until it comes
 * within the margin. `content-visibility: auto` would keep it reachable, but in
 * measurement it saved almost none of the reflow this exists to avoid.
 */
export function virtualizeActivityGroups(
  root: HTMLElement,
  observers: ObserverConstructors = { IntersectionObserver, MutationObserver },
): () => void {
  const observed = new Set<HTMLDetailsElement>();
  const nearby = new WeakMap<HTMLDetailsElement, boolean>();

  const reveal = (group: HTMLDetailsElement): void => {
    group.classList.remove(OFFSCREEN_CLASS);
    group.style.removeProperty(PLACEHOLDER_HEIGHT);
  };

  const park = (group: HTMLDetailsElement, measuredHeight?: number): void => {
    if (group.open) {
      reveal(group);
      return;
    }
    const height = measuredHeight && measuredHeight > 0
      ? measuredHeight
      : group.getBoundingClientRect().height;
    if (!Number.isFinite(height) || height <= 0) return;
    group.style.setProperty(PLACEHOLDER_HEIGHT, `${height}px`);
    group.classList.add(OFFSCREEN_CLASS);
  };

  const intersections = new observers.IntersectionObserver((entries) => {
    for (const entry of entries) {
      const group = entry.target as HTMLDetailsElement;
      nearby.set(group, entry.isIntersecting);
      if (entry.isIntersecting || group.open) reveal(group);
      else park(group, entry.boundingClientRect.height);
    }
  }, { root, rootMargin: NEARBY_MARGIN });

  const observeTree = (node: Node): void => {
    for (const group of activityGroupsIn(node)) {
      if (observed.has(group)) continue;
      observed.add(group);
      intersections.observe(group);
    }
  };

  const unobserveTree = (node: Node): void => {
    for (const group of activityGroupsIn(node)) {
      if (!observed.delete(group)) continue;
      intersections.unobserve(group);
      nearby.delete(group);
      reveal(group);
    }
  };

  observeTree(root);
  const mutations = new observers.MutationObserver((records) => {
    for (const record of records) {
      record.removedNodes.forEach(unobserveTree);
      record.addedNodes.forEach(observeTree);
    }
  });
  mutations.observe(root, { childList: true, subtree: true });

  const handleToggle = (event: Event): void => {
    const group = event.target;
    if (!isElement(group) || !group.matches(GROUP_SELECTOR)) return;
    const details = group as HTMLDetailsElement;
    if (details.open || nearby.get(details) !== false) reveal(details);
    else park(details);
  };
  // `toggle` does not bubble; capture lets one root listener handle every group.
  root.addEventListener("toggle", handleToggle, true);

  return () => {
    mutations.disconnect();
    intersections.disconnect();
    root.removeEventListener("toggle", handleToggle, true);
    observed.forEach(reveal);
    observed.clear();
  };
}

/** `rootRef` must point at the conversation's scroll container, which stays mounted for the pane's lifetime. */
export function useActivityGroupVirtualization(rootRef: RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver === "undefined" || typeof MutationObserver === "undefined") return;
    return virtualizeActivityGroups(root);
  }, [rootRef]);
}
