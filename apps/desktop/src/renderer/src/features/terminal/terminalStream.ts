/** The part of xterm a stream needs: somewhere to put bytes. */
export interface TerminalStreamTarget {
  write(data: string): void;
}

/**
 * The pump between main's terminal data events and the xterm showing them.
 *
 * The panel used to accumulate every chunk into one rolling React string,
 * capped at half a megabyte, and hand xterm whatever the new string had that
 * the old one did not. That works right up to the cap: past it the head of the
 * string falls off, the new value stops starting with the old one, and the
 * panel answers by resetting the terminal and replaying the whole buffer — for
 * every chunk, forever. Resetting throws the viewport back to the bottom (it
 * clears xterm's own "the user has scrolled up" flag) and replaying a tail that
 * starts mid escape sequence draws garbage, which is exactly what a long
 * claude code session looked like.
 *
 * So chunks go straight through to xterm, which owns the scrollback and, left
 * alone, keeps the viewport where the reader put it.
 */
export class TerminalStream {
  private target: TerminalStreamTarget | undefined;
  private pending: string[] = [];

  /** Take a chunk from main, buffering it until a terminal is listening. */
  push(data: string): void {
    if (this.target) this.target.write(data);
    else this.pending.push(data);
  }

  /** Point the stream at a freshly opened terminal and flush what it missed. */
  attach(target: TerminalStreamTarget): void {
    this.target = target;
    const buffered = this.pending;
    this.pending = [];
    for (const data of buffered) target.write(data);
  }

  /** Let go of a terminal that is being disposed, if it is still the live one. */
  detach(target: TerminalStreamTarget): void {
    if (this.target === target) this.target = undefined;
  }

  /**
   * Forget what arrived before the replay snapshot was taken.
   *
   * The snapshot main answers with already contains everything it had buffered
   * when the request reached it, so chunks that raced the reply are in both and
   * would otherwise be drawn twice.
   */
  discardPending(): void {
    this.pending = [];
  }
}
