import assert from "node:assert/strict";
import test from "node:test";
import { acceleratorFromKeyPress, formatAccelerator } from "../src/renderer/src/features/settings/shortcutAccelerator.ts";

const press = (overrides: Partial<Parameters<typeof acceleratorFromKeyPress>[0]> & { key: string }) => ({
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...overrides,
});

test("command and control collapse into one portable name", () => {
  // Recording on a Mac must still mean something on the user's Windows machine.
  assert.deepEqual(acceleratorFromKeyPress(press({ key: " ", metaKey: true, shiftKey: true })), {
    ok: true,
    accelerator: "CommandOrControl+Shift+Space",
  });
  assert.deepEqual(acceleratorFromKeyPress(press({ key: "k", ctrlKey: true })), {
    ok: true,
    accelerator: "CommandOrControl+K",
  });
});

test("a global shortcut is refused without a modifier", () => {
  // A bare letter would be taken from every other application on the machine.
  const result = acceleratorFromKeyPress(press({ key: "k" }));
  assert.equal(result.ok, false);
});

test("a modifier alone is not a shortcut yet", () => {
  assert.equal(acceleratorFromKeyPress(press({ key: "Shift", shiftKey: true })).ok, false);
  assert.equal(acceleratorFromKeyPress(press({ key: "Meta", metaKey: true })).ok, false);
});

test("named keys use the names Electron knows", () => {
  assert.deepEqual(acceleratorFromKeyPress(press({ key: "ArrowUp", altKey: true })), { ok: true, accelerator: "Alt+Up" });
  assert.deepEqual(acceleratorFromKeyPress(press({ key: "Enter", metaKey: true })), { ok: true, accelerator: "CommandOrControl+Return" });
  assert.deepEqual(acceleratorFromKeyPress(press({ key: "F5", ctrlKey: true })), { ok: true, accelerator: "CommandOrControl+F5" });
  assert.equal(acceleratorFromKeyPress(press({ key: "Unidentified", ctrlKey: true })).ok, false);
});

test("the shortcut is displayed the way each platform writes it", () => {
  assert.equal(formatAccelerator("CommandOrControl+Shift+Space", "darwin"), "⌘⇧Space");
  assert.equal(formatAccelerator("CommandOrControl+Shift+Space", "win32"), "Ctrl+Shift+Space");
  assert.equal(formatAccelerator("Alt+Up", "darwin"), "⌥Up");
});
