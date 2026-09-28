import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const description = "上下文压缩走 CoilCoil 自己的两层：清完够小就停在第 1 层（整理稿，不调模型）；/compact 带额外要求时走第 2 层（调模型写交接摘要）；每一步都进运行日志";

/** 会话目录里最新的、包含某段文字的会话文件。 */
function sessionFile(root, marker) {
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".jsonl") && readFileSync(path, "utf8").includes(marker)) found.push(path);
    }
  };
  walk(join(root, "data", "sessions"));
  return found.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

const compactions = (path) => readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.type === "compaction");
const runtimeLog = (root) => readFileSync(join(root, "data", "agent", "logs", "runtime.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

export async function run({ page, ui, root, check }) {
  await ui.newConversation("projA");
  const composer = page.locator(".prompt-editor");
  const sendRaw = async (text, waitFor) => {
    await composer.click();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.insertText(text);
    await page.getByRole("button", { name: "发送消息" }).click();
    if (waitFor) await ui.waitFor(async () => (await page.getByText(waitFor, { exact: false }).count()) > 0, 60_000);
    await page.waitForTimeout(800);
  };
  // 两轮：第一轮会被压掉，第二轮足够长（Pi 估算超过 2 万 token），落在保留区。
  const filler = "keep this recent line intact. ".repeat(3200);
  await sendRaw(`第一轮 MOCK:[{"text":"收到一"}]\n把 config.json 的超时改成 30 秒`, "收到一");
  await sendRaw(`第二轮 MOCK:[{"text":"收到二"}]\n${filler}`, "收到二");

  await sendRaw("/compact");
  const path = await (async () => {
    let found;
    await ui.waitFor(async () => {
      found = sessionFile(root, "第二轮");
      return Boolean(found && compactions(found).length >= 1);
    }, 60_000);
    return found;
  })();
  check("手动压缩落地了一条压缩记录", Boolean(path && compactions(path).length === 1));
  const first = compactions(path)[0];
  check("第 1 层：清完够小，不调模型，交回整理稿", first?.details?.coilcoil?.layer === 1, JSON.stringify(first?.details?.coilcoil));
  check("整理稿里是第一轮的原话", String(first?.summary).includes("【用户】第一轮"), String(first?.summary).slice(0, 200));
  check("最近的第二轮原样保留，没被压进去", !String(first?.summary).includes("keep this recent line intact"));
  const log = runtimeLog(root);
  check("运行日志记下了第 1 层的估算和决定", log.some((entry) => entry.event === "coilcoil_layer1_planned" && entry.data?.accept === true));
  check("运行日志记下了完成", log.some((entry) => entry.event === "coilcoil_done" && entry.data?.layer === 1));

  // 再来两轮，然后带额外要求 /compact：走第 2 层，模型写摘要（mock 模型回一段短文字）。
  await sendRaw(`第三轮 MOCK:[{"text":"收到三"}]\n接着把重试次数改成 5`, "收到三");
  await sendRaw(`第四轮 MOCK:[{"text":"收到四"}]\n${filler}`, "收到四");
  await sendRaw("/compact 重点保留配置改动");
  await ui.waitFor(async () => compactions(path).length >= 2, 60_000);
  const second = compactions(path)[1];
  check("带额外要求时走第 2 层，调模型写摘要", second?.details?.coilcoil?.layer === 2, JSON.stringify(second?.details?.coilcoil));
  const log2 = runtimeLog(root);
  check("第 2 层的每次请求都记了耗时", log2.some((entry) => entry.event === "coilcoil_request_completed" && typeof entry.data?.ms === "number"));
  check("日志带着会话路径", log2.filter((entry) => String(entry.event).startsWith("coilcoil_")).every((entry) => String(entry.sessionPath ?? entry.data?.sessionPath ?? "").endsWith(".jsonl")));
  check("压缩期间没有提示失败", (await page.getByText("上下文压缩失败", { exact: false }).count()) === 0);
}
