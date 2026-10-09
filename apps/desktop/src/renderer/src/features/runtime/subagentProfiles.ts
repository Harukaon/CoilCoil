import type {
  RuntimeConfiguration,
  SaveSubagentProfileInput,
  SubagentProfileInfo,
  SubagentProfileModels,
  SubagentProfileScope,
} from "@coilcoil/runtime-protocol";
import type { SelectOption } from "../../ui/Select";

/**
 * What the settings pages say about the subagents that ship with the product.
 *
 * A profile's own description is written for the model that decides when to dispatch it,
 * so the built-in ones are in English. People reading this page get a short line in
 * Chinese instead. A profile the user wrote has no entry here and shows what they wrote.
 */
const BUILTIN_BLURBS: Record<string, string> = {
  explore: "只读搜索与代码梳理",
  worker: "编码实现与文件修改",
  reviewer: "独立代码评审",
  hacker: "自己设计用例，找出已完成代码里的问题",
};

export function subagentTitle(profile: Pick<SubagentProfileInfo, "name" | "source">): string {
  if (profile.source !== "builtin") return profile.name;
  return `${profile.name.charAt(0).toUpperCase()}${profile.name.slice(1)}`;
}

export function subagentBlurb(profile: Pick<SubagentProfileInfo, "name" | "source" | "description">): string {
  if (profile.source === "builtin") return BUILTIN_BLURBS[profile.name] ?? profile.description;
  return profile.description;
}

/** The model the user picked, or empty when none is picked. */
export function chosenSubagentModel(models: SubagentProfileModels, name: string): string {
  return Object.hasOwn(models, name) ? models[name]?.trim() ?? "" : "";
}

/**
 * Whether the subagent can be dispatched at all. A model picked here is enough, and so is
 * one written in the profile's own file; with neither, dispatching it is refused.
 */
export function subagentUsable(profile: Pick<SubagentProfileInfo, "name" | "fileModel">, models: SubagentProfileModels): boolean {
  return Boolean(chosenSubagentModel(models, profile.name) || profile.fileModel);
}

/** The models to send when saving: every listed profile, empty where nothing is picked, so a cleared choice sticks. */
export function subagentModelsToSave(profiles: readonly Pick<SubagentProfileInfo, "name">[], models: SubagentProfileModels): SubagentProfileModels {
  return Object.fromEntries(profiles.map((profile) => [profile.name, chosenSubagentModel(models, profile.name)]));
}

/** A subagent the user wrote, which they may edit or delete; the built-in ones ship with the product. */
export function isCustomSubagent(profile: Pick<SubagentProfileInfo, "source">): profile is Pick<SubagentProfileInfo, "source"> & { source: SubagentProfileScope } {
  return profile.source !== "builtin";
}

/**
 * The choices for a subagent's model: "none" first (worded by whether its file names one), then
 * a model that was picked but is no longer available (shown, not selectable), then every model
 * that can be used.
 */
export function subagentModelOptions(input: {
  fileModel?: string;
  selected: string;
  models: RuntimeConfiguration["models"];
}): SelectOption[] {
  const available = input.models.some((model) => `${model.provider}/${model.id}` === input.selected);
  return [
    input.fileModel
      ? { value: "", label: `沿用文件里写的模型（${input.fileModel}）`, detail: "不另选时，用这个子 Agent 文件里写明的模型" }
      : { value: "", label: "未配置（此子 Agent 不可用）", detail: "不配置就不给派发，而不是悄悄用主会话模型" },
    ...(input.selected && !available
      ? [{ value: input.selected, label: input.selected, detail: "当前不可用", disabled: true }]
      : []),
    ...input.models.map((model) => ({
      value: `${model.provider}/${model.id}`,
      label: model.name,
      detail: `${model.providerName} · ${model.provider}/${model.id}`,
      keywords: `${model.providerName} ${model.provider} ${model.id}`,
    })),
  ];
}

// ---- the form for adding or editing a subagent ----

/** What each tool lets a subagent do, in words that need no knowledge of the tool's name. */
const TOOL_BLURBS: Record<string, string> = {
  read: "读文件",
  grep: "搜索内容",
  ls: "列目录",
  bash: "运行命令",
  terminal: "后台和长时间运行的命令",
  edit: "修改文件",
  write: "写新文件",
  mcp: "外部工具（MCP）",
};

export function subagentToolBlurb(tool: string): string {
  return TOOL_BLURBS[tool] ?? "";
}

/** A new subagent starts able to look but not to change anything; whoever adds it ticks the rest. */
export const DEFAULT_NEW_SUBAGENT_TOOLS: readonly string[] = ["read", "grep", "ls"];

/** Tools that change files. A subagent holding one is given the Git safety rules (see the workflow's child.ts). */
const FILE_CHANGING_TOOLS: readonly string[] = ["edit", "write"];

export function changesFiles(tools: readonly string[]): boolean {
  return tools.some((tool) => FILE_CHANGING_TOOLS.includes(tool));
}

export interface SubagentDraft {
  name: string;
  scope: SubagentProfileScope;
  description: string;
  systemPrompt: string;
  tools: string[];
  worktree: boolean;
  /** The model to run on, as "provider/id"; empty for none. */
  model: string;
}

export function newSubagentDraft(): SubagentDraft {
  return { name: "", scope: "user", description: "", systemPrompt: "", tools: [...DEFAULT_NEW_SUBAGENT_TOOLS], worktree: false, model: "" };
}

export function subagentDraftFromProfile(profile: SubagentProfileInfo & { source: SubagentProfileScope }, model: string): SubagentDraft {
  return {
    name: profile.name,
    scope: profile.source,
    description: profile.description,
    systemPrompt: profile.systemPrompt,
    tools: [...profile.tools],
    worktree: profile.worktree,
    model,
  };
}

/** What is sent to save the draft: text trimmed, tools in the order they are offered. */
export function subagentDraftToInput(draft: SubagentDraft, offeredTools: readonly string[]): SaveSubagentProfileInput {
  return {
    name: draft.name.trim(),
    scope: draft.scope,
    description: draft.description.trim(),
    systemPrompt: draft.systemPrompt.trim(),
    tools: offeredTools.filter((tool) => draft.tools.includes(tool)),
    worktree: draft.worktree,
  };
}

/**
 * The rule the runtime enforces for a name, so the form can say so before anything is sent:
 * it becomes a file name and is what the main agent types to dispatch it. The runtime has the
 * last word (tests/subagent-profiles.test.ts keeps the two in step).
 */
export function isValidSubagentName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,47}$/.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(name);
}

export const SUBAGENT_NAME_RULE = "名字只能用小写字母、数字、- 和 _，以字母或数字开头，最长 48 个字符。";

/**
 * The first thing wrong with a draft, in words for the person filling it in, or nothing when it
 * can be sent. Creating never replaces a subagent that exists: the runtime would take the same
 * name in the same place for an edit and rewrite the file.
 */
export function subagentDraftProblem(
  draft: SubagentDraft,
  mode: "create" | "edit",
  offeredTools: readonly string[],
  existingNames: readonly string[],
): string | undefined {
  const name = draft.name.trim();
  if (mode === "create") {
    if (!name) return "请填名字。";
    if (!isValidSubagentName(name)) return SUBAGENT_NAME_RULE;
    if (existingNames.includes(name)) return `已经有叫「${name}」的子 Agent 了，请换一个名字，或者在列表里编辑它。`;
  }
  if (!draft.description.trim()) return "请写一句说明：主 Agent 靠它判断什么时候该派这个子 Agent。";
  if (!draft.systemPrompt.trim()) return "请写提示词：它是这个子 Agent 全部的工作说明。";
  if (!offeredTools.some((tool) => draft.tools.includes(tool))) return "请至少选一个工具。";
  return undefined;
}
