import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

/**
 * 任务面板那条后台运行专用的两个工具：回复用户，和请用户拍板。
 *
 * 这个扩展**不在** package.json 的 pi.extensions 里，所以普通对话不会加载它——普通
 * 对话本来就在跟用户说话，多这两个工具只会让模型犯迷糊。只有任务面板起的那个独立
 * 运行会用 --extension 的方式单独把它挂上去。
 *
 * 为什么非得有这么一个工具，而不是把最后一段话当成回复：这条运行是完全后台的，用
 * 户看不到它调了什么工具、走了几步，只会在任务卡片上看到一段结论。模型自己写的收
 * 尾话经常是「我先看看这个文件」这种半截话；显式调用一次工具，才能保证卡片上那段
 * 话是它当成结论说的，而且能把「做了什么」和「你怎么验收」分开。
 *
 * 结果写文件而不是走事件总线：起这条运行的是同一个进程里的另一个 runtime，它只要
 * 读一个 JSON 就行，不用为此在 runtime 里拉一条新的事件通道。
 */

/** 这一次运行的目录，由起它的人在创建 runtime 之前放进环境变量。 */
export const ISSUE_RUN_DIR_ENV = "COILCOIL_ISSUE_RUN_DIR";
export const ISSUE_REPLY_FILENAME = "reply.json";

export interface IssueAgentReply {
  /** reply：做完了，等验收；ask：卡住了，要用户拿主意。 */
  kind: "reply" | "ask";
  text: string;
  /** 只有 reply 有：怎么验收。 */
  verify?: string;
  at: string;
}

export function issueReplyFile(runDir: string): string {
  return join(runDir, ISSUE_REPLY_FILENAME);
}

export function writeIssueReply(runDir: string, reply: IssueAgentReply): void {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(issueReplyFile(runDir), `${JSON.stringify(reply, null, 2)}\n`, "utf8");
}

/** 读这一轮的回复；没有回复、或者文件坏了，都当成「还没回复」。 */
export function readIssueReply(runDir: string): IssueAgentReply | undefined {
  let raw: string;
  try {
    raw = readFileSync(issueReplyFile(runDir), "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<IssueAgentReply>;
    if (parsed.kind !== "reply" && parsed.kind !== "ask") return undefined;
    if (typeof parsed.text !== "string" || !parsed.text.trim()) return undefined;
    return {
      kind: parsed.kind,
      text: parsed.text,
      verify: typeof parsed.verify === "string" && parsed.verify.trim() ? parsed.verify : undefined,
      at: typeof parsed.at === "string" ? parsed.at : new Date().toISOString(),
    };
  } catch {
    return undefined;
  }
}

const ReplyParams = Type.Object({
  summary: Type.String({
    description: "给用户看的结论：你做了什么、改了哪里。用户看不到你的过程，所以这段话要自己站得住。",
  }),
  verify: Type.Optional(Type.String({
    description: "用户怎么验收：具体到点哪里、跑哪条命令、该看到什么。没有可验收的东西就省略。",
  })),
});

const AskParams = Type.Object({
  question: Type.String({
    description: "你需要用户拿的那个主意。把选项和你的建议一起说清楚，用户回一句就能让你接着做。",
  }),
});

export interface IssueAgentOptions {
  env?: NodeJS.ProcessEnv;
}

export default function issueAgent(pi: ExtensionAPI, options: IssueAgentOptions = {}): void {
  // 在扩展加载的这一刻读，而不是等工具被调用时再读：加载发生在创建这条运行的那一
  // 瞬间，那时环境变量一定是这条运行的。
  const runDir = (options.env ?? process.env)[ISSUE_RUN_DIR_ENV]?.trim();

  const record = (reply: Omit<IssueAgentReply, "at">): { ok: boolean; text: string } => {
    if (!runDir) {
      return { ok: false, text: "这条运行没有结果目录，无法回复用户。请把结论直接写在正文里。" };
    }
    try {
      writeIssueReply(runDir, { ...reply, at: new Date().toISOString() });
      return { ok: true, text: "已经把这段话交给用户了，你可以结束这一轮了。" };
    } catch (error) {
      return { ok: false, text: `写回复失败：${error instanceof Error ? error.message : String(error)}` };
    }
  };

  pi.registerTool({
    name: "issue_reply",
    label: "回复用户",
    description:
      "把这条任务的结论交给用户，并结束这一轮。做完了、做不了、发现这条任务不该做，都用它。用户只会看到这段话，看不到你的过程。",
    promptSnippet: "issue_reply: 把这条任务的结论交给用户（做完了就调用）",
    promptGuidelines: [
      "你正在处理任务面板上的一条任务，用户不在旁边看，也看不到你的工具调用；结束这一轮之前必须调用一次 issue_reply 或 issue_ask，否则用户那边什么都收不到。",
      "issue_reply 的 summary 是给用户看的结论，不是给自己看的笔记：说清楚改了什么、结果如何；verify 说清楚他怎么验收。",
    ],
    parameters: ReplyParams,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const result = record({ kind: "reply", text: params.summary, verify: params.verify });
      return {
        content: [{ type: "text", text: result.text }],
        details: { kind: "reply", summary: params.summary, verify: params.verify },
        isError: !result.ok,
      };
    },
  });

  pi.registerTool({
    name: "issue_ask",
    label: "请用户拿主意",
    description:
      "这条任务卡在一个只有用户能定的问题上时调用：任务会停在「待回复」，用户回答后会重新排进队列。不要用它问你自己查得到的东西。",
    promptSnippet: "issue_ask: 需要用户拍板时问一句（问完这一轮就结束）",
    promptGuidelines: [
      "只有当继续做下去必须先知道用户的取舍时才用 issue_ask；能自己查、自己试的，先做。",
    ],
    parameters: AskParams,
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const result = record({ kind: "ask", text: params.question });
      return {
        content: [{ type: "text", text: result.text }],
        details: { kind: "ask", question: params.question },
        isError: !result.ok,
      };
    },
  });
}
