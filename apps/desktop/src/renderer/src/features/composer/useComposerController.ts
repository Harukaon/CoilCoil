import { useCallback, useRef, useState } from "react";
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
} from "@coilcoil/runtime-protocol";
import { insertPathsAtCaret } from "./pathInsert";
import { clipboardImage } from "./promptImages";

export interface ComposerController {
  draft: string;
  images: PromptImage[];
  inputRef: RefObject<HTMLTextAreaElement | null>;
  modelMenuOpen: boolean;
  modelChanging: boolean;
  setDraft: (value: string) => void;
  restoreDraft: (value: string) => void;
  setImages: React.Dispatch<React.SetStateAction<PromptImage[]>>;
  setModelMenuOpen: (open: boolean) => void;
  reset: () => void;
  focus: () => void;
  insertPaths: (paths: string[]) => void;
  handlePaste: (event: ReactClipboardEvent<HTMLTextAreaElement>) => void;
  handleCompositionStart: () => void;
  handleCompositionEnd: () => void;
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  selectModel: (model: ModelOption) => Promise<void>;
  configureModelOptions: (model: ModelOption, thinkingLevel: RuntimeConfiguration["thinkingLevel"], contextWindow?: number) => Promise<void>;
  setFast: (enabled: boolean) => Promise<void>;
}

export function useComposerController({
  configuration,
  runtimeId,
  sessionThinkingLevel,
  onConfigurationChange,
  onEmptyEnter,
  onError,
}: {
  configuration?: RuntimeConfiguration;
  runtimeId?: string;
  sessionThinkingLevel?: RuntimeConfiguration["thinkingLevel"];
  onConfigurationChange: (configuration: RuntimeConfiguration) => void;
  /**
   * Enter on an empty composer. Returning true consumes the key, which is how
   * a second Enter promotes the message the first one queued.
   */
  onEmptyEnter?: () => boolean;
  onError: (message?: string) => void;
}): ComposerController {
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<PromptImage[]>([]);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelChanging, setModelChanging] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const emptyEnterRef = useRef(onEmptyEnter);
  emptyEnterRef.current = onEmptyEnter;

  const reset = useCallback((): void => {
    setDraft("");
    setImages([]);
  }, []);

  /**
   * Put a message the runtime handed back into the composer.
   *
   * Stopping a run gives back the steered message Pi had not delivered yet. It
   * belongs where the user can edit and resend it, but never on top of
   * something they have already started typing since.
   */
  const restoreDraft = useCallback((value: string): void => {
    if (!value.trim()) return;
    setDraft((current) => (current.trim() ? current : value));
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const focus = useCallback((): void => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const insertPaths = useCallback((paths: string[]): void => {
    if (!paths.length) return;
    const input = inputRef.current;
    const start = input?.selectionStart ?? draft.length;
    const end = input?.selectionEnd ?? start;
    const result = insertPathsAtCaret(draft, paths, start, end);
    setDraft(result.value);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(result.caret, result.caret);
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
      if (!draftRef.current.trim() && !imagesRef.current.length && emptyEnterRef.current?.()) return;
      event.currentTarget.form?.requestSubmit();
    }
  }, []);

  const selectModel = useCallback(async (model: ModelOption): Promise<void> => {
    if (!configuration || modelChanging) return;
    setModelChanging(true);
    onError(undefined);
    setModelMenuOpen(false);
    try {
      const next = await window.coilcoil.request<RuntimeConfiguration>({
        type: runtimeId ? "set_session_model" : "configure_model",
        provider: model.provider,
        modelId: model.id,
        thinkingLevel: runtimeId ? (sessionThinkingLevel ?? configuration.thinkingLevel) : configuration.thinkingLevel,
      }, runtimeId);
      onConfigurationChange(next);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setModelChanging(false);
    }
  }, [configuration, modelChanging, onConfigurationChange, onError, runtimeId, sessionThinkingLevel]);

  const configureModelOptions = useCallback(async (
    model: ModelOption,
    thinkingLevel: RuntimeConfiguration["thinkingLevel"],
    contextWindow?: number,
  ): Promise<void> => {
    if (!configuration || modelChanging) return;
    setModelChanging(true);
    onError(undefined);
    try {
      const next = await window.coilcoil.request<RuntimeConfiguration>({
        type: runtimeId ? "set_session_model" : "configure_model",
        provider: model.provider,
        modelId: model.id,
        thinkingLevel,
        contextWindow,
      }, runtimeId);
      onConfigurationChange(next);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setModelChanging(false);
    }
  }, [configuration, modelChanging, onConfigurationChange, onError, runtimeId]);

  const setFast = useCallback(async (enabled: boolean): Promise<void> => {
    if (!runtimeId || modelChanging) return;
    setModelChanging(true);
    onError(undefined);
    try {
      await window.coilcoil.request({ type: "set_session_fast", enabled }, runtimeId);
    } catch (caught) {
      onError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setModelChanging(false);
    }
  }, [modelChanging, onError, runtimeId]);

  return {
    draft,
    images,
    inputRef,
    modelMenuOpen,
    modelChanging,
    setDraft,
    restoreDraft,
    setImages,
    setModelMenuOpen,
    reset,
    focus,
    insertPaths,
    handlePaste,
    handleCompositionStart: () => { composingRef.current = true; },
    handleCompositionEnd: () => { composingRef.current = false; },
    handleKeyDown,
    selectModel,
    configureModelOptions,
    setFast,
  };
}
