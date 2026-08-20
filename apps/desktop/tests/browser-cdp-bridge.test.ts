import assert from "node:assert/strict";
import test from "node:test";
import { detachDebuggerListener } from "../src/main/browser-cdp-teardown.ts";

function guest(options: {
  destroyed?: boolean;
  off?: () => void;
} = {}) {
  let destroyed = options.destroyed ?? false;
  return {
    isDestroyed: () => destroyed,
    debugger: {
      off: () => {
        options.off?.();
      },
    },
    destroy: () => { destroyed = true; },
  };
}

test("debugger listener teardown ignores an already destroyed guest", () => {
  let called = false;
  assert.doesNotThrow(() => detachDebuggerListener(guest({ destroyed: true, off: () => { called = true; } }), () => {}));
  assert.equal(called, false);
});

test("debugger listener teardown tolerates destruction during off", () => {
  let called = false;
  let destroyedDuringOff: ReturnType<typeof guest>;
  destroyedDuringOff = guest({
    off: () => {
      called = true;
      destroyedDuringOff.destroy();
      throw new Error("Object has been destroyed");
    },
  });
  assert.doesNotThrow(() => detachDebuggerListener(destroyedDuringOff, () => {}));
  assert.equal(called, true);
});

test("debugger listener teardown preserves unrelated errors", () => {
  const failure = new Error("unexpected debugger failure");
  assert.throws(() => detachDebuggerListener(guest({ off: () => { throw failure; } }), () => {}), failure);
});

test("debugger listener teardown detaches a live guest", () => {
  let called = false;
  detachDebuggerListener(guest({ off: () => { called = true; } }), () => {});
  assert.equal(called, true);
});
