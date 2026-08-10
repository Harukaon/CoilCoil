import type { RuntimeContextItem, RuntimeContextItemKind, RuntimeToolDefinition } from "@suocode/runtime-protocol";

export const contextKindLabel: Record<RuntimeContextItemKind, string> = {
  user: "用户消息",
  assistant: "模型回复",
  reasoning: "思考内容",
  tool_call: "工具调用",
  tool_result: "工具结果",
  custom: "运行时数据",
};

export type GalaxyCategoryKey =
  | "system"
  | "toolDefs"
  | "user"
  | "assistant"
  | "reasoning"
  | "toolTraffic"
  | "custom"
  | "residual";

/**
 * Fixed order, never sorted by weight. Ranking the ring by size would make
 * categories swap places whenever one grows, so the whole graph would rearrange
 * between turns — motion that carries no information and reads as noise.
 */
const CATEGORY_ORDER: ReadonlyArray<{ key: GalaxyCategoryKey; label: string }> = [
  { key: "system", label: "系统提示词" },
  { key: "toolDefs", label: "工具定义" },
  { key: "user", label: contextKindLabel.user },
  { key: "assistant", label: contextKindLabel.assistant },
  { key: "reasoning", label: contextKindLabel.reasoning },
  { key: "toolTraffic", label: "工具活动" },
  { key: "custom", label: contextKindLabel.custom },
  { key: "residual", label: "其他 · 未归类" },
];

const KIND_CATEGORY: Record<RuntimeContextItemKind, GalaxyCategoryKey> = {
  user: "user",
  assistant: "assistant",
  reasoning: "reasoning",
  tool_call: "toolTraffic",
  tool_result: "toolTraffic",
  custom: "custom",
};

export interface ContextGalaxyInput {
  contextItems: RuntimeContextItem[];
  tools?: RuntimeToolDefinition[];
  estimates: {
    systemPrompt?: number;
    toolDefinitions?: number;
    messages?: number;
    total?: number;
  };
}

export interface GalaxyNode {
  id: string;
  parentId?: string;
  /** 0 = total, 1 = category, 2 = individual tool. */
  depth: 0 | 1 | 2;
  label: string;
  /** Raw tool name for depth-2 nodes, so the UI can localise it. */
  toolName?: string;
  tokens: number;
  /** Fraction of `denominator`, 0-1. */
  share: number;
  itemCount: number;
  detail?: string;
  x: number;
  y: number;
  radius: number;
}

export interface GalaxyLink {
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface ContextGalaxy {
  nodes: GalaxyNode[];
  links: GalaxyLink[];
  /** Everything we could classify, on the local chars/4 estimator. */
  classified: number;
  /** Provider-reported total, when available. */
  reportedTotal?: number;
  /** reportedTotal - classified, when positive and above the noise floor. */
  residual: number;
  /** classified - reportedTotal, when the estimates overshoot provider truth. */
  overshoot: number;
  /** What shares are taken against: max(reportedTotal, classified). */
  denominator: number;
  /** True when sector padding had to be squeezed to make everything fit. */
  tight: boolean;
  /** True when there is nothing to draw. */
  degenerate: boolean;
}

export const GALAXY_VIEWBOX = 100;
const CENTRE = GALAXY_VIEWBOX / 2;
const PAD = 3;
const GAP = 5;
const R_MIN = 1.2;
const SLOT_PAD = 3;
const R_MAX = CENTRE - PAD;
const TAU = Math.PI * 2;
/** Ignore a residual below this share of the denominator — it is rounding noise. */
const RESIDUAL_FLOOR = 0.002;
const DEFAULT_MAX_LEAVES = 10;

export interface GalaxyOptions {
  /** 1 keeps only the category ring — the panel thumbnail is too small for leaves. */
  depth?: 1 | 2;
  maxLeaves?: number;
}

interface LeafSeed {
  key: string;
  label: string;
  toolName?: string;
  tokens: number;
  itemCount: number;
  detail?: string;
}

interface CategorySeed {
  key: GalaxyCategoryKey;
  label: string;
  tokens: number;
  itemCount: number;
  detail?: string;
  leaves: LeafSeed[];
}

/**
 * Plain string comparison, not `localeCompare` — collation is environment
 * dependent, which would make the layout differ between machines and defeat the
 * determinism the whole design rests on.
 */
function byKey(left: { key: string }, right: { key: string }): number {
  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

function byTokensThenKey(left: LeafSeed, right: LeafSeed): number {
  return right.tokens - left.tokens || byKey(left, right);
}

function longestPreview(current: string | undefined, candidate: string): string | undefined {
  const next = candidate.trim();
  if (!next) return current;
  return !current || next.length > current.length ? next : current;
}

function safeTokens(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function collectSeeds(input: ContextGalaxyInput, maxLeaves: number): { seeds: CategorySeed[]; classified: number } {
  const seeds = new Map<GalaxyCategoryKey, CategorySeed>();
  const seedFor = (key: GalaxyCategoryKey): CategorySeed => {
    const existing = seeds.get(key);
    if (existing) return existing;
    const label = CATEGORY_ORDER.find((entry) => entry.key === key)?.label ?? key;
    const created: CategorySeed = { key, label, tokens: 0, itemCount: 0, leaves: [] };
    seeds.set(key, created);
    return created;
  };

  // These two are part of the context window but are not messages, so they only
  // exist in `estimates` and never appear among contextItems.
  const systemPrompt = safeTokens(input.estimates.systemPrompt ?? 0);
  if (systemPrompt > 0) {
    const seed = seedFor("system");
    seed.tokens = systemPrompt;
    seed.itemCount = 1;
  }

  const toolDefinitions = safeTokens(input.estimates.toolDefinitions ?? 0);
  if (toolDefinitions > 0) {
    const seed = seedFor("toolDefs");
    seed.tokens = toolDefinitions;
    seed.itemCount = 1;
    // `estimates.toolDefinitions` is exactly the sum over active tools, so these
    // leaves add up to their parent rather than approximating it.
    for (const tool of input.tools ?? []) {
      if (!tool.active) continue;
      const tokens = safeTokens(tool.estimatedTokens);
      if (tokens <= 0) continue;
      seed.leaves.push({
        key: tool.name,
        label: tool.name,
        toolName: tool.name,
        tokens,
        itemCount: 1,
        detail: tool.description || undefined,
      });
    }
  }

  const toolLeaves = new Map<string, LeafSeed>();
  for (const item of input.contextItems) {
    const tokens = safeTokens(item.estimatedTokens);
    if (tokens <= 0) continue;
    const key = KIND_CATEGORY[item.kind];
    if (!key) continue;
    const seed = seedFor(key);
    seed.tokens += tokens;
    seed.itemCount += 1;
    seed.detail = longestPreview(seed.detail, item.preview);
    if (key !== "toolTraffic") continue;
    // A call and its result are folded into one leaf: what the user wants to see
    // is the total cost of using `read`, not two half-answers.
    const toolName = item.toolName?.trim() || "未知工具";
    const leaf = toolLeaves.get(toolName)
      ?? { key: toolName, label: toolName, toolName, tokens: 0, itemCount: 0, detail: undefined };
    leaf.tokens += tokens;
    leaf.itemCount += 1;
    leaf.detail = longestPreview(leaf.detail, item.preview);
    toolLeaves.set(toolName, leaf);
  }
  const traffic = seeds.get("toolTraffic");
  if (traffic) traffic.leaves = [...toolLeaves.values()];

  const classified = [...seeds.values()].reduce((total, seed) => total + seed.tokens, 0);

  for (const seed of seeds.values()) {
    if (seed.leaves.length <= maxLeaves) continue;
    // Select by rank, then hand the survivors back in key order below — so a
    // leaf that grows changes size without swapping places with its neighbours.
    const ranked = [...seed.leaves].sort(byTokensThenKey);
    const kept = ranked.slice(0, maxLeaves - 1);
    const folded = ranked.slice(maxLeaves - 1);
    kept.push({
      key: "￿其他",
      label: `其他 ${folded.length} 项`,
      tokens: folded.reduce((total, leaf) => total + leaf.tokens, 0),
      itemCount: folded.reduce((total, leaf) => total + leaf.itemCount, 0),
      detail: folded.map((leaf) => leaf.label).join("、"),
    });
    seed.leaves = kept;
  }

  const ordered = CATEGORY_ORDER
    .map((entry) => seeds.get(entry.key))
    .filter((seed): seed is CategorySeed => Boolean(seed) && seed!.tokens > 0);
  for (const seed of ordered) seed.leaves.sort(byKey);
  return { seeds: ordered, classified };
}

const EMPTY: ContextGalaxy = {
  nodes: [],
  links: [],
  classified: 0,
  residual: 0,
  overshoot: 0,
  denominator: 0,
  tight: false,
  degenerate: true,
};

export function buildContextGalaxy(input: ContextGalaxyInput | undefined, options: GalaxyOptions = {}): ContextGalaxy {
  if (!input) return { ...EMPTY };
  const depth = options.depth ?? 2;
  const maxLeaves = Math.max(2, options.maxLeaves ?? DEFAULT_MAX_LEAVES);
  const { seeds, classified } = collectSeeds(input, maxLeaves);

  const reportedTotal = input.estimates.total;
  const gap = reportedTotal !== undefined ? reportedTotal - classified : 0;
  const denominatorBase = Math.max(reportedTotal ?? 0, classified);
  const residual = gap > 0 && gap >= denominatorBase * RESIDUAL_FLOOR ? gap : 0;
  // Estimates can overshoot provider truth (contextUsage lags a turn; chars/4
  // over-counts CJK). Never draw a negative band and never rescale the parts —
  // just report the discrepancy.
  const overshoot = gap < 0 ? -gap : 0;

  if (residual > 0) {
    seeds.push({ key: "residual", label: "其他 · 未归类", tokens: residual, itemCount: 0, leaves: [],
      detail: "服务端上报的总量减去可归类分项，包含消息封装与估算误差。" });
  }

  const denominator = seeds.reduce((total, seed) => total + seed.tokens, 0);
  if (!seeds.length || denominator <= 0) {
    return { ...EMPTY, classified, reportedTotal, residual, overshoot, denominator: 0 };
  }

  // One scale for the whole figure, so area really is proportional to tokens —
  // including for the root, which is a datum here rather than a decorative hub.
  const rootWeight = Math.sqrt(denominator);
  const categoryWeight = Math.max(0, ...seeds.map((seed) => Math.sqrt(seed.tokens)));
  const leafWeight = depth < 2
    ? 0
    : Math.max(0, ...seeds.flatMap((seed) => seed.leaves.map((leaf) => Math.sqrt(leaf.tokens))), 0);
  const weightSpan = rootWeight + 2 * categoryWeight + 2 * leafWeight;
  const scale = weightSpan > 0 ? (R_MAX - 2 * GAP) / weightSpan : 0;
  if (!(scale > 0)) {
    return { ...EMPTY, classified, reportedTotal, residual, overshoot, denominator };
  }

  const rootRadius = scale * rootWeight;
  const orbitCategory = rootRadius + GAP + scale * categoryWeight;
  const orbitLeaf = orbitCategory + scale * categoryWeight + GAP + scale * leafWeight;
  const radiusOf = (tokens: number): number => Math.max(R_MIN, scale * Math.sqrt(tokens));
  const outerOrbit = depth < 2 || leafWeight <= 0 ? orbitCategory : orbitLeaf;

  // Tangential demand drives the angular split. Sizing wedges by demand rather
  // than by tokens is what guarantees nothing collides: the whole overlap
  // question collapses to `demand <= circumference`.
  const measure = (slotPad: number): { demand: number; perCategory: number[]; perLeaf: number[][] } => {
    const perLeaf = seeds.map((seed) => seed.leaves.map((leaf) => 2 * radiusOf(leaf.tokens) + slotPad));
    const perCategory = seeds.map((seed, index) => {
      const leafDemand = perLeaf[index]!.reduce((total, value) => total + value, 0);
      const own = (2 * radiusOf(seed.tokens) + slotPad) * (outerOrbit / orbitCategory);
      return Math.max(leafDemand, own);
    });
    return { demand: perCategory.reduce((total, value) => total + value, 0), perCategory, perLeaf };
  };

  const circumference = TAU * outerOrbit;
  let slotPad = SLOT_PAD;
  let measured = measure(slotPad);
  let tight = false;
  if (measured.demand > circumference) {
    // Demand is affine in the padding, so the relaxation is closed-form.
    const slotCount = seeds.reduce((total, seed) => total + Math.max(1, seed.leaves.length), 0);
    const bare = measure(0);
    const room = circumference - bare.demand;
    slotPad = room > 0 ? Math.min(SLOT_PAD, room / Math.max(1, slotCount)) : 0;
    measured = measure(slotPad);
    tight = true;
  }

  const nodes: GalaxyNode[] = [{
    id: "root",
    depth: 0,
    label: "上下文总计",
    tokens: reportedTotal ?? denominator,
    share: 1,
    itemCount: input.contextItems.length,
    x: CENTRE,
    y: CENTRE,
    radius: rootRadius,
  }];
  const links: GalaxyLink[] = [];

  const connect = (parent: GalaxyNode, child: GalaxyNode): void => {
    const dx = child.x - parent.x;
    const dy = child.y - parent.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 1e-6) return;
    const ux = dx / distance;
    const uy = dy / distance;
    links.push({
      from: parent.id,
      to: child.id,
      x1: parent.x + ux * parent.radius,
      y1: parent.y + uy * parent.radius,
      x2: child.x - ux * child.radius,
      y2: child.y - uy * child.radius,
    });
  };

  // Start at 12 o'clock so the first category lands where the eye does.
  let cursor = -Math.PI / 2;
  const root = nodes[0]!;
  seeds.forEach((seed, index) => {
    const wedge = TAU * (measured.perCategory[index]! / measured.demand);
    const mid = cursor + wedge / 2;
    const node: GalaxyNode = {
      id: `cat:${seed.key}`,
      parentId: "root",
      depth: 1,
      label: seed.label,
      tokens: seed.tokens,
      share: seed.tokens / denominator,
      itemCount: seed.itemCount,
      detail: seed.detail,
      x: CENTRE + Math.cos(mid) * orbitCategory,
      y: CENTRE + Math.sin(mid) * orbitCategory,
      radius: radiusOf(seed.tokens),
    };
    nodes.push(node);
    connect(root, node);

    if (depth >= 2 && seed.leaves.length) {
      const demands = measured.perLeaf[index]!;
      const categoryDemand = demands.reduce((total, value) => total + value, 0);
      let leafCursor = cursor;
      seed.leaves.forEach((leaf, leafIndex) => {
        const slot = wedge * (demands[leafIndex]! / (categoryDemand || 1));
        const leafMid = leafCursor + slot / 2;
        const leafNode: GalaxyNode = {
          id: `cat:${seed.key}/${leaf.key}`,
          parentId: node.id,
          depth: 2,
          label: leaf.label,
          toolName: leaf.toolName,
          tokens: leaf.tokens,
          share: leaf.tokens / denominator,
          itemCount: leaf.itemCount,
          detail: leaf.detail,
          x: CENTRE + Math.cos(leafMid) * orbitLeaf,
          y: CENTRE + Math.sin(leafMid) * orbitLeaf,
          radius: radiusOf(leaf.tokens),
        };
        nodes.push(leafNode);
        connect(node, leafNode);
        leafCursor += slot;
      });
    }
    cursor += wedge;
  });

  return { nodes, links, classified, reportedTotal, residual, overshoot, denominator, tight, degenerate: false };
}

/**
 * `contextItems` is a fresh array on every inspection emission even when nothing
 * changed, so a reference-keyed memo never holds. `sessionRevision` alone is not
 * enough either — it only moves on compaction and rewind, not on new messages —
 * so the counts catch appends and the trailing token count catches the final
 * assistant block growing mid-stream.
 */
export function contextGalaxySignature(
  sessionRevision: number | undefined,
  input: ContextGalaxyInput | undefined,
): string {
  if (!input) return "empty";
  const { systemPrompt = 0, toolDefinitions = 0, messages = 0, total = 0 } = input.estimates;
  return [
    sessionRevision ?? 0,
    input.contextItems.length,
    input.tools?.length ?? 0,
    systemPrompt,
    toolDefinitions,
    messages,
    total,
    input.contextItems.at(-1)?.estimatedTokens ?? 0,
  ].join("|");
}

/** Flat, largest-first rows backing the table in the fullscreen board. */
export function contextGalaxyBreakdown(galaxy: ContextGalaxy): GalaxyNode[] {
  return galaxy.nodes
    .filter((node) => node.depth === 1)
    .sort((left, right) => right.tokens - left.tokens || (left.id < right.id ? -1 : 1));
}
