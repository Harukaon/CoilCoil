import { ArrowUp, Square, X } from "lucide-react";
import type { FormEvent, RefObject } from "react";
import type {
  ModelOption,
  PromptImage,
  ProjectSelection,
  RuntimeConfiguration,
  SessionSnapshot,
} from "@suocode/runtime-protocol";
import { imageDataUrl } from "../conversation/ConversationTimeline";
import { ModelPicker } from "./ModelPicker";

export function ConversationComposer({
  project,
  running,
  loading,
  startingSession,
  draft,
  images,
  inputRef,
  configuration,
  selectedModel,
  modelMenuOpen,
  modelChanging,
  onSubmit,
  onDraftChange,
  onImagesChange,
  onPaste,
  onCompositionStart,
  onCompositionEnd,
  onKeyDown,
  onModelMenuOpenChange,
  onSelectModel,
  onOpenSettings,
  onAbort,
}: {
  project: ProjectSelection | null;
  running: boolean;
  loading: boolean;
  startingSession: boolean;
  draft: string;
  images: PromptImage[];
  inputRef: RefObject<HTMLTextAreaElement | null>;
  configuration?: RuntimeConfiguration;
  selectedModel?: SessionSnapshot["model"];
  modelMenuOpen: boolean;
  modelChanging: boolean;
  onSubmit: (event: FormEvent) => void;
  onDraftChange: (value: string) => void;
  onImagesChange: React.Dispatch<React.SetStateAction<PromptImage[]>>;
  onPaste: React.ClipboardEventHandler<HTMLTextAreaElement>;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement>;
  onModelMenuOpenChange: (open: boolean) => void;
  onSelectModel: (model: ModelOption) => void;
  onOpenSettings: () => void;
  onAbort: () => void;
}): React.JSX.Element {
  return (
    <form className="composer" onSubmit={onSubmit}>
      {images.length ? <div className="composer-images">{images.map((image) => <figure key={image.id ?? image.data.slice(0, 24)}><img src={imageDataUrl(image)} alt={image.name ?? "粘贴的图片"} /><button type="button" aria-label="移除图片" onClick={() => onImagesChange((current) => current.filter((item) => item !== image))}><X size={11} /></button></figure>)}</div> : null}
      <textarea
        ref={inputRef}
        rows={1}
        value={draft}
        aria-label="发送消息给 SuoCode"
        placeholder={project ? (running ? "补充指令…" : "让 SuoCode 处理这个项目…") : "请先打开项目"}
        disabled={!project || loading || startingSession}
        onChange={(event) => onDraftChange(event.target.value)}
        onPaste={onPaste}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        onKeyDown={onKeyDown}
      />
      <div className="composer-toolbar">
        <ModelPicker configuration={configuration} currentModel={selectedModel} open={modelMenuOpen} busy={modelChanging} onOpenChange={onModelMenuOpenChange} onSelect={onSelectModel} onOpenSettings={onOpenSettings} />
        {running ? <button className="stop-button" type="button" aria-label="停止 Agent" onClick={onAbort}><Square size={12} fill="currentColor" /></button> : null}
        <button className="send-button" type="submit" aria-label={running ? "补充指令" : "发送消息"} disabled={!project || startingSession || (!draft.trim() && !images.length)}><ArrowUp size={17} strokeWidth={2.2} /></button>
      </div>
    </form>
  );
}
