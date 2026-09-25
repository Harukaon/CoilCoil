import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ToolRun } from "@coilcoil/runtime-protocol";
import {
  ActivityGroupView,
  toggleActivityDisclosure,
  type ActivityEntry,
} from "../src/renderer/src/features/conversation/ActivityGroupView.tsx";
import {
  NEARBY_MARGIN,
  OFFSCREEN_CLASS,
  PLACEHOLDER_HEIGHT,
  virtualizeActivityGroups,
} from "../src/renderer/src/features/conversation/useActivityGroupVirtualization.ts";

function toolEntry(status: ToolRun["status"], output: string): ActivityEntry {
  const tool = {
    id: `tool-${status}`,
    order: 1,
    name: "bash",
    label: "运行命令",
    args: { command: "echo hello" },
    output,
    status,
    startedAt: 1,
    endedAt: status === "running" ? undefined : 2,
  } as ToolRun;
  return { kind: "tool", id: tool.id, tool };
}

test("a historical closed activity group does not build its command details", () => {
  const markup = renderToStaticMarkup(createElement(ActivityGroupView, {
    entries: [toolEntry("succeeded", "large hidden output")],
  }));

  assert.match(markup, /<details class="tool-activity">/);
  assert.doesNotMatch(markup, /tool-activity-list/);
  assert.doesNotMatch(markup, /large hidden output/);
});

test("a group born running still renders its live command details", () => {
  const markup = renderToStaticMarkup(createElement(ActivityGroupView, {
    entries: [toolEntry("running", "live output")],
  }));

  assert.match(markup, /<details class="tool-activity" open="">/);
  assert.match(markup, /tool-activity-list/);
  assert.match(markup, /live output/);
});

test("opening builds the details once, and closing keeps them for nested row state", () => {
  const born = { open: false, detailsMounted: false };
  const opened = toggleActivityDisclosure(born, true);
  assert.deepEqual(opened, { open: true, detailsMounted: true });

  const closed = toggleActivityDisclosure(opened, false);
  assert.deepEqual(closed, { open: false, detailsMounted: true });
  assert.deepEqual(toggleActivityDisclosure(closed, true), { open: true, detailsMounted: true });
});

test("a toggle that changes nothing keeps the same state and skips a re-render", () => {
  const closed = { open: false, detailsMounted: false };
  assert.equal(toggleActivityDisclosure(closed, false), closed);
  const open = { open: true, detailsMounted: true };
  assert.equal(toggleActivityDisclosure(open, true), open);
});

// Just enough of the DOM for the virtualizer: it only reads these members.
class FakeGroup {
  readonly nodeType = 1;
  open = false;
  readonly classes = new Set(["tool-activity"]);
  readonly properties = new Map<string, string>();
  readonly classList = {
    add: (name: string) => { this.classes.add(name); },
    remove: (name: string) => { this.classes.delete(name); },
  };
  readonly style = {
    setProperty: (name: string, value: string) => { this.properties.set(name, value); },
    removeProperty: (name: string) => { this.properties.delete(name); return ""; },
  };
  constructor(readonly height = 17) {}
  matches(selector: string): boolean { return selector === "details.tool-activity"; }
  querySelectorAll(): FakeGroup[] { return []; }
  getBoundingClientRect(): { height: number } { return { height: this.height }; }
  get parked(): boolean { return this.classes.has(OFFSCREEN_CLASS); }
}

class FakeContainer {
  readonly nodeType = 1;
  constructor(readonly groups: FakeGroup[]) {}
  matches(): boolean { return false; }
  querySelectorAll(): FakeGroup[] { return this.groups; }
}

class FakeRoot extends FakeContainer {
  readonly listeners = new Map<string, (event: { target: unknown }) => void>();
  addEventListener(type: string, listener: (event: { target: unknown }) => void): void { this.listeners.set(type, listener); }
  removeEventListener(type: string): void { this.listeners.delete(type); }
  toggle(target: FakeGroup): void { this.listeners.get("toggle")?.({ target }); }
}

class FakeIntersectionObserver {
  static current: FakeIntersectionObserver;
  readonly observed = new Set<unknown>();
  disconnected = false;
  constructor(
    readonly callback: (entries: unknown[]) => void,
    readonly options: { rootMargin?: string },
  ) {
    FakeIntersectionObserver.current = this;
  }
  observe(target: unknown): void { this.observed.add(target); }
  unobserve(target: unknown): void { this.observed.delete(target); }
  disconnect(): void { this.disconnected = true; this.observed.clear(); }
  report(target: FakeGroup, isIntersecting: boolean): void {
    this.callback([{ target, isIntersecting, boundingClientRect: { height: target.height } }]);
  }
}

class FakeMutationObserver {
  static current: FakeMutationObserver;
  disconnected = false;
  options?: MutationObserverInit;
  constructor(readonly callback: (records: unknown[]) => void) {
    FakeMutationObserver.current = this;
  }
  observe(_target: unknown, options: MutationObserverInit): void { this.options = options; }
  disconnect(): void { this.disconnected = true; }
  emit(added: unknown[], removed: unknown[] = []): void {
    this.callback([{ addedNodes: added, removedNodes: removed }]);
  }
}

function virtualize(groups: FakeGroup[]): { root: FakeRoot; io: FakeIntersectionObserver; mo: FakeMutationObserver; cleanup: () => void } {
  const root = new FakeRoot(groups);
  const cleanup = virtualizeActivityGroups(root as unknown as HTMLElement, {
    IntersectionObserver: FakeIntersectionObserver as unknown as typeof IntersectionObserver,
    MutationObserver: FakeMutationObserver as unknown as typeof MutationObserver,
  });
  return { root, io: FakeIntersectionObserver.current, mo: FakeMutationObserver.current, cleanup };
}

test("only distant closed groups become fixed-height placeholders", () => {
  const near = new FakeGroup();
  const far = new FakeGroup(16.5);
  const { io } = virtualize([near, far]);

  assert.equal(io.options.rootMargin, NEARBY_MARGIN);
  io.report(near, true);
  io.report(far, false);

  assert.equal(near.parked, false);
  assert.equal(far.parked, true);
  assert.equal(far.properties.get(PLACEHOLDER_HEIGHT), "16.5px");

  io.report(far, true);
  assert.equal(far.parked, false);
  assert.equal(far.properties.has(PLACEHOLDER_HEIGHT), false);
});

test("an open group is never parked, and closing it far away parks it again", () => {
  const group = new FakeGroup();
  const { root, io } = virtualize([group]);

  group.open = true;
  io.report(group, false);
  assert.equal(group.parked, false);

  group.open = false;
  root.toggle(group);
  assert.equal(group.parked, true);

  group.open = true;
  root.toggle(group);
  assert.equal(group.parked, false);
});

test("toggles from nested tool rows or other nodes never move the parent group", () => {
  const group = new FakeGroup();
  const { root, io } = virtualize([group]);
  io.report(group, false);
  assert.equal(group.parked, true);

  const nestedRow = { nodeType: 1, open: true, matches: () => false };
  root.listeners.get("toggle")?.({ target: nestedRow });
  root.listeners.get("toggle")?.({ target: { nodeType: 3 } });
  assert.equal(group.parked, true);
});

test("closing a group near the viewport leaves it rendered", () => {
  const group = new FakeGroup();
  const { root, io } = virtualize([group]);
  io.report(group, true);

  group.open = false;
  root.toggle(group);
  assert.equal(group.parked, false);
});

test("groups streamed in later are observed and removed ones are restored", () => {
  const initial = new FakeGroup();
  const { io, mo } = virtualize([initial]);
  const streamed = new FakeGroup();
  assert.deepEqual(mo.options, { childList: true, subtree: true });

  mo.emit([new FakeContainer([streamed])]);
  assert.equal(io.observed.has(streamed), true);

  io.report(initial, false);
  assert.equal(initial.parked, true);
  mo.emit([], [initial]);
  assert.equal(io.observed.has(initial), false);
  assert.equal(initial.parked, false);
});

test("cleanup disconnects both observers and restores every placeholder", () => {
  const group = new FakeGroup();
  const { root, io, mo, cleanup } = virtualize([group]);
  io.report(group, false);
  assert.equal(group.parked, true);

  cleanup();

  assert.equal(io.disconnected, true);
  assert.equal(mo.disconnected, true);
  assert.equal(root.listeners.has("toggle"), false);
  assert.equal(group.parked, false);
  assert.doesNotThrow(cleanup);
});

test("the conversation wires the virtualizer and styles placeholders without layout", () => {
  const source = resolve(import.meta.dirname, "../src/renderer/src");
  const pane = readFileSync(resolve(source, "features/conversation/ConversationPane.tsx"), "utf8");
  const styles = readFileSync(resolve(source, "styles.css"), "utf8");

  assert.match(pane, /useActivityGroupVirtualization\(timelineRef\)/);
  const rule = styles.match(/\.tool-activity\.tool-activity-offscreen:not\(\[open\]\)\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.match(rule, /block-size:\s*var\(--tool-activity-placeholder-height/);
  assert.match(rule, /content-visibility:\s*hidden/);
  assert.match(rule, /contain:\s*strict/);
});
