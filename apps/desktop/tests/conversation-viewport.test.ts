import assert from "node:assert/strict";
import test from "node:test";
import { autoFollowAfterScroll, gestureLeavesBottom } from "../src/renderer/src/hooks/useConversationViewport.ts";

test("reaching the bottom always resumes following the newest message", () => {
  assert.equal(autoFollowAfterScroll({ distanceFromBottom: 0, msSinceGesture: 10_000, following: false }), true);
  assert.equal(autoFollowAfterScroll({ distanceFromBottom: 1, msSinceGesture: 0, following: false }), true);
});

test("a scroll the user drove stops the timeline from following", () => {
  assert.equal(autoFollowAfterScroll({ distanceFromBottom: 800, msSinceGesture: 30, following: true }), false);
  assert.equal(autoFollowAfterScroll({ distanceFromBottom: 800, msSinceGesture: 600, following: true }), false);
});

test("a scroll nobody asked for leaves following alone", () => {
  // Switching conversations resets scrollTop and fires this event on its own.
  assert.equal(autoFollowAfterScroll({ distanceFromBottom: 4_000, msSinceGesture: 5_000, following: true }), true);
  assert.equal(autoFollowAfterScroll({ distanceFromBottom: 4_000, msSinceGesture: 5_000, following: false }), false);
});

test("the reader's own scroll still follows at one pixel from the bottom", () => {
  const reader = { msSinceGesture: 10, following: false };
  assert.equal(autoFollowAfterScroll({ ...reader, distanceFromBottom: 1 }), true);
  assert.equal(autoFollowAfterScroll({ ...reader, distanceFromBottom: 2 }), false);
});

test("a wheel away from the newest message stops the follow on its own", () => {
  // While a reply streams the wheel and pin-to-bottom coalesce into one scroll
  // event that reads as "still at the bottom", so the gesture has to speak.
  assert.equal(gestureLeavesBottom({ type: "wheel", deltaY: -120 } as WheelEvent), true);
  assert.equal(gestureLeavesBottom({ type: "wheel", deltaY: 120 } as WheelEvent), false);
  assert.equal(gestureLeavesBottom({ type: "wheel", deltaY: 0 } as WheelEvent), false);
});

test("keys that page backwards stop the follow, typing does not", () => {
  assert.equal(gestureLeavesBottom({ type: "keydown", key: "PageUp" } as KeyboardEvent), true);
  assert.equal(gestureLeavesBottom({ type: "keydown", key: "Home" } as KeyboardEvent), true);
  assert.equal(gestureLeavesBottom({ type: "keydown", key: "PageDown" } as KeyboardEvent), false);
  assert.equal(gestureLeavesBottom({ type: "keydown", key: "a" } as KeyboardEvent), false);
});

test("a finger dragged down pulls earlier messages in and stops the follow", () => {
  const touchAt = (clientY: number): TouchEvent => ({ type: "touchmove", touches: [{ clientY }] } as unknown as TouchEvent);
  assert.equal(gestureLeavesBottom(touchAt(300), 200), true);
  assert.equal(gestureLeavesBottom(touchAt(100), 200), false);
  // The first move of a gesture has nothing to compare against.
  assert.equal(gestureLeavesBottom(touchAt(300), undefined), false);
});

test("a pointer press is a gesture but not a departure", () => {
  assert.equal(gestureLeavesBottom({ type: "pointerdown" } as PointerEvent), false);
});
