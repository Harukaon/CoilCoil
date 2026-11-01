import type { MemorySettings, ModelOption } from "@coilcoil/runtime-protocol";
import { Select, type SelectOption } from "../../ui/Select";

export function memoryWorkerProviders(models: ModelOption[], selected?: string): SelectOption[] {
  const providers = new Map(models.filter((model) => model.configured).map((model) => [model.provider, model.providerName]));
  return [
    { value: "", label: "跟随当前会话模型" },
    ...[...providers].map(([value, label]) => ({ value, label })),
    ...(selected && !providers.has(selected) ? [{ value: selected, label: `${selected}（未配置）`, disabled: true }] : []),
  ];
}

export function memoryWorkerModels(models: ModelOption[], provider?: string, selected?: string): SelectOption[] {
  const available = models.filter((model) => model.configured && model.provider === provider);
  return [
    { value: "", label: provider ? "选择模型" : "使用当前会话模型", disabled: Boolean(provider) },
    ...available.map((model) => ({ value: model.id, label: model.name, detail: model.id })),
    ...(selected && !available.some((model) => model.id === selected)
      ? [{ value: selected, label: `${selected}（不可用）`, disabled: true }] : []),
  ];
}

export function MemoryWorkerSettings({ settings, models, onChange }: {
  settings: MemorySettings;
  models: ModelOption[];
  onChange: (change: Partial<MemorySettings>) => void;
}): React.JSX.Element {
  return <div className="memory-worker-settings">
    <div><strong>做梦 Agent</strong><small>所有 Workspace 共用此模型配置，分别整理自己的随手记和对话。</small>
      <small>达到轮数或 Workspace 空闲 5 分钟后整理；无新内容不运行。应用运行期间生效。</small></div>
    <label><span>供应商</span><Select ariaLabel="后台记忆整理供应商" searchable
      value={settings.workerProvider ?? ""} options={memoryWorkerProviders(models, settings.workerProvider)}
      onChange={(value) => onChange({ workerProvider: value || undefined, workerModelId: undefined })} /></label>
    <label><span>模型</span><Select ariaLabel="后台记忆整理模型" searchable disabled={!settings.workerProvider}
      value={settings.workerModelId ?? ""} options={memoryWorkerModels(models, settings.workerProvider, settings.workerModelId)}
      onChange={(value) => onChange({ workerModelId: value || undefined })} /></label>
  </div>;
}
