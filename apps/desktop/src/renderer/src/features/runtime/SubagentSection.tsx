import { Bot, LoaderCircle, Pencil, Plus, Save, Trash2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  RuntimeConfiguration,
  SaveSubagentProfileInput,
  SubagentConfiguration,
  SubagentProfileInfo,
  SubagentProfileModels,
  SubagentProfileScope,
  SubagentProfilesSnapshot,
} from "@coilcoil/runtime-protocol";
import { ConfirmDialog } from "../../ui/dialog";
import { Select } from "../../ui/Select";
import { toastError, toastSuccess } from "../../ui/toast";
import { RuntimeSection } from "./RuntimeSection";
import { SubagentProfileDialog } from "./SubagentProfileDialog";
import {
  chosenSubagentModel,
  isCustomSubagent,
  subagentBlurb,
  subagentModelOptions,
  subagentModelsToSave,
  subagentTitle,
  subagentUsable,
} from "./subagentProfiles";
import { useSubagentProfiles } from "./useSubagentProfiles";

type CustomProfile = SubagentProfileInfo & { source: SubagentProfileScope };

function errorText(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

/**
 * The runtime panel's block for subagents: every profile the open project can use, the model
 * each one runs on, and adding, changing and deleting the ones the user wrote.
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
  /** The form: open for a new subagent (no profile) or for one being changed. */
  const [form, setForm] = useState<{ profile?: CustomProfile }>();
  const [removing, setRemoving] = useState<CustomProfile>();
  const [removeBusy, setRemoveBusy] = useState(false);
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
      toastError(errorText(caught));
    } finally {
      setSaving(false);
    }
  };

  /** Saves what the form holds; resolves to what went wrong, or to nothing once it is saved and the form closed. */
  const saveProfile = async (input: SaveSubagentProfileInput, model: string): Promise<string | undefined> => {
    const creating = !form?.profile;
    try {
      list.replace(await window.coilcoil.request<SubagentProfilesSnapshot>({ type: "save_subagent_profile", input, cwd }, runtimeId));
    } catch (caught) {
      return errorText(caught);
    }
    // The file is saved. What is left is only the model: if that fails, the subagent is listed
    // without one, and says so.
    if (model || !creating) {
      try {
        const saved = await window.coilcoil.request<SubagentConfiguration>({
          type: "save_subagent_configuration",
          input: { models: { [input.name]: model } },
        }, runtimeId);
        // Only this one: the choices made in the other rows and not saved yet stay as they are.
        setModels((current) => ({ ...current, [input.name]: saved.models[input.name] ?? "" }));
      } catch (caught) {
        toastError(`子 Agent 已保存，但没能保存它的模型：${errorText(caught)}`);
      }
    }
    toastSuccess(creating ? `已添加子 Agent「${input.name}」` : `已保存子 Agent「${input.name}」`);
    setForm(undefined);
    return undefined;
  };

  const removeProfile = async (): Promise<void> => {
    if (!removing) return;
    setRemoveBusy(true);
    try {
      const snapshot = await window.coilcoil.request<SubagentProfilesSnapshot>({
        type: "delete_subagent_profile",
        name: removing.name,
        scope: removing.source,
        cwd,
      }, runtimeId);
      list.replace(snapshot);
      // The runtime forgets the model chosen for a name once nothing carries that name any more.
      if (!snapshot.profiles.some((profile) => profile.name === removing.name)) {
        setModels((current) => Object.fromEntries(Object.entries(current).filter(([name]) => name !== removing.name)));
      }
      toastSuccess(`已删除子 Agent「${removing.name}」`);
      setRemoving(undefined);
    } catch (caught) {
      toastError(errorText(caught));
    } finally {
      setRemoveBusy(false);
    }
  };

  return (
    <RuntimeSection
      title="子 Agent"
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
          return (
            <div className={`runtime-subagent-model-row ${usable ? "" : "unconfigured"}`} key={`${profile.source}:${profile.name}`}>
              <span>
                <strong>
                  {usable ? null : <XCircle className="runtime-subagent-unavailable" size={13} />}
                  {title}
                  {profile.source === "project" ? <em className="runtime-subagent-scope">本项目</em> : null}
                </strong>
                <small title={isCustomSubagent(profile) ? profile.description : undefined}>{usable ? subagentBlurb(profile) : "未配置模型，派发会被拒绝"}</small>
                {isCustomSubagent(profile) ? (
                  <span className="runtime-subagent-actions">
                    <button type="button" className="runtime-subagent-icon" aria-label={`编辑 ${profile.name}`} title="编辑" onClick={() => setForm({ profile })}><Pencil size={12} /></button>
                    <button type="button" className="runtime-subagent-icon" aria-label={`删除 ${profile.name}`} title="删除" onClick={() => setRemoving(profile)}><Trash2 size={12} /></button>
                  </span>
                ) : null}
              </span>
              <Select
                value={selected}
                options={subagentModelOptions({ fileModel: profile.fileModel, selected, models: availableModels })}
                onChange={(model) => setModels((current) => ({ ...current, [profile.name]: model }))}
                ariaLabel={`${title} 默认模型`}
                className="runtime-subagent-select"
                searchable
              />
            </div>
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
        <button type="button" disabled={!runtimeId || list.profiles.length === 0} onClick={() => setForm({})}>
          <Plus size={12} />添加子 Agent
        </button>
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

      {form ? (
        <SubagentProfileDialog
          profile={form.profile}
          availableTools={list.availableTools}
          existingNames={list.profiles.map((profile) => profile.name)}
          hasProject={Boolean(cwd)}
          models={availableModels}
          initialModel={form.profile ? chosenSubagentModel(models, form.profile.name) : ""}
          onSave={saveProfile}
          onClose={() => setForm(undefined)}
        />
      ) : null}
      <ConfirmDialog
        open={Boolean(removing)}
        title={`删除子 Agent「${removing?.name ?? ""}」？`}
        description={`会删掉它的文件（${removing?.filePath ?? ""}），给它选的模型也一起清掉。已经派出去、还在跑的不受影响。`}
        onClose={() => { if (!removeBusy) setRemoving(undefined); }}
        actions={[
          { label: "取消", onClick: () => setRemoving(undefined) },
          { label: removeBusy ? "删除中…" : "删除", variant: "danger", onClick: () => { if (!removeBusy) void removeProfile(); } },
        ]}
      />
    </RuntimeSection>
  );
}
