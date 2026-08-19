import assert from "node:assert/strict";
import test from "node:test";
import { autoFollowAfterScroll } from "../src/renderer/src/hooks/useConversationViewport.ts";

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
