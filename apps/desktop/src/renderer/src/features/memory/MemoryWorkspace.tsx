import { ArrowLeft, BookOpen, CheckCircle2, ChevronDown, ChevronRight, Globe2, LoaderCircle, PanelLeft, RefreshCw, Save, Sparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  MemoryConfigurationSnapshot,
  MemorySettings,
  RuntimeInspectionSnapshot,
} from "@suocode/runtime-protocol";
import { toastError, toastSuccess } from "../../ui/toast";
import {
  DEFAULT_MEMORY_SCOPE,
  memoryEditorExpanded,
  memoryMaxChars,
  type MemoryScope,
} from "./memoryState";
import "./memory.css";

function charCount(value: string): number {
  return Array.from(value).length;
}

/** One editable draft per project memory the store holds, keyed by its file. */
function draftsFor(configuration: MemoryConfigurationSnapshot): Record<string, string> {
  return Object.fromEntries(configuration.projects.map((document) => [document.filePath, document.content]));
}

function statusLabel(inspection?: RuntimeInspectionSnapshot): string {
  const state = inspection?.memory?.state;
  if (state === "running") return "整理中";
  if (state === "busy") return "排队中";
  if (state === "succeeded") return "已完成";
  if (state === "failed") return "失败";
  if (state === "disabled") return "已停用";
  return "就绪";
}

export function MemoryWorkspace({
  runtimeId,
  cwd,
  leftOpen,
  onOpenLeft,
  onClose,
}: {
  runtimeId?: string;
  cwd?: string;
  leftOpen: boolean;
  onOpenLeft: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const [configuration, setConfiguration] = useState<MemoryConfigurationSnapshot>();
  const [inspection, setInspection] = useState<RuntimeInspectionSnapshot>();
  const [scope, setScope] = useState<MemoryScope>(DEFAULT_MEMORY_SCOPE);
  const [expandedProjectEditors, setExpandedProjectEditors] = useState<Set<string>>(new Set());
  const [globalContent, setGlobalContent] = useState("");
  const [projectDrafts, setProjectDrafts] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<MemorySettings>();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);

  const load = useCallback(async (surfaceError = false): Promise<void> => {
    setLoading(true);
    try {
      const [next, nextInspection] = await Promise.all([
        window.suocode.request<MemoryConfigurationSnapshot>({ type: "get_memory_configuration", cwd }, runtimeId),
        runtimeId
          ? window.suocode.request<RuntimeInspectionSnapshot>({ type: "get_runtime_inspection" }, runtimeId)
          : Promise.resolve(undefined),
      ]);
      setConfiguration(next);
      setSettings(next.settings);
      setGlobalContent(next.global.content);
      setProjectDrafts(draftsFor(next));
      setInspection(nextInspection);
      if (!next.projects.length) setScope("global");
    } catch (caught) {
      if (surfaceError) toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [cwd, runtimeId]);

  useEffect(() => { void load(true); }, [load]);

  useEffect(() => {
    if (!runtimeId) return undefined;
    return window.suocode.onRuntimeEvent((event, eventRuntimeId) => {
      if (eventRuntimeId !== runtimeId || event.type !== "runtime_inspection_updated") return;
      setInspection(event.inspection);
    });
  }, [runtimeId]);

  const globalDocument = configuration?.global;
  const globalCount = charCount(globalContent);
  const globalMaxChars = memoryMaxChars("global", settings, globalDocument);
  const projectDocuments = configuration?.projects ?? [];
  const projectMaxChars = memoryMaxChars("project", settings, configuration?.project);
  const settingsReady = settings !== undefined;
  const editedProjects = useMemo(
    () => projectDocuments.filter((document) => (projectDrafts[document.filePath] ?? "") !== document.content),
    [projectDocuments, projectDrafts],
  );
  const dirty = useMemo(() => {
    if (!configuration || !settings) return false;
    return globalContent !== configuration.global.content
      || editedProjects.length > 0
      || JSON.stringify(settings) !== JSON.stringify(configuration.settings);
  }, [configuration, editedProjects, globalContent, settings]);

  const updateSettings = <K extends keyof MemorySettings>(key: K, value: MemorySettings[K]): void => {
    setSettings((current) => current ? { ...current, [key]: value } : current);
  };

  const toggleProjectEditor = (filePath: string): void => {
    setExpandedProjectEditors((current) => {
      const next = new Set(current);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  const save = async (): Promise<void> => {
    if (!settings) return;
    setSaving(true);
    try {
      const next = await window.suocode.request<MemoryConfigurationSnapshot>({
        type: "save_memory_configuration",
        cwd,
        input: {
          settings,
          globalContent,
          projectContents: editedProjects.map((document) => ({
            filePath: document.filePath,
            content: projectDrafts[document.filePath] ?? "",
          })),
        },
      }, runtimeId);
      setConfiguration(next);
      setSettings(next.settings);
      setGlobalContent(next.global.content);
      setProjectDrafts(draftsFor(next));
      toastSuccess("记忆设置已保存，后续会话将使用新规则。");
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  const runMemory = async (): Promise<void> => {
    setRunning(true);
    try {
      await window.suocode.request({ type: "run_memory_now" }, runtimeId);
      toastSuccess("项目记忆整理已在后台启动。");
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="memory-workspace" aria-labelledby="memory-workspace-title">
      <header className="memory-workspace-header window-drag">
        <div>
          {!leftOpen ? <button className="icon-button no-drag" type="button" aria-label="展开侧栏" onClick={onOpenLeft}><PanelLeft size={17} /></button> : null}
          <span className="settings-icon"><BookOpen size={17} /></span>
          <div>
            <h1 id="memory-workspace-title">记忆</h1>
            <p>管理全局与项目级记忆、生成规则和注入字数限制。</p>
          </div>
        </div>
        <div className="memory-header-actions no-drag">
          <button className="settings-header-action" type="button" disabled={loading || saving} onClick={() => void load(true)}><RefreshCw className={loading ? "spin" : ""} size={13} />刷新</button>
          <button className="settings-header-action primary" type="button" disabled={!settingsReady || !dirty || saving} onClick={() => void save()}><Save size={13} />保存</button>
          <button className="settings-header-action" type="button" onClick={onClose}><ArrowLeft size={14} />返回对话</button>
        </div>
      </header>

      <div className="memory-workspace-content">
        {loading ? <div className="memory-loading"><LoaderCircle className="spin" size={15} />加载记忆配置…</div> : null}
        {!loading && configuration && settings ? (
          <div className="memory-settings">
            <section className="memory-overview-card">
              <div><strong>{configuration.project?.projectName ?? "当前工作区"}</strong><p>后台记忆模块会把项目记忆保存到独立目录，不修改项目源码。</p></div>
              <span className={`memory-status ${inspection?.memory?.state ?? "idle"}`}><Sparkles size={12} />{statusLabel(inspection)}</span>
              <dl>
                <div><dt>全局路径</dt><dd title={configuration.global.filePath}>{configuration.global.filePath}</dd></div>
                {configuration.project ? <div><dt>项目路径</dt><dd title={configuration.project.filePath}>{configuration.project.filePath}</dd></div> : null}
                <div><dt>存储目录</dt><dd title={configuration.storageRoot}>{configuration.storageRoot}</dd></div>
              </dl>
            </section>

            <section className="memory-editor-card">
              <div className="memory-section-heading"><div><strong>记忆内容</strong><p>全局记忆注入所有工作区；项目记忆逐项目保存，只有当前工作区的那份会被注入。</p></div><div className="memory-scope-tabs">
                <button type="button" className={scope === "global" ? "active" : ""} onClick={() => setScope("global")}><Globe2 size={12} />全局</button>
                <button type="button" className={scope === "project" ? "active" : ""} disabled={!projectDocuments.length} onClick={() => setScope("project")}><BookOpen size={12} />项目（{projectDocuments.length}）</button>
              </div></div>
              {scope === "global" && globalDocument ? <>
                <div className="memory-editor-meta"><span>{globalDocument.label}</span><code>{globalDocument.filePath}</code><small className={globalCount > globalMaxChars ? "over" : ""}>{globalCount.toLocaleString()} / {globalMaxChars.toLocaleString()} 字</small></div>
                <textarea className="memory-content-editor" value={globalContent} onChange={(event) => setGlobalContent(event.target.value)} spellCheck={false} placeholder="记录跨项目长期偏好、稳定工具约定…" />
                <p className="memory-editor-hint">超过限制不会截断原文，但注入模型时只会取前 {globalMaxChars.toLocaleString()} 个 Unicode 字符。</p>
              </> : null}
              {scope === "project" ? (
                projectDocuments.length ? projectDocuments.map((document) => {
                  const draft = projectDrafts[document.filePath] ?? "";
                  const count = charCount(draft);
                  const expanded = memoryEditorExpanded("project", document.filePath, expandedProjectEditors);
                  const current = document.filePath === configuration.project?.filePath;
                  return (
                    <div className="memory-project-entry" key={document.filePath}>
                      <button className="memory-editor-meta project-toggle" type="button" aria-expanded={expanded} onClick={() => toggleProjectEditor(document.filePath)}>
                        {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        <span>{document.label}</span>
                        {current ? <em className="memory-project-current">当前</em> : null}
                        {!document.exists ? <em className="memory-project-empty">未创建</em> : null}
                        <code title={document.filePath}>{document.filePath}</code>
                        <small className={count > projectMaxChars ? "over" : ""}>{count.toLocaleString()} / {projectMaxChars.toLocaleString()} 字</small>
                      </button>
                      {expanded ? <>
                        <textarea
                          className="memory-content-editor"
                          value={draft}
                          onChange={(event) => setProjectDrafts((drafts) => ({ ...drafts, [document.filePath]: event.target.value }))}
                          spellCheck={false}
                          placeholder="记录该项目的稳定事实、约定和关键决策…"
                        />
                        <p className="memory-editor-hint">超过限制不会截断原文，但注入模型时只会取前 {projectMaxChars.toLocaleString()} 个 Unicode 字符。</p>
                      </> : null}
                    </div>
                  );
                }) : <p className="memory-empty">记忆目录里还没有任何项目记忆。</p>
              ) : null}
              {scope === "project" && projectDocuments.length ? <p className="memory-editor-hint collapsed">点击项目行展开对应的文本编辑框。</p> : null}
            </section>

            <section className="memory-settings-card">
              <div className="memory-section-heading"><div><strong>生成与注入规则</strong><p>控制后台整理频率、两类记忆是否注入，以及各自的字数预算。</p></div></div>
              <div className="memory-toggle-grid">
                <label><input type="checkbox" checked={settings.globalEnabled} onChange={(event) => updateSettings("globalEnabled", event.target.checked)} /><span><strong>注入全局记忆</strong><small>对所有工作区生效</small></span></label>
                <label><input type="checkbox" checked={settings.projectEnabled} onChange={(event) => updateSettings("projectEnabled", event.target.checked)} /><span><strong>注入项目记忆</strong><small>仅对当前工作区生效</small></span></label>
                <label><input type="checkbox" checked={settings.autoSummarize} onChange={(event) => updateSettings("autoSummarize", event.target.checked)} /><span><strong>回复后自动整理</strong><small>后台记忆任务会在会话结束后运行</small></span></label>
              </div>
              <div className="memory-limit-grid">
                <label><span>全局记忆上限（字）</span><input type="number" min={100} max={1000000} step={100} value={settings.globalMaxChars} onChange={(event) => updateSettings("globalMaxChars", Math.max(100, Number(event.target.value) || 100))} /></label>
                <label><span>项目记忆上限（字）</span><input type="number" min={100} max={1000000} step={100} value={settings.projectMaxChars} onChange={(event) => updateSettings("projectMaxChars", Math.max(100, Number(event.target.value) || 100))} /></label>
              </div>
              <label className="memory-rules-field"><span>记忆生成规则</span><textarea value={settings.generationRules} onChange={(event) => updateSettings("generationRules", event.target.value)} spellCheck={false} /></label>
            </section>

            <section className="memory-actions-card">
              <div><strong>立即整理当前项目</strong><p>{inspection?.memory?.message ?? "使用当前模型在后台分析最近会话，更新项目记忆。"}</p></div>
              <button className="memory-run-button" type="button" disabled={!runtimeId || running || inspection?.memory?.state === "running"} onClick={() => void runMemory()}>{running || inspection?.memory?.state === "running" ? <LoaderCircle className="spin" size={13} /> : <CheckCircle2 size={13} />}立即整理</button>
            </section>
          </div>
        ) : null}
      </div>
    </section>
  );
}
