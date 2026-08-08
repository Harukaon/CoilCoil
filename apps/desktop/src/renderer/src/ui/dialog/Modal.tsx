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
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
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
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div
      className="suo-modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {bare ? (
        children
      ) : (
        <section
          ref={panelRef}
          className={`suo-modal suo-modal-${size}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
        >
          {title ? <h2 className="suo-modal-title" id={titleId}>{title}</h2> : null}
          {description ? <p className="suo-modal-description" id={descriptionId}>{description}</p> : null}
          {children}
          {footer ? <footer className="suo-modal-footer">{footer}</footer> : null}
        </section>
      )}
    </div>,
    document.body,
  );
}
