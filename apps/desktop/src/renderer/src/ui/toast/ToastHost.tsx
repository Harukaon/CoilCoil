import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { useSyncExternalStore } from "react";
import { dismissToast, getToasts, subscribeToasts } from "./toastStore";
import "./toast.css";

export function ToastHost(): React.JSX.Element | null {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts, () => []);
  if (!toasts.length) return null;
  return (
    <div className="toast-host" aria-live="polite" aria-relevant="additions text">
      {toasts.map((toast) => (
        <div className={`toast-item toast-${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"} key={toast.id}>
          <span className="toast-icon" aria-hidden="true">
            {toast.kind === "success" ? <CheckCircle2 size={15} strokeWidth={2} /> : toast.kind === "info" ? <Info size={15} strokeWidth={2} /> : <AlertCircle size={15} strokeWidth={2} />}
          </span>
          <span className="toast-message">{toast.message}</span>
          <button className="toast-dismiss" type="button" aria-label="关闭通知" onClick={() => dismissToast(toast.id)}>
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      ))}
    </div>
  );
}
