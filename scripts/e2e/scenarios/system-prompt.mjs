// 单元测试把一份手写的提示词喂给某个扩展，看不到「某一块悄悄没再送到模型手里」——工程规范
// 就这样丢过一阵：测试一直是绿的，真实对话里却一个字都没有。这个场景看的是真实应用拼出来、
// 真正发给模型的系统提示词。
export const description = "系统提示词：工程规范真的发给了模型，而且是英文";

const CJK = /[\u3000-\u9fff\uff00-\uffef]/;

export async function run({ ui, check, gatewayLog }) {
  await ui.newConversation("projA");
  await ui.send([{ tool: "ls", args: { path: "." } }, { echo: true }], "提示词");

  const request = gatewayLog().find((entry) => entry.tools?.includes("ls") && entry.systemFull);
  const prompt = request?.systemFull ?? "";
  check("对话的第一个请求带着系统提示词", prompt.length > 0);

  const blocks = prompt.split("<engineering_standards>").length - 1;
  check("工程规范在系统提示词里，且只有一份", blocks === 1, `出现 ${blocks} 次`);

  const standards = prompt.match(/<engineering_standards>\n([\s\S]*?)\n<\/engineering_standards>/)?.[1] ?? "";
  check("规范里有 Git 安全那一节", standards.includes("Git safety:"), standards.slice(0, 120));
  check("规范全是英文", standards.length > 0 && !CJK.test(standards), standards.match(CJK)?.[0]);
  check("规范里没有「测试与验证」那一块", standards.length > 0 && !/Testing and verification/.test(standards));
  check("规范里没有「不要创建提交」那一条", standards.length > 0 && !/create commits/.test(standards));
  check("规范是追加在 Pi 自己的提示词后面的，没有顶掉它", prompt.indexOf("<engineering_standards>") > 300, prompt.slice(0, 120));
}
