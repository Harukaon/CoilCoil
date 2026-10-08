import { LoaderCircle, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type {
  RuntimeConfiguration,
  SessionNamingConfiguration,
  SubagentConfiguration,
  SubagentProfileModels,
} from "@coilcoil/runtime-protocol";
import { Select, type SelectOption } from "../../ui/Select";
import { toastError, toastSuccess } from "../../ui/toast";
import { chosenSubagentModel, subagentBlurb, subagentModelsToSave, subagentTitle } from "../runtime/subagentProfiles";
import { useSubagentProfiles } from "../runtime/useSubagentProfiles";

function modelOptions(configuration?: RuntimeConfiguration): SelectOption[] {
  const models = configuration?.models.filter((model) => model.configured) ?? [];
  return [
    { value: "", label: "未配置（此 profile 不派发）", detail: "可以之后在设置里补上" },
    ...models.map((model) => ({
      value: `${model.provider}/${model.id}`,
      label: model.name,
      detail: `${model.providerName} · ${model.provider}/${model.id}`,
      keywords: `${model.providerName} ${model.provider} ${model.id}`,
    })),
  ];
}

export function OnboardingAgentSetup({ configuration, runtimeId }: { configuration?: RuntimeConfiguration; runtimeId?: string }): React.JSX.Element {
  const [models, setModels] = useState<SubagentProfileModels>({});
  const profileList = useSubagentProfiles(runtimeId, undefined);
  const [namingModel, setNamingModel] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const options = useMemo(() => modelOptions(configuration), [configuration]);
  const hasConfiguredModel = options.length > 1;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void Promise.all([
      window.coilcoil.request<SubagentConfiguration>({ type: "get_subagent_configuration" }, runtimeId),
      window.coilcoil.request<SessionNamingConfiguration>({ type: "get_session_naming_configuration" }, runtimeId),
    ]).then(([subagent, naming]) => {
      if (cancelled) return;
      setModels(subagent?.models ?? {});
      setNamingModel(naming?.model ?? "");
    }).catch((caught) => {
      if (!cancelled) toastError(caught instanceof Error ? caught.message : String(caught));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [runtimeId]);

  const save = async (): Promise<void> => {
    setSaving(true);
    setSaved(false);
    try {
      await window.coilcoil.request<SubagentConfiguration>({
        type: "save_subagent_configuration",
        input: { models: subagentModelsToSave(profileList.profiles, models) },
      }, runtimeId);
      await window.coilcoil.request<SessionNamingConfiguration>({
        type: "save_session_naming_configuration",
        input: { model: namingModel.trim() },
      }, runtimeId);
      setSaved(true);
      toastSuccess("子 Agent 和会话命名模型已保存");
    } catch (caught) {
      toastError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  if (loading || (profileList.loading && profileList.profiles.length === 0)) return <div className="onboarding-setup-loading"><LoaderCircle className="spin" size={15} />读取已有配置…</div>;

  return (
    <div className="onboarding-config-grid">
      <section className="onboarding-config-section">
        <header>
          <strong>子 Agent 模型</strong>
          <small>给不同职责单独指定模型；留空则不启用该 profile。</small>
          {profileList.error ? <small>读取子 Agent 列表失败：{profileList.error}</small> : null}
        </header>
        <div className="onboarding-agent-list">
          {profileList.profiles.map((profile) => (
            <label className="onboarding-agent-row" key={`${profile.source}:${profile.name}`}>
              <span><strong>{subagentTitle(profile)}</strong><small>{subagentBlurb(profile)}</small></span>
              <Select
                value={chosenSubagentModel(models, profile.name)}
                options={options}
                onChange={(value) => { setModels((current) => ({ ...current, [profile.name]: value })); setSaved(false); }}
                ariaLabel={`${subagentTitle(profile)} 模型`}
                placeholder="选择模型"
                searchable
                disabled={!hasConfiguredModel || saving}
              />
            </label>
          ))}
        </div>
      </section>

      <section className="onboarding-config-section">
        <header><strong>会话命名模型</strong><small>空白表示跟随当前会话模型，不额外指定。</small></header>
        <Select
          value={namingModel}
          options={options}
          onChange={(value) => { setNamingModel(value); setSaved(false); }}
          ariaLabel="会话命名模型"
          placeholder="跟随会话当前模型"
          searchable
          disabled={!hasConfiguredModel || saving}
        />
      </section>

      <div className="onboarding-config-actions">
        <button className="onboarding-inline-save" type="button" disabled={saving} onClick={() => void save()}>
          {saving ? <LoaderCircle className="spin" size={13} /> : <Save size={13} />}
          {saved ? "已保存" : "保存配置"}
        </button>
        {!hasConfiguredModel ? <span>请先在上一步配置至少一个可用模型。</span> : null}
      </div>
    </div>
  );
}
