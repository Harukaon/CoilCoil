import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { loadProfiles } from "../extensions/subagents/profiles.ts";

/**
 * The prompts that ship with the built-in subagents, checked as a set.
 *
 * They are English for the same reason the rest of the system prompt is: the same text costs fewer
 * tokens than in Chinese, and a Chinese role prompt sitting under Pi's English prompt is the
 * mixed-language problem already fixed for the tool descriptions. The one thing that must not follow
 * the prompt's language is the report, because the user reads it.
 */

const CJK = /[\u3000-\u9fff\uff00-\uffef]/;

function builtinProfiles() {
  const builtinDir = join(import.meta.dirname, "..", "agents");
  const none = join(builtinDir, "none");
  return loadProfiles({ builtinDir, userDir: none, projectDir: none });
}

test("every built-in subagent is described and prompted in English", () => {
  const profiles = builtinProfiles();
  assert.ok(profiles.size >= 4, "expected at least explore, hacker, reviewer and worker");
  for (const profile of profiles.values()) {
    assert.ok(profile.systemPrompt, `${profile.name} has no prompt`);
    assert.doesNotMatch(profile.description ?? "", CJK, `${profile.name}: the description is not English`);
    assert.doesNotMatch(profile.systemPrompt, CJK, `${profile.name}: the prompt is not English`);
  }
});

test("every built-in subagent writes its report in the language of the task", () => {
  for (const profile of builtinProfiles().values()) {
    assert.match(
      profile.systemPrompt ?? "",
      /in the language of the task/i,
      `${profile.name} must say which language the report is in, because the user reads it`,
    );
  }
});

test("the worker stays out of testing and leaves outdated tests to its report", () => {
  const worker = builtinProfiles().get("worker");
  assert.ok(worker?.systemPrompt);
  assert.match(worker.systemPrompt, /do not run the project's tests/i);
  assert.match(worker.systemPrompt, /do not write or edit tests/i);
  assert.match(worker.systemPrompt, /do not edit the test yourself/i);
});

// The hacker is the tester that testing was taken away from the worker for. What follows pins the
// decisions made about it, so that a later edit cannot undo one of them without a test saying so.

test("the hacker can write tests but is given no MCP tools and no worktree", () => {
  const hacker = builtinProfiles().get("hacker");
  assert.ok(hacker, "the built-in hacker is missing");
  const tools = hacker.tools ?? [];
  for (const needed of ["read", "bash", "terminal", "edit", "write"]) {
    assert.ok(tools.includes(needed), `the hacker needs ${needed} to write and run its own tests`);
  }
  // Browsers, apps and other MCP servers are hard to supervise from a subagent, so the main agent runs
  // anything that needs one and the hacker reports it instead.
  assert.ok(!tools.includes("mcp"), "the hacker must not get MCP tools");
  // A worktree holds only what is committed, and the hacker has to see the code that was just changed.
  assert.notEqual(hacker.worktree, true, "the hacker must work on the code as it is now, not on a checkout");
});

test("the hacker looks for problems from the requirement and hands what it cannot run to the main agent", () => {
  const prompt = builtinProfiles().get("hacker")?.systemPrompt ?? "";
  assert.match(prompt, /never change the code under test/i);
  assert.match(prompt, /never change a failing check to make it pass/i);
  assert.match(prompt, /leave them uncommitted/i);
  assert.match(prompt, /no browser and no other MCP tools/i);
  // Said twice on purpose, and each one is checked on its own: once where it is told what to do when it
  // cannot run something, once in the shape of the report the main agent will read.
  assert.match(prompt, /write down what the main agent should run and what to look for/i);
  assert.match(prompt, /what you could not run \(and what the main agent should run for it\)/i);
  assert.match(prompt, /never claim you ran or verified what you did not/i);
  assert.match(prompt, /do not invent problems/i);
});

test("the hacker prompt asks for a task, not a role from a contest", () => {
  // The idea comes from how programming contests hack a solution, and the first draft opened with that
  // identity. It made the model play the contest, with its tricks, instead of testing a real project.
  const hacker = builtinProfiles().get("hacker");
  const text = `${hacker?.description ?? ""}\n${hacker?.systemPrompt ?? ""}`;
  assert.doesNotMatch(text, /\b(contest|competition|competitive|codeforces|ACM|judge|you are a)\b/i);
  assert.doesNotMatch(text, /\b(overflow|off-by-one|boundary values?)\b/i, "no contest-style checklist of tricks");
  assert.ok((hacker?.systemPrompt ?? "").split(/\s+/).length < 600, "the prompt is meant to stay short");
});
