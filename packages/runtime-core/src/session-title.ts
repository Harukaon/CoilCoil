/**
 * 会话标题：拿第一问一答单独问一次模型。
 *
 * 以前标题就是第一句话截断，找起来几乎没用——一屏侧栏全是「帮我看一下这个」「继续」
 * 「为什么不继续了」。这里在第一轮结束后单独发一次独立请求，让模型看着这一问一答
 * 起个名字，比只看提问准得多。
 *
 * 走的是独立的一次 completeSimple，不是主对话里的工具调用：不占主对话的记录、不会
 * 因为模型不配合而要重发，也不会把一次命名变成两个来回。
 */

/** 命名请求的系统提示词。 */
export const SESSION_TITLE_SYSTEM_PROMPT = [
  "你在给一段刚开始的对话起标题，标题会显示在侧栏的会话列表里。",
  "要求：",
  "- 只输出标题本身，不要引号、不要句号、不要任何解释或前缀。",
  "- 用对话使用的语言。",
  "- 不超过 16 个字（中文）或 6 个词（英文）。",
  "- 概括这次对话要解决的事，而不是复述用户的第一句话。",
  "- 具体一点：出现关键的文件名、模块名、报错名比泛泛而谈有用。",
].join("\n");

/** 标题最长多少字符——超出的一律截断，侧栏一行也放不下更多。 */
export const SESSION_TITLE_MAX_CHARS = 40;

/** 送去命名的那一问一答各截多长。整段发过去纯属浪费，开头已经够说清楚要做什么。 */
const EXCERPT_CHARS = 2_000;

function excerpt(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > EXCERPT_CHARS ? `${trimmed.slice(0, EXCERPT_CHARS)}\n…（已截断）` : trimmed;
}

/** 命名请求的用户消息。助手那一段可能为空（比如第一轮就被打断）。 */
export function buildSessionTitlePrompt(firstUserMessage: string, firstAssistantMessage: string): string {
  const parts = [`用户的第一条消息：\n${excerpt(firstUserMessage)}`];
  const reply = excerpt(firstAssistantMessage);
  if (reply) parts.push(`助手的第一条回复：\n${reply}`);
  parts.push("请给这段对话一个标题。");
  return parts.join("\n\n");
}

/**
 * 把模型回的东西收拾成一个能用的标题，收拾不出来就返回 undefined。
 *
 * 模型经常会加引号、加「标题：」前缀、或者干脆回一整段话。这里只接一行短文本：
 * 拿不到就保留原来那个截断标题，总好过把一段解释塞进侧栏。
 */
export function sanitizeSessionTitle(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // 推理模型有时会把思考连着答案一起给出来，只取最后一个非空行。
  const lines = raw.split("\n").map((line) => line.trim()).filter(Boolean);
  let title = lines.at(-1) ?? "";
  title = title.replace(/^(标题|title)\s*[:：]\s*/i, "");
  title = title.replace(/^[“"'『「]+|[”"'』」]+$/g, "");
  title = title.replace(/\s+/g, " ").trim();
  title = title.replace(/[。.]+$/, "");
  if (!title) return undefined;
  // 回了一整段话就当它没回：标题里不该还有句子分隔。长度未必超标——一句中文解释
  // 三十来个字就说完了，光看长度是拦不住的。（末尾那个句号上面已经去掉了，所以
  // 这里命中的一定是中间的断句。）
  if (/。|\. /.test(title)) return undefined;
  if (title.length > SESSION_TITLE_MAX_CHARS) title = title.slice(0, SESSION_TITLE_MAX_CHARS);
  return title;
}
