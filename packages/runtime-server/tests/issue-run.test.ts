import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import type { CoilCoilRuntime, CoilCoilRuntimeOptions } from "@coilcoil/runtime-core";
import type { RuntimeEvent, SessionSnapshot } from "@coilcoil/runtime-protocol";
// 故意从扩展那边导入写入函数：这两个文件隔着一层文件格式约定，测试里让真正的写入方
// 和真正的读取方对上，格式改了一边就会在这里断掉。
import { writeIssueReply } from "../../workflow/extensions/issue-agent.ts";
import { runIssueTask } from "../src/issue-run.js";

const ISSUE_RUN_DIR_ENV = "COILCOIL_ISSUE_RUN_DIR";

interface FakeBehaviour {
  /** 第几轮调用回复工具（1 开始）；不给就是从头到尾不回复。 */
  replyOnTurn?: number;
  reply?: { kind: "reply" | "ask"; text: string; verify?: string };
  /** 不发 run_state，用来模拟「根本没起来」。 */
  neverStarts?: boolean;
  /** 发了开始但不发结束，用来模拟卡住。 */
  neverFinishes?: boolean;
  lastAssistantText?: string;
}

class FakeRuntime {
  readonly prompts: string[] = [];
  readonly options: CoilCoilRuntimeOptions;
  disposed = false;
  private turn = 0;

  constructor(options: CoilCoilRuntimeOptions, private readonly behaviour: FakeBehaviour) {
    this.options = options;
  }

  private emit(event: RuntimeEvent): void {
    this.options.onEvent?.(event);
  }

  async createSession(): Promise<SessionSnapshot> {
    return {} as SessionSnapshot;
  }

  async prompt(text: string): Promise<{ accepted: true }> {
    this.prompts.push(text);
    this.turn += 1;
    const turn = this.turn;
    if (this.behaviour.neverStarts) return { accepted: true };
    // 真的运行时也是这样：prompt 先返回，跑起来是下一拍的事。
    setTimeout(() => {
      this.emit({ type: "run_state", running: true });
      if (this.behaviour.neverFinishes) return;
      if (this.behaviour.replyOnTurn === turn) {
        const runDir = process.env[ISSUE_RUN_DIR_ENV];
        assert.ok(runDir, "运行目录必须在扩展加载时就已经放进环境变量");
        writeIssueReply(runDir, {
          ...this.behaviour.reply ?? { kind: "reply" as const, text: "做完了" },
          at: new Date().toISOString(),
        });
      }
      this.emit({ type: "run_state", running: false });
    }, 1);
    return { accepted: true };
  }

  async snapshot(): Promise<SessionSnapshot> {
    return {
      messages: [
        { id: "1", order: 0, role: "user", text: "任务", timestamp: 1 },
        { id: "2", order: 1, role: "assistant", text: this.behaviour.lastAssistantText ?? "我看了一圈", timestamp: 2 },
      ],
    } as unknown as SessionSnapshot;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

function harness(behaviour: FakeBehaviour): {
  agentDir: string;
  sessionDir: string;
  runtimes: FakeRuntime[];
  options: CoilCoilRuntimeOptions;
  dependencies: Parameters<typeof runIssueTask>[2];
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "coilcoil-issue-run-"));
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const runtimes: FakeRuntime[] = [];
  return {
    agentDir,
    sessionDir,
    runtimes,
    options: { agentDir, sessionDir },
    dependencies: {
      createRuntime: (options) => {
        const runtime = new FakeRuntime(options, behaviour);
        runtimes.push(runtime);
        return runtime as unknown as CoilCoilRuntime;
      },
      startTimeoutMs: 60,
      turnTimeoutMs: 120,
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("一条任务跑在自己的会话目录里，工作区那份完全没被碰过", async () => {
  const fixture = harness({ replyOnTurn: 1, reply: { kind: "reply", text: "已经把按钮加上了", verify: "打开面板看右上角" } });
  try {
    const result = await runIssueTask(fixture.options, {
      cwd: "/project",
      issueId: "issue-1",
      prompt: "把按钮加上",
    }, fixture.dependencies);

    assert.deepEqual(result, { kind: "reply", text: "已经把按钮加上了", verify: "打开面板看右上角", turns: 1 });
    const runtime = fixture.runtimes[0];
    // 隔离的三条：会话文件在 agentDir/issues/runs 下、不在工作区的会话目录里；
    // 这两个工具只有这条运行有；跑完运行时就扔掉。
    assert.ok(runtime.options.sessionDir.startsWith(join(fixture.agentDir, "issues", "runs")));
    assert.ok(relative(fixture.sessionDir, runtime.options.sessionDir).startsWith(".."), "会话文件绝不能落在工作区的会话目录里");
    assert.ok(runtime.options.additionalExtensionPaths?.some((path) => path.endsWith("issue-agent.ts")));
    assert.equal(runtime.disposed, true);
    assert.equal(existsSync(fixture.sessionDir), false, "工作区的会话目录连建都不该建");
  } finally {
    fixture.cleanup();
  }
});

test("没回复就再催一轮，回复了就停", async () => {
  const fixture = harness({ replyOnTurn: 3, reply: { kind: "ask", text: "两个方案你要哪个？" } });
  try {
    const result = await runIssueTask(fixture.options, {
      cwd: "/project",
      issueId: "issue-2",
      prompt: "改一下",
    }, fixture.dependencies);

    assert.equal(result.kind, "ask");
    assert.equal(result.turns, 3);
    const prompts = fixture.runtimes[0].prompts;
    assert.equal(prompts.length, 3, "回复之后不该再催");
    assert.match(prompts[0], /改一下/);
    for (const nudge of prompts.slice(1)) assert.match(nudge, /还没有把结论交给用户/);
  } finally {
    fixture.cleanup();
  }
});

test("催满上限还不回复，就把它最后那段话交上去", async () => {
  const fixture = harness({ lastAssistantText: "我把三个文件都看了一遍，没发现问题" });
  try {
    const result = await runIssueTask(fixture.options, {
      cwd: "/project",
      issueId: "issue-3",
      prompt: "查一下",
      maxTurns: 2,
    }, fixture.dependencies);

    assert.deepEqual(result, {
      kind: "fallback",
      text: "我把三个文件都看了一遍，没发现问题",
      turns: 2,
    });
    assert.equal(fixture.runtimes[0].prompts.length, 2);
  } finally {
    fixture.cleanup();
  }
});

test("卡住的一轮会被掐掉，任务不会永远停在进行中", async () => {
  const fixture = harness({ neverFinishes: true });
  try {
    const result = await runIssueTask(fixture.options, {
      cwd: "/project",
      issueId: "issue-4",
      prompt: "跑个长的",
    }, fixture.dependencies);

    assert.equal(result.kind, "fallback");
    assert.match(result.text, /掐掉/);
    assert.equal(result.turns, 1);
  } finally {
    fixture.cleanup();
  }
});

test("根本没起来（多半是模型没配好）要报错，而不是假装跑完了", async () => {
  const fixture = harness({ neverStarts: true });
  try {
    await assert.rejects(
      () => runIssueTask(fixture.options, { cwd: "/project", issueId: "issue-5", prompt: "做点什么" }, fixture.dependencies),
      /没能开始/,
    );
  } finally {
    fixture.cleanup();
  }
});

test("运行目录的环境变量用完就还原，不会泄给下一条", async () => {
  const before = process.env[ISSUE_RUN_DIR_ENV];
  const fixture = harness({ replyOnTurn: 1 });
  try {
    await runIssueTask(fixture.options, { cwd: "/project", issueId: "issue-6", prompt: "做完它" }, fixture.dependencies);
    assert.equal(process.env[ISSUE_RUN_DIR_ENV], before);
  } finally {
    fixture.cleanup();
  }
});
