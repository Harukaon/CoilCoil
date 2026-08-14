import assert from "node:assert/strict";
import test from "node:test";
import { pausedCallFrames } from "../src/main/browser-debug-client.ts";

test("advanced browser debugger presents one-based call frames and reusable scope ids", () => {
  assert.deepEqual(pausedCallFrames({
    callFrames: [{
      callFrameId: "frame-1",
      functionName: "calculate",
      url: "https://example.test/app.js",
      location: { scriptId: "7", lineNumber: 9, columnNumber: 3 },
      scopeChain: [
        { type: "local", name: "calculate", object: { objectId: "scope-local", description: "Object" } },
        { type: "global", object: { objectId: "scope-global" } },
      ],
    }],
  }), [{
    callFrameId: "frame-1",
    functionName: "calculate",
    url: "https://example.test/app.js",
    line: 10,
    column: 4,
    scopes: [
      { type: "local", name: "calculate", objectId: "scope-local", description: "Object" },
      { type: "global", objectId: "scope-global" },
    ],
  }]);
});

test("advanced browser debugger ignores malformed call frames", () => {
  assert.deepEqual(pausedCallFrames({ callFrames: [null, {}, { callFrameId: 4 }] }), []);
});
