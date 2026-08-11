import {
  CheckCircle2,
  Circle,
  CircleDot,
  FileText,
  Play,
  Users,
  X,
} from "lucide-react";
import { useState } from "react";
import type { PlanApprovalState, PlanExecutionTarget } from "@suocode/runtime-protocol";

const SUBAGENT_PROFILES = ["explore", "reviewer", "worker"] as const;

function planStatusLabel(status: PlanApprovalState["status"]): string {
  if (status === "pending_approval") return "等待审批";
  if (status === "running") return "主 Agent 执行中";
  if (status === "delegated") return "子 Agent 执行中";
  if (status === "completed") return "已完成";
  if (status === "rejected") return "已暂缓";
  return "执行失败";
}

export function PlanApprovalCard({
  plan,
  onApprove,
  onReject,
}: {
  plan: PlanApprovalState;
  onApprove: (planId: string, target: PlanExecutionTarget, agent?: string) => Promise<PlanApprovalState>;
  onReject: (planId: string) => Promise<PlanApprovalState>;
}): React.JSX.Element {
  const [profile, setProfile] = useState<string>("worker");
  const [pendingAction, setPendingAction] = useState<"main" | "subagent" | "reject">();
  const [error, setError] = useState<string>();

  const run = async (action: "main" | "subagent" | "reject"): Promise<void> => {
    if (pendingAction) return;
    setPendingAction(action);
    setError(undefined);
    try {
      if (action === "reject") await onReject(plan.id);
      else await onApprove(plan.id, action, action === "subagent" ? profile : undefined);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPendingAction(undefined);
    }
  };

  return (
    <section className={`plan-approval-card status-${plan.status}`} aria-label={`执行计划：${plan.title}`}>
      <div className="plan-approval-summary">
        <span className="plan-approval-icon"><FileText size={18} /></span>
        <span className="plan-approval-copy">
          <strong>{plan.title}</strong>
          <small>{planStatusLabel(plan.status)} · 已保存为可编辑计划文件</small>
        </span>
      </div>

      <div className="plan-approval-block">
        <strong>目标</strong>
        <p className="plan-approval-objective">{plan.objective}</p>
      </div>

      <div className="plan-approval-block">
        <strong>执行步骤</strong>
        <ol className="plan-approval-steps">
          {plan.steps.map((step) => (
            <li className={step.status} key={step.id}>
              {step.status === "completed" ? <CheckCircle2 size={15} /> : step.status === "in_progress" ? <CircleDot size={15} /> : <Circle size={15} />}
              <span>{step.text}</span>
            </li>
          ))}
        </ol>
      </div>

      <section className="plan-approval-section">
        <strong>验收标准</strong>
        <ul>
          {plan.acceptanceCriteria.map((criterion, index) => <li key={`${index}-${criterion}`}>{criterion}</li>)}
        </ul>
      </section>
      {plan.notes ? <section className="plan-approval-section"><strong>补充说明</strong><p>{plan.notes}</p></section> : null}

      <div className="plan-file-path" title={plan.filePath}>
        <FileText size={13} />
        <span>{plan.filePath}</span>
      </div>

      {plan.status === "pending_approval" ? (
        <div className="plan-approval-actions">
          <button className="plan-primary-action" type="button" disabled={Boolean(pendingAction)} onClick={() => void run("main")}>
            <Play size={14} />{pendingAction === "main" ? "正在启动…" : "主 Agent 执行"}
          </button>
          <div className="plan-agent-picker" aria-label="选择子 Agent">
            {SUBAGENT_PROFILES.map((agent) => (
              <button className={profile === agent ? "active" : ""} type="button" key={agent} disabled={Boolean(pendingAction)} onClick={() => setProfile(agent)}>{agent}</button>
            ))}
            <input
              aria-label="子 Agent profile"
              disabled={Boolean(pendingAction)}
              list="plan-subagent-profiles"
              onChange={(event) => setProfile(event.target.value)}
              placeholder="其他 profile"
              value={SUBAGENT_PROFILES.includes(profile as (typeof SUBAGENT_PROFILES)[number]) ? "" : profile}
            />
            <datalist id="plan-subagent-profiles">{SUBAGENT_PROFILES.map((agent) => <option key={agent} value={agent} />)}</datalist>
          </div>
          <button type="button" disabled={Boolean(pendingAction) || !profile.trim()} onClick={() => void run("subagent")}>
            <Users size={14} />{pendingAction === "subagent" ? "正在派发…" : "派发给子 Agent"}
          </button>
          <button className="plan-reject-action" type="button" disabled={Boolean(pendingAction)} onClick={() => void run("reject")}>
            <X size={14} />暂不执行
          </button>
        </div>
      ) : null}
      {plan.status === "delegated" && plan.agentProfile ? <div className="plan-execution-note">由 {plan.agentProfile} 执行{plan.subagentRunId ? ` · ${plan.subagentRunId}` : ""}</div> : null}
      {plan.report ? <div className="plan-execution-report"><strong>执行报告</strong><p>{plan.report}</p></div> : null}
      {plan.error || error ? <div className="plan-approval-error">{error ?? plan.error}</div> : null}
    </section>
  );
}
