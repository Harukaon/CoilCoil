import type { MemoryDocumentSnapshot } from "@coilcoil/runtime-protocol";

/**
 * The memory store laid out as a map instead of a list.
 *
 * Memory is already a tree — one global note, a folder per project, a file per
 * memory — and a column of collapsed rows showed none of that shape. Here the
 * global note sits at the centre, projects ring it, and a project's memories
 * appear as a block beside it when it is opened.
 *
 * **Every measurement here is a real pixel size, and the stylesheet is required
 * to match it.** The first version of this file placed cards by assuming each
 * one occupied 34px of ring; the cards were nearer 140px wide, so ninety-two
 * pairs of them overlapped and the whole map had to shrink to a third of its
 * size to fit, which made every label unreadable. Layout arithmetic that does
 * not use the true card size is arithmetic about nothing. If a card's size
 * changes in `memory.css`, it changes here in the same commit.
 *
 * The second rule the first version broke: a project with twenty-seven memories
 * cannot show them all and stay legible. Projects are closed by default, so the
 * resting state is one node per project — ten nodes, comfortably readable — and
 * opening one is a deliberate act that the layout then has room to honour.
 */

export const GLOBAL_NODE_ID = "__global__";

/* Card sizes. These mirror `.memory-node` in memory.css exactly. */
export const GLOBAL_SIZE = { width: 176, height: 64 };
export const PROJECT_SIZE = { width: 172, height: 56 };
export const ENTRY_SIZE = { width: 136, height: 28 };

/** Space between two memory chips inside an opened project's block. */
const ENTRY_GAP = 8;
/** Widest an opened block gets before it wraps to another row. */
const MAX_ENTRY_COLUMNS = 4;
/** Clear air between a project card and the block hanging off it. */
const BLOCK_GAP = 34;
/** Clear air between one project's footprint and the next one's. */
const RING_GAP = 54;
/** The ring never draws tighter than this, however few projects there are. */
const MIN_RING_RADIUS = 250;
/** Breathing room kept outside the outermost card. */
const MARGIN = 56;

export type NebulaNodeKind = "global" | "project" | "entry";

export interface NebulaNode {
  id: string;
  kind: NebulaNodeKind;
  label: string;
  /** Centre of the card, in canvas coordinates with the global node at 0,0. */
  x: number;
  y: number;
  width: number;
  height: number;
  chars: number;
  exists: boolean;
  projectName?: string;
  /** The file this node opens; absent on a project that has no index file yet. */
  filePath?: string;
  /** Memories hanging off this project. */
  childCount?: number;
  expanded?: boolean;
  /** First chip of an opened block; only this one gets a line from its project. */
  firstOfBlock?: boolean;
  parentId?: string;
}

export interface NebulaLink {
  from: string;
  to: string;
}

export interface NebulaLayout {
  nodes: NebulaNode[];
  links: NebulaLink[];
  width: number;
  height: number;
}

export interface MemoryProjectGroup {
  name: string;
  index?: MemoryDocumentSnapshot;
  entries: MemoryDocumentSnapshot[];
}

/**
 * Group the store's flat document list back into projects.
 *
 * Keyed by project name rather than built from the index files, because a
 * project can hold memories with no index — the file was deleted, or never
 * written — and it must still appear on the map.
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

export interface BlockShape {
  columns: number;
  rows: number;
  width: number;
  height: number;
}

/** The block an opened project's memories occupy: roughly square, never too wide. */
export function entryBlockShape(count: number): BlockShape {
  if (count <= 0) return { columns: 0, rows: 0, width: 0, height: 0 };
  const columns = Math.min(MAX_ENTRY_COLUMNS, Math.ceil(Math.sqrt(count)));
  const rows = Math.ceil(count / columns);
  return {
    columns,
    rows,
    width: columns * ENTRY_SIZE.width + (columns - 1) * ENTRY_GAP,
    height: rows * ENTRY_SIZE.height + (rows - 1) * ENTRY_GAP,
  };
}


/** Two cards touching is a bug, not a style; a little padding keeps them apart. */
const COLLISION_PADDING = 10;

function nodesOverlap(nodes: readonly NebulaNode[]): boolean {
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      // Chips inside one block are placed on a grid and cannot collide. They sit
      // closer together than the padding this test demands of strangers, so
      // counting them made every block look like a collision and the ring grew
      // fourteen times over without ever satisfying the check.
      if (a.parentId === b.parentId && a.kind === "entry" && b.kind === "entry") continue;
      if (Math.abs(a.x - b.x) * 2 < a.width + b.width + COLLISION_PADDING
        && Math.abs(a.y - b.y) * 2 < a.height + b.height + COLLISION_PADDING) return true;
    }
  }
  return false;
}

/** Every project and its open memories, placed around a ring of the given radius. */
function placeNodes(
  groups: readonly MemoryProjectGroup[],
  shapes: readonly BlockShape[],
  footprints: readonly number[],
  total: number,
  radius: number,
): NebulaNode[] {
  const placed: NebulaNode[] = [];
  let travelled = 0;
  groups.forEach((group, index) => {
    // Each project sits at the middle of the arc it was allotted.
    const angle = -Math.PI / 2 + ((travelled + footprints[index] / 2) / total) * 2 * Math.PI;
    travelled += footprints[index];
    const unit = { x: Math.cos(angle), y: Math.sin(angle) };
    const x = unit.x * radius;
    const y = unit.y * radius;
    const projectId = `project:${group.name}`;
    const shape = shapes[index];
    placed.push({
      id: projectId,
      kind: "project",
      label: group.name,
      x,
      y,
      ...PROJECT_SIZE,
      chars: group.index?.contentChars ?? 0,
      exists: group.index?.exists ?? false,
      projectName: group.name,
      filePath: group.index?.filePath,
      childCount: group.entries.length,
      expanded: shape.rows > 0,
      parentId: GLOBAL_NODE_ID,
    });
    if (!shape.rows) return;

    // The block sits further out along the same bearing but stays axis-aligned:
    // rotated cards follow the geometry and defeat the reader.
    //
    // How far out it has to go depends on the bearing. A project at the top of
    // the ring only needs to clear the block's half-height; one at the side has
    // to clear its half-width, which for an opened block is far larger. Using
    // the height regardless put every sideways block back on top of its own
    // project card. This is the support function of an axis-aligned box along
    // the bearing, for both boxes.
    const along = (width: number, height: number): number =>
      (Math.abs(unit.x) * width + Math.abs(unit.y) * height) / 2;
    const reach = along(PROJECT_SIZE.width, PROJECT_SIZE.height)
      + BLOCK_GAP
      + along(shape.width, shape.height);
    const blockX = x + unit.x * reach;
    const blockY = y + unit.y * reach;
    group.entries.forEach((entry, entryIndex) => {
      const column = entryIndex % shape.columns;
      const row = Math.floor(entryIndex / shape.columns);
      placed.push({
        id: entry.filePath,
        kind: "entry",
        label: entry.label,
        x: blockX - shape.width / 2 + column * (ENTRY_SIZE.width + ENTRY_GAP) + ENTRY_SIZE.width / 2,
        y: blockY - shape.height / 2 + row * (ENTRY_SIZE.height + ENTRY_GAP) + ENTRY_SIZE.height / 2,
        ...ENTRY_SIZE,
        chars: entry.contentChars,
        exists: entry.exists,
        projectName: group.name,
        filePath: entry.filePath,
        parentId: projectId,
        // One leader line per block, not one per chip: sixty-five is noise.
        firstOfBlock: entryIndex === 0,
      });
    });
  });
  return placed;
}

export function buildMemoryNebula(
  global: MemoryDocumentSnapshot | undefined,
  documents: readonly MemoryDocumentSnapshot[],
  expanded: ReadonlySet<string> = new Set(),
): NebulaLayout {
  const groups = groupMemoryProjects(documents);
  const nodes: NebulaNode[] = [{
    id: GLOBAL_NODE_ID,
    kind: "global",
    label: "全局记忆",
    x: 0,
    y: 0,
    ...GLOBAL_SIZE,
    chars: global?.contentChars ?? 0,
    exists: global?.exists ?? false,
    filePath: global?.filePath,
    childCount: groups.length,
  }];
  const links: NebulaLink[] = [];
  if (!groups.length) return { nodes, links, width: 640, height: 640 };

  // Each project claims ring space equal to how wide it actually draws, so an
  // opened project pushes its neighbours apart instead of drawing over them.
  const shapes = groups.map((group) => (
    expanded.has(group.name) ? entryBlockShape(group.entries.length) : entryBlockShape(0)
  ));
  const footprints = shapes.map((shape) => Math.max(PROJECT_SIZE.width, shape.width) + RING_GAP);
  const total = footprints.reduce((sum, width) => sum + width, 0);
  let radius = Math.max(MIN_RING_RADIUS, total / (2 * Math.PI));
  // Angular width alone is not enough once blocks are open: a tall block reaches
  // far enough outward to clip the one beside it, which arithmetic about widths
  // cannot see. Grow the ring until the drawn rectangles genuinely miss each
  // other. Bounded, because a ring that will not settle must still return.
  for (let attempt = 0; attempt < 14; attempt++) {
    if (!nodesOverlap(placeNodes(groups, shapes, footprints, total, radius))) break;
    radius *= 1.09;
  }

  nodes.push(...placeNodes(groups, shapes, footprints, total, radius));
  for (const node of nodes) {
    if (node.parentId === GLOBAL_NODE_ID) links.push({ from: GLOBAL_NODE_ID, to: node.id });
    else if (node.parentId && node.kind === "entry" && node.firstOfBlock) links.push({ from: node.parentId, to: node.id });
  }

  const reachX = nodes.reduce((far, node) => Math.max(far, Math.abs(node.x) + node.width / 2), 0);
  const reachY = nodes.reduce((far, node) => Math.max(far, Math.abs(node.y) + node.height / 2), 0);
  return {
    nodes,
    links,
    width: (reachX + MARGIN) * 2,
    height: (reachY + MARGIN) * 2,
  };
}

/** Where the canvas origin sits inside the laid-out box. */
