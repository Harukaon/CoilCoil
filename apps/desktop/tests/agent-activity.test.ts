import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_QUIPS,
  agentActivityLine,
  createQuipBag,
  QUIP_DELAY_MS,
  QUIP_INTERVAL_MS,
  startQuipRotation,
  type QuipTimers,
} from "../src/renderer/src/features/conversation/agentActivity.ts";

/** A clock the test advances by hand, so the 5s delay costs no wall time. */
function fakeClock(): QuipTimers & { advance(ms: number): void; pending(): number } {
  let now = 0;
  let handle = 0;
  const timers = new Map<number, { at: number; every?: number; run: () => void }>();
  return {
    setTimeout(run, ms) { handle += 1; timers.set(handle, { at: now + ms, run }); return handle; },
    setInterval(run, ms) { handle += 1; timers.set(handle, { at: now + ms, every: ms, run }); return handle; },
    clearTimeout(id) { timers.delete(id); },
    clearInterval(id) { timers.delete(id); },
    pending() { return timers.size; },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, timer] = due;
        now = timer.at;
        if (timer.every === undefined) timers.delete(id);
        else timer.at += timer.every;
        timer.run();
      }
      now = until;
    },
  };
}

test("the plain phase always leads, and reads exactly as before without a quip", () => {
  // A short run never reaches a quip, so its status must stay the sober one.
  assert.equal(agentActivityLine("思考"), "思考中…");
  assert.equal(agentActivityLine("回复"), "组织回答中…");
  assert.equal(agentActivityLine("工具"), "动手处理中…");
  assert.equal(agentActivityLine(undefined), "工作中…");

  assert.equal(agentActivityLine("工具", "先备份，再动手"), "动手处理中 · 先备份，再动手");
  assert.equal(agentActivityLine(undefined, "这次一定"), "工作中 · 这次一定");
});

test("a quip is company for a wait, not a flash", () => {
  // Reading one takes longer than the 2.3s the old carousel gave it, and a run
  // that ends inside the delay never shows one at all.
  assert.ok(QUIP_DELAY_MS >= 3_000, "a quip must not appear before the wait is worth noticing");
  assert.ok(QUIP_INTERVAL_MS >= 5_000, "a quip has to stay long enough to read");
});

test("every quip is short enough to sit after the phase word", () => {
  const longest = [...AGENT_QUIPS].sort((left, right) => right.length - left.length)[0]!;
  assert.ok(longest.length <= 22, `"${longest}" is too long for the status row`);
  assert.equal(new Set(AGENT_QUIPS).size, AGENT_QUIPS.length, "duplicate quips waste the bag");
  assert.ok(AGENT_QUIPS.length >= 40, "a small pool is what makes canned copy feel canned");
});

test("the bag deals every quip once per pass and never twice in a row", () => {
  const bag = createQuipBag(AGENT_QUIPS.length);
  const first = Array.from({ length: AGENT_QUIPS.length }, () => bag.next());
  assert.deepEqual(
    [...first].sort((left, right) => left - right),
    [...Array(AGENT_QUIPS.length).keys()],
    "one pass must cover the whole list exactly once",
  );

  const second = Array.from({ length: AGENT_QUIPS.length }, () => bag.next());
  assert.deepEqual(
    [...second].sort((left, right) => left - right),
    [...Array(AGENT_QUIPS.length).keys()],
    "the next pass covers it again",
  );
  assert.notEqual(second[0], first.at(-1), "the seam between passes must not repeat a line");
  assert.notDeepEqual(second, first, "a reshuffle that reproduces the same order is not a shuffle");
});

test("the bag survives a degenerate pool instead of dealing undefined", () => {
  const single = createQuipBag(1);
  assert.equal(single.next(), 0);
  assert.equal(single.next(), 0, "one quip can only ever repeat, and must not crash trying not to");
  assert.equal(createQuipBag(0).next(), -1);
});

test("a fixed random source deals a deterministic order", () => {
  // Same seed, same deal — the shuffle must read from the source it was given
  // rather than from Math.random behind its back.
  const values = [0.9, 0.1, 0.7, 0.3, 0.5];
  const deal = (): number[] => {
    let index = 0;
    const bag = createQuipBag(5, () => values[index++ % values.length]!);
    return Array.from({ length: 5 }, () => bag.next());
  };
  assert.deepEqual(deal(), deal());
});

test("nothing is dealt until the wait is long enough to notice", () => {
  const clock = fakeClock();
  const shown: string[] = [];
  const stop = startQuipRotation((quip) => shown.push(quip), clock);

  clock.advance(QUIP_DELAY_MS - 1);
  assert.deepEqual(shown, [], "a run that ends inside the delay must never have shown a quip");

  clock.advance(1);
  assert.equal(shown.length, 1, "the first quip lands exactly when the delay is up");

  clock.advance(QUIP_INTERVAL_MS * 3);
  assert.equal(shown.length, 4, "then one per interval");
  assert.ok(shown.every((line) => AGENT_QUIPS.includes(line)), "every line comes from the pool");

  stop();
  clock.advance(QUIP_INTERVAL_MS * 5);
  assert.equal(shown.length, 4, "a finished run stops dealing");
  assert.equal(clock.pending(), 0, "and leaves no timer behind");
});

test("a run that ends during the delay cancels the pending first quip", () => {
  const clock = fakeClock();
  const shown: string[] = [];
  const stop = startQuipRotation((quip) => shown.push(quip), clock);
  clock.advance(QUIP_DELAY_MS - 500);
  stop();
  clock.advance(QUIP_DELAY_MS * 4);
  assert.deepEqual(shown, []);
  assert.equal(clock.pending(), 0);
});
