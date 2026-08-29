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

/** Swap a section with its neighbour; at either end the order is unchanged. */
export function moveSidebarSection(
  order: readonly SidebarSection[],
  section: SidebarSection,
  direction: "up" | "down",
): SidebarSection[] {
  const index = order.indexOf(section);
  const target = index + (direction === "up" ? -1 : 1);
  if (index < 0 || target < 0 || target >= order.length) return [...order];
  const next = [...order];
  next[index] = order[target] as SidebarSection;
  next[target] = section;
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
