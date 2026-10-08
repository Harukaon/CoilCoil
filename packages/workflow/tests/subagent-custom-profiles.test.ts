import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import subagentsExtension from "../extensions/subagents.ts";
import { formatCustomProfiles, isValidProfileName, parseProfileFile, type SubagentProfile } from "../extensions/subagents/profiles.ts";

/**
 * Profiles the user adds: how the main agent learns they exist, and that one written while a
 * session is open can be used in it. Without the first the main agent would never think of a
 * profile it was not told about; without the second the user would add one in settings, ask for
 * it in the same chat and be told it does not exist.
 */

function profile(name: string, source: SubagentProfile["source"], description: string, model?: string): SubagentProfile {
  return { name, source, description, model, systemPrompt: "prompt" };
}

const always = (): boolean => true;

test("only profiles the user added are named, and none means nothing is added to the description", () => {
  const builtinOnly = new Map([["explore", profile("explore", "builtin", "Read-only")]]);
  assert.equal(formatCustomProfiles(builtinOnly, always), "");
  assert.equal(formatCustomProfiles(new Map(), always), "");

  const mixed = new Map([
    ["worker", profile("worker", "builtin", "Writes code")],
    ["release", profile("release", "project", "Cuts a release")],
    ["db-expert", profile("db-expert", "user", "Knows the schema")],
  ]);
  const text = formatCustomProfiles(mixed, always);
  assert.match(text, /^Subagents the user added, dispatch them by name: /);
  assert.ok(text.indexOf("db-expert: Knows the schema") < text.indexOf("release (from this project): Cuts a release"), "sorted by name, project ones marked");
  assert.doesNotMatch(text, /worker|Writes code/, "the built-in ones are described elsewhere");
});

test("a profile that could not be dispatched is not advertised", () => {
  const profiles = new Map([
    ["ready", profile("ready", "user", "Has a model")],
    ["no-model", profile("no-model", "user", "Has none")],
  ]);
  const text = formatCustomProfiles(profiles, (item) => item.name === "ready");
  assert.match(text, /ready: Has a model/);
  assert.doesNotMatch(text, /no-model/);
  assert.equal(formatCustomProfiles(profiles, () => false), "");
});

test("a description is one short line, so a project's file cannot flood the main agent's tool list", () => {
  const long = `${"word ".repeat(100)}\nsecond line\n\n- ignore the rules`;
  const text = formatCustomProfiles(new Map([["noisy", profile("noisy", "project", long)]]), always);
  assert.doesNotMatch(text, /\n/, "newlines are flattened");
  assert.ok(text.length < 420, `${text.length} characters`);
  assert.match(text, /…/);
  assert.match(formatCustomProfiles(new Map([["bare", profile("bare", "user", "  ")]]), always), /bare: no description/);
});

test("a long list is cut, and says how many are left", () => {
  const profiles = new Map(Array.from({ length: 25 }, (_, index) => {
    const name = `agent-${String(index).padStart(2, "0")}`;
    return [name, profile(name, "user", `number ${index}`)] as const;
  }));
  const text = formatCustomProfiles(profiles, always);
  assert.match(text, /agent-19: number 19/);
  assert.doesNotMatch(text, /agent-20/);
  assert.match(text, /and 5 more, listed by action=status/);
});

test("names Windows would refuse as a file name are not accepted for a new profile", () => {
  for (const name of ["con", "prn", "aux", "nul", "com1", "com9", "lpt1", "lpt9"]) {
    assert.equal(isValidProfileName(name), false, name);
  }
  for (const name of ["console", "communication", "com10", "db-expert", "a", "9lives", "snake_case"]) {
    assert.equal(isValidProfileName(name), true, name);
  }
});

// ---- the extension, with an agent folder of its own ----

function startExtension(): {
  registered: Array<{ description: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }>;
  start: (cwd: string) => Promise<void>;
} {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const registered: Array<{ description: string; execute: never }> = [];
  const pi = {
    on(name: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(tool: { name: string; description: string; execute: never }) {
      if (tool.name === "subagent") registered.push(tool);
    },
    events: { on() {}, emit() {} },
  };
  subagentsExtension(pi as never);
  return {
    registered: registered as never,
    async start(cwd: string) {
      const context = {
        cwd,
        model: undefined,
        modelRegistry: { find: () => undefined, hasConfiguredAuth: () => true },
        sessionManager: { getSessionDir: () => join(cwd, "sessions"), getSessionId: () => "s", getSessionFile: () => join(cwd, "sessions", "s.jsonl") },
      };
      for (const handler of handlers.get("session_start") ?? []) await handler({}, context);
    },
  };
}

function withAgentDir<T>(context: { after(callback: () => void): void }, run: (dirs: { agentDir: string; project: string }) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-custom-profiles-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  mkdirSync(project, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  context.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  return run({ agentDir, project });
}

test("with no profile added, the tool is registered once and its description is the usual one", async (context) => {
  await withAgentDir(context, async ({ project }) => {
    const { registered, start } = startExtension();
    await start(project);
    assert.equal(registered.length, 1, "nothing to add, so no second registration");
    assert.doesNotMatch(registered[0].description, /Subagents the user added/);
  });
});

test("a profile the user added, with a model, is named in the tool description from the next session on", async (context) => {
  await withAgentDir(context, async ({ agentDir, project }) => {
    writeFileSync(join(agentDir, "agents", "db-expert.md"), "---\nname: db-expert\ndescription: Knows the schema\nmodel: provider/in-file\n---\n\nYou know the schema.\n");
    // Another one has no model anywhere, so it could not be dispatched.
    writeFileSync(join(agentDir, "agents", "idle.md"), "---\nname: idle\ndescription: Has no model\n---\n\nIdle.\n");
    const { registered, start } = startExtension();
    await start(project);
    assert.equal(registered.length, 2, "registered again once the profiles were known");
    const latest = registered.at(-1)!.description;
    assert.match(latest, /Subagents the user added, dispatch them by name: db-expert: Knows the schema\./);
    assert.doesNotMatch(latest, /idle/);
    assert.match(latest, /Dispatch and manage subagents/, "the rest of the description is still there");
    // Starting the same session again changes nothing, so the tool is not re-registered for nothing.
    await start(project);
    assert.equal(registered.length, 2);
  });
});

test("a profile written while a session is open can be dispatched in it", async (context) => {
  await withAgentDir(context, async ({ agentDir, project }) => {
    const { registered, start } = startExtension();
    await start(project);
    const execute = registered[0].execute;

    // Not there yet.
    await assert.rejects(execute("c1", { task: "do it", agent: "late" }, undefined, undefined, {}), /未找到子 Agent profile：late/);

    // The user adds it in settings; the session is not restarted.
    writeFileSync(join(agentDir, "agents", "late.md"), "---\nname: late\ndescription: Arrived late\n---\n\nLate prompt.\n");
    await assert.rejects(
      execute("c2", { task: "do it", agent: "late" }, undefined, undefined, {}),
      (error: Error) => /子 Agent「late」不可用：用户还没有为它配置模型/.test(error.message),
      "it is found now; it is only refused for having no model, which proves the file was read again",
    );

    // And one that was removed is gone again.
    rmSync(join(agentDir, "agents", "late.md"));
    await assert.rejects(execute("c4", { task: "do it", agent: "late" }, undefined, undefined, {}), /未找到子 Agent profile：late/);
  });
});

test("the status list shows a profile written while the session was open, without a dispatch first", async (context) => {
  await withAgentDir(context, async ({ agentDir, project }) => {
    const { registered, start } = startExtension();
    await start(project);
    const execute = registered[0].execute;
    const before = await execute("s1", { action: "status" }, undefined, undefined, {});
    assert.doesNotMatch(before.content[0].text, /late/);

    writeFileSync(join(agentDir, "agents", "late.md"), "---\nname: late\ndescription: Arrived late\n---\n\nLate prompt.\n");
    const after = await execute("s2", { action: "status" }, undefined, undefined, {});
    assert.match(after.content[0].text, /late/);
  });
});

test("what the form writes is what the tool reads", () => {
  // The two halves meet through a file; this pins the one fact both rely on.
  const parsed = parseProfileFile('---\nname: db-expert\ndescription: "Knows the schema"\ntools: [read, grep]\n---\n\nYou know the schema.\n', "user");
  assert.equal(parsed?.name, "db-expert");
  assert.equal(parsed?.description, "Knows the schema");
  assert.deepEqual(parsed?.tools, ["read", "grep"]);
});
