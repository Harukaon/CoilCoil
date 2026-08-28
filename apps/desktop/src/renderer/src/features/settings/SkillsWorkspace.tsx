import { ArrowLeft, PanelLeft, Sparkles } from "lucide-react";
import { WindowDragBar } from "../../ui/WindowDragBar";
import { SkillSettings } from "./SkillSettings";

export function SkillsWorkspace({
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
  return (
    <section className="skills-workspace" aria-labelledby="skills-workspace-title">
      <header className="skills-workspace-header">
        <WindowDragBar />
        <div>
          {!leftOpen ? (
            <button className="icon-button no-drag" type="button" aria-label="展开侧栏" onClick={onOpenLeft}>
              <PanelLeft size={17} />
            </button>
          ) : null}
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
