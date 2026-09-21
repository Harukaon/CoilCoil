import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import type {
  McpConfigurationSnapshot,
  ProjectSelection,
  SkillConfigurationSnapshot,
  SkillEntry,
} from "@coilcoil/runtime-protocol";
import type { PromptEditorHandle } from "./PromptEditor";

export type SlashToken = {
  query: string;
  start: number;
  end: number;
};

export type SlashMenuItem = {
  id: string;
  kind: "skill" | "mcp" | "action" | "command";
  title: string;
  description: string;
  /** Insert into the composer when selected. */
  insert?: string;
  /** Open a settings section instead of inserting. */
  openSettings?: "models" | "mcp" | "skills" | "appearance";
  skill?: SkillEntry;
};

export type SettingsSection = "models" | "mcp" | "skills" | "appearance";

function isSlashChar(value: string): boolean {
  return value === "/" || value === "／";
}

function tokenKey(token: SlashToken | null): string {
  return token ? `${token.start}:${token.end}:${token.query}` : "";
}

/** Token under caret that starts with `/` (whitespace-delimited). */
export function findSlashToken(text: string, caret: number): SlashToken | null {
  const pos = Math.max(0, Math.min(caret, text.length));
  let start = pos;
  while (start > 0 && !/\s/.test(text[start - 1]!)) start -= 1;
  let end = pos;
  while (end < text.length && !/\s/.test(text[end]!)) end += 1;
  const token = text.slice(start, end);
  if (!token || !isSlashChar(token[0]!)) return null;
  return { query: token.slice(1).toLowerCase(), start, end };
}

function matchesQuery(item: SlashMenuItem, needle: string): boolean {
  if (!needle) return true;
  const haystack = `${item.title} ${item.description} ${item.kind}`.toLowerCase();
  return haystack.includes(needle);
}

/** 斜杠菜单里有哪些条目。抽成纯函数是为了能直接测：哪些写进输入框、哪些跳设置。 */
export function buildSlashMenuItems(
  skills: SkillEntry[],
  mcpServers: McpConfigurationSnapshot["servers"],
): SlashMenuItem[] {
  const items: SlashMenuItem[] = [
    {
      id: "action:mcp",
      kind: "action",
      title: "/mcp",
      description: "打开 MCP 设置，连接或管理服务器（下面每一条是直接告诉 Agent 用哪个）",
      openSettings: "mcp",
    },
    {
      id: "action:skills",
      kind: "action",
      title: "/skills",
      description: "打开技能设置，管理技能与目录",
      openSettings: "skills",
    },
    {
      id: "command:goal",
      kind: "command",
      title: "/goal",
      description: "设定必须完成的目标，进入不会自行停止的 Agent 循环",
      insert: "/goal ",
    },
    {
      id: "command:memory",
      kind: "command",
      title: "/memory",
      description: "立即在后台整理当前项目记忆",
      insert: "/memory",
    },
    {
      id: "command:compact",
      kind: "command",
      title: "/compact",
      description: "立即压缩上下文，把较早的对话折叠成摘要；后面可以再补一句对摘要的要求",
      insert: "/compact",
    },
  ];
  /* 选一个 MCP 服务器，是「我想让 Agent 用这个去查」，不是「我想去设置页看看」。
     以前这一排每一条都跳去 MCP 设置，等于把人从正在写的那句话里踢出去，还得自己
     回来把名字打一遍。现在把菜单里那行原样写进输入框，剩下的交给 Agent 自己判断
     ——不做引用、不做连接，给它一个名字就够了。
     已停用的那几条仍然跳设置：写进去也用不了，那才是死路。 */
  for (const server of mcpServers) {
    const scope = server.scope === "project" ? "项目" : "全局";
    items.push({
      id: `mcp:${server.name}`,
      kind: "mcp",
      title: `/mcp ${server.name}`,
      description: server.disabled
        ? `${scope} · 已停用，选中后去设置里启用`
        : `${scope} · ${server.transport === "http" ? server.url : server.command}`,
      ...(server.disabled
        ? { openSettings: "mcp" as const }
        : { insert: `/mcp ${server.name} ` }),
    });
  }
  for (const skill of skills) {
    items.push({
      id: `skill:${skill.filePath}`,
      kind: "skill",
      title: `/skill:${skill.name}`,
      description: skill.description.trim(),
      insert: `/skill:${skill.name} `,
      skill,
    });
  }
  return items;
}

export function useSlashMenu({
  draft,
  inputRef,
  project,
  runtimeId,
  onReplaceTextRange,
  onOpenSettings,
}: {
  draft: string;
  inputRef: RefObject<PromptEditorHandle | null>;
  project: ProjectSelection | null;
  runtimeId?: string;
  onReplaceTextRange: (start: number, end: number, replacement: string) => void;
  onOpenSettings?: (section?: SettingsSection) => void;
}): {
  slashActive: boolean;
  slashMenuOpen: boolean;
  filteredItems: SlashMenuItem[];
  itemIndex: number;
  setItemIndex: (index: number) => void;
  selectItem: (item: SlashMenuItem) => void;
  dismissSlash: () => void;
  handleSlashKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => boolean;
} {
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  const [mcpServers, setMcpServers] = useState<McpConfigurationSnapshot["servers"]>([]);
  const [itemIndex, setItemIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const [slashEpoch, setSlashEpoch] = useState(0);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const tokenRef = useRef<SlashToken | null>(null);
  const pendingCaret = useRef<number | null>(null);
  const composingRef = useRef(false);

  const readToken = useCallback((): SlashToken | null => {
    const caret = pendingCaret.current
      ?? inputRef.current?.getCaretOffset()
      ?? draftRef.current.length;
    return findSlashToken(draftRef.current, caret);
  }, [inputRef]);

  const publishTokenIfChanged = useCallback((): void => {
    if (composingRef.current) return;
    const next = readToken();
    if (tokenKey(next) === tokenKey(tokenRef.current)) return;
    tokenRef.current = next;
    setSlashEpoch((value) => value + 1);
  }, [readToken]);

  useEffect(() => {
    if (pendingCaret.current !== null) {
      tokenRef.current = findSlashToken(draft, pendingCaret.current);
      return;
    }
    publishTokenIfChanged();
  }, [draft, publishTokenIfChanged]);

  useEffect(() => {
    const input = inputRef.current?.element;
    if (!input) return;
    const onCompositionStart = (): void => {
      composingRef.current = true;
    };
    const onCompositionEnd = (): void => {
      composingRef.current = false;
      publishTokenIfChanged();
    };
    const onCaretMove = (): void => {
      if (pendingCaret.current !== null) return;
      if (composingRef.current) return;
      publishTokenIfChanged();
    };
    input.addEventListener("compositionstart", onCompositionStart);
    input.addEventListener("compositionend", onCompositionEnd);
    input.addEventListener("keyup", onCaretMove);
    input.addEventListener("click", onCaretMove);
    input.addEventListener("select", onCaretMove);
    return () => {
      input.removeEventListener("compositionstart", onCompositionStart);
      input.removeEventListener("compositionend", onCompositionEnd);
      input.removeEventListener("keyup", onCaretMove);
      input.removeEventListener("click", onCaretMove);
      input.removeEventListener("select", onCaretMove);
    };
  }, [inputRef, publishTokenIfChanged, draft]);

  const loadCatalog = useCallback(async (): Promise<void> => {
    if (!project) {
      setSkills([]);
      setMcpServers([]);
      return;
    }
    try {
      const [skillSnapshot, mcpSnapshot] = await Promise.all([
        window.coilcoil.request<SkillConfigurationSnapshot>({
          type: "get_skill_configuration",
          cwd: project.path,
        }, runtimeId),
        window.coilcoil.request<McpConfigurationSnapshot>({
          type: "get_mcp_configuration",
          cwd: project.path,
        }, runtimeId).catch(() => ({ servers: [] as McpConfigurationSnapshot["servers"] })),
      ]);
      setSkills(skillSnapshot.skills.filter((skill) => skill.enabled && !skill.disableModelInvocation));
      setMcpServers(mcpSnapshot.servers ?? []);
    } catch (error) {
      console.error("加载斜杠命令失败", error);
      setSkills([]);
      setMcpServers([]);
    }
  }, [project, runtimeId]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const token = useMemo(() => {
    void slashEpoch;
    return tokenRef.current ?? findSlashToken(draft, inputRef.current?.getCaretOffset() ?? draft.length);
  }, [draft, inputRef, slashEpoch]);

  useEffect(() => {
    setSlashDismissed(false);
  }, [token?.start, token?.query]);

  const allItems = useMemo<SlashMenuItem[]>(
    () => buildSlashMenuItems(skills, mcpServers),
    [mcpServers, skills],
  );

  const filteredItems = useMemo(() => {
    if (!token) return [];
    const needle = token.query;
    return allItems.filter((item) => matchesQuery(item, needle)).slice(0, 12);
  }, [allItems, token]);

  useEffect(() => {
    setItemIndex(0);
  }, [filteredItems]);

  const slashActive = Boolean(token) && !slashDismissed;
  const slashMenuOpen = slashActive && filteredItems.length > 0;

  const selectItem = useCallback((item: SlashMenuItem): void => {
    if (item.openSettings) {
      setSlashDismissed(true);
      tokenRef.current = null;
      onOpenSettings?.(item.openSettings);
      // Clear the bare slash token so the menu closes cleanly.
      const current = findSlashToken(draftRef.current, inputRef.current?.getCaretOffset() ?? draftRef.current.length);
      if (current && draftRef.current.slice(current.start, current.end).match(/^[/／]\S*$/)) {
        const caret = current.start;
        pendingCaret.current = caret;
        onReplaceTextRange(current.start, current.end, "");
        requestAnimationFrame(() => {
          const input = inputRef.current;
          if (!input) return;
          input.focus();
          input.setCaretOffset(caret);
          pendingCaret.current = null;
        });
      }
      return;
    }
    if (!item.insert) return;
    const current = findSlashToken(draftRef.current, inputRef.current?.getCaretOffset() ?? draftRef.current.length);
    if (!current) return;
    const nextCaret = current.start + item.insert.length;
    pendingCaret.current = nextCaret;
    tokenRef.current = null;
    setSlashDismissed(true);
    onReplaceTextRange(current.start, current.end, item.insert);
    requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setCaretOffset(nextCaret);
      pendingCaret.current = null;
      publishTokenIfChanged();
    });
  }, [inputRef, onOpenSettings, onReplaceTextRange, publishTokenIfChanged]);

  const dismissSlash = useCallback((): void => {
    setSlashDismissed(true);
  }, []);

  const handleSlashKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>): boolean => {
    if (!slashMenuOpen) return false;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setItemIndex((current) => (current + 1) % filteredItems.length);
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setItemIndex((current) => (current - 1 + filteredItems.length) % filteredItems.length);
      return true;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const item = filteredItems[itemIndex];
      if (item) selectItem(item);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setSlashDismissed(true);
      return true;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const item = filteredItems[itemIndex];
      if (item) selectItem(item);
      return true;
    }
    return false;
  }, [filteredItems, itemIndex, selectItem, slashMenuOpen]);

  return {
    slashActive,
    slashMenuOpen,
    filteredItems,
    itemIndex,
    setItemIndex,
    selectItem,
    dismissSlash,
    handleSlashKeyDown,
  };
}

/** @deprecated Use useSlashMenu */
export const useSlashSkills = useSlashMenu;
