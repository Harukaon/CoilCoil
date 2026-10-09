import { LoaderCircle } from "lucide-react";
import { useId, useState } from "react";
import type {
  RuntimeConfiguration,
  SaveSubagentProfileInput,
  SubagentProfileInfo,
  SubagentProfileScope,
} from "@coilcoil/runtime-protocol";
import { Modal } from "../../ui/dialog";
import { Checkbox, Field, TextArea, TextField } from "../../ui/form";
import { Select, type SelectOption } from "../../ui/Select";
import {
  changesFiles,
  newSubagentDraft,
  subagentDraftFromProfile,
  subagentDraftProblem,
  subagentDraftToInput,
  subagentModelOptions,
  subagentToolBlurb,
  type SubagentDraft,
} from "./subagentProfiles";
import "./subagent-dialog.css";

const SCOPE_HINTS: Record<SubagentProfileScope, string> = {
  user: "保存在你自己的配置目录里，每个项目都能用。",
  project: "保存在这个项目的 .coilcoil/agents 里，可以随项目一起提交给团队。",
};

/**
 * The form for adding a subagent, or changing one the user wrote.
 *
 * It only collects what the profile file holds (name, where it lives, what it is for, its
 * prompt, its tools, whether it works on its own git branch) plus the model it runs on. What
 * the runtime refuses it says in the form, next to the buttons, instead of in a toast that
 * would vanish before it was read.
 */
export function SubagentProfileDialog({
  profile,
  availableTools,
  existingNames,
  hasProject,
  models,
  initialModel,
  onSave,
  onClose,
}: {
  /** The subagent being changed; none when adding a new one. */
  profile?: SubagentProfileInfo & { source: SubagentProfileScope };
  availableTools: readonly string[];
  /** Every name already taken, built-in ones included. */
  existingNames: readonly string[];
  /** Whether a project is open: only then can a subagent be saved into it. */
  hasProject: boolean;
  models: RuntimeConfiguration["models"];
  /** The model chosen for the subagent being changed. */
  initialModel: string;
  /** Saves it. Resolves to what went wrong, or to nothing when it worked (the caller then closes the dialog). */
  onSave: (input: SaveSubagentProfileInput, model: string) => Promise<string | undefined>;
  onClose: () => void;
}): React.JSX.Element {
  const mode = profile ? "edit" : "create";
  const formId = useId();
  const titleId = useId();
  const descriptionId = useId();
  const toolsId = useId();
  const [draft, setDraft] = useState<SubagentDraft>(() => (profile ? subagentDraftFromProfile(profile, initialModel) : newSubagentDraft()));
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const update = (changes: Partial<SubagentDraft>): void => {
    setDraft((current) => ({ ...current, ...changes }));
    // What was said was about the form as it was; once it is changed, say nothing until it is tried again.
    setError(undefined);
  };
  const toggleTool = (tool: string, on: boolean): void => {
    update({ tools: on ? [...draft.tools, tool] : draft.tools.filter((item) => item !== tool) });
  };

  const submit = async (): Promise<void> => {
    if (saving) return;
    const problem = subagentDraftProblem(draft, mode, availableTools, existingNames);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(undefined);
    const failure = await onSave(subagentDraftToInput(draft, availableTools), draft.model);
    if (failure) {
      setError(failure);
      setSaving(false);
    }
  };

  const scopeOptions: SelectOption[] = [
    { value: "user", label: "我的所有项目", detail: "保存在你自己的配置目录里，每个项目都能用" },
    {
      value: "project",
      label: "仅当前项目",
      detail: hasProject ? "保存在项目的 .coilcoil/agents 里，可以随项目提交" : "没有打开项目，不能选",
      disabled: !hasProject,
    },
  ];

  return (
    <Modal open bare onClose={onClose}>
      <section className="coil-modal coil-modal-lg subagent-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
        <h2 className="coil-modal-title" id={titleId}>{profile ? `编辑子 Agent「${profile.name}」` : "添加子 Agent"}</h2>
        <p className="coil-modal-description" id={descriptionId}>子 Agent 在自己独立的对话里干活，只把结论交回主 Agent。写好它的分工，主 Agent 就能按名字派它。</p>
        <form
          id={formId}
          className="subagent-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="subagent-form-row">
            <Field>
              名字
              <TextField
                value={draft.name}
                disabled={mode === "edit"}
                placeholder="例如 db-expert"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => update({ name: event.target.value })}
              />
              <small className="subagent-form-hint">{mode === "edit" ? "名字不能改；想换名字，就新建一个，再删掉这个。" : "小写字母、数字、- 和 _。主 Agent 按这个名字派它，它也是文件名。"}</small>
            </Field>
            <Field>
              保存位置
              <Select
                value={draft.scope}
                options={scopeOptions}
                disabled={mode === "edit"}
                ariaLabel="保存位置"
                onChange={(scope) => update({ scope: scope as SubagentProfileScope })}
              />
              <small className="subagent-form-hint">{SCOPE_HINTS[draft.scope]}</small>
            </Field>
          </div>

          <Field>
            说明
            <TextField
              value={draft.description}
              placeholder="例如：熟悉数据库表结构，帮忙检查 SQL"
              autoFocus={mode === "edit"}
              onChange={(event) => update({ description: event.target.value })}
            />
            <small className="subagent-form-hint">一句话写清它擅长什么、什么时候该派它。主 Agent 就靠这句话决定要不要派。</small>
          </Field>

          <Field>
            提示词
            <TextArea
              className="subagent-form-prompt"
              value={draft.systemPrompt}
              spellCheck={false}
              placeholder="例如：You check SQL against the schema. Report only what is wrong."
              onChange={(event) => update({ systemPrompt: event.target.value })}
            />
            <small className="subagent-form-hint">这是它收到的全部工作说明，每次派发都会带上。用英文写更省 Token。</small>
          </Field>

          <div className="subagent-form-group" role="group" aria-labelledby={toolsId}>
            <span className="subagent-form-group-title" id={toolsId}>工具</span>
            <div className="subagent-form-tools">
              {availableTools.map((tool) => (
                <Field className="subagent-form-tool" key={tool}>
                  <Checkbox className="subagent-form-tick" checked={draft.tools.includes(tool)} onChange={(event) => toggleTool(tool, event.target.checked)} />
                  <span>{subagentToolBlurb(tool) || tool}<code>{tool}</code></span>
                </Field>
              ))}
            </div>
            <small className="subagent-form-hint">
              {changesFiles(draft.tools)
                ? "它能改文件，所以会自动带上 Git 安全规则：不覆盖别人的改动，不用毁坏性命令。"
                : "没有勾「修改文件」和「写新文件」，它只能看，不能改。"}
            </small>
          </div>

          <Field className="subagent-form-tool">
            <Checkbox className="subagent-form-tick" checked={draft.worktree} onChange={(event) => update({ worktree: event.target.checked })} />
            <span className="subagent-form-option">
              <span>在独立的 Git 副本里工作</span>
              <small className="subagent-form-hint">它的改动落在单独的分支副本里，不碰你的工作区，之后由主 Agent 合并。</small>
            </span>
          </Field>

          <Field>
            默认模型
            <Select
              value={draft.model}
              options={subagentModelOptions({ fileModel: profile?.fileModel, selected: draft.model, models })}
              ariaLabel="默认模型"
              onChange={(model) => update({ model })}
              searchable
            />
            <small className="subagent-form-hint">不选就不能派发它：宁可不可用，也不悄悄用主会话的模型跑。</small>
          </Field>

        </form>
        {/* Outside the form, which scrolls: said inside it, a refusal would sit below the fold, out of sight of the button just pressed. */}
        {error ? <div className="subagent-form-error" role="alert">{error}</div> : null}
        <footer className="coil-modal-footer">
          <button className="coil-modal-button" type="button" onClick={onClose}>取消</button>
          <button className="coil-modal-button primary" type="submit" form={formId} disabled={saving}>
            {saving ? <LoaderCircle className="spin" size={13} /> : null}保存
          </button>
        </footer>
      </section>
    </Modal>
  );
}
