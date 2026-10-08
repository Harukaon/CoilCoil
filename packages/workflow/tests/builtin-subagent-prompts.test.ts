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
  assert.ok(profiles.size >= 3, "expected at least explore, reviewer and worker");
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
