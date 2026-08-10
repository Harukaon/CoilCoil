import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeContextItem, RuntimeContextItemKind, RuntimeToolDefinition } from "@suocode/runtime-protocol";
import {
  buildContextGalaxy,
  contextGalaxyBreakdown,
  contextGalaxySignature,
  GALAXY_VIEWBOX,
  type ContextGalaxy,
  type ContextGalaxyInput,
  type GalaxyNode,
} from "../src/renderer/src/features/runtime/contextGalaxyModel.ts";

let sequence = 0;
function item(
  kind: RuntimeContextItemKind,
  estimatedTokens: number,
  toolName?: string,
  preview = "",
): RuntimeContextItem {
  sequence += 1;
  return {
    id: `ctx-${sequence}`,
    kind,
    label: kind,
    preview,
    estimatedTokens,
    active: true,
    ...(toolName ? { toolName } : {}),
  };
}

function tool(name: string, estimatedTokens: number, active = true): RuntimeToolDefinition {
  return { name, description: `${name} description`, source: "builtin", active, estimatedTokens };
}

function input(
  contextItems: RuntimeContextItem[],
  estimates: ContextGalaxyInput["estimates"] = {},
  tools?: RuntimeToolDefinition[],
): ContextGalaxyInput {
  return { contextItems, estimates, ...(tools ? { tools } : {}) };
}

function node(galaxy: ContextGalaxy, id: string): GalaxyNode {
  const found = galaxy.nodes.find((candidate) => candidate.id === id);
  assert.ok(found, `expected a node with id ${id}`);
  return found;
}

function ids(galaxy: ContextGalaxy, depth: number): string[] {
  return galaxy.nodes.filter((entry) => entry.depth === depth).map((entry) => entry.id);
}

// --- classification -------------------------------------------------------

test("a call and its result are one tool, not two", () => {
  const galaxy = buildContextGalaxy(input([
    item("tool_call", 60, "read"),
    item("tool_result", 640, "read"),
    item("tool_result", 200, "bash"),
  ]));
  // Splitting these would show `read` twice and answer nobody's question.
  assert.equal(node(galaxy, "cat:toolTraffic/read").tokens, 700);
  assert.equal(node(galaxy, "cat:toolTraffic/read").itemCount, 2);
  assert.equal(node(galaxy, "cat:toolTraffic").tokens, 900);
});

test("kinds with no tool name stay aggregated", () => {
  const galaxy = buildContextGalaxy(input([
    item("user", 90), item("user", 60), item("assistant", 50), item("reasoning", 40),
  ]));
  assert.equal(node(galaxy, "cat:user").tokens, 150);
  assert.equal(node(galaxy, "cat:user").itemCount, 2);
  assert.ok(!galaxy.nodes.some((entry) => entry.depth === 2));
});

test("nameless tool traffic is surfaced, not silently dropped", () => {
  const galaxy = buildContextGalaxy(input([item("tool_result", 500)]));
  assert.equal(node(galaxy, "cat:toolTraffic/未知工具").tokens, 500);
});

test("tool definitions come from the active tools and add up to their parent", () => {
  const galaxy = buildContextGalaxy(input([], { toolDefinitions: 300 }, [
    tool("read", 120), tool("bash", 180), tool("retired", 999, false),
  ]));
  assert.equal(node(galaxy, "cat:toolDefs").tokens, 300);
  const leaves = galaxy.nodes.filter((entry) => entry.parentId === "cat:toolDefs");
  assert.equal(leaves.reduce((total, leaf) => total + leaf.tokens, 0), 300);
  assert.ok(!leaves.some((leaf) => leaf.label === "retired"));
});

test("an item flagged inactive still counts", () => {
  // Upstream hardcodes `active: true`, so honouring the flag would be theatre.
  const galaxy = buildContextGalaxy(input([{ ...item("user", 500), active: false }]));
  assert.equal(node(galaxy, "cat:user").tokens, 500);
});

test("categories keep their declared order however the weights fall", () => {
  const heavyTools = buildContextGalaxy(input([item("user", 10), item("tool_result", 9_000, "read")]));
  const heavyUser = buildContextGalaxy(input([item("user", 9_000), item("tool_result", 10, "read")]));
  // Ordering the ring by size would make categories trade places as one grows.
  assert.deepEqual(ids(heavyTools, 1), ["cat:user", "cat:toolTraffic"]);
  assert.deepEqual(ids(heavyUser, 1), ["cat:user", "cat:toolTraffic"]);
});

test("node ids survive a compaction that renumbers every item", () => {
  const before = buildContextGalaxy(input([item("tool_result", 300, "read"), item("user", 200)]));
  sequence += 1_000;
  const after = buildContextGalaxy(input([item("tool_result", 300, "read"), item("user", 200)]));
  assert.deepEqual(before.nodes.map((entry) => entry.id), after.nodes.map((entry) => entry.id));
});

test("surplus tools fold into one bucket that keeps their weight", () => {
  const items = Array.from({ length: 12 }, (_, index) => item("tool_result", 100 - index, `tool-${index}`));
  const galaxy = buildContextGalaxy(input(items), { maxLeaves: 4 });
  const leaves = galaxy.nodes.filter((entry) => entry.depth === 2);
  assert.equal(leaves.length, 4);
  const folded = leaves.find((leaf) => leaf.label.startsWith("其他"));
  assert.ok(folded, "expected a folded bucket");
  assert.equal(leaves.reduce((total, leaf) => total + leaf.tokens, 0), node(galaxy, "cat:toolTraffic").tokens);
});

// --- honesty about the two estimators ------------------------------------

test("the gap between reported and classified totals is drawn, not absorbed", () => {
  const galaxy = buildContextGalaxy(input([item("user", 1_000)], { systemPrompt: 1_000, total: 4_000 }));
  assert.equal(galaxy.classified, 2_000);
  assert.equal(galaxy.residual, 2_000);
  assert.equal(node(galaxy, "cat:residual").tokens, 2_000);
  // The parts keep their own numbers rather than being scaled up to the total.
  assert.equal(node(galaxy, "cat:user").tokens, 1_000);
  assert.equal(node(galaxy, "cat:system").tokens, 1_000);
});

test("estimates overshooting provider truth never draw a negative band", () => {
  const galaxy = buildContextGalaxy(input([item("user", 5_000)], { total: 4_000 }));
  assert.equal(galaxy.residual, 0);
  assert.equal(galaxy.overshoot, 1_000);
  assert.ok(!galaxy.nodes.some((entry) => entry.id === "cat:residual"));
  assert.ok(galaxy.nodes.every((entry) => entry.tokens >= 0 && entry.share <= 1));
  // Shares fall back to the parts sum, so nothing exceeds 100%.
  assert.equal(galaxy.denominator, 5_000);
});

test("a rounding-sized gap is noise, not a category", () => {
  const galaxy = buildContextGalaxy(input([item("user", 1_000)], { total: 1_001 }));
  assert.equal(galaxy.residual, 0);
  assert.ok(!galaxy.nodes.some((entry) => entry.id === "cat:residual"));
});

test("the root reports the provider's number even when the parts disagree", () => {
  const galaxy = buildContextGalaxy(input([item("user", 5_000)], { total: 4_000 }));
  assert.equal(node(galaxy, "root").tokens, 4_000);
});

test("shares are taken against the drawn total", () => {
  const galaxy = buildContextGalaxy(input([item("user", 1_000)], { total: 2_000 }));
  assert.equal(node(galaxy, "cat:user").share, 0.5);
  assert.equal(node(galaxy, "cat:residual").share, 0.5);
});

// --- geometry -------------------------------------------------------------

const busy = (): ContextGalaxyInput => input([
  item("tool_result", 9_000, "read"),
  item("tool_result", 40, "grep"),
  item("tool_result", 30, "bash"),
  item("tool_call", 20, "edit"),
  item("user", 800),
  item("assistant", 700),
  item("reasoning", 600),
  item("custom", 12),
], { systemPrompt: 1_200, toolDefinitions: 3_000, total: 20_000 }, [tool("read", 1_500), tool("bash", 1_500)]);

test("identical input produces an identical layout", () => {
  assert.deepEqual(buildContextGalaxy(busy()), buildContextGalaxy(busy()));
});

test("no two nodes overlap", () => {
  // The demand-based wedge split is what guarantees this; assert it directly
  // rather than trusting the derivation.
  const galaxy = buildContextGalaxy(busy());
  for (let a = 0; a < galaxy.nodes.length; a += 1) {
    for (let b = a + 1; b < galaxy.nodes.length; b += 1) {
      const left = galaxy.nodes[a]!;
      const right = galaxy.nodes[b]!;
      const distance = Math.hypot(left.x - right.x, left.y - right.y);
      assert.ok(
        distance >= left.radius + right.radius - 1e-6,
        `${left.label} overlaps ${right.label} (gap ${(distance - left.radius - right.radius).toFixed(3)})`,
      );
    }
  }
});

test("area tracks tokens, for the root as much as for a leaf", () => {
  const galaxy = buildContextGalaxy(input([item("user", 4_000), item("assistant", 1_000)]));
  const user = node(galaxy, "cat:user");
  const assistant = node(galaxy, "cat:assistant");
  const root = node(galaxy, "root");
  // 4x the tokens must be 4x the area, i.e. 2x the radius.
  assert.ok(Math.abs(user.radius ** 2 / assistant.radius ** 2 - 4) < 1e-6);
  assert.ok(Math.abs(root.radius ** 2 / user.radius ** 2 - 5_000 / 4_000) < 1e-6);
});

test("every node stays inside the viewbox", () => {
  for (const galaxy of [buildContextGalaxy(busy()), buildContextGalaxy(input([item("user", 1)]))]) {
    for (const entry of galaxy.nodes) {
      assert.ok(entry.x - entry.radius >= -1e-6, `${entry.label} escapes left`);
      assert.ok(entry.y - entry.radius >= -1e-6, `${entry.label} escapes top`);
      assert.ok(entry.x + entry.radius <= GALAXY_VIEWBOX + 1e-6, `${entry.label} escapes right`);
      assert.ok(entry.y + entry.radius <= GALAXY_VIEWBOX + 1e-6, `${entry.label} escapes bottom`);
    }
  }
});

test("a negligible category is still a visible target", () => {
  const galaxy = buildContextGalaxy(input([item("tool_result", 100_000, "read"), item("custom", 1)]));
  assert.ok(node(galaxy, "cat:custom").radius >= 1.2);
});

test("growing one leaf resizes it without reshuffling its neighbours", () => {
  // Selection is by rank but placement is by name, so weight changes must not
  // move anything. This is the property that keeps the graph from twitching.
  const order = (galaxy: ContextGalaxy): string[] => ids(galaxy, 2);
  const before = buildContextGalaxy(input([
    item("tool_result", 100, "read"), item("tool_result", 200, "bash"), item("tool_result", 300, "grep"),
  ]));
  const after = buildContextGalaxy(input([
    item("tool_result", 9_000, "read"), item("tool_result", 200, "bash"), item("tool_result", 300, "grep"),
  ]));
  assert.deepEqual(order(before), order(after));
  assert.ok(node(after, "cat:toolTraffic/read").radius > node(before, "cat:toolTraffic/read").radius);
});

test("links stop at the circle edges", () => {
  const galaxy = buildContextGalaxy(busy());
  assert.ok(galaxy.links.length > 0);
  for (const link of galaxy.links) {
    const from = node(galaxy, link.from);
    const to = node(galaxy, link.to);
    assert.ok(Math.abs(Math.hypot(link.x1 - from.x, link.y1 - from.y) - from.radius) < 1e-6);
    assert.ok(Math.abs(Math.hypot(link.x2 - to.x, link.y2 - to.y) - to.radius) < 1e-6);
  }
});

test("the thumbnail depth draws the category ring only", () => {
  const galaxy = buildContextGalaxy(busy(), { depth: 1 });
  assert.ok(galaxy.nodes.some((entry) => entry.depth === 1));
  assert.equal(galaxy.nodes.filter((entry) => entry.depth === 2).length, 0);
});

test("nodes in a ring share an orbit", () => {
  const galaxy = buildContextGalaxy(busy());
  for (const depth of [1, 2] as const) {
    const ring = galaxy.nodes.filter((entry) => entry.depth === depth);
    const orbits = ring.map((entry) => Math.hypot(entry.x - 50, entry.y - 50));
    for (const orbit of orbits) assert.ok(Math.abs(orbit - orbits[0]!) < 1e-6);
  }
});

// --- degenerate input -----------------------------------------------------

test("nothing to draw yields an empty figure rather than NaN", () => {
  for (const galaxy of [
    buildContextGalaxy(undefined),
    buildContextGalaxy(input([])),
    buildContextGalaxy(input([item("user", 0), item("assistant", 0)])),
    buildContextGalaxy(input([{ ...item("user", Number.NaN) }, { ...item("assistant", -50) }])),
  ]) {
    assert.equal(galaxy.nodes.length, 0);
    assert.equal(galaxy.links.length, 0);
    assert.ok(galaxy.degenerate);
  }
});

test("estimates alone still produce a graph", () => {
  const galaxy = buildContextGalaxy(input([], { systemPrompt: 900, toolDefinitions: 2_100 }));
  assert.equal(node(galaxy, "cat:system").tokens, 900);
  assert.equal(node(galaxy, "cat:toolDefs").tokens, 2_100);
  assert.equal(node(galaxy, "root").tokens, 3_000);
});

test("a single category is laid out without collapsing", () => {
  const galaxy = buildContextGalaxy(input([item("user", 42)]));
  assert.equal(node(galaxy, "cat:user").share, 1);
  assert.equal(galaxy.links.length, 1);
  assert.ok(node(galaxy, "root").radius > 0);
});

// --- memoisation ----------------------------------------------------------

test("the memo signature tracks values, not array identity", () => {
  const first = input([item("user", 100)], { total: 500 });
  const second = input([{ ...first.contextItems[0]!, id: "different" }], { total: 500 });
  assert.notEqual(first.contextItems, second.contextItems);
  assert.equal(contextGalaxySignature(3, first), contextGalaxySignature(3, second));
  assert.notEqual(contextGalaxySignature(3, first), contextGalaxySignature(4, first));
  assert.equal(contextGalaxySignature(undefined, undefined), "empty");
});

test("the signature notices the last block growing mid-stream", () => {
  // sessionRevision only moves on compaction and rewind, and the item count is
  // unchanged while the final assistant block streams — so without the trailing
  // token count the graph would freeze mid-turn.
  const before = input([item("user", 100), item("assistant", 40)], { total: 500 });
  const after = input([before.contextItems[0]!, { ...before.contextItems[1]!, estimatedTokens: 900 }], { total: 500 });
  assert.notEqual(contextGalaxySignature(3, before), contextGalaxySignature(3, after));
});

test("the breakdown lists categories largest first", () => {
  const galaxy = buildContextGalaxy(input([item("tool_result", 300, "read"), item("user", 900)]));
  const rows = contextGalaxyBreakdown(galaxy);
  assert.ok(!rows.some((row) => row.id === "root"));
  assert.deepEqual(rows.map((row) => row.tokens), [...rows.map((row) => row.tokens)].sort((a, b) => b - a));
});
