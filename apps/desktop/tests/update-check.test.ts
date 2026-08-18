import assert from "node:assert/strict";
import test from "node:test";
import {
  checkForUpdate,
  compareVersions,
  newestRelease,
  parseVersion,
} from "../src/main/update-check.ts";

function release(tag: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { tag_name: tag, html_url: `https://github.com/Harukaon/SuoCode/releases/tag/${tag}`, ...extra };
}

test("beta builds order by number, not by string", () => {
  // The whole point of the scheme: beta.10 ships after beta.9, and a string
  // comparison puts it before.
  assert.equal(compareVersions("0.1.0-beta.10", "0.1.0-beta.9"), 1);
  assert.equal(compareVersions("0.1.0-beta.2", "0.1.0-beta.10"), -1);
  assert.equal(compareVersions("0.1.0-beta.7", "0.1.0-beta.7"), 0);
});

test("a finished release outranks the betas that led to it", () => {
  assert.equal(compareVersions("0.1.0", "0.1.0-beta.99"), 1);
  assert.equal(compareVersions("0.1.0-beta.1", "0.1.0"), -1);
  assert.equal(compareVersions("0.2.0-beta.1", "0.1.0"), 1);
  assert.equal(compareVersions("1.0.0", "0.9.9"), 1);
});

test("tags are read with or without their v", () => {
  assert.deepEqual(parseVersion("v0.1.0-beta.3")?.release, [0, 1, 0]);
  assert.deepEqual(parseVersion("0.1.0")?.prerelease, []);
  assert.equal(parseVersion("beta"), undefined, "a rolling pointer is not a version");
  assert.equal(parseVersion("nightly-2026-08-18"), undefined);
});

test("the newest comparable release wins, drafts and non-version tags aside", () => {
  const latest = newestRelease([
    release("v0.1.0-beta.9"),
    release("beta"),
    release("v0.1.0-beta.12"),
    release("v0.2.0-beta.1", { draft: true }),
    release("v0.1.0-beta.10", { prerelease: true }),
  ]);
  assert.equal(latest?.version, "0.1.0-beta.12");
  assert.match(latest?.url ?? "", /releases\/tag\/v0\.1\.0-beta\.12$/);
  assert.equal(newestRelease([release("beta"), { tag_name: "v9.9.9" }]), undefined, "a release with no page cannot be offered");
  assert.equal(newestRelease({}), undefined);
});

test("only a genuinely newer build is offered", async () => {
  const feed = [release("v0.1.0-beta.5"), release("v0.1.0-beta.7")];
  assert.deepEqual(
    await checkForUpdate("0.1.0-beta.5", async () => feed),
    { current: "0.1.0-beta.5", latest: "0.1.0-beta.7", url: "https://github.com/Harukaon/SuoCode/releases/tag/v0.1.0-beta.7" },
  );

  assert.equal(await checkForUpdate("0.1.0-beta.7", async () => feed), undefined, "the current build is not an update");
  // A developer running an unreleased build must never be told to downgrade.
  assert.equal(await checkForUpdate("0.1.0-beta.9", async () => feed), undefined);
  assert.equal(await checkForUpdate("0.1.0-beta.1", async () => []), undefined, "an empty feed offers nothing");
});
