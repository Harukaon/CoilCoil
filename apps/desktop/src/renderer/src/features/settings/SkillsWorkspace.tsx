import { ArrowLeft, Sparkles } from "lucide-react";
import { WindowDragBar } from "../../ui/WindowDragBar";
import { SkillSettings } from "./SkillSettings";

export function SkillsWorkspace({
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
  return (
    <section className="shell-surface skills-workspace" style={{ visibility: layoutPending ? "hidden" : undefined }} aria-labelledby="skills-workspace-title">
      <header className="skills-workspace-header window-drag-bar">
        <WindowDragBar />
        <div>
          <span className="settings-icon"><Sparkles size={17} /></span>
          <div>
            <h1 id="skills-workspace-title">技能</h1>
            <p>管理 CoilCoil 在当前工作区中发现和使用的技能。</p>
          </div>
        </div>
        <button className="settings-header-action no-drag" type="button" onClick={onClose}>
          <ArrowLeft size={14} />返回对话
        </button>
      </header>
      <div className="skills-workspace-content">
        <SkillSettings runtimeId={runtimeId} cwd={cwd} />
      </div>
    </section>
  );
}
