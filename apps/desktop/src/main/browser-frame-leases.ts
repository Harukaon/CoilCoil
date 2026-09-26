export type SurfaceFrameMode = "texture" | "jpeg";

/**
 * 在路上的画面：最多三张纹理、一张 JPEG。窗口画得慢就丢新帧，不能无限占着 GPU 纹理，
 * 也不能把消息队列堆满。
 *
 * 纹理超时只报告「卡住了」，绝不提前归还：窗口那边可能还在读这张纹理，提前还给页面
 * 会被下一帧覆盖，甚至读到已释放的显存。等迟到的回执，或者确认窗口那边的页面已经
 * 没了（重载、崩溃）再整体收回。JPEG 是拷贝过去的，超时直接作废。
 */
export class BrowserFrameLeases {
  private sequence = 0;
  private readonly entries = new Map<number, {
    mode: SurfaceFrameMode;
    release: () => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(private readonly timedOut: (mode: SurfaceFrameMode) => void, private readonly timeoutMs = 2000) {}

  count(mode: SurfaceFrameMode): number {
    let count = 0;
    for (const entry of this.entries.values()) if (entry.mode === mode) count++;
    return count;
  }

  canSend(mode: SurfaceFrameMode): boolean {
    return this.count(mode) < (mode === "texture" ? 3 : 1);
  }

  add(mode: SurfaceFrameMode, release: () => void): number {
    const id = ++this.sequence;
    const timer = setTimeout(() => {
      if (!this.entries.has(id)) return;
      if (mode === "jpeg") this.complete(id);
      this.timedOut(mode);
    }, this.timeoutMs);
    timer.unref?.();
    this.entries.set(id, { mode, release, timer });
    return id;
  }

  /** 收到回执（或确认对方用不到了）：归还这一帧。重复、过期的回执不算。 */
  complete(id: number): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    clearTimeout(entry.timer);
    entry.release();
    return true;
  }

  /** 只在窗口那边的页面已经没了（重载、崩溃、关闭）时用；切标签、收起面板、超时都不能清空。 */
  dispose(): void {
    for (const id of [...this.entries.keys()]) this.complete(id);
  }

  get size(): number {
    return this.entries.size;
  }
}
