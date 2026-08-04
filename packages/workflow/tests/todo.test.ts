import assert from "node:assert/strict";
import test from "node:test";
import {
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
