import assert from "node:assert/strict";
import test from "node:test";
import { validateMcpJsonText } from "../src/index.ts";

function mcpJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

test("a server needs exactly one transport", () => {
  assert.equal(validateMcpJsonText(mcpJson({ mcpServers: { a: { command: "npx" } } })).ok, true);
  assert.equal(validateMcpJsonText(mcpJson({ mcpServers: { a: { url: "https://x/mcp" } } })).ok, true);
  assert.equal(
    validateMcpJsonText(mcpJson({ mcpServers: { a: { command: "npx", url: "https://x/mcp" } } })).ok,
    false,
  );
  assert.equal(validateMcpJsonText(mcpJson({ mcpServers: { a: { lifecycle: "lazy" } } })).ok, false);
});

test("a tombstone the runtime writes for a removed import stays valid", () => {
  // Removing an imported server cannot delete it from the app that supplies it,
  // so SuoCode records `{ "disabled": true }` here. Rejecting that shape made
  // the JSON editor refuse to save a file SuoCode had just written itself.
  const document = mcpJson({
    imports: ["claude-code", "claude-desktop", "codex", "opencode"],
    mcpServers: {
      Mobius2: { disabled: true },
      "computer-use": { disabled: true },
      node_repl: { disabled: true },
    },
  });
  assert.equal(validateMcpJsonText(document).ok, true);
});

test("an override-only entry may not smuggle in a half-configured server", () => {
  // Missing transport is only forgiven when the entry carries nothing but
  // overrides; anything else is an incomplete definition and should be caught.
  assert.equal(validateMcpJsonText(mcpJson({ mcpServers: { a: { disabled: true } } })).ok, true);
  assert.equal(validateMcpJsonText(mcpJson({ mcpServers: { a: { args: ["-y"] } } })).ok, false);
  assert.equal(validateMcpJsonText(mcpJson({ mcpServers: { a: { env: { A: "1" } } } })).ok, false);
  assert.equal(validateMcpJsonText(mcpJson({ mcpServers: { a: {} } })).ok, true);
});

test("field types are still enforced on a full definition", () => {
  const base = { command: "npx" };
  assert.equal(validateMcpJsonText(mcpJson({ mcpServers: { a: { ...base, args: "-y" } } })).ok, false);
  assert.equal(validateMcpJsonText(mcpJson({ mcpServers: { a: { ...base, env: { A: 1 } } } })).ok, false);
  assert.equal(validateMcpJsonText(mcpJson({ mcpServers: { a: { ...base, disabled: "yes" } } })).ok, false);
  assert.equal(validateMcpJsonText(mcpJson({ mcpServers: { a: { ...base, auth: "basic" } } })).ok, false);
  assert.equal(validateMcpJsonText(mcpJson({ mcpServers: { a: { ...base, lifecycle: "always" } } })).ok, false);
  assert.equal(validateMcpJsonText(mcpJson({ mcpServers: { a: { ...base, headers: { A: "1" } } } })).ok, true);
});

test("the document shell is validated", () => {
  assert.equal(validateMcpJsonText("not json").ok, false);
  assert.equal(validateMcpJsonText(mcpJson([])).ok, false);
  assert.equal(validateMcpJsonText(mcpJson({})).ok, false);
  assert.equal(validateMcpJsonText(mcpJson({ mcpServers: [] })).ok, false);
  assert.equal(validateMcpJsonText(mcpJson({ mcpServers: {} })).ok, true);
  assert.equal(validateMcpJsonText(mcpJson({ mcpServers: {}, imports: ["nope"] })).ok, false);
});
