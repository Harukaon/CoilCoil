import { ImagePlus, X } from "lucide-react";
import { useRef } from "react";
import type { ClipboardEvent, DragEvent } from "react";
import type { PromptImage } from "@coilcoil/runtime-protocol";
import { clipboardImage, imageDataUrl } from "../composer/promptImages";

/**
 * 任务面板里贴的图。
 *
 * 用的是聊天输入框那一套（`promptImages`）：同一种数据结构，所以贴在任务上的图
 * 到了「开始」那一步能原样发给 agent，不用再转一道。
 */

/** 从粘贴板、拖进来的东西或者文件选择框里挑出图片。不是图片的一律不要。 */
export async function imagesFromFiles(list: Iterable<globalThis.File> | null | undefined): Promise<PromptImage[]> {
  const files = [...list ?? []].filter((file) => file.type.startsWith("image/"));
  return files.length ? Promise.all(files.map(clipboardImage)) : [];
}

/**
 * 一个既能粘贴又能拖放的区域要接的三个事件。
 *
 * 提任务的弹窗和留言框都要这一套，写两遍迟早有一边漏掉某个事件，所以做成一个
 * 挂件：`{...imageDropHandlers(add)}` 摊到元素上就行。
 */
export function imageDropHandlers(add: (images: PromptImage[]) => void, onError?: (message: string) => void): {
  onPaste(event: ClipboardEvent): void;
  onDragOver(event: DragEvent): void;
  onDrop(event: DragEvent): void;
} {
  const take = (files: Iterable<globalThis.File> | undefined, event: { preventDefault(): void }): void => {
    const images = [...files ?? []].filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    // 只有真的拿到图才拦截，否则会把「粘贴一段文字」也一起吃掉。
    event.preventDefault();
    void imagesFromFiles(images)
      .then(add)
      .catch((caught) => onError?.(caught instanceof Error ? caught.message : String(caught)));
  };
  return {
    onPaste: (event) => take(event.clipboardData?.files, event),
    onDragOver: (event) => { if (event.dataTransfer?.types.includes("Files")) event.preventDefault(); },
    onDrop: (event) => take(event.dataTransfer?.files, event),
  };
}

/** 只读地摆一排贴过的图。 */
export function IssueImageStrip({ images }: { images: PromptImage[] }): React.JSX.Element | null {
  if (!images.length) return null;
  return (
    <div className="issue-images">
      {images.map((image) => (
        <img key={image.id ?? image.data.slice(0, 24)} src={imageDataUrl(image)} alt={image.name ?? "任务附图"} />
      ))}
    </div>
  );
}

/** 编辑态的一排图：一张一个缩略图，右上角叉掉，最后跟一个「加图」。 */
export function IssueImagePicker({
  images,
  onChange,
  onError,
}: {
  images: PromptImage[];
  onChange(next: PromptImage[]): void;
  onError?(message: string): void;
}): React.JSX.Element {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="issue-image-picker">
      {images.map((image) => (
        <figure key={image.id ?? image.data.slice(0, 24)}>
          <img src={imageDataUrl(image)} alt={image.name ?? "贴的图"} />
          <button
            type="button"
            aria-label="移除这张图"
            onClick={() => onChange(images.filter((item) => item !== image))}
          >
            <X size={11} />
          </button>
        </figure>
      ))}
      <button className="issue-image-add" type="button" onClick={() => fileRef.current?.click()}>
        <ImagePlus size={15} />
        <span>加图</span>
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(event) => {
          const picked = event.target.files;
          // 选完就清空，不然连着选同一个文件第二次不会触发 change。
          event.target.value = "";
          void imagesFromFiles(picked)
            .then((next) => { if (next.length) onChange([...images, ...next]); })
            .catch((caught) => onError?.(caught instanceof Error ? caught.message : String(caught)));
        }}
      />
    </div>
  );
}
