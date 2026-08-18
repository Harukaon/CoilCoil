/**
 * Stable per-session identity for tool runs.
 *
 * SuoCode keys tool cards, terminals, and subagent placeholders by the tool call
 * id the provider reports. That is safe for `anthropic-messages` and
 * `openai-responses`, which mint a globally unique id per call, but not for
 * OpenAI-compatible `openai-completions` endpoints: DeepSeek and friends number
 * their calls `call_0`, `call_1`, … and restart at zero on every assistant turn.
 * Using the raw id there makes the second turn's `call_0` overwrite the first
 * turn's card, so a session that really ran two dozen tools showed a handful.
 *
 * Counting occurrences fixes that without inventing ids the rest of the runtime
 * cannot correlate: the first run of a raw id keeps that id verbatim, so any
 * provider with unique ids is completely unaffected, and only a genuine repeat
 * gets a suffix.
 */
export function toolRunId(rawToolCallId: string, occurrence: number): string {
  return occurrence <= 1 ? rawToolCallId : `${rawToolCallId}#${occurrence}`;
}

export class ToolRunIds {
  private readonly occurrences = new Map<string, number>();
  private readonly inFlight = new Map<string, string>();

  /**
   * Claim the run id for a call that is starting.
   *
   * Idempotent on purpose: a call is projected both from its assistant message
   * and from `tool_execution_start`, and those must land on one run.
   */
  begin(rawToolCallId: string): string {
    const existing = this.inFlight.get(rawToolCallId);
    if (existing) return existing;
    const occurrence = (this.occurrences.get(rawToolCallId) ?? 0) + 1;
    this.occurrences.set(rawToolCallId, occurrence);
    const id = toolRunId(rawToolCallId, occurrence);
    this.inFlight.set(rawToolCallId, id);
    return id;
  }

  /** The run a partial result or a late label update belongs to. */
  current(rawToolCallId: string): string {
    return this.inFlight.get(rawToolCallId) ?? this.begin(rawToolCallId);
  }

  /**
   * Close the run. The next call reusing this raw id is a different tool run and
   * must not reuse the finished card.
   */
  end(rawToolCallId: string): string {
    const id = this.current(rawToolCallId);
    this.inFlight.delete(rawToolCallId);
    return id;
  }
}
