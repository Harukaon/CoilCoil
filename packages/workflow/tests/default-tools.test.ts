import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import defaultToolsExtension, {
  engineeringStandardsBlock,
  extraToolsForPlatform,
  withEngineeringStandards,
} from "../extensions/default-tools.ts";
import { createChildSession } from "../extensions/subagents/child.ts";
import {
  COILCOIL_ENGINEERING_STANDARDS,
  COILCOIL_WINDOWS_SHELL_STANDARDS,
} from "../extensions/system/engineering-standards.ts";

const CJK = /[\u3000-\u9fff\uff00-\uffef]/;

function createHarness() {
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  let activeTools = ["read", "bash"];

  const pi = {
    on(event: string, handler: (...args: any[]) => any) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    getActiveTools() {
      return activeTools;
    },
    setActiveTools(tools: string[]) {
      activeTools = tools;
    },
  };

  defaultToolsExtension(pi as any);
  return { handlers, activeTools: () => activeTools };
}

test("extension keeps the extra tools active", async () => {
  const harness = createHarness();
  await harness.handlers.get("session_start")?.[0]({}, {});
  assert.deepEqual(harness.activeTools(), ["read", "bash", "grep", "ls"]);
});

test("the PowerShell tool is activated on Windows only", () => {
  assert.deepEqual(extraToolsForPlatform("darwin"), ["grep", "ls"]);
  assert.deepEqual(extraToolsForPlatform("linux"), ["grep", "ls"]);
  assert.deepEqual(extraToolsForPlatform("win32"), ["grep", "ls", "powershell"]);
});

test("the standards are appended to the prompt as one tagged block", () => {
  const prompt = "Base\n\n<rules>\n- Be concise\n</rules>\n\n<cwd>\n/project\n</cwd>";
  assert.equal(
    withEngineeringStandards(prompt, "darwin"),
    `${prompt}\n\n<engineering_standards>\n${COILCOIL_ENGINEERING_STANDARDS}\n</engineering_standards>`,
  );
});

test("a prompt that already carries the standards is left alone", () => {
  const once = withEngineeringStandards("Base", "linux");
  assert.equal(withEngineeringStandards(once, "linux"), once);
});

test("a prompt with none of Pi's sections still gets the standards", () => {
  // A custom system prompt gives the standards nothing to anchor on. They must arrive anyway:
  // this is the case the old heading-matching splice dropped without a word.
  const result = withEngineeringStandards("Custom system prompt", "linux");
  assert.ok(result.startsWith("Custom system prompt\n\n<engineering_standards>\n"));
  assert.ok(result.includes(COILCOIL_ENGINEERING_STANDARDS));
});

test("every turn gets the standards through before_agent_start, once", async () => {
  const harness = createHarness();
  const handler = harness.handlers.get("before_agent_start")?.[0];
  assert.ok(handler, "the extension must listen to before_agent_start");

  const first = await handler({ systemPrompt: "Base" }, {});
  assert.deepEqual(first, { systemPrompt: withEngineeringStandards("Base") });
  assert.equal(await handler({ systemPrompt: first.systemPrompt }, {}), undefined, "nothing to add the second time");
});

test("Windows adds the PowerShell guidance to the standards, other platforms do not", () => {
  assert.ok(engineeringStandardsBlock("win32").includes(COILCOIL_WINDOWS_SHELL_STANDARDS));
  assert.ok(!engineeringStandardsBlock("darwin").includes(COILCOIL_WINDOWS_SHELL_STANDARDS));
  assert.ok(!engineeringStandardsBlock("linux").includes(COILCOIL_WINDOWS_SHELL_STANDARDS));
  assert.match(COILCOIL_WINDOWS_SHELL_STANDARDS, /Prefer it for shell work/);
});

test("the standards are English, and leave testing and committing out", () => {
  for (const [name, text] of [
    ["engineering standards", COILCOIL_ENGINEERING_STANDARDS],
    ["Windows shell standards", COILCOIL_WINDOWS_SHELL_STANDARDS],
  ] as const) {
    assert.doesNotMatch(text, CJK, `${name} must stay English: it costs fewer tokens and sits next to Pi's English prompt`);
  }
  assert.doesNotMatch(
    COILCOIL_ENGINEERING_STANDARDS,
    /Testing and verification/,
    "testing is meant for a dedicated test agent; the main agent's prompt should not ask it to run and write tests",
  );
  assert.doesNotMatch(
    COILCOIL_ENGINEERING_STANDARDS,
    /create commits/,
    "whether to commit follows the user's own preferences, not a default rule",
  );
});

test("the standards reach the prompt Pi really builds, and Pi's own text stays as it was", async (context) => {
  // The earlier tests fed hand-written prompts into the splice and all passed while the real
  // prompt never received the standards. This one starts from a prompt Pi built itself.
  const root = mkdtempSync(join(tmpdir(), "coilcoil-standards-"));
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const handle = await createChildSession({
    cwd: root,
    agentDir: join(root, "agent"),
    parentSessionDir: join(root, "sessions"),
    parentSessionId: "standards",
    onEvent: () => undefined,
  });
  context.after(() => handle.dispose());

  const piPrompt = handle.session.systemPrompt;
  assert.ok(piPrompt.length > 500, "expected the prompt Pi built for the session, not an empty stand-in");

  const result = await createHarness().handlers.get("before_agent_start")?.[0]({ systemPrompt: piPrompt }, {});
  assert.ok(result, "the standards must be added to a real Pi prompt");
  assert.ok(result.systemPrompt.startsWith(piPrompt), "Pi's own sections must not be cut or reordered");
  assert.ok(result.systemPrompt.includes(`<engineering_standards>\n${COILCOIL_ENGINEERING_STANDARDS}`));
});
