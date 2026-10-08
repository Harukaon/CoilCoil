import assert from "node:assert/strict";
import test from "node:test";
import { configuredSubagentModel } from "../extensions/subagents.ts";
import {
  DEFAULT_CHILD_TOOLS,
  isValidProfileName,
  parseProfileFile,
  serializeProfile,
  type ProfileFileFields,
} from "../extensions/subagents/profiles.ts";

// The settings page writes user-defined profiles with `serializeProfile`, and the
// subagent tool reads them back with `parseProfileFile` in another process. These tests
// are the contract between the two: whatever is written has to read back unchanged.

function roundTrip(fields: ProfileFileFields) {
  const parsed = parseProfileFile(serializeProfile(fields), "user", "/profiles/x.md");
  assert.ok(parsed, `profile ${fields.name} did not read back`);
  return parsed;
}

test("a profile read back from its serialized form is the profile that was written", () => {
  const written: ProfileFileFields = {
    name: "db-expert",
    description: "Answers questions about the database schema",
    tools: ["read", "grep", "ls"],
    worktree: true,
    model: "provider/model-1",
    systemPrompt: "You know the schema.\n\n- Rule one\n- Rule two",
  };
  const parsed = roundTrip(written);
  assert.equal(parsed.name, written.name);
  assert.equal(parsed.description, written.description);
  assert.deepEqual(parsed.tools, written.tools);
  assert.equal(parsed.worktree, true);
  assert.equal(parsed.model, written.model);
  assert.equal(parsed.systemPrompt, written.systemPrompt);
  assert.equal(parsed.source, "user");
});

test("serializing keeps awkward descriptions and prompts intact", () => {
  // Colons, quotes and a hash inside the description; a description that is itself
  // wrapped in quotes; a prompt that opens with a horizontal rule.
  const awkward: ProfileFileFields[] = [
    { name: "colons", description: 'Says "hello": and: more # not a comment', tools: ["read"], systemPrompt: "body" },
    { name: "quoted", description: '"already quoted"', tools: ["read"], systemPrompt: "body" },
    { name: "rule", description: "Prompt starts with a rule", tools: ["read"], systemPrompt: "---\nA body that opens with a rule\n---\nand has another one" },
  ];
  for (const fields of awkward) {
    const parsed = roundTrip(fields);
    assert.equal(parsed.description, fields.description, fields.name);
    assert.equal(parsed.systemPrompt, fields.systemPrompt, fields.name);
  }
});

test("a multi-line description is flattened to one line, because the header is one key per line", () => {
  const parsed = roundTrip({ name: "flat", description: "line one\nline two\n\n  line three", tools: ["bash"], systemPrompt: "x" });
  assert.equal(parsed.description, "line one line two line three");
});

test("optional fields are left out when they are not set", () => {
  const text = serializeProfile({ name: "bare", description: "Only a name and a description" });
  assert.doesNotMatch(text, /^tools:/m);
  assert.doesNotMatch(text, /^worktree:/m);
  assert.doesNotMatch(text, /^model:/m);
  const parsed = roundTrip({ name: "bare", description: "Only a name and a description" });
  assert.equal(parsed.tools, undefined);
  assert.equal(parsed.worktree, undefined);
  assert.equal(parsed.systemPrompt, undefined);
  // A profile with no tool list of its own is granted the default set.
  assert.ok(DEFAULT_CHILD_TOOLS.includes("read"));
});

test("new profile names must be safe as file names", () => {
  for (const name of ["hacker", "db-expert", "a", "a_b-c9", "0lead"]) assert.equal(isValidProfileName(name), true, name);
  for (const name of ["", "Hacker", "has space", "../escape", "a/b", "a.b", "-lead", "_lead", "x".repeat(49), "中文"]) {
    assert.equal(isValidProfileName(name), false, JSON.stringify(name));
  }
});

test("a user-defined profile gets the model chosen for it, and no profile inherits one it did not choose", () => {
  const settings = { models: { "db-expert": " provider/db ", explore: "provider/fast" } };
  assert.equal(configuredSubagentModel(settings, "db-expert"), "provider/db");
  assert.equal(configuredSubagentModel(settings, "explore"), "provider/fast");
  assert.equal(configuredSubagentModel(settings, "hacker"), "");
});

test("names that exist on every object are not mistaken for chosen models", () => {
  const settings = { models: { explore: "provider/fast" } };
  for (const name of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.equal(configuredSubagentModel(settings, name), "", name);
  }
});

test("the old single-model setting does not reach profiles that were added after it", () => {
  assert.equal(configuredSubagentModel({ model: "provider/legacy" }, "reviewer"), "provider/legacy");
  assert.equal(configuredSubagentModel({ model: "provider/legacy" }, "hacker"), "");
  assert.equal(configuredSubagentModel({ model: "provider/legacy" }, "db-expert"), "");
});
