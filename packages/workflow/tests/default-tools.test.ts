import assert from "node:assert/strict";
import test from "node:test";
import defaultToolsExtension, {
  coreGuidelines,
  extraToolsForPlatform,
  removePiDocumentationGuide,
  removeRedundantToolCatalog,
  removeToolPromptGuidelines,
  trimNativeSystemPrompt,
} from "../extensions/default-tools.ts";
import {
  COILCOIL_ENGINEERING_STANDARDS,
  COILCOIL_WINDOWS_SHELL_STANDARDS,
} from "../extensions/system/engineering-standards.ts";

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

test("native tool catalog is removed while behavioral guidelines remain", () => {
  const prompt = `You are a coding assistant.

Available tools:
- read: Read file contents
- bash: Execute commands

In addition to the tools above, custom tools may be available.

Guidelines:
- Be concise

Current working directory: /project`;

  assert.equal(
    removeRedundantToolCatalog(prompt),
    `You are a coding assistant.

Guidelines:
- Be concise

Current working directory: /project`,
  );
});

test("custom prompts without the native catalog are left unchanged", () => {
  const prompt = "Custom system prompt\n\nRules:\n- Keep changes focused";
  assert.equal(trimNativeSystemPrompt(prompt), prompt);
});

test("native Pi documentation guide is removed without removing skills", () => {
  const prompt = `Guidelines:
- Be concise

Pi documentation (read only when asked about pi):
- Main documentation: /pi/README.md
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)

The following skills provide specialized instructions.
<available_skills />`;

  assert.equal(
    removePiDocumentationGuide(prompt),
    `Guidelines:
- Be concise

The following skills provide specialized instructions.
<available_skills />`,
  );
});

test("tool prompt guidelines are replaced by the CoilCoil engineering standards", () => {
  const prompt = `Base

Guidelines:
- Use read instead of cat
- Tool-specific duplicate
- Be concise in your responses
- Show file paths clearly when working with files

Pi documentation (read only when asked about pi):
- docs`;

  assert.equal(removeToolPromptGuidelines(prompt), `Base

${COILCOIL_ENGINEERING_STANDARDS}

Pi documentation (read only when asked about pi):
- docs`);
});

test("extension keeps extra tools active and strips the catalog per turn", async () => {
  const harness = createHarness();
  await harness.handlers.get("session_start")?.[0]({}, {});
  assert.deepEqual(harness.activeTools(), ["read", "bash", "grep", "ls"]);

  const result = await harness.handlers.get("before_agent_start")?.[0]({
    systemPrompt: `Base

Available tools:
- read: Read

Guidelines:
- Tool-specific duplicate
- Be concise in your responses
- Show file paths clearly when working with files

Pi documentation (read only when asked about pi):
- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)

Current working directory: /project`,
  }, {});

  assert.deepEqual(result, {
    systemPrompt: `Base

${COILCOIL_ENGINEERING_STANDARDS}

Current working directory: /project`,
  });
});

test("the PowerShell tool is activated on Windows only", () => {
  assert.deepEqual(extraToolsForPlatform("darwin"), ["grep", "ls"]);
  assert.deepEqual(extraToolsForPlatform("linux"), ["grep", "ls"]);
  assert.deepEqual(extraToolsForPlatform("win32"), ["grep", "ls", "powershell"]);
});

test("Windows adds the PowerShell preference to the engineering standards", () => {
  assert.equal(coreGuidelines("darwin"), `\n\n${COILCOIL_ENGINEERING_STANDARDS}`);
  assert.equal(
    coreGuidelines("win32"),
    `\n\n${COILCOIL_ENGINEERING_STANDARDS}\n\n${COILCOIL_WINDOWS_SHELL_STANDARDS}`,
  );
  assert.match(COILCOIL_WINDOWS_SHELL_STANDARDS, /Prefer it for shell work/);
});

test("the Windows system prompt carries the PowerShell guidance", () => {
  const prompt = `Base

Guidelines:
- Be concise in your responses

Pi documentation (read only when asked about pi):
- docs`;

  assert.match(removeToolPromptGuidelines(prompt, "win32"), /powershell tool is available/);
  assert.doesNotMatch(removeToolPromptGuidelines(prompt, "darwin"), /powershell tool is available/);
});
