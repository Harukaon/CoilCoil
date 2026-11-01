import { ArrowLeft, BookOpen, CheckCircle2, ChevronDown, ChevronRight, LoaderCircle, RefreshCw, Save, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  MemoryConfigurationSnapshot,
  MemoryDocumentSnapshot,
  MemorySettings,
  RuntimeInspectionSnapshot,
  RuntimeConfiguration,
} from "@coilcoil/runtime-protocol";
import { toastError, toastSuccess } from "../../ui/toast";
import { WindowDragBar } from "../../ui/WindowDragBar";
import { MemoryNebula } from "./MemoryNebula";
import type { NebulaNode } from "./nebulaLayout";
import { memoryMaxChars } from "./memoryState";
import { MemoryWorkerSettings } from "./MemoryWorkerSettings";
import "./memory.css";
import { Checkbox, TextArea, TextField } from "../../ui/form";

function charCount(value: string): number {
  return Array.from(value).length;
}

/**
 * A path short enough for the panel, keeping the end that identifies the file.
 *
 * CSS ellipsis cuts the tail, which on these paths is the only part worth
 * reading — every memory file lives under the same long Application Support
 * prefix. Reversing the text direction to cut the head instead is worse: it
 * moves the trailing slash to the front and reads as gibberish.
 */
function shortPath(path: string, segments = 3): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length <= segments ? path : `…/${parts.slice(-segments).join("/")}`;
}

/**
 * One editable draft per file the store holds, global included.
 *
 * Keying everything by path lets the map hand back a node and the editor open it
 * without caring which of the two kinds of memory it was — the distinction that
 * used to be a pair of tabs is now just where the node sits on the map.
 */
function draftsFor(configuration: MemoryConfigurationSnapshot): Record<string, string> {
  return Object.fromEntries([
    [configuration.global.filePath, configuration.global.content],
    ...configuration.projects.map((document) => [document.filePath, document.content] as const),
    ...(configuration.jottings ?? []).map((document) => [document.filePath, document.content] as const),
  ]);
}

function statusLabel(inspection?: RuntimeInspectionSnapshot): string {
  const state = inspection?.memory?.state;
  if (state === "running") return "整理中";
  if (state === "busy") return "工作区正忙";
  if (state === "succeeded") return "已完成";
  if (state === "failed") return "失败";
  if (state === "disabled") return "已停用";
  return "就绪";
}

/**
 * The memory workspace: every memory this machine holds, drawn as one map.
 *
 * It is deliberately not scoped to the open conversation. Memory outlives the
 * workspace you happen to be standing in, and a panel that only ever showed the
 * current one made the rest of the store invisible — including projects whose
 * folder is long gone but whose memory is still being kept.
 */
export function MemoryWorkspace({
  runtimeId,
  cwd,
  layoutPending,
  onClose,
}: {
  runtimeId?: string;
  cwd?: string;
  layoutPending: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const [configuration, setConfiguration] = useState<MemoryConfigurationSnapshot>();
  const [inspection, setInspection] = useState<RuntimeInspectionSnapshot>();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<MemorySettings>();
  const [models, setModels] = useState<RuntimeConfiguration["models"]>([]);
  const [view, setView] = useState<"curated" | "jottings">("curated");
  const [selectedPath, setSelectedPath] = useState<string>();
  const [rulesOpen, setRulesOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  const load = useCallback(async (surfaceError = false): Promise<void> => {
    setLoading(true);
    try {
      const [next, nextInspection, nextModels] = await Promise.all([
        window.coilcoil.request<MemoryConfigurationSnapshot>({ type: "get_memory_configuration", cwd }, runtimeId),
        runtimeId
          ? window.coilcoil.request<RuntimeInspectionSnapshot>({ type: "get_runtime_inspection" }, runtimeId)
          : Promise.resolve(undefined),
        window.coilcoil.request<RuntimeConfiguration>({ type: "get_configuration" }, runtimeId),
      ]);
      setConfiguration(next);
      setSettings(next.settings);
      setDrafts(draftsFor(next));
      setInspection(nextInspection);
      setModels(nextModels.models);
      setSelectedPath((current) => current ?? next.global.filePath);
    } catch (caught) {
      if (surfaceError) toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [cwd, runtimeId]);

  useEffect(() => { void load(true); }, [load]);

  useEffect(() => {
    if (!runtimeId) return undefined;
    return window.coilcoil.onRuntimeEvent((event, eventRuntimeId) => {
      if (eventRuntimeId !== runtimeId || event.type !== "runtime_inspection_updated") return;
      setInspection(event.inspection);
    });
  }, [runtimeId]);

  const documents = useMemo((): MemoryDocumentSnapshot[] => (
    configuration ? [configuration.global, ...configuration.projects, ...(configuration.jottings ?? [])] : []
  ), [configuration]);
  const selected = documents.find((document) => document.filePath === selectedPath);
  const selectedDraft = selectedPath ? drafts[selectedPath] ?? "" : "";
  const selectedLimit = selected
    ? selected.kind === "entry" || selected.kind === "jotting" ? 0 : memoryMaxChars(selected.scope, settings, selected)
    : 0;
  const selectedCount = charCount(selectedDraft);

  const editedDocuments = useMemo(
    () => documents.filter((document) => (drafts[document.filePath] ?? "") !== document.content),
    [documents, drafts],
  );
  const dirty = useMemo(() => {
    if (!configuration || !settings) return false;
    return editedDocuments.length > 0 || JSON.stringify(settings) !== JSON.stringify(configuration.settings);
  }, [configuration, editedDocuments, settings]);

  const updateSettings = <K extends keyof MemorySettings>(key: K, value: MemorySettings[K]): void => {
    setSettings((current) => current ? { ...current, [key]: value } : current);
  };

  const save = async (): Promise<void> => {
    if (!settings || !configuration) return;
    setSaving(true);
    try {
      const globalPath = configuration.global.filePath;
      const next = await window.coilcoil.request<MemoryConfigurationSnapshot>({
        type: "save_memory_configuration",
        cwd,
        input: {
          settings,
          globalContent: drafts[globalPath] ?? configuration.global.content,
          projectContents: editedDocuments
            .filter((document) => document.filePath !== globalPath)
            .map((document) => ({ filePath: document.filePath, content: drafts[document.filePath] ?? "" })),
        },
      }, runtimeId);
      setConfiguration(next);
      setSettings(next.settings);
      setDrafts(draftsFor(next));
      toastSuccess("已保存。随手记由后台筛选，长期记忆更新将在新对话生效。");
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const runMemory = async (): Promise<void> => {
    setRunning(true);
    try {
      await window.coilcoil.request({ type: "run_memory_now" }, runtimeId);
      toastSuccess("做梦 Agent 已在后台启动，筛选随手记和对话中的长期信息。");
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunning(false);
    }
  };

  const selectNode = (node: NebulaNode): void => {
    // A project whose MEMORY.md was never written has no file to open; its card
    // is still worth clicking, so fall back to leaving the current editor alone.
    if (node.filePath) setSelectedPath(node.filePath);
  };

  return (
    <section className="shell-surface memory-workspace" style={{ visibility: layoutPending ? "hidden" : undefined }} aria-labelledby="memory-workspace-title">
      <div className="memory-workspace-content">
        {loading && !configuration ? <div className="memory-loading"><LoaderCircle className="spin" size={15} />加载记忆…</div> : null}
        {configuration && settings ? <>
          {/* 固定选项放在最上面：它们管的是整个记忆模块，不属于底下任何一个节点。 */}
          <div className="memory-controls">
            <div className="memory-control-group">
              <label><Checkbox look="plain" className="memory-control-checkbox" checked={settings.globalEnabled} onChange={(event) => updateSettings("globalEnabled", event.target.checked)} /><span>注入全局记忆</span></label>
              <label><Checkbox look="plain" className="memory-control-checkbox" checked={settings.projectEnabled} onChange={(event) => updateSettings("projectEnabled", event.target.checked)} /><span>注入项目记忆</span></label>
              <label><Checkbox look="plain" className="memory-control-checkbox" checked={settings.autoSummarize} onChange={(event) => updateSettings("autoSummarize", event.target.checked)} /><span>启用后台做梦整理</span></label>
            </div>
            <div className="memory-control-group">
              <label><span>全局上限</span><TextField look="plain" className="memory-control-number" type="number" min={100} max={1000000} step={100} value={settings.globalMaxChars} onChange={(event) => updateSettings("globalMaxChars", Math.max(100, Number(event.target.value) || 100))} /></label>
              <label><span>索引上限</span><TextField look="plain" className="memory-control-number" type="number" min={100} max={1000000} step={100} value={settings.projectMaxChars} onChange={(event) => updateSettings("projectMaxChars", Math.max(100, Number(event.target.value) || 100))} /></label>
              <label><span>整理间隔</span><TextField look="plain" className="memory-control-number" type="number" min={1} max={1000} step={1} value={settings.summarizeEveryTurns} onChange={(event) => updateSettings("summarizeEveryTurns", Math.min(1000, Math.max(1, Math.round(Number(event.target.value) || 1))))} /><small>轮（已 {configuration.turnsSinceSummary.toLocaleString()}）</small></label>
            </div>
            <div className="memory-control-group end">
              <button className="memory-rules-toggle" type="button" aria-expanded={rulesOpen} onClick={() => setRulesOpen((open) => !open)}>
                {rulesOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}长期记忆筛选规则
              </button>
              <button className="memory-run-button" type="button" title={dirty ? "请先保存配置和编辑内容" : undefined} disabled={dirty || !runtimeId || running || inspection?.memory?.state === "running"} onClick={() => void runMemory()}>
                {running || inspection?.memory?.state === "running" ? <LoaderCircle className="spin" size={13} /> : <CheckCircle2 size={13} />}立即整理
              </button>
            </div>
          </div>
          <MemoryWorkerSettings settings={settings} models={models}
            onChange={(change) => setSettings((current) => current ? { ...current, ...change } : current)} />
          {configuration.migrationNotice ? <div className="memory-migration-notice" role="status">
            <p>{configuration.migrationNotice}</p>
            {configuration.legacyMemoryDir ? <code>{configuration.legacyMemoryDir}</code> : null}
          </div> : null}
          {rulesOpen ? <div className="memory-rules-strip">
            <TextArea look="plain" className="memory-rules-input" value={settings.generationRules} onChange={(event) => updateSettings("generationRules", event.target.value)} spellCheck={false} aria-label="记忆生成规则" />
            <p>做梦 Agent 按这些规则筛选长期信息、去重并维护索引；随手记不会直接进入长期记忆。</p>
          </div> : null}

          <div className="memory-view-tabs">
            <button type="button" aria-pressed={view === "curated"} onClick={() => { setView("curated"); setSelectedPath(configuration.project?.filePath ?? configuration.global.filePath); }}>长期记忆</button>
            <button type="button" aria-pressed={view === "jottings"} onClick={() => { setView("jottings"); setSelectedPath(configuration.jottings?.[0]?.filePath); }}>当前 Workspace 随手记（{configuration.jottings?.length ?? 0}）</button>
            <span>随手记先保存候选内容，后台筛选后才写入长期索引和文档。</span>
          </div>

          <div className="memory-stage">
            {view === "curated" ? <MemoryNebula
              global={configuration.global}
              documents={configuration.projects}
              selectedPath={selectedPath}
              onSelect={selectNode}
            /> : <div className="memory-jottings-list">
              {(configuration.jottings ?? []).map((document) => <button type="button" key={document.filePath}
                aria-pressed={document.filePath === selectedPath} onClick={() => setSelectedPath(document.filePath)}>
                <strong>{document.label}</strong><small>{document.contentChars.toLocaleString()} 字</small>
              </button>)}
              {!configuration.jottings?.length ? <p>当前 Workspace 还没有随手记。Agent 会先在这里记录候选信息，后台再决定哪些值得长期保留。</p> : null}
            </div>}
            <aside className="memory-inspector">
              {selected ? <>
                <header>
                  <strong>{selected.kind === "jotting" ? `随手记 · ${selected.label}` : selected.kind === "entry" ? selected.label : `${selected.projectName ?? "全局"} 的索引`}</strong>
                  <small className={selectedLimit > 0 && selectedCount > selectedLimit ? "over" : ""}>
                    {selectedLimit > 0
                      ? `${selectedCount.toLocaleString()} / ${selectedLimit.toLocaleString()} 字`
                      : `${selectedCount.toLocaleString()} 字`}
                  </small>
                </header>
                {/* 路径从右往左省略：尾巴上的文件名比开头那一长串目录有用得多。 */}
                <code title={selected.filePath}>{shortPath(selected.filePath)}</code>
                <TextArea look="plain"
                  className="memory-content-editor"
                  value={selectedDraft}
                  onChange={(event) => setDrafts((current) => ({ ...current, [selected.filePath]: event.target.value }))}
                  spellCheck={false}
                  placeholder={selected.kind === "jotting" ? "候选观察、来源和证据…" : selected.kind === "entry" ? "这条记忆的正文，写细一点…" : "索引和重要事实…"}
                />
                <p>{selected.kind === "jotting" ? "随手记是待筛选的材料，不会常驻模型上下文。整理过的原始记录保留以便追溯。" : selected.kind === "entry"
                  ? "正文不常驻上下文，也不限字数——模型按索引里的一句话说明决定要不要读它。"
                  : "长期索引在新会话开始时注入；已开始的会话沿用原有快照。"}</p>
              </> : <p className="memory-empty">在左边的星云里点一个节点，<br />就能在这里读它、改它。</p>}
            </aside>
          </div>
        </> : null}
      </div>
      {/* 页头排在内容后面，屏幕上的位置由 grid-row 摆回顶上：内容里的按钮矩形哪怕滚到或被拖到
          页头底下，页头排在后面也盖得住。约定见 ui/WindowDragBar.tsx。 */}
      <header className="memory-workspace-header window-drag-bar">
        <WindowDragBar />
        <div>
          <span className="settings-icon"><BookOpen size={17} /></span>
          <div>
            <h1 id="memory-workspace-title">记忆星云</h1>
            <p>Agent 先写随手记，每个 Workspace 的做梦 Agent 再筛选出长期记忆。</p>
          </div>
        </div>
        <div className="memory-header-actions">
          <span className={`memory-status ${inspection?.memory?.state ?? "idle"}`}><Sparkles size={12} />{statusLabel(inspection)}</span>
          <button className="settings-header-action" type="button" disabled={loading || saving} onClick={() => void load(true)}><RefreshCw className={loading ? "spin" : ""} size={13} />刷新</button>
          <button className="settings-header-action primary" type="button" disabled={!settings || !dirty || saving} onClick={() => void save()}><Save size={13} />保存</button>
          <button className="settings-header-action" type="button" onClick={onClose}><ArrowLeft size={14} />返回对话</button>
        </div>
      </header>
    </section>
  );
}
