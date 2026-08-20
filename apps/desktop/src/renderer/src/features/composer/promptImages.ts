import type { PromptImage } from "@coilcoil/runtime-protocol";

export function imageDataUrl(image: PromptImage): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

export async function clipboardImage(file: globalThis.File): Promise<PromptImage> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("无法读取粘贴的图片。"));
    reader.readAsDataURL(file);
  });
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`,
    name: file.name || "粘贴的图片",
    mimeType: file.type || "image/png",
    data: dataUrl.slice(dataUrl.indexOf(",") + 1),
  };
}
