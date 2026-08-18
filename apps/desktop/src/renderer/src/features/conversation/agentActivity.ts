export type AgentPhase = "思考" | "回复" | "工具";

/**
 * The plain half of the status line.
 *
 * It always leads, because it is the only part that reports anything true
 * about the run. The quip that follows is company for a wait, not a status.
 */
const PHASE_COPY: Record<AgentPhase, string> = {
  思考: "思考中",
  回复: "组织回答中",
  工具: "动手处理中",
};

const PHASE_FALLBACK = "工作中";

/** A short run just says what it is doing; a quip that flashes past only distracts. */
export const QUIP_DELAY_MS = 5_000;

/** Long enough to actually read one, unlike the 2.3s the old phrase carousel used. */
export const QUIP_INTERVAL_MS = 6_500;

/**
 * Company for a long wait.
 *
 * Kept deliberately mixed — folklore, advice that is actually worth taking, and
 * plain silliness — because the same three lines arriving every time a run gets
 * long is worse than no lines at all. Each one is short enough to sit after the
 * phase word without wrapping the status row.
 */
export const AGENT_QUIPS = [
  // 行业老梗
  "计算机科学两大难题：缓存失效和命名",
  "这段代码半年后你也会觉得是别人写的",
  "能跑，就先别动它",
  "它昨天还是好的，我发誓",
  "在我机器上是好的",
  "又是少一个分号的一天",
  "数组从 0 开始，痛苦从 1 开始",
  "用正则解决问题，现在你有两个问题",
  "注释和代码，总有一个在骗人",
  "过早优化是万恶之源，但优化真的很爽",
  "命名想了十分钟，最后叫 data2",
  "叫 temp 的变量，往往活到了上线",
  "删掉那行注释之后，程序就跑不动了",
  "修好一个 bug，唤醒两个 bug",
  "这不是 bug，是没写进文档的特性",
  "生产环境最稳的时刻，是没人上线的时候",
  "周五下午发版，是勇士的浪漫",
  "sleep 3 是最好的同步原语（并不是）",
  "缩进之争打了三十年，还没打完",
  "复制来的代码，注释里还留着别人的名字",

  // 和 AI 一起写代码的新烦恼
  "AI 写的代码也要读，真的",
  "提交前看一眼 diff，就一眼",
  "别 vibe 到生产环境去",
  "「帮我改一下」是最贵的四个字",
  "上下文烧完之前，先存个盘",
  "让它写测试，然后你去读测试",
  "需求写「随便弄弄」的，都是最难的需求",
  "你说差不多就行，我可当真了",
  "跟 AI 结对，责任还是你的",
  "提示词越具体，返工越少",
  "它很自信，但自信不等于正确",
  "review 的时候，别只看它说了什么",
  "大改之前，先开个分支",
  "一次只让它改一件事，其实更快",
  "跑通了不等于对了",

  // 半正经的建议
  "先让它跑起来，再让它跑得对",
  "小步提交，你会感谢今天的自己",
  "写不出测试，多半是设计有问题",
  "讲给小黄鸭听，一半的 bug 自己会现形",
  "加日志比猜快",
  "复现不了的 bug，先别急着改",
  "三层 if 嵌套之后，考虑换个写法",
  "起的名字，要让半年后的你看懂",
  "复制粘贴之前，先问一句为什么",
  "装依赖之前，看看它多久没更新了",
  "报错读到最后一行，答案常在那儿",
  "二分法定位，比通读快十倍",
  "先备份，再动手",
  "能删掉的代码，是最好的代码",
  "文档要写在你还记得的时候",
  "不确定就去查，别硬猜",
  "先问清楚要什么，再决定怎么做",

  // 纯陪聊
  "咖啡续上了，继续",
  "正在把想法翻译成人话",
  "别催，正在跟自己辩论",
  "已进入心流，请勿打扰",
  "键盘敲得响，说明在思考",
  "这次一定",
  "马上就好（程序员时间）",
  "正在假装很有把握",
  "想了个更好的办法，又被自己否了",
  "脑子里有三个方案在打架",
  "正在把大问题拆成小问题",
  "顺手清了个小 bug",
  "在翻文件，像在翻抽屉",
  "找到了，就在最后找的那个地方",
  "别盯进度条，盯结果",
  "已经很努力了，真的",
  "今天手气应该不错",
  "稳住，我们能赢",
  "再给我一秒钟，就一秒",
  "快好了（这句可能不太可信）",
];

/**
 * Deal quips without repeats.
 *
 * Picking at random re-shows the same line two or three times before half the
 * list has ever appeared, which is exactly what makes canned copy feel canned.
 * A shuffled bag guarantees every line shows once per pass, and the seam
 * between passes is patched so a line never lands twice in a row.
 */
export interface QuipBag {
  next(): number;
}

export function createQuipBag(count: number, random: () => number = Math.random): QuipBag {
  let order: number[] = [];
  let cursor = 0;
  let previous = -1;

  const refill = (): void => {
    order = [...Array(count).keys()];
    for (let index = order.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(random() * (index + 1));
      [order[index], order[swap]] = [order[swap]!, order[index]!];
    }
    if (order.length > 1 && order[0] === previous) [order[0], order[1]] = [order[1]!, order[0]!];
    cursor = 0;
  };

  return {
    next(): number {
      if (count <= 0) return -1;
      if (cursor >= order.length) refill();
      const value = order[cursor]!;
      cursor += 1;
      previous = value;
      return value;
    },
  };
}

/** The clock the rotation runs on, so a test can drive it without waiting 5 real seconds. */
export interface QuipTimers {
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(handle: number): void;
  setInterval(handler: () => void, ms: number): number;
  clearInterval(handle: number): void;
}

/**
 * Hold the plain status for a beat, then start dealing quips.
 *
 * Split out of the hook because this delay is the whole feature: a run that
 * ends inside it must never have shown a quip at all, and that is not
 * something a five-line effect body can be trusted with untested.
 */
export function startQuipRotation(
  show: (quip: string) => void,
  timers: QuipTimers,
  bag: QuipBag = createQuipBag(AGENT_QUIPS.length),
): () => void {
  let interval: number | undefined;
  const deal = (): void => show(AGENT_QUIPS[bag.next()]!);
  const delay = timers.setTimeout(() => {
    deal();
    interval = timers.setInterval(deal, QUIP_INTERVAL_MS);
  }, QUIP_DELAY_MS);
  return () => {
    timers.clearTimeout(delay);
    if (interval !== undefined) timers.clearInterval(interval);
  };
}

/** Join the two halves. Without a quip the line reads exactly as it always has. */
export function agentActivityLine(phase: AgentPhase | undefined, quip?: string): string {
  const head = phase ? PHASE_COPY[phase] : PHASE_FALLBACK;
  return quip ? `${head} · ${quip}` : `${head}…`;
}
