import { X } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import type { PromptImage } from "@coilcoil/runtime-protocol";
import { imageDataUrl } from "./promptImages";

/** 缩略图统一入口：输入框里的图点一下就看大图，Esc 或点遮罩返回。 */
export function PromptImagePreview({
  image,
  alt,
  className,
}: {
  image: PromptImage;
  alt: string;
  className?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      previous?.focus();
    };
  }, [open]);

  const openPreview = (event: ReactMouseEvent<HTMLSpanElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    setOpen(true);
  };

  const onTriggerKeyDown = (event: ReactKeyboardEvent<HTMLSpanElement>): void => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    setOpen(true);
  };

  const close = (): void => setOpen(false);
  const imageUrl = imageDataUrl(image);

  return (
    <>
      <span
        className={`prompt-image-trigger${className ? ` ${className}` : ""}`}
        role="button"
        tabIndex={0}
        aria-label={`放大查看${alt}`}
        title="点击放大预览"
        onClick={openPreview}
        onKeyDown={onTriggerKeyDown}
      >
        <img src={imageUrl} alt={alt} draggable={false} />
      </span>
      {open ? createPortal(
        <div
          className="prompt-image-lightbox-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <div
            className="prompt-image-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label="图片预览"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button ref={closeButtonRef} className="prompt-image-lightbox-close" type="button" aria-label="关闭图片预览" onClick={close}>
              <X size={18} strokeWidth={1.8} />
            </button>
            <img src={imageUrl} alt={alt} draggable={false} />
            {image.name ? <span className="prompt-image-lightbox-name">{image.name}</span> : null}
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}
