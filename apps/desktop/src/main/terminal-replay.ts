/**
 * The rolling copy of a shell's output that a panel replays when it attaches.
 *
 * Only the tail is worth keeping: a shell that has been open for hours emits
 * far more than a fresh xterm needs, and the live view is fed by data events
 * anyway. Keeping that tail as `output = (output + data).slice(-LIMIT)` looks
 * innocent but rebuilds the whole half-megabyte string for every chunk the pty
 * hands over — dozens of times a second under a full-screen TUI like claude
 * code — so the tail is stored as the chunks themselves and only joined when
 * somebody actually asks for it.
 */

export const TERMINAL_REPLAY_LIMIT = 500_000;

/** How far into the tail a line break is still worth looking for. */
const LINE_START_SEARCH = 8_192;

/**
 * Drop the partial first line of a trimmed tail.
 *
 * The cut point is a character count, so it lands wherever it lands — often in
 * the middle of an escape sequence, which xterm then paints as stray letters
 * for the rest of the session. Escape sequences never span a line break, so
 * starting the replay after the first one is enough to make the tail parse.
 * A tail with no break in reach (a TUI redrawing in place) is left alone
 * rather than thrown away.
 */
export function trimToLineStart(text: string): string {
  const breakAt = text.indexOf("\n");
  return breakAt === -1 || breakAt >= LINE_START_SEARCH ? text : text.slice(breakAt + 1);
}

export class TerminalReplayBuffer {
  private readonly chunks: string[] = [];
  private readonly limit: number;
  private size = 0;
  private cached: string | undefined;

  constructor(limit: number = TERMINAL_REPLAY_LIMIT) {
    this.limit = limit;
  }

  push(data: string): void {
    if (!data) return;
    this.chunks.push(data);
    this.size += data.length;
    // Whole chunks only: dropping characters out of the oldest one would mean
    // rewriting it, which is the cost this buffer exists to avoid.
    while (this.chunks.length > 1 && this.size - (this.chunks[0]?.length ?? 0) >= this.limit) {
      this.size -= this.chunks.shift()?.length ?? 0;
    }
    this.cached = undefined;
  }

  text(): string {
    if (this.cached === undefined) {
      const joined = this.chunks.join("");
      this.cached = joined.length > this.limit ? trimToLineStart(joined.slice(-this.limit)) : joined;
    }
    return this.cached;
  }
}
