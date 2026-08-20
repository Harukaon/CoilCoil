import { Modal } from "./Modal";

export interface ConfirmAction {
  label: string;
  onClick: () => void;
  variant?: "default" | "primary" | "danger";
  autoFocus?: boolean;
}

export function ConfirmDialog({
  open,
  title,
  description,
  actions,
  onClose,
}: {
  open: boolean;
  title: string;
  description: string;
  actions: ConfirmAction[];
  onClose: () => void;
}): React.JSX.Element {
  return (
    <Modal
      open={open}
      size="sm"
      title={title}
      description={description}
      onClose={onClose}
      footer={actions.map((action) => (
        <button
          key={action.label}
          className={
            action.variant === "primary"
              ? "coil-modal-button primary"
              : action.variant === "danger"
                ? "coil-modal-button danger"
                : "coil-modal-button"
          }
          type="button"
          autoFocus={action.autoFocus}
          onClick={action.onClick}
        >
          {action.label}
        </button>
      ))}
    />
  );
}
