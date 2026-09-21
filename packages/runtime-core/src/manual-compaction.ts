/**
 * What a hand-typed `/compact` says when it cannot happen.
 *
 * Compaction has always existed here, but only ever fired by itself: at the
 * threshold, or after the context overflowed. Someone who can see the context
 * meter climbing and wants to summarize *now* — before a long task, or right
 * after a stretch of noisy tool output — had no way to say so, even though the
 * failure notice cheerfully told them to 「必要时手动 /compact」.
 *
 * The command itself is parsed in the protocol package, because the composer
 * has to recognise it too. Only the words belong here.
 */

/** Everything about the session that decides whether `/compact` can run. */
export interface ManualCompactionState {
  compacting: boolean;
  /** An automatic compaction or a branch summary is already running. */
  summarizing: boolean;
  /** A turn is streaming, starting, or being handed over from the queue. */
  busy: boolean;
  hasModel: boolean;
  messages: number;
  /** The last entry on this branch is already a compaction. */
  alreadyCompacted: boolean;
}

/**
 * Why this `/compact` will not run — or nothing, if it will.
 *
 * A running turn is refused rather than interrupted. Pi's own manual
 * compaction aborts whatever is streaming first, and silently eating an answer
 * that is halfway written is not what someone typing 「压缩一下」 is asking for.
 *
 * The last two cases are answered here rather than by Pi for the same reason:
 * Pi announces the compaction before it checks whether there is anything to
 * compact, so letting it refuse would draw a 「上下文整理失败」 rule across the
 * transcript of a session whose only crime was being short.
 */
export function manualCompactionRefusal(state: ManualCompactionState): string | undefined {
  if (state.compacting) return "上下文正在压缩，请等它结束。";
  if (state.summarizing) return "上下文正在整理，请等它结束。";
  if (state.busy) return "当前回复还在运行，先停止或等它结束再压缩上下文。";
  if (!state.hasModel) return "当前没有可用于压缩上下文的模型。";
  if (state.messages === 0) return "当前会话还没有可压缩的上下文。";
  if (state.alreadyCompacted) return "上次压缩之后还没有新的对话，没有需要压缩的内容。";
  return undefined;
}

/**
 * Say why a compaction did not happen, in the language the user typed in.
 *
 * Pi answers in English and from its own vocabulary — "Nothing to compact
 * (session too small)" tells someone who pressed a button in a Chinese
 * interface nothing they can act on.
 */
export function manualCompactionErrorMessage(message: string): string {
  if (message.includes("Already compacted")) {
    return "上次压缩之后还没有新的对话，没有需要压缩的内容。";
  }
  if (message.includes("Nothing to compact")) {
    return "当前对话还太短，没有需要压缩的历史。";
  }
  if (message.includes("Compaction cancelled")) return "上下文压缩已取消。";
  return `上下文压缩失败：${message}`;
}
