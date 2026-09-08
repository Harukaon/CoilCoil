import type { MemoryDocumentSnapshot } from "@coilcoil/runtime-protocol";

/**
 * The memory store laid out as a picture instead of a list.
 *
 * Memory is already a tree — one global note, a folder per project, and a file
 * per memory under each — but the panel used to render it as a flat column of
 * collapsed rows, which shows the shape of nothing. Here the same tree becomes
 * a map: global at the centre, projects orbiting it, each project's memories
 * orbiting their project.
 *
 * The layout is computed, never simulated. A force-directed graph settles into a
 * different arrangement every time it is opened, so the memory you found on the
 * left yesterday is on the right today; positions here are a pure function of
 * the store's contents, so a memory stays where you last saw it until the store
 * itself changes.
 */

export const GLOBAL_NODE_ID = "__global__";

/** Roughly how much ring each orbiting card is given, in pixels of circumference. */
const ENTRY_ARC = 34;
const PROJECT_GAP = 56;
const MIN_ENTRY_ORBIT = 96;
const MIN_PROJECT_ORBIT = 260;
/** Padding kept around the outermost card so nothing touches the canvas edge. */
const MARGIN = 120;

export type NebulaNodeKind = "global" | "project" | "entry";

export interface NebulaNode {
  id: string;
  kind: NebulaNodeKind;
  label: string;
  x: number;
  y: number;
  chars: number;
  exists: boolean;
  /** Which project this belongs to; absent on the global node. */
  projectName?: string;
  /** The file to open when this node is selected; absent on synthesized project nodes. */
  filePath?: string;
  /** How many memories hang off this node, for the project cards. */
  childCount?: number;
  parentId?: string;
}

export interface NebulaLink {
  from: string;
  to: string;
}

export interface NebulaLayout {
  nodes: NebulaNode[];
  links: NebulaLink[];
  /** Canvas size that contains every node with room to breathe. */
  width: number;
  height: number;
}

export interface MemoryProjectGroup {
  name: string;
  /** The project's MEMORY.md, when it has one. */
  index?: MemoryDocumentSnapshot;
  entries: MemoryDocumentSnapshot[];
}

/**
 * Group the store's flat document list back into projects.
 *
 * The list mixes each project's index with its bodies, and a project can have
 * bodies without an index (the file was deleted, or never written), so the group
 * is keyed by project name rather than built from the indexes.
 */
export function groupMemoryProjects(documents: readonly MemoryDocumentSnapshot[]): MemoryProjectGroup[] {
  const groups = new Map<string, MemoryProjectGroup>();
  for (const document of documents) {
    const name = document.projectName ?? document.label;
    const group = groups.get(name) ?? { name, entries: [] };
    if (document.kind === "entry") group.entries.push(document);
    else group.index = document;
    groups.set(name, group);
  }
  return [...groups.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-Hans"));
}

/** Circumference-driven radius, so a crowded ring grows instead of overlapping. */
function orbitFor(count: number, arc: number, minimum: number): number {
  return Math.max(minimum, (count * arc) / (2 * Math.PI));
}

/**
 * Place the whole store on a canvas.
 *
 * Angles start at the top and run clockwise, so the first project is where the
 * eye lands. A project's memories are spread over the full circle around it
 * rather than a wedge facing outward: a wedge looks tidier with three memories
 * and unreadable with twenty.
 */
export function buildMemoryNebula(
  global: MemoryDocumentSnapshot | undefined,
  documents: readonly MemoryDocumentSnapshot[],
): NebulaLayout {
  const groups = groupMemoryProjects(documents);
  const nodes: NebulaNode[] = [{
    id: GLOBAL_NODE_ID,
    kind: "global",
    label: "全局记忆",
    x: 0,
    y: 0,
    chars: global?.contentChars ?? 0,
    exists: global?.exists ?? false,
    filePath: global?.filePath,
    childCount: groups.length,
  }];
  const links: NebulaLink[] = [];

  const widestOrbit = groups.reduce(
    (widest, group) => Math.max(widest, orbitFor(group.entries.length, ENTRY_ARC, MIN_ENTRY_ORBIT)),
    MIN_ENTRY_ORBIT,
  );
  const projectOrbit = groups.length
    ? Math.max(MIN_PROJECT_ORBIT, (groups.length * (2 * widestOrbit + PROJECT_GAP)) / (2 * Math.PI))
    : 0;

  groups.forEach((group, index) => {
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / Math.max(1, groups.length);
    const x = Math.cos(angle) * projectOrbit;
    const y = Math.sin(angle) * projectOrbit;
    const projectId = `project:${group.name}`;
    nodes.push({
      id: projectId,
      kind: "project",
      label: group.name,
      x,
      y,
      chars: group.index?.contentChars ?? 0,
      exists: group.index?.exists ?? false,
      projectName: group.name,
      filePath: group.index?.filePath,
      childCount: group.entries.length,
      parentId: GLOBAL_NODE_ID,
    });
    links.push({ from: GLOBAL_NODE_ID, to: projectId });

    const orbit = orbitFor(group.entries.length, ENTRY_ARC, MIN_ENTRY_ORBIT);
    group.entries.forEach((entry, entryIndex) => {
      // Offset by the project's own angle so neighbouring projects do not both
      // start their ring at the same bearing and read as one blurred band.
      const entryAngle = angle + (entryIndex * 2 * Math.PI) / Math.max(1, group.entries.length);
      nodes.push({
        id: entry.filePath,
        kind: "entry",
        label: entry.label,
        x: x + Math.cos(entryAngle) * orbit,
        y: y + Math.sin(entryAngle) * orbit,
        chars: entry.contentChars,
        exists: entry.exists,
        projectName: group.name,
        filePath: entry.filePath,
        parentId: projectId,
      });
      links.push({ from: projectId, to: entry.filePath });
    });
  });

  const reach = nodes.reduce(
    (furthest, node) => Math.max(furthest, Math.abs(node.x), Math.abs(node.y)),
    MIN_PROJECT_ORBIT / 2,
  );
  const size = (reach + MARGIN) * 2;
  return { nodes, links, width: size, height: size };
}

/** Where the canvas origin sits inside the laid-out box, so nodes can be drawn from it. */
export function nebulaCentre(layout: NebulaLayout): { x: number; y: number } {
  return { x: layout.width / 2, y: layout.height / 2 };
}

/** The zoom range the canvas allows; outside it the map is either unreadable or pointless. */
export const NEBULA_MIN_ZOOM = 0.35;
export const NEBULA_MAX_ZOOM = 2;

export function clampZoom(value: number): number {
  return Math.min(NEBULA_MAX_ZOOM, Math.max(NEBULA_MIN_ZOOM, value));
}

/** The zoom that fits the whole map in a viewport, never enlarging past 1:1. */
export function zoomToFit(layout: NebulaLayout, viewportWidth: number, viewportHeight: number): number {
  if (viewportWidth <= 0 || viewportHeight <= 0) return 1;
  return clampZoom(Math.min(1, viewportWidth / layout.width, viewportHeight / layout.height));
}
