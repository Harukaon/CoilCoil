import assert from "node:assert/strict";
import test from "node:test";
import type { SkillEntry } from "@coilcoil/runtime-protocol";
import {
  canDeleteSkill,
  canRemoveSkill,
  managedSkills,
  skillCountLabel,
  skillEnabledCount,
  skillToggleActionLabel,
  skillToggleLabel,
  skillToggleTarget,
} from "../src/renderer/src/features/settings/skillPolicy.ts";

function skill(overrides: Partial<SkillEntry> = {}): SkillEntry {
  const name = overrides.name ?? "pdf";
  return {
    name,
    description: `${name} skill`,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    source: "user",
    enabled: false,
    disableModelInvocation: false,
    scope: "user",
    ...overrides,
  };
}

test("skills that cannot be turned on or off are not listed", () => {
  const listed = managedSkills([
    skill({ name: "bundled-one", source: "bundled" }),
    skill({ name: "mine", source: "user" }),
    skill({ name: "ours", source: "project" }),
    skill({ name: "agents", source: "agents" }),
  ]);
  assert.deepEqual(listed.map((entry) => entry.name), ["mine", "ours", "agents"]);
});

test("an empty or missing skill list is handled without listing anything", () => {
  assert.deepEqual(managedSkills(undefined), []);
  assert.deepEqual(managedSkills([]), []);
  assert.equal(skillCountLabel(undefined), "0/0 已启用");
});

test("the counter reflects only skills the user can control", () => {
  const skills = [
    skill({ name: "bundled-on", source: "bundled", enabled: true }),
    skill({ name: "on", enabled: true }),
    skill({ name: "off", enabled: false }),
  ];
  assert.equal(skillEnabledCount(skills), 1);
  assert.equal(skillCountLabel(skills), "1/2 已启用");
});

test("a bundled skill never inflates the total", () => {
  const onlyBundled = [skill({ source: "bundled", enabled: true })];
  assert.equal(skillCountLabel(onlyBundled), "0/0 已启用");
});

test("the toggle names the action it performs, not the state it is in", () => {
  assert.equal(skillToggleLabel({ enabled: true }), "停用");
  assert.equal(skillToggleLabel({ enabled: false }), "启用");
});

test("the accessible label matches the visible label", () => {
  const enabled = skill({ name: "pdf", enabled: true });
  const disabled = skill({ name: "pdf", enabled: false });
  assert.ok(skillToggleActionLabel(enabled).startsWith(skillToggleLabel(enabled)));
  assert.ok(skillToggleActionLabel(disabled).startsWith(skillToggleLabel(disabled)));
  assert.equal(skillToggleActionLabel(enabled), "停用 pdf");
  assert.equal(skillToggleActionLabel(disabled), "启用 pdf");
});

test("clicking the toggle requests the opposite of the current state", () => {
  assert.equal(skillToggleTarget({ enabled: true }), false);
  assert.equal(skillToggleTarget({ enabled: false }), true);
});

test("the label and the requested change always agree", () => {
  for (const enabled of [true, false]) {
    const entry = skill({ enabled });
    const wantsOn = skillToggleTarget(entry);
    assert.equal(skillToggleLabel(entry), wantsOn ? "启用" : "停用");
  }
});

test("only user skills copied into the managed directory can be deleted", () => {
  assert.equal(canDeleteSkill(skill({ baseDir: "/agent/skills/mine" }), "/agent/skills"), true);
  assert.equal(canDeleteSkill(skill({ source: "project", scope: "project", baseDir: "/project/.pi/skills/mine" }), "/agent/skills"), false);
  assert.equal(canDeleteSkill(skill({ source: "agents", baseDir: "/home/.agents/skills/mine" }), "/agent/skills"), false);
  assert.equal(canDeleteSkill(skill({ baseDir: "/agent/skills-other/mine" }), "/agent/skills"), false);
});

test("external skill imports can be removed without being deletable", () => {
  assert.equal(canRemoveSkill(skill({ source: "agents" })), true);
  assert.equal(canRemoveSkill(skill({ source: "project" })), true);
  assert.equal(canRemoveSkill(skill({ source: "user" })), true);
  assert.equal(canRemoveSkill(skill({ source: "bundled" })), false);
});
