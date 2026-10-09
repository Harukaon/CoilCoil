import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import "./dialog.css";

export function Modal({
  open,
  title,
  description,
  children,
  footer,
  size = "md",
  bare = false,
  labelledBy,
  describedBy,
  onClose,
}: {
  open: boolean;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg";
  /** Render children as the panel itself (for complex dialogs with custom chrome). */
  bare?: boolean;
  labelledBy?: string;
  describedBy?: string;
  onClose: () => void;
}): React.JSX.Element | null {
  const autoTitleId = useId();
  const autoDescriptionId = useId();
  const titleId = labelledBy ?? (title ? autoTitleId : undefined);
  const descriptionId = describedBy ?? (description ? autoDescriptionId : undefined);
  const panelRef = useRef<HTMLDivElement>(null);
  // Kept apart from the effect below. Parents hand over a new onClose on every render, and an
  // effect that depended on it would run again each time: give the focus back to what is behind
  // the dialog, then take it to the dialog's first control - in the middle of someone typing.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    requestAnimationFrame(() => {
      const root = panelRef.current ?? document.body;
      const focusable = root.querySelector<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])");
      focusable?.focus();
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      previous?.focus();
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      className="coil-modal-backdrop"
      role="presentation"
      ref={panelRef}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {bare ? (
        children
      ) : (
        <section
          className={`coil-modal coil-modal-${size}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
        >
          {title ? <h2 className="coil-modal-title" id={titleId}>{title}</h2> : null}
          {description ? <p className="coil-modal-description" id={descriptionId}>{description}</p> : null}
          {children}
          {footer ? <footer className="coil-modal-footer">{footer}</footer> : null}
        </section>
      )}
    </div>,
    document.body,
  );
}
