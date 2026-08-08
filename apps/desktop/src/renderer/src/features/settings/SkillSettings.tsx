import { FolderPlus, LoaderCircle, Power, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { SkillConfigurationSnapshot, SkillEntry, SkillSource } from "@suocode/runtime-protocol";
import { toastError, toastSuccess } from "../../ui/toast";

const sourceLabel: Record<SkillSource, string> = {
  user: "用户",
  project: "项目",
  agents: "Agents",
  bundled: "内置",
};

export function SkillSettings({ runtimeId, cwd }: { runtimeId?: string; cwd?: string }): React.JSX.Element {
  const [configuration, setConfiguration] = useState<SkillConfigurationSnapshot>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (surfaceError = false): Promise<void> => {
    setLoading(true);
    try {
      setConfiguration(await window.suocode.request<SkillConfigurationSnapshot>({ type: "get_skill_configuration", cwd }, runtimeId));
    } catch (caught) {
      if (surfaceError) toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [cwd, runtimeId]);

  useEffect(() => {
    void load(true);
  }, [load]);

  const withBusy = async (action: () => Promise<SkillConfigurationSnapshot>, success?: string): Promise<void> => {
    setBusy(true);
    try {
      setConfiguration(await action());
      if (success) toastSuccess(success);
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const toggleSkill = (skill: SkillEntry): void => {
    if (skill.source === "bundled") return;
    void withBusy(
      () => window.suocode.request<SkillConfigurationSnapshot>({
        type: "set_skill_enabled",
        filePath: skill.filePath,
        enabled: !skill.enabled,
        cwd,
      }, runtimeId),
      skill.enabled ? `已停用 ${skill.name}` : `已启用 ${skill.name}`,
    );
  };

  const addPath = async (): Promise<void> => {
    const path = await window.suocode.pickDirectory({ title: "选择技能目录" });
    if (!path) return;
    await withBusy(
      () => window.suocode.request<SkillConfigurationSnapshot>({ type: "add_skill_path", path, cwd }, runtimeId),
      "已添加技能目录",
    );
  };

  const removePath = (path: string): void => {
    void withBusy(
      () => window.suocode.request<SkillConfigurationSnapshot>({ type: "remove_skill_path", path, cwd }, runtimeId),
      "已移除技能目录",
    );
  };

  const enabledCount = configuration?.skills.filter((skill) => skill.enabled).length ?? 0;
  const totalCount = configuration?.skills.length ?? 0;

  return (
    <div className="skills-settings">
      <header className="skills-header">
        <div className="skills-header-copy">
          <div className="skills-header-title">
            <strong>已发现的技能</strong>
            {configuration ? <small>{enabledCount}/{totalCount} 已启用</small> : null}
          </div>
          <p>放到用户 skills、项目 <code>.pi/skills</code> / <code>.agents/skills</code>，或 <code>~/.agents/skills</code>。</p>
        </div>
        <div className="skills-toolbar">
          <button type="button" disabled={busy || loading} onClick={() => void addPath()}>
            <FolderPlus size={13} />添加技能目录
          </button>
          <button type="button" aria-label="刷新 Skills" disabled={loading || busy} onClick={() => void load(true)}>
            {loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
          </button>
        </div>
      </header>

      {configuration?.customSkillPaths.length ? (
        <section className="skills-paths" aria-label="自定义技能目录">
          <header><strong>自定义目录</strong></header>
          <ul>
            {configuration.customSkillPaths.map((path) => (
              <li key={path}>
                <code title={path}>{path}</code>
                <button type="button" aria-label={`移除 ${path}`} disabled={busy} onClick={() => removePath(path)}>
                  <Trash2 size={12} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="skills-list" aria-label="已发现的技能">
        {loading ? (
          <div className="settings-loading"><LoaderCircle className="spin" size={15} />加载 Skills…</div>
        ) : null}
        {!loading && configuration?.skills.map((skill) => (
          <article key={skill.filePath} className={skill.enabled ? "enabled" : "disabled"}>
            <span className="skills-list-icon"><Sparkles size={14} /></span>
            <div>
              <div className="skills-list-title">
                <strong>{skill.name}</strong>
                <span className="skills-source">{sourceLabel[skill.source]}</span>
                {skill.disableModelInvocation ? <span className="skills-source">仅手动</span> : null}
              </div>
              <p>{skill.description}</p>
            </div>
            <button
              type="button"
              className={skill.enabled ? "active" : ""}
              disabled={busy || skill.source === "bundled"}
              aria-label={skill.enabled ? `停用 ${skill.name}` : `启用 ${skill.name}`}
              title={skill.source === "bundled" ? "内置技能始终可用" : undefined}
              onClick={() => toggleSkill(skill)}
            >
              <Power size={13} />
              {skill.source === "bundled" ? "始终可用" : skill.enabled ? "启用" : "停用"}
            </button>
          </article>
        ))}
        {!loading && !configuration?.skills.length ? (
          <p className="skills-empty">尚未发现技能。可将含 SKILL.md 的目录放到约定位置，或点击「添加技能目录」。</p>
        ) : null}
      </section>

      {configuration?.diagnostics.length ? (
        <section className="skills-diagnostics" aria-label="Skills 诊断">
          {configuration.diagnostics.map((item, index) => (
            <p key={`${item.path ?? item.message}-${index}`}>{item.type}: {item.message}</p>
          ))}
        </section>
      ) : null}
    </div>
  );
}
