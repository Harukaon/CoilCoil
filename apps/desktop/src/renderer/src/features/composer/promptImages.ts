import type { PromptImage } from "@coilcoil/runtime-protocol";

/** Keep a prompt bounded before it reaches the runtime and provider. */
export const MAX_PROMPT_IMAGES = 8;
/** Base64 data is roughly 4/3 the original binary size. */
export const MAX_PROMPT_IMAGE_DATA_CHARS = 10_000_000;

export function imageDataUrl(image: PromptImage): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

export function appendPromptImages(current: readonly PromptImage[], next: readonly PromptImage[]): PromptImage[] {
  if (current.length + next.length > MAX_PROMPT_IMAGES) {
    throw new Error(`最多只能附加 ${MAX_PROMPT_IMAGES} 张图片。`);
  }
  return [...current, ...next];
}

export async function clipboardImage(file: globalThis.File): Promise<PromptImage> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("无法读取粘贴的图片。"));
    reader.readAsDataURL(file);
  });
  const data = dataUrl.slice(dataUrl.indexOf(",") + 1);
  if (data.length > MAX_PROMPT_IMAGE_DATA_CHARS) {
    throw new Error("图片太大，单张图片不能超过约 7.5 MB。请压缩后再添加。");
  }
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    name: file.name || "粘贴的图片",
    mimeType: file.type || "image/png",
    data,
  };
}
