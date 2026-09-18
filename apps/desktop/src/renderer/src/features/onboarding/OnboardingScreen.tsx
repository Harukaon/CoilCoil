import { FolderOpen, FolderTree } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { RuntimeConfiguration } from "@coilcoil/runtime-protocol";
import type { MacPermissionId, MacPermissions, ProjectSelection } from "../../../../shared/desktop-api";
import { ModelSettings } from "../settings/ModelSettings";
import { WindowDragBar } from "../../ui/WindowDragBar";
import {
  advance,
  canAdvance,
  canSkip,
  goBack,
  INITIAL_ONBOARDING,
  isLastStep,
  ONBOARDING_STEP_LABELS,
  ONBOARDING_STEPS,
  PERMISSION_TOPICS,
  type OnboardingProgress,
  type PermissionDecisions,
  stepIndex,
} from "./onboardingSteps";
import "./onboarding.css";

/** 三条产品理念。放在这里而不是散在 JSX 里，改文案不用动结构。 */
const PRINCIPLES: readonly { label: string; body: string }[] = [
  { label: "同一个界面", body: "Agent 打开的网页、跑的终端、改的文件，都画在你眼前那一排标签里。你随时能点进去接管，也能直接关掉。" },
  { label: "一区一世界", body: "每个工作区各自的会话、浏览器登录状态和记忆互不串门。换一个项目，就是换一整套环境。" },
  { label: "在你机器上", body: "读你本地的目录，用你已经登录好的浏览器。代码不用搬走，东西还是你的。" },
];

/**
 * 首次启动的引导。整屏一层，走完才进工作区，设置里可以随时重来。
 *
 * 规则（哪几步、哪一步能跳、问哪些权限）在 onboardingSteps.ts，这里只管画。唯一的
 * 硬约束是权限那一步每一项都要表态——原因写在那个文件里。
 *
 * 视觉上刻意不用卡片和描边：分隔靠留白和发丝线，背景是一团慢慢飘的墨，和产品自己
 * 那个墨团标志是同一套语言。
 */
export function OnboardingScreen({ configuration, onConfigurationSaved, runtimeId, projects, onOpenProject, onDone }: {
  configuration?: RuntimeConfiguration;
  onConfigurationSaved: (configuration: RuntimeConfiguration) => void;
  runtimeId?: string;
  projects: ProjectSelection[];
  onOpenProject: () => void;
  onDone: (permissions: PermissionDecisions) => void;
}): React.JSX.Element {
  const [progress, setProgress] = useState<OnboardingProgress>(INITIAL_ONBOARDING);
  const [permissions, setPermissions] = useState<MacPermissions>();

  // 系统已经给了的那几项不必再问一遍——用户早就表过态了。
  const adoptGranted = useCallback((next: MacPermissions): void => {
    setPermissions(next);
    setProgress((current) => {
      const granted = PERMISSION_TOPICS.filter((topic) => next.status[topic.id] === "granted" && current.permissions[topic.id] === undefined);
      if (granted.length === 0) return current;
      const merged = { ...current.permissions };
      for (const topic of granted) merged[topic.id] = "grant";
      return { ...current, permissions: merged };
    });
  }, []);

  const refresh = useCallback(() => {
    if (typeof window.coilcoil?.getMacPermissions !== "function") return;
    void window.coilcoil.getMacPermissions().then(adoptGranted).catch(() => undefined);
  }, [adoptGranted]);

  // 进到权限这一步就探一次；用户去系统设置点完再切回来，窗口重新拿到焦点时再探一次
  // ——授权之后不用他自己回来按刷新。
  useEffect(() => {
    if (progress.step !== "permissions") return;
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [progress.step, refresh]);

  const decide = (id: MacPermissionId, decision: "grant" | "skip"): void => {
    setProgress((current) => ({ ...current, permissions: { ...current.permissions, [id]: decision } }));
    if (decision === "grant") void window.coilcoil.openPermissionSettings(id);
  };

  const index = stepIndex(progress.step);
  const next = (): void => {
    if (isLastStep(progress.step)) onDone(progress.permissions);
    else setProgress(advance(progress));
  };

  return (
    <main className="onboarding-screen" aria-labelledby="onboarding-title">
      <div className="onboarding-ink" aria-hidden="true"><i /><i /><i /></div>
      <div className="onboarding-drag window-drag-bar"><WindowDragBar /></div>

      <div className="onboarding-stage">
        <div className={`onboarding-inner ${progress.step === "model" ? "wide" : ""}`}>
          <nav className="onboarding-rail" aria-label="引导进度">
            {ONBOARDING_STEPS.map((step, position) => (
              <span className={position < index ? "done" : position === index ? "current" : ""} key={step}>
                {ONBOARDING_STEP_LABELS[step]}
              </span>
            ))}
          </nav>

          <section className="onboarding-step" key={progress.step}>
            <span className="onboarding-mark" aria-hidden="true">{index + 1}</span>

            {progress.step === "intro" ? (
              <>
                <div className="onboarding-headline onboarding-rise" style={{ "--i": 0 } as React.CSSProperties}>
                  <h1 id="onboarding-title">让 AI 和你<br />待在同一个界面里</h1>
                  <p>它开的网页、跑的命令、改的文件都在你眼前，而不是在你看不见的地方。</p>
                </div>
                <div className="onboarding-lines">
                  {PRINCIPLES.map((line, position) => (
                    <div className="onboarding-rise" key={line.label} style={{ "--i": position + 1 } as React.CSSProperties}>
                      <strong>{line.label}</strong>
                      <span>{line.body}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : null}

            {progress.step === "model" ? (
              <>
                <div className="onboarding-headline">
                  <h1 id="onboarding-title">配一个模型</h1>
                  <p>选一个服务商填上密钥就能开始。现在不配也行，之后在「设置 → 模型与服务商」里随时能补。</p>
                </div>
                <div className="onboarding-embed">
                  <ModelSettings configuration={configuration} onSaved={onConfigurationSaved} runtimeId={runtimeId} />
                </div>
              </>
            ) : null}

            {progress.step === "permissions" ? (
              <>
                <div className="onboarding-headline">
                  <h1 id="onboarding-title">系统权限</h1>
                  <p>下面每一项在 macOS 里都是独立的开关，给不给都由你定。这里只说明它可能被用来做什么——macOS 拒绝的时候不会报错，功能只会悄悄消失，所以每一项都请你自己过一遍。</p>
                </div>
                <div className="onboarding-permissions">
                  {PERMISSION_TOPICS.map((topic, position) => {
                    const decision = progress.permissions[topic.id];
                    const granted = permissions?.status[topic.id] === "granted";
                    return (
                      <div className="onboarding-permission onboarding-rise" key={topic.id} style={{ "--i": position } as React.CSSProperties}>
                        <div className="onboarding-permission-name">
                          {topic.name}
                          {granted ? <em>已开启</em> : null}
                        </div>
                        <p className="onboarding-permission-purpose">{topic.purpose}</p>
                        <div className="onboarding-permission-actions">
                          <button className={decision === "grant" ? "chosen" : ""} type="button" onClick={() => decide(topic.id, "grant")}>
                            {granted ? "已开启" : "去开启"}
                          </button>
                          <button className={decision === "skip" ? "chosen" : ""} type="button" onClick={() => decide(topic.id, "skip")}>不用</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            ) : null}

            {progress.step === "workspace" ? (
              <>
                <div className="onboarding-headline">
                  <h1 id="onboarding-title">挂一个工作区</h1>
                  <p>选一个本地文件夹，CoilCoil 就在它里面干活。之后在左侧栏随时能再加，现在跳过也行。</p>
                </div>
                <div className="onboarding-workspace">
                  <button className="onboarding-pick" type="button" onClick={onOpenProject}><FolderOpen size={15} />选择文件夹</button>
                  {projects.length ? (
                    <ul className="onboarding-mounted">
                      {projects.map((item) => (
                        <li key={item.path}><FolderTree size={14} />{item.name}<small>{item.path}</small></li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              </>
            ) : null}
          </section>
        </div>
      </div>

      <footer className="onboarding-footer">
        {index > 0 ? <button className="onboarding-back" type="button" onClick={() => setProgress(goBack(progress))}>上一步</button> : null}
        <span className="spacer" />
        {canSkip(progress.step) ? <button className="onboarding-skip" type="button" onClick={next}>跳过这一步</button> : null}
        <button className="onboarding-next" type="button" disabled={!canAdvance(progress)} onClick={next}>
          {isLastStep(progress.step) ? "开始使用" : "继续"}
        </button>
      </footer>
    </main>
  );
}
