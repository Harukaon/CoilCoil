/**
 * Pull reasoning that arrived inside an assistant's visible text back out.
 *
 * Reasoning belongs in the thinking channel, and both Pi transports SuoCode
 * uses put it there: `openai-responses` replays reasoning items and drops
 * thinking blocks it cannot sign, and `openai-completions` only inlines
 * `<thinking>` delimiters behind the explicit `requiresThinkingAsText` compat
 * flag. Neither path can produce these tags on its own.
 *
 * They still show up through OpenAI-compatible proxies, which is where the
 * reasoning-item round trip is least reliable, and they show up on long
 * conversations rather than short ones. Once a proxy inlines one turn's
 * reasoning as text the model sees that convention in its own history and
 * imitates it, so the leak sticks for the rest of the session.
 *
 * Rendering the tags verbatim is the one outcome that is certainly wrong, so
 * the projection normalizes them regardless of who produced them.
 */

const INLINE_THINKING_PATTERN = /<(thinking|thought|think)>([\s\S]*?)<\/\1>/gi;
/** An unterminated tag: the turn was cut off, or the closer is still streaming. */
const UNTERMINATED_THINKING_PATTERN = /<(thinking|thought|think)>([\s\S]*)$/i;

export interface SplitThinking {
  text: string;
  thinking: string;
}

export function splitInlineThinking(text: string, existingThinking = ""): SplitThinking {
  if (!text.includes("<")) return { text, thinking: existingThinking };

  const extracted: string[] = [];
  let remaining = text.replace(INLINE_THINKING_PATTERN, (_match, _tag: string, body: string) => {
    const trimmed = body.trim();
    if (trimmed) extracted.push(trimmed);
    return "";
  });

  const unterminated = UNTERMINATED_THINKING_PATTERN.exec(remaining);
  if (unterminated) {
    const trimmed = unterminated[2].trim();
    if (trimmed) extracted.push(trimmed);
    remaining = remaining.slice(0, unterminated.index);
  }

  if (!extracted.length) return { text, thinking: existingThinking };

  // Blank lines are left behind where the blocks were removed.
  const cleaned = remaining.replace(/\n{3,}/g, "\n\n").trim();
  const thinking = [existingThinking.trim(), ...extracted].filter(Boolean).join("\n\n");
  return { text: cleaned, thinking };
}
