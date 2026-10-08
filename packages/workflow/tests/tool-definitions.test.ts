import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * What every CoilCoil tool tells the model, checked once for all of them.
 *
 * Pi copies a tool's `promptSnippet` into the system prompt's <tools> section and its
 * `promptGuidelines` into <rules>. The tool definition already reaches the model through the
 * request's tool list, so those copies only repeat it, and CoilCoil's Chinese ones sat next to
 * Pi's English ones in the same prompt. The rule now: a tool has one English description that
 * carries its usage rules, and adds nothing to the system prompt on its own.
 */

interface RegisteredTool {
  name: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters?: unknown;
}

const CJK = /[\u3000-\u9fff\uff00-\uffef]/;

/** A stand-in for `pi` that answers every call harmlessly and records the tools registered. */
function recordingPi(tools: RegisteredTool[]): unknown {
  const nothing = (): undefined => undefined;
  return new Proxy({}, {
    get(_target, key) {
      if (key === "registerTool") return (tool: RegisteredTool) => { tools.push(tool); };
      if (key === "events") return { on: () => nothing, emit: nothing };
      if (key === "getActiveTools" || key === "getAllTools") return () => [];
      if (key === "then") return undefined;
      return nothing;
    },
  });
}

async function registeredTools(): Promise<RegisteredTool[]> {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
    pi?: { extensions?: string[] };
  };
  const tools: RegisteredTool[] = [];
  for (const path of manifest.pi?.extensions ?? []) {
    const module = await import(new URL(`../${path}`, import.meta.url).href);
    await module.default(recordingPi(tools));
  }
  return tools;
}

/** Every `description` in a JSON schema, with the path it was found at. */
function schemaDescriptions(schema: unknown, path: string, found: Array<{ path: string; text: string }> = []): Array<{ path: string; text: string }> {
  if (!schema || typeof schema !== "object") return found;
  for (const [key, value] of Object.entries(schema)) {
    if (key === "description" && typeof value === "string") found.push({ path, text: value });
    else schemaDescriptions(value, `${path}.${key}`, found);
  }
  return found;
}

test("the recorder sees the tools of every extension", async () => {
  const names = (await registeredTools()).map((tool) => tool.name);
  for (const expected of [
    "bash", "terminal", "mcp", "coilcoil", "subagent", "plan", "todo", "goal_complete",
    "browser_open", "browser_navigate", "browser_click", "browser_type", "browser_tabs",
  ]) {
    assert.ok(names.includes(expected), `${expected} was not registered; the checks below would be vacuous`);
  }
});

test("CoilCoil tools add nothing to the system prompt on their own", async () => {
  for (const tool of await registeredTools()) {
    assert.equal(
      tool.promptSnippet,
      undefined,
      `${tool.name}: promptSnippet is copied into the system prompt's <tools> list; the tool definition already says it`,
    );
    assert.deepEqual(
      tool.promptGuidelines ?? [],
      [],
      `${tool.name}: promptGuidelines are copied into the system prompt's <rules>; put the usage rules in the description instead`,
    );
  }
});

test("CoilCoil tool descriptions and parameter descriptions are English", async () => {
  for (const tool of await registeredTools()) {
    assert.ok(tool.description?.trim(), `${tool.name}: a tool needs a description`);
    const texts = [
      { path: "description", text: tool.description },
      ...schemaDescriptions(tool.parameters, "parameters"),
    ];
    for (const { path, text } of texts) {
      assert.doesNotMatch(text, CJK, `${tool.name} ${path} is not English: ${text.slice(0, 80)}`);
    }
  }
});
