import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import type { SkillEntry } from "@coilcoil/runtime-protocol";
import {
  canDeleteSkill,
  canRemoveSkill,
  managedSkills,
  skillCountLabel,
  skillEnabledCount,
  skillStateLabel,
  skillSwitchLabel,
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

test("the row states the skill's condition, so it cannot be read as the opposite instruction", () => {
  assert.equal(skillStateLabel({ enabled: true }), "已启用");
  assert.equal(skillStateLabel({ enabled: false }), "已停用");
});

test("the switch is named by what it controls, never by the state it is in", () => {
  // aria-checked already announces on/off; a label that flipped with the state
  // would contradict it, so both states get the same name.
  assert.equal(skillSwitchLabel(skill({ name: "pdf", enabled: true })), "启用 pdf");
  assert.equal(skillSwitchLabel(skill({ name: "pdf", enabled: false })), "启用 pdf");
});

test("clicking the toggle requests the opposite of the current state", () => {
  assert.equal(skillToggleTarget({ enabled: true }), false);
  assert.equal(skillToggleTarget({ enabled: false }), true);
});

test("the state shown and the change a click requests are always opposites", () => {
  for (const enabled of [true, false]) {
    const entry = skill({ enabled });
    const wantsOn = skillToggleTarget(entry);
    assert.equal(skillStateLabel(entry), wantsOn ? "已停用" : "已启用");
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

test("the skills list says on/off with a switch and colour, not with an outline", () => {
  // The complaint was that enabled and disabled looked alike. The state has to
  // be carried by the switch's shape and the state word — never by an added
  // border, and never by washing the whole card grey.
  const markup = readFileSync(resolve(import.meta.dirname, "../src/renderer/src/features/settings/SkillSettings.tsx"), "utf8");
  const styles = readFileSync(resolve(import.meta.dirname, "../src/renderer/src/features/settings/settings.css"), "utf8");

  assert.match(markup, /role="switch"/);
  assert.match(markup, /aria-checked=\{skill\.enabled\}/);
  assert.match(styles, /\.skills-switch\.on \{[^}]*var\(--c-green-solid\)/);
  assert.doesNotMatch(styles, /\.skills-list article\.disabled \{/);
});
