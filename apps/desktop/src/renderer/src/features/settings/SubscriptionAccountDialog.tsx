import { LoaderCircle } from "lucide-react";
import { useId, useState } from "react";
import type { CreateSubscriptionAccountInput, SubscriptionProvider } from "@coilcoil/runtime-protocol";
import { Modal } from "../../ui/dialog";
import { Field, TextField } from "../../ui/form";
import { Select } from "../../ui/Select";
import "./subscriptionAccount.css";

export function SubscriptionAccountDialog({ existingIds, onCreate, onClose }: {
  existingIds: readonly string[];
  onCreate: (input: CreateSubscriptionAccountInput) => Promise<string | undefined>;
  onClose: () => void;
}): React.JSX.Element {
  const formId = useId();
  const [provider, setProvider] = useState<SubscriptionProvider>("anthropic");
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const submit = async (): Promise<void> => {
    if (saving) return;
    const prefix = id.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(prefix)) {
      setError("请填写独立账号前缀，只能用字母、数字、点、- 和 _，最多 64 个字符。");
      return;
    }
    if (existingIds.includes(prefix)) {
      setError(`前缀“${prefix}”已被使用，请换一个；不会覆盖原登录。`);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const failure = await onCreate({ id: prefix, provider, name: name.trim() || undefined });
      if (failure) setError(failure);
    } finally { setSaving(false); }
  };
  return <Modal open title="添加订阅账号" size="md" description="每个账号单独登录、单独查额度，不会替换原来的登录。添加后，请在授权网页选择对应账号。" onClose={() => { if (!saving) onClose(); }} footer={<>
    <button className="coil-modal-button" type="button" disabled={saving} onClick={onClose}>取消</button>
    <button className="coil-modal-button primary" type="submit" form={formId} disabled={saving}>{saving ? <LoaderCircle className="spin" size={13} /> : null}{saving ? "添加中…" : "添加账号"}</button>
  </>}>
    <form id={formId} className="ui-form subscription-account-form" noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <Field>订阅类型<Select value={provider} ariaLabel="订阅类型" options={[{ value: "anthropic", label: "Anthropic / Claude 订阅" }, { value: "openai-codex", label: "OpenAI / Codex 订阅" }]} onChange={(value) => { setProvider(value as SubscriptionProvider); setError(undefined); }} /></Field>
      <Field>账号前缀<TextField value={id} maxLength={64} autoComplete="off" spellCheck={false} placeholder={provider === "anthropic" ? "例如 claude-work" : "例如 codex-personal"} onChange={(event) => { setId(event.target.value); setError(undefined); }} /><small>会显示在模型名前，创建后不能修改；请选择一个尚未使用的前缀。</small></Field>
      <Field>显示名称<TextField value={name} maxLength={80} placeholder="例如工作账号；留空则使用前缀" onChange={(event) => { setName(event.target.value); setError(undefined); }} /></Field>
    </form>
    {error ? <p className="subscription-account-error" role="alert">{error}</p> : null}
  </Modal>;
}
