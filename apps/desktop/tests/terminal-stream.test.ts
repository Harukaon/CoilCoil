import assert from "node:assert/strict";
import test from "node:test";
import { TerminalReplayBuffer, trimToLineStart } from "../src/main/terminal-replay.ts";
import { TerminalStream } from "../src/renderer/src/features/terminal/terminalStream.ts";

/**
 * A stand-in for xterm's viewport, with the part of its behaviour this bug was
 * about: `write` only pulls the view down when the reader is already at the
 * bottom, and `reset` wipes the buffer and forgets that they had scrolled up.
 * The panel used to call `reset` for every chunk once its rolling copy of the
 * output passed the size cap, which is what dragged the reader back down.
 */
class FakeTerminal {
  lines = 0;
  ybase = 0;
  ydisp = 0;
  userScrolling = false;
  resets = 0;
  readonly written: string[] = [];

  constructor(private readonly rows: number = 24) {}

  write(data: string): void {
    this.written.push(data);
    this.lines += data.split("\n").length - 1;
    this.ybase = Math.max(0, this.lines - this.rows);
    if (!this.userScrolling) this.ydisp = this.ybase;
  }

  reset(): void {
    this.resets += 1;
    this.lines = 0;
    this.ybase = 0;
    this.ydisp = 0;
    this.userScrolling = false;
    this.written.length = 0;
  }

  scrollUp(lines: number): void {
    this.ydisp = Math.max(0, this.ydisp - lines);
    if (this.ydisp < this.ybase) this.userScrolling = true;
  }
}

test("output that arrives before the terminal is open is replayed in order", () => {
  const stream = new TerminalStream();
  const terminal = new FakeTerminal();
  stream.push("one\n");
  stream.push("two\n");
  stream.attach(terminal);
  stream.push("three\n");
  assert.deepEqual(terminal.written, ["one\n", "two\n", "three\n"]);
});

test("output that raced the first snapshot is dropped instead of drawn twice", () => {
  const stream = new TerminalStream();
  const terminal = new FakeTerminal();
  // The snapshot main answers with already contains this chunk.
  stream.push("已经在快照里\n");
  stream.discardPending();
  stream.attach(terminal);
  stream.push("新的\n");
  assert.deepEqual(terminal.written, ["新的\n"]);
});

test("a terminal that is being disposed stops receiving output", () => {
  const stream = new TerminalStream();
  const first = new FakeTerminal();
  const second = new FakeTerminal();
  stream.attach(first);
  stream.detach(second); // a stale cleanup must not unhook the live terminal
  stream.push("still here\n");
  stream.detach(first);
  stream.push("buffered\n");
  stream.attach(second);
  assert.deepEqual(first.written, ["still here\n"]);
  assert.deepEqual(second.written, ["buffered\n"]);
});

test("a reader who has scrolled up is left there no matter how much output lands", () => {
  const stream = new TerminalStream();
  const terminal = new FakeTerminal();
  stream.attach(terminal);
  for (let index = 0; index < 200; index += 1) stream.push(`启动输出 ${index}\n`);
  terminal.scrollUp(50);
  const parked = terminal.ydisp;
  assert.ok(terminal.userScrolling);

  // Far more than the half megabyte the panel used to cap its own copy of the
  // output at — the point where the old code began resetting on every chunk.
  for (let index = 0; index < 20_000; index += 1) stream.push(`${"x".repeat(40)}\n`);
  assert.equal(terminal.resets, 0);
  assert.equal(terminal.ydisp, parked);
  assert.ok(terminal.userScrolling);
});

test("the replay buffer keeps the tail of a long session, not the head", () => {
  const buffer = new TerminalReplayBuffer(1_000);
  for (let index = 0; index < 5_000; index += 1) buffer.push(`第 ${index} 行\n`);
  const text = buffer.text();
  assert.ok(text.length <= 1_200, `replay grew to ${text.length}`);
  assert.ok(text.endsWith("第 4999 行\n"));
  assert.ok(!text.includes("第 0 行"));
});

test("a replay never starts in the middle of a line", () => {
  const buffer = new TerminalReplayBuffer(64);
  buffer.push(`${"a".repeat(200)}\n`);
  buffer.push("\u001b[32m绿色\u001b[0m\n");
  // Cutting at a character count can land inside an escape sequence, which
  // xterm then paints as stray letters for the rest of the session.
  assert.equal(buffer.text(), "\u001b[32m绿色\u001b[0m\n");
});

test("a tail with no line break in reach is kept rather than thrown away", () => {
  // A TUI that redraws in place can go a long way without a line break; the
  // replay is better off slightly ragged than empty.
  const redraw = "\u001b[H\u001b[2J".repeat(5_000);
  assert.equal(trimToLineStart(redraw), redraw);
  assert.equal(trimToLineStart(`${"x".repeat(9_000)}\n尾巴`), `${"x".repeat(9_000)}\n尾巴`);
  assert.equal(trimToLineStart(`半行\n整行\n`), "整行\n");
});
