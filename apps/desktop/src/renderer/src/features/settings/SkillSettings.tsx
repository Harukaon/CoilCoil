import { FolderPlus, LoaderCircle, Power, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { SkillConfigurationSnapshot, SkillEntry, SkillSource } from "@suocode/runtime-protocol";
import { toastError, toastSuccess } from "../../ui/toast";
import { canDeleteSkill, managedSkills, skillCountLabel, skillToggleActionLabel, skillToggleLabel, skillToggleTarget } from "./skillPolicy";

const sourceLabel: Record<SkillSource, string> = {
  user: "用户",
  project: "项目",
  agents: "Agents",
  bundled: "内置",
};

function diagnosticDisplayPath(path: string | undefined, userSkillsDir: string | undefined): string | undefined {
  if (!path) return undefined;
  const normalizedPath = path.replaceAll("\\", "/");
  const normalizedRoot = userSkillsDir?.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalizedRoot && normalizedPath.startsWith(`${normalizedRoot}/`)
    ? normalizedPath.slice(normalizedRoot.length + 1)
    : path;
}

function canDeleteDiagnostic(
  configuration: SkillConfigurationSnapshot,
  path: string | undefined,
): path is string {
  if (!path || configuration.skills.some((skill) => skill.filePath === path)) return false;
  const normalizedPath = path.replaceAll("\\", "/");
  const normalizedRoot = configuration.userSkillsDir.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalizedPath.startsWith(`${normalizedRoot}/`);
}

export function SkillSettings({ runtimeId, cwd }: { runtimeId?: string; cwd?: string }): React.JSX.Element {
  const [configuration, setConfiguration] = useState<SkillConfigurationSnapshot>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [deleteArmed, setDeleteArmed] = useState<string>();

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
        enabled: skillToggleTarget(skill),
        cwd,
      }, runtimeId),
      skill.enabled ? `已停用 ${skill.name}` : `已启用 ${skill.name}`,
    );
  };

  const addPath = async (): Promise<void> => {
    const path = await window.suocode.pickDirectory({ title: "选择要导入的技能目录" });
    if (!path) return;
    await withBusy(
      () => window.suocode.request<SkillConfigurationSnapshot>({ type: "add_skill_path", path, cwd }, runtimeId),
      "已导入技能目录",
    );
  };

  const removePath = (path: string): void => {
    void withBusy(
      () => window.suocode.request<SkillConfigurationSnapshot>({ type: "remove_skill_path", path, cwd }, runtimeId),
      "已移除技能目录",
    );
  };

  const deleteSkill = (skill: SkillEntry): void => {
    if (!canDeleteSkill(skill, configuration?.userSkillsDir)) return;
    if (deleteArmed !== skill.filePath) {
      setDeleteArmed(skill.filePath);
      return;
    }
    setDeleteArmed(undefined);
    void withBusy(
      () => window.suocode.request<SkillConfigurationSnapshot>({ type: "delete_skill", filePath: skill.filePath, cwd }, runtimeId),
      `已删除 ${skill.name}`,
    );
  };

  const deleteInvalidSkill = (filePath: string): void => {
    void withBusy(
      () => window.suocode.request<SkillConfigurationSnapshot>({ type: "delete_skill", filePath, cwd }, runtimeId),
      "已删除无效 Skill",
    );
  };

  const skills = managedSkills(configuration?.skills);

  return (
    <div className="skills-settings">
      <header className="skills-header">
        <div className="skills-header-copy">
          <div className="skills-header-title">
            <strong>已发现的技能</strong>
            {configuration ? <small>{skillCountLabel(configuration.skills)}</small> : null}
          </div>
          <p>技能会从约定目录自动发现；从其他位置导入后，会复制到 SuoCode 自维护目录，不依赖原目录。</p>
        </div>
        <div className="skills-toolbar">
          <button type="button" disabled={busy || loading} onClick={() => void addPath()}>
            <FolderPlus size={13} />导入技能目录
          </button>
          <button type="button" aria-label="刷新技能" disabled={loading || busy} onClick={() => void load(true)}>
            {loading ? <LoaderCircle className="spin" size={13} /> : <RefreshCw size={13} />}
          </button>
        </div>
      </header>

      {configuration?.customSkillPaths.length ? (
        <section className="skills-paths" aria-label="旧外部技能目录">
          <header><strong>旧外部目录</strong><small>这些目录仍由设置直接引用；新导入的技能会复制到自维护目录。</small></header>
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
          <div className="settings-loading"><LoaderCircle className="spin" size={15} />加载技能…</div>
        ) : null}
        {!loading && skills.map((skill) => (
          <article key={skill.filePath} className={skill.enabled ? "enabled" : "disabled"}>
            <span className="skills-list-icon"><Sparkles size={14} /></span>
            <div className="skills-list-copy">
              <div className="skills-list-title">
                <strong>{skill.name}</strong>
                <span className="skills-source">{sourceLabel[skill.source]}</span>
                {skill.disableModelInvocation ? <span className="skills-source">仅手动</span> : null}
              </div>
              <p>{skill.description}</p>
            </div>
            <div className="skills-list-actions">
              <button
                type="button"
                className={skill.enabled ? "active" : ""}
                disabled={busy}
                aria-pressed={skill.enabled}
                aria-label={skillToggleActionLabel(skill)}
                onClick={() => toggleSkill(skill)}
              >
                <Power size={13} />
                {skillToggleLabel(skill)}
              </button>
              {canDeleteSkill(skill, configuration?.userSkillsDir) ? (
                <button
                  type="button"
                  className={`skill-delete${deleteArmed === skill.filePath ? " armed" : ""}`}
                  disabled={busy}
                  aria-label={deleteArmed === skill.filePath ? `再次确认删除 ${skill.name}` : `删除 ${skill.name}`}
                  title={deleteArmed === skill.filePath ? "再次点击确认删除" : "删除技能"}
                  onClick={() => deleteSkill(skill)}
                >
                  <Trash2 size={13} />
                  {deleteArmed === skill.filePath ? "再次确认" : "删除"}
                </button>
              ) : null}
            </div>
          </article>
        ))}
        {!loading && !skills.length ? (
          <p className="skills-empty">尚未发现技能。可将含 SKILL.md 的目录放到约定位置，或点击「导入技能目录」将其复制保存到 SuoCode 自维护目录。</p>
        ) : null}
      </section>

      {configuration?.diagnostics.length ? (
        <section className="skills-diagnostics" aria-label="Skills 诊断">
          <header><strong>未能导入的 Skill</strong><small>修正源文件后重新导入，或删除已经遗留的无效副本。</small></header>
          {configuration.diagnostics.map((item, index) => {
            const diagnosticPath = item.path;
            const displayPath = diagnosticDisplayPath(diagnosticPath, configuration.userSkillsDir);
            const deletable = canDeleteDiagnostic(configuration, diagnosticPath);
            return (
              <article key={`${item.path ?? item.message}-${index}`}>
                <div>
                  {displayPath ? <code title={item.path}>{displayPath}</code> : null}
                  <p>{item.message}</p>
                </div>
                {deletable ? (
                  <button type="button" disabled={busy} onClick={() => deleteInvalidSkill(diagnosticPath)}>
                    <Trash2 size={12} />删除无效副本
                  </button>
                ) : null}
              </article>
            );
          })}
        </section>
      ) : null}
    </div>
  );
}
