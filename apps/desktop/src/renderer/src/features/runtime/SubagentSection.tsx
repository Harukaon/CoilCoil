import { Bot, LoaderCircle, Save, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { RuntimeConfiguration, SubagentConfiguration, SubagentProfileModels } from "@coilcoil/runtime-protocol";
import { Select, type SelectOption } from "../../ui/Select";
import { toastError, toastSuccess } from "../../ui/toast";
import { RuntimeSection } from "./RuntimeSection";
import {
  chosenSubagentModel,
  subagentBlurb,
  subagentModelsToSave,
  subagentTitle,
  subagentUsable,
} from "./subagentProfiles";
import { useSubagentProfiles } from "./useSubagentProfiles";

/**
 * The runtime panel's block for subagents: every profile the open project can use, and the
 * model each one runs on.
 */
export function SubagentSection({
  runtimeId,
  cwd,
  availableModels,
  inspectionModels,
}: {
  runtimeId?: string;
  cwd?: string;
  availableModels: RuntimeConfiguration["models"];
  /** The choices the runtime reports; the block follows them when they change elsewhere. */
  inspectionModels?: SubagentProfileModels;
}): React.JSX.Element {
  const [models, setModels] = useState<SubagentProfileModels>(inspectionModels ?? {});
  const list = useSubagentProfiles(runtimeId, cwd);
  const [saving, setSaving] = useState(false);
  const configuredCount = list.profiles.filter((profile) => subagentUsable(profile, models)).length;

  // Chosen somewhere else (another window, the onboarding page): follow that rather than
  // the copy taken when this panel mounted.
  const inspectionModelsJson = JSON.stringify(inspectionModels ?? {});
  useEffect(() => {
    setModels(JSON.parse(inspectionModelsJson) as SubagentProfileModels);
  }, [inspectionModelsJson]);

  const saveModels = async (): Promise<void> => {
    setSaving(true);
    try {
      const result = await window.coilcoil.request<SubagentConfiguration>({
        type: "save_subagent_configuration",
        // Every profile listed here is named, an empty choice included, so a cleared model
        // sticks; the ones this panel does not list (other projects') are left as they are.
        input: { models: subagentModelsToSave(list.profiles, models) },
      }, runtimeId);
      setModels(result.models);
      const count = list.profiles.filter((profile) => subagentUsable(profile, result.models)).length;
      toastSuccess(count > 0
        ? `已保存子 Agent 模型配置（${count}/${list.profiles.length}）`
        : "已清除子 Agent 模型配置，它们都将不可用");
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <RuntimeSection
      title="子 Agent 模型"
      icon={<Bot size={14} />}
      badge={list.profiles.length === 0
        ? undefined
        : configuredCount
          ? `${configuredCount}/${list.profiles.length} 已配置`
          : `${list.profiles.length} 个都未配置 · 不可用`}
    >
      <div className="runtime-subagent-models">
        {list.profiles.map((profile) => {
          const selected = chosenSubagentModel(models, profile.name);
          const usable = subagentUsable(profile, models);
          const title = subagentTitle(profile);
          const selectedAvailable = availableModels.some((model) => `${model.provider}/${model.id}` === selected);
          const modelOptions: SelectOption[] = [
            profile.fileModel
              ? { value: "", label: `沿用文件里写的模型（${profile.fileModel}）`, detail: "不另选时，用这个子 Agent 文件里写明的模型" }
              : { value: "", label: "未配置（此子 Agent 不可用）", detail: "不配置就不给派发，而不是悄悄用主会话模型" },
            ...(selected && !selectedAvailable
              ? [{ value: selected, label: selected, detail: "当前不可用", disabled: true }]
              : []),
            ...availableModels.map((model) => ({
              value: `${model.provider}/${model.id}`,
              label: model.name,
              detail: `${model.providerName} · ${model.provider}/${model.id}`,
              keywords: `${model.providerName} ${model.provider} ${model.id}`,
            })),
          ];
          return (
            <label className={`runtime-subagent-model-row ${usable ? "" : "unconfigured"}`} key={`${profile.source}:${profile.name}`}>
              <span>
                <strong>{usable ? null : <XCircle className="runtime-subagent-unavailable" size={13} />}{title}</strong>
                <small>{usable ? subagentBlurb(profile) : "未配置模型，派发会被拒绝"}</small>
              </span>
              <Select
                value={selected}
                options={modelOptions}
                onChange={(model) => setModels((current) => ({ ...current, [profile.name]: model }))}
                ariaLabel={`${title} 默认模型`}
                className="runtime-subagent-select"
                searchable
              />
            </label>
          );
        })}
      </div>
      {list.loading && list.profiles.length === 0 ? <p className="runtime-section-footnote">正在读取子 Agent 列表…</p> : null}
      {list.error ? (
        <p className="runtime-section-footnote">
          读取子 Agent 列表失败：{list.error}
          {" "}<button type="button" onClick={() => { void list.reload(); }}>重试</button>
        </p>
      ) : null}
      <div className="runtime-actions">
        <button
          className="primary"
          type="button"
          disabled={saving || !runtimeId || list.profiles.length === 0}
          onClick={() => { void saveModels(); }}
        >
          {saving ? <LoaderCircle className="spin" size={12} /> : <Save size={12} />}保存配置
        </button>
      </div>
      <p className="runtime-section-footnote">每个子 Agent 独立配置。没配模型的那一项不可用：Agent 派发它会直接收到「未配置，请改用其他方式」的错误，而不是悄悄改用主会话模型跑一遍。</p>
    </RuntimeSection>
  );
}
