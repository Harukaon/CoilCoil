import assert from "node:assert/strict";
import test from "node:test";
import todoExtension, {
  buildTodoWidgetLines,
  validateTodoPlan,
  type TodoItem,
} from "../extensions/todo.ts";

const plainTheme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
};

test("todo accepts one active item and trims task text", () => {
  const result = validateTodoPlan([
    { text: "  调研接口  ", status: "completed" },
    { text: "实现扩展", status: "in_progress" },
    { text: "验证结果", status: "pending" },
  ]);

  assert.deepEqual(result, {
    plan: [
      { text: "调研接口", status: "completed" },
      { text: "实现扩展", status: "in_progress" },
      { text: "验证结果", status: "pending" },
    ],
  });
});

test("todo rejects multiple active items", () => {
  assert.deepEqual(
    validateTodoPlan([
      { text: "第一项", status: "in_progress" },
      { text: "第二项", status: "in_progress" },
    ]),
    { error: "同一时间只能有一项进行中" },
  );
});

test("todo widget stays compact and keeps the active item visible", () => {
  const plan: TodoItem[] = Array.from({ length: 12 }, (_, index) => ({
    text: `任务 ${index + 1}`,
    status: index < 8
      ? "completed"
      : index === 8
        ? "in_progress"
        : "pending",
  }));

  const lines = buildTodoWidgetLines(plan, plainTheme);

  assert.equal(lines[0], "TODO 8/12");
  assert.ok(lines.some((line) => line.includes("● 9. 任务 9")));
  assert.ok(lines.length <= 9);
});

interface Harness {
  handlers: Map<string, Function[]>;
  execute(plan: TodoItem[]): Promise<any>;
}

function harness(): Harness {
  const handlers = new Map<string, Function[]>();
  let tool: any;
  const pi = {
    on(name: string, handler: Function) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool(definition: any) {
      tool = definition;
    },
  };
  todoExtension(pi as any);
  return {
    handlers,
    execute: (plan) =>
      tool.execute("call-1", { plan }, undefined, undefined, { hasUI: false }),
  };
}

function toolResultMessage(plan: TodoItem[]) {
  return { role: "toolResult", toolName: "todo", details: { plan } };
}

test("todo 每一轮都注入当前清单并标出进行中的那条", async () => {
  const { handlers, execute } = harness();
  await execute([
    { text: "读代码", status: "completed" },
    { text: "写扩展", status: "in_progress" },
    { text: "补测试", status: "pending" },
  ]);

  const before = handlers.get("before_agent_start")!;
  for (let round = 0; round < 3; round++) {
    const result = await before[0]({ systemPrompt: "base" }, {});
    assert.equal(result.message.display, false);
    assert.match(result.message.content, /当前 Todo（已完成 1\/3）/);
    assert.match(result.message.content, /● 2\. 写扩展 ← 进行中/);
    assert.match(result.message.content, /todo 工具更新状态/);
  }
});

test("todo 为空或全部完成时不注入任何东西", async () => {
  const { handlers, execute } = harness();
  const before = handlers.get("before_agent_start")![0];

  assert.equal(await before({ systemPrompt: "base" }, {}), undefined);

  await execute([{ text: "唯一一项", status: "completed" }]);
  assert.equal(await before({ systemPrompt: "base" }, {}), undefined);

  await execute([]);
  assert.equal(await before({ systemPrompt: "base" }, {}), undefined);
});

test("清单仍在上下文里时不重复注入，被压缩掉后补回来", async () => {
  const { handlers, execute } = harness();
  const plan: TodoItem[] = [
    { text: "第一步", status: "in_progress" },
    { text: "第二步", status: "pending" },
  ];
  await execute(plan);
  const context = handlers.get("context")![0];

  assert.equal(
    await context({ messages: [toolResultMessage(plan)] }, {}),
    undefined,
  );

  const injected = await context({ messages: [{ role: "user" }] }, {});
  assert.equal(injected.messages.length, 2);
  assert.equal(injected.messages[1].role, "custom");
  assert.match(injected.messages[1].content, /● 1\. 第一步 ← 进行中/);

  // 补回来的那条本身也算「模型看得见」，不会每次请求都再叠一条
  assert.equal(await context({ messages: injected.messages }, {}), undefined);
});
