import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ClipboardEvent as ReactClipboardEvent,
  KeyboardEvent,
  RefObject,
} from "react";
import type {
  ModelOption,
  PromptImage,
  RuntimeConfiguration,
  SessionSnapshot,
} from "@suocode/runtime-protocol";
import { clipboardImage } from "../conversation/ConversationTimeline";

function quotePath(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export interface ComposerController {
  draft: string;
  images: PromptImage[];
  inputRef: RefObject<HTMLTextAreaElement | null>;
  modelMenuOpen: boolean;
  modelChanging: boolean;
  setDraft: (value: string) => void;
  setImages: React.Dispatch<React.SetStateAction<PromptImage[]>>;
  setModelMenuOpen: (open: boolean) => void;
  reset: () => void;
  focus: () => void;
  insertPath: (path: string) => void;
  handlePaste: (event: ReactClipboardEvent<HTMLTextAreaElement>) => void;
  handleCompositionStart: () => void;
  handleCompositionEnd: () => void;
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  selectModel: (model: ModelOption) => Promise<void>;
}

export function useComposerController({
  configuration,
  runtimeId,
  onConfigurationChange,
  onError,
}: {
  configuration?: RuntimeConfiguration;
  runtimeId?: string;
  onConfigurationChange: (configuration: RuntimeConfiguration) => void;
  onError: (message?: string) => void;
}): ComposerController {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<PromptImage[]>([]);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelChanging, setModelChanging] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.max(42, Math.min(input.scrollHeight, 160))}px`;
  }, [draft]);

  const reset = useCallback((): void => {
    setDraft("");
    setImages([]);
  }, []);

  const focus = useCallback((): void => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const insertPath = useCallback((path: string): void => {
    const input = inputRef.current;
    const start = input?.selectionStart ?? draft.length;
    const end = input?.selectionEnd ?? start;
    const before = draft.slice(0, start);
    const after = draft.slice(end);
    const leadingSpace = before.length && !/\s$/.test(before) ? " " : "";
    const trailingSpace = after.length && !/^\s/.test(after) ? " " : "";
    const insertion = `${leadingSpace}${quotePath(path)}${trailingSpace}`;
    const caret = start + insertion.length;
    setDraft(`${before}${insertion}${after}`);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(caret, caret);
    });
  }, [draft]);

  const handlePaste = useCallback((event: ReactClipboardEvent<HTMLTextAreaElement>): void => {
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    void Promise.all(files.map(clipboardImage))
      .then((nextImages) => setImages((current) => [...current, ...nextImages]))
      .catch((caught) => onError(caught instanceof Error ? caught.message : String(caught)));
  }, [onError]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }, []);

  const selectModel = useCallback(async (model: ModelOption): Promise<void> => {
    if (!configuration || modelChanging) return;
    setModelChanging(true);
    onError(undefined);
    try {
      const next = await window.suocode.request<RuntimeConfiguration>({
        type: "configure_model",
        provider: model.provider,
        modelId: model.id,
        thinkingLevel: configuration.thinkingLevel,
      }, runtimeId);
      onConfigurationChange(next);
      setModelMenuOpen(false);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setModelChanging(false);
    }
  }, [configuration, modelChanging, onConfigurationChange, onError, runtimeId]);

  return {
    draft,
    images,
    inputRef,
    modelMenuOpen,
    modelChanging,
    setDraft,
    setImages,
    setModelMenuOpen,
    reset,
    focus,
    insertPath,
    handlePaste,
    handleCompositionStart: () => { composingRef.current = true; },
    handleCompositionEnd: () => { composingRef.current = false; },
    handleKeyDown,
    selectModel,
  };
}
