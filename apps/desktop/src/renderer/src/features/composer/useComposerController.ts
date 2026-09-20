import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ClipboardEvent as ReactClipboardEvent,
  KeyboardEvent,
  RefObject,
} from "react";
import type {
  ModelOption,
  PromptBrowserElementPart,
  PromptDocument,
  PromptImage,
  RuntimeConfiguration,
} from "@coilcoil/runtime-protocol";
import type { BrowserElementSelection } from "../../../../shared/desktop-api";
import { quotePath } from "./pathInsert";
import { appendPromptImages, clipboardImage, MAX_PROMPT_IMAGE_DATA_CHARS, MAX_PROMPT_IMAGES } from "./promptImages";
import {
  browserElementPart,
  clonePromptDocument,
  emptyPromptDocument,
  insertPartAtOffset,
  promptDocumentFromText,
  promptDocumentHasContent,
  promptDocumentText,
  replaceTextRange,
} from "./promptDocument";
import type { PromptEditorHandle } from "./PromptEditor";

interface CachedComposerDraft {
  document: PromptDocument;
  images: PromptImage[];
}

export interface ComposerController {
  document: PromptDocument;
  draft: string;
  images: PromptImage[];
  inputRef: RefObject<PromptEditorHandle | null>;
  modelMenuOpen: boolean;
  modelChanging: boolean;
  setDocument: (document: PromptDocument) => void;
  setDraft: (value: string) => void;
  restoreDraft: (value: string) => void;
  restoreDocument: (document: PromptDocument) => void;
  setImages: React.Dispatch<React.SetStateAction<PromptImage[]>>;
  setModelMenuOpen: (open: boolean) => void;
  reset: () => void;
  focus: () => void;
  insertPaths: (paths: string[]) => void;
  replaceTextRange: (start: number, end: number, replacement: string) => void;
  insertBrowserElement: (selection: BrowserElementSelection) => void;
  handlePaste: (event: ReactClipboardEvent<HTMLDivElement>) => void;
  handleCompositionStart: () => void;
  handleCompositionEnd: () => void;
  handleKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  selectModel: (model: ModelOption) => Promise<void>;
  configureModelOptions: (model: ModelOption, thinkingLevel: RuntimeConfiguration["thinkingLevel"], contextWindow?: number) => Promise<void>;
  setFast: (enabled: boolean) => Promise<void>;
}

export function useComposerController({
  sessionKey,
  configuration,
  runtimeId,
  sessionThinkingLevel,
  onConfigurationChange,
  onEmptyEnter,
  onError,
}: {
  sessionKey: string;
  configuration?: RuntimeConfiguration;
  runtimeId?: string;
  sessionThinkingLevel?: RuntimeConfiguration["thinkingLevel"];
  onConfigurationChange: (configuration: RuntimeConfiguration) => void;
  onEmptyEnter?: () => boolean;
  onError: (message?: string) => void;
}): ComposerController {
  const [document, setDocumentState] = useState<PromptDocument>(emptyPromptDocument);
  const [images, setImages] = useState<PromptImage[]>([]);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [modelChanging, setModelChanging] = useState(false);
  const inputRef = useRef<PromptEditorHandle>(null);
  const composingRef = useRef(false);
  const documentRef = useRef(document);
  documentRef.current = document;
  const draft = promptDocumentText(document);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const imagesRef = useRef(images);
  imagesRef.current = images;
  const emptyEnterRef = useRef(onEmptyEnter);
  emptyEnterRef.current = onEmptyEnter;
  const cacheRef = useRef(new Map<string, CachedComposerDraft>());
  const activeSessionKeyRef = useRef(sessionKey);

  const cacheCurrent = useCallback((key: string): void => {
    cacheRef.current.set(key, {
      document: clonePromptDocument(documentRef.current),
      images: imagesRef.current.map((image) => ({ ...image })),
    });
  }, []);

  useEffect(() => {
    const previousKey = activeSessionKeyRef.current;
    if (previousKey === sessionKey) return;
    cacheCurrent(previousKey);
    activeSessionKeyRef.current = sessionKey;
    const cached = cacheRef.current.get(sessionKey);
    setDocumentState(clonePromptDocument(cached?.document ?? emptyPromptDocument()));
    setImages(cached?.images?.map((image) => ({ ...image })) ?? []);
  }, [cacheCurrent, sessionKey]);

  const setDocument = useCallback((next: PromptDocument): void => {
    setDocumentState(clonePromptDocument(next));
  }, []);

  const reset = useCallback((): void => {
    setDocumentState(emptyPromptDocument());
    cacheRef.current.delete(activeSessionKeyRef.current);
    setImages([]);
  }, []);

  const restoreDraft = useCallback((value: string): void => {
    if (!value.trim()) return;
    setDocumentState((current) => promptDocumentText(current).trim() ? current : promptDocumentFromText(value));
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const restoreDocument = useCallback((value: PromptDocument): void => {
    if (promptDocumentHasContent(documentRef.current)) return;
    setDocumentState(clonePromptDocument(value));
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const focus = useCallback((): void => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const replaceTextRangeInDocument = useCallback((start: number, end: number, replacement: string): void => {
    const next = replaceTextRange(documentRef.current, start, end, replacement);
    setDocumentState(next);
    requestAnimationFrame(() => inputRef.current?.setCaretOffset(start + replacement.length));
  }, []);

  const insertPaths = useCallback((paths: string[]): void => {
    if (!paths.length) return;
    const current = documentRef.current;
    const start = inputRef.current?.getCaretOffset() ?? promptDocumentText(current).length;
    const plain = promptDocumentText(current);
    const before = plain.slice(0, start);
    const after = plain.slice(start);
    const leadingSpace = before.length && !/\s$/.test(before) ? " " : "";
    const trailingSpace = after.length && !/^\s/.test(after) ? " " : "";
    const insertion = `${leadingSpace}${paths.map(quotePath).join(" ")}${trailingSpace}`;
    replaceTextRangeInDocument(start, start, insertion);
  }, [replaceTextRangeInDocument]);

  const insertBrowserElement = useCallback((selection: BrowserElementSelection): void => {
    const imageMatch = selection.screenshot?.match(/^data:([^;,]+);base64,([\s\S]+)$/);
    const image = imageMatch ? {
      id: globalThis.crypto?.randomUUID?.() ?? `browser-element-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: `网页元素 · ${selection.selector}`,
      mimeType: imageMatch[1],
      data: imageMatch[2],
    } : undefined;
    if (image && image.data.length > MAX_PROMPT_IMAGE_DATA_CHARS) {
      onError("网页截图太大，单张图片不能超过约 7.5 MB。");
      return;
    }
    if (image && imagesRef.current.length >= MAX_PROMPT_IMAGES) {
      onError(`最多只能附加 ${MAX_PROMPT_IMAGES} 张图片。`);
      return;
    }
    const current = documentRef.current;
    const ordinal = current.parts.filter((part): part is PromptBrowserElementPart => part.type === "browser-element").length + 1;
    const part = browserElementPart(selection, image?.id, ordinal);
    const offset = inputRef.current?.getCaretOffset() ?? promptDocumentText(current).length;
    setDocumentState(insertPartAtOffset(current, part, offset));
    if (image) {
      setImages((existing) => {
        try {
          return appendPromptImages(existing, [image]);
        } catch (caught) {
          onError(caught instanceof Error ? caught.message : String(caught));
          return existing;
        }
      });
    }
    requestAnimationFrame(() => inputRef.current?.setCaretOffset(offset + part.label.length));
  }, [onError]);

  const handlePaste = useCallback((event: ReactClipboardEvent<HTMLDivElement>): void => {
    const files = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;
    event.preventDefault();
    void Promise.all(files.map(clipboardImage))
      .then((nextImages) => setImages((current) => {
        try {
          return appendPromptImages(current, nextImages);
        } catch (caught) {
          onError(caught instanceof Error ? caught.message : String(caught));
          return current;
        }
      }))
      .catch((caught) => onError(caught instanceof Error ? caught.message : String(caught)));
  }, [onError]);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>): void => {
    if (composingRef.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!draftRef.current.trim() && !imagesRef.current.length && emptyEnterRef.current?.()) return;
      event.currentTarget.closest("form")?.requestSubmit();
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
    document,
    draft,
    images,
    inputRef,
    modelMenuOpen,
    modelChanging,
    setDocument,
    setDraft: (value: string) => setDocumentState(promptDocumentFromText(value)),
    restoreDraft,
    restoreDocument,
    setImages,
    setModelMenuOpen,
    reset,
    focus,
    insertPaths,
    replaceTextRange: replaceTextRangeInDocument,
    insertBrowserElement,
    handlePaste,
    handleCompositionStart: () => { composingRef.current = true; },
    handleCompositionEnd: () => { composingRef.current = false; },
    handleKeyDown,
    selectModel,
    configureModelOptions,
    setFast,
  };
}
