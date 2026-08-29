/**
 * The order of the sidebar's two movable sections.
 *
 * "Recent" and "Projects" are useful to different people in different weeks: a
 * few long-lived workspaces you navigate by folder want the tree on top, while
 * hopping between many conversations wants the recent list there. Rather than
 * guess, the two swap places and the choice is remembered.
 *
 * The pinned block is not part of this - it is a short, always-topmost strip.
 */
export type SidebarSection = "recent" | "projects";

export const SIDEBAR_SECTION_ORDER_KEY = "coilcoil.sidebar-section-order";

/** Recent on top, the way the sidebar has always opened. */
export const DEFAULT_SIDEBAR_SECTION_ORDER: readonly SidebarSection[] = ["recent", "projects"];

export const SIDEBAR_SECTION_LABELS: Record<SidebarSection, string> = { recent: "最近", projects: "项目" };

function isSidebarSection(value: string): value is SidebarSection {
  return value === "recent" || value === "projects";
}

/**
 * Read a stored order back, repairing anything unexpected.
 *
 * A section missing from the stored value is appended in its default position
 * rather than dropped: a preference written by an older build must never be
 * able to hide a whole section.
 */
export function resolveSidebarSectionOrder(stored: string | null | undefined): SidebarSection[] {
  const parsed = (stored ?? "").split(",").map((part) => part.trim()).filter(isSidebarSection);
  const order = parsed.filter((section, index) => parsed.indexOf(section) === index);
  for (const section of DEFAULT_SIDEBAR_SECTION_ORDER) {
    if (!order.includes(section)) order.push(section);
  }
  return order;
}

export function serializeSidebarSectionOrder(order: readonly SidebarSection[]): string {
  return order.join(",");
}

/**
 * Drop one section onto another: the dragged one lands where the target was and
 * everything else closes up behind it.
 *
 * With today's two sections that is simply a swap, but this is written as a real
 * move so a third section later cannot silently get the wrong behaviour. A drop
 * on itself, or on anything not in the order, leaves the order untouched.
 */
export function dropSidebarSection(
  order: readonly SidebarSection[],
  dragged: SidebarSection,
  target: SidebarSection,
): SidebarSection[] {
  const from = order.indexOf(dragged);
  const to = order.indexOf(target);
  if (from < 0 || to < 0 || from === to) return [...order];
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, dragged);
  return next;
}

export function loadSidebarSectionOrder(): SidebarSection[] {
  try {
    return resolveSidebarSectionOrder(window.localStorage.getItem(SIDEBAR_SECTION_ORDER_KEY));
  } catch {
    return [...DEFAULT_SIDEBAR_SECTION_ORDER];
  }
}

export function saveSidebarSectionOrder(order: readonly SidebarSection[]): void {
  try {
    window.localStorage.setItem(SIDEBAR_SECTION_ORDER_KEY, serializeSidebarSectionOrder(order));
  } catch {
    // Losing the preference is not worth failing the click over.
  }
}
