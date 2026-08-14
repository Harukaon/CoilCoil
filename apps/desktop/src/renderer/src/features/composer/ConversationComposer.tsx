import { ArrowUp, Square, X } from "lucide-react";
import { useEffect, useRef } from "react";
import type { DragEvent as ReactDragEvent, FormEvent, KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import type {
  ModelOption,
  PromptImage,
  ProjectSelection,
  RuntimeConfiguration,
  SessionSnapshot,
} from "@suocode/runtime-protocol";
import { insertPathAtCaret, SUOCODE_PATH_TYPE } from "./pathInsert";
import { imageDataUrl } from "./promptImages";
import { ModelPicker } from "./ModelPicker";

export type ComposerVariant = "footer" | "inline";

export function ConversationComposer({
  variant = "footer",
  project,
  running,
  loading,
  startingSession,
  draft,
  images,
  inputRef,
  configuration,
  selectedModel,
  thinkingLevel,
  fast,
  modelMenuOpen,
  modelChanging,
  autoFocus,
  onSubmit,
  onDraftChange,
  onImagesChange,
  onPaste,
  onCompositionStart,
  onCompositionEnd,
  onKeyDown,
  onSlashKeyDown,
  onModelMenuOpenChange,
  onSelectModel,
  onConfigureModelOptions,
  onFastChange,
  onOpenSettings,
  onAbort,
  onEscape,
  onPathDropError,
}: {
  variant?: ComposerVariant;
  project: ProjectSelection | null;
  running: boolean;
  loading: boolean;
  startingSession: boolean;
  draft: string;
  images: PromptImage[];
  inputRef: RefObject<HTMLTextAreaElement | null>;
  configuration?: RuntimeConfiguration;
  selectedModel?: SessionSnapshot["model"];
  thinkingLevel?: RuntimeConfiguration["thinkingLevel"];
  fast?: boolean;
  modelMenuOpen: boolean;
  modelChanging: boolean;
  autoFocus?: boolean;
  onSubmit: (event: FormEvent) => void;
  onDraftChange: (value: string) => void;
  onImagesChange: React.Dispatch<React.SetStateAction<PromptImage[]>>;
  onPaste: React.ClipboardEventHandler<HTMLTextAreaElement>;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  onKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement>;
  onSlashKeyDown?: (event: ReactKeyboardEvent<HTMLTextAreaElement>) => boolean;
  onModelMenuOpenChange: (open: boolean) => void;
  onSelectModel: (model: ModelOption) => void;
  onConfigureModelOptions?: (model: ModelOption, thinkingLevel: RuntimeConfiguration["thinkingLevel"], contextWindow?: number) => Promise<void>;
  onFastChange?: (enabled: boolean) => Promise<void>;
  onOpenSettings: () => void;
  onAbort?: () => void;
  onEscape?: () => void;
  onPathDropError?: (message: string) => void;
}): React.JSX.Element {
  const inline = variant === "inline";
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const composingRef = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const onStart = (): void => {
      composingRef.current = true;
    };
    const onEnd = (): void => {
      composingRef.current = false;
      input.style.height = "auto";
      input.style.height = `${Math.max(42, Math.min(input.scrollHeight, 160))}px`;
    };
    input.addEventListener("compositionstart", onStart);
    input.addEventListener("compositionend", onEnd);
    return () => {
      input.removeEventListener("compositionstart", onStart);
      input.removeEventListener("compositionend", onEnd);
    };
  }, [inputRef]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input || composingRef.current) return;
    input.style.height = "auto";
    input.style.height = `${Math.max(42, Math.min(input.scrollHeight, 160))}px`;
  }, [draft, inputRef]);

  useEffect(() => {
    if (!autoFocus) return;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [autoFocus, inputRef]);

  const handlePathDragOver = (event: ReactDragEvent<HTMLElement>): void => {
    if (!event.dataTransfer.types.includes(SUOCODE_PATH_TYPE)) return;
    event.preventDefault();
    // Do not stopPropagation on enter/over — that made the pane think the drag left,
    // flashing the drop mask off while hovering an inline composer / user message.
    event.dataTransfer.dropEffect = "copy";
  };

  const handlePathDrop = (event: ReactDragEvent<HTMLElement>): void => {
    const serialized = event.dataTransfer.getData(SUOCODE_PATH_TYPE);
    if (!serialized) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      const dropped = JSON.parse(serialized) as { path?: string };
      if (!dropped.path) return;
      const textarea = inputRef.current;
      const value = draftRef.current;
      const start = textarea?.selectionStart ?? value.length;
      const end = textarea?.selectionEnd ?? start;
      const result = insertPathAtCaret(value, dropped.path, start, end);
      onDraftChange(result.value);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.setSelectionRange(result.caret, result.caret);
      });
    } catch {
      onPathDropError?.("无法插入拖入的路径。请重新拖动一次。");
    }
  };

  const handleKeyDown: React.KeyboardEventHandler<HTMLTextAreaElement> = (event) => {
    if (onSlashKeyDown?.(event)) return;
    if (event.key === "Escape" && onEscape) {
      event.preventDefault();
      onEscape();
      return;
    }
    onKeyDown(event);
  };

  return (
    <form
      className={`composer ${inline ? "composer-inline" : ""}`}
      data-composer-variant={variant}
      onSubmit={onSubmit}
      onDragEnter={handlePathDragOver}
      onDragOver={handlePathDragOver}
      onDrop={handlePathDrop}
    >
      {images.length ? (
        <div className="composer-images">
          {images.map((image) => (
            <figure key={image.id ?? image.data.slice(0, 24)}>
              <img src={imageDataUrl(image)} alt={image.name ?? "粘贴的图片"} />
              <button type="button" aria-label="移除图片" onClick={() => onImagesChange((current) => current.filter((item) => item !== image))}>
                <X size={11} />
              </button>
            </figure>
          ))}
        </div>
      ) : null}
      <textarea
        ref={inputRef}
        rows={1}
        value={draft}
        aria-label={inline ? "编辑历史消息" : "发送消息给 SuoCode"}
        placeholder={
          inline
            ? "编辑历史消息…"
            : project
              ? (running ? "补充指令…" : "让 SuoCode 处理这个项目…")
              : "请先打开项目"
        }
        disabled={!project || loading || startingSession || modelChanging}
        onChange={(event) => onDraftChange(event.target.value)}
        onPaste={onPaste}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        onKeyDown={handleKeyDown}
        onDragOver={handlePathDragOver}
        onDrop={handlePathDrop}
      />
      <div className="composer-toolbar">
        <ModelPicker
          configuration={configuration}
          currentModel={selectedModel}
          currentThinkingLevel={thinkingLevel}
          currentFast={fast}
          open={modelMenuOpen}
          busy={modelChanging}
          side={inline ? "bottom" : "top"}
          onOpenChange={onModelMenuOpenChange}
          onSelect={onSelectModel}
          onConfigureOptions={onConfigureModelOptions}
          onFastChange={onFastChange}
          onOpenSettings={onOpenSettings}
        />
        {!inline && running && onAbort ? (
          <button className="stop-button" type="button" aria-label="停止 Agent" onClick={onAbort}>
            <Square size={12} fill="currentColor" />
          </button>
        ) : null}
        <button
          className="send-button"
          type="submit"
          aria-label={inline ? "从这里重新开始" : running ? "补充指令" : "发送消息"}
          disabled={!project || startingSession || modelChanging || (!draft.trim() && !images.length)}
        >
          <ArrowUp size={17} strokeWidth={2.2} />
        </button>
      </div>
    </form>
  );
}
