export type ToastKind = "success" | "error";

export interface ToastItem {
  id: string;
  kind: ToastKind;
  message: string;
  createdAt: number;
}

type Listener = () => void;

const DEFAULT_DURATION_MS: Record<ToastKind, number> = {
  success: 3500,
  error: 5200,
};

let toasts: ToastItem[] = [];
const listeners = new Set<Listener>();
const dismissTimers = new Map<string, number>();

function emit(): void {
  for (const listener of listeners) listener();
}

function scheduleDismiss(id: string, durationMs: number): void {
  const existing = dismissTimers.get(id);
  if (existing) window.clearTimeout(existing);
  const timer = window.setTimeout(() => dismissToast(id), durationMs);
  dismissTimers.set(id, timer);
}

export function getToasts(): ToastItem[] {
  return toasts;
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function dismissToast(id: string): void {
  const timer = dismissTimers.get(id);
  if (timer) {
    window.clearTimeout(timer);
    dismissTimers.delete(id);
  }
  const next = toasts.filter((item) => item.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

export function showToast(
  kind: ToastKind,
  message: string,
  options?: { durationMs?: number },
): string {
  const text = message.trim();
  if (!text) return "";
  const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  toasts = [...toasts, { id, kind, message: text, createdAt: Date.now() }].slice(-5);
  emit();
  scheduleDismiss(id, options?.durationMs ?? DEFAULT_DURATION_MS[kind]);
  return id;
}

export function toastSuccess(message: string, options?: { durationMs?: number }): string {
  return showToast("success", message, options);
}

export function toastError(message: string, options?: { durationMs?: number }): string {
  return showToast("error", message, options);
}
