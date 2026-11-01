import assert from "node:assert/strict";
import test from "node:test";
import { browserBridgeEndpoint } from "../extensions/browser-bridge.ts";

const env = {
  COILCOIL_BROWSER_MCP_ARGS: JSON.stringify([
    "/devtools.js", "--wsEndpoint", "ws://127.0.0.1:4321/devtools/browser/secret-token",
    "--wsHeaders", JSON.stringify({ Authorization: "Bearer abc" }),
  ]),
};

test("tab bridge preserves authentication and session scope", () => {
  const endpoint = browserBridgeEndpoint("tabs", "session-a", env);
  assert.equal(endpoint?.url, "http://127.0.0.1:4321/coilcoil/tabs/secret-token?scope=session-a");
  assert.deepEqual(endpoint?.headers, { Authorization: "Bearer abc" });
  assert.equal(browserBridgeEndpoint("tabs", "session-a", {}), undefined);
});
