import { create } from "zustand";

export interface ToastAction {
  label: string;
  onClick: () => void | Promise<void>;
}

export interface ToastItem {
  id: string;
  type: "error" | "warning" | "info" | "success";
  message: string;
  action?: ToastAction;
  /** Auto-dismiss delay in ms. `0` keeps the toast until dismissed. Default: 5000. */
  durationMs?: number;
}

interface ToastState {
  toasts: ToastItem[];
  addToast: (toast: Omit<ToastItem, "id">) => string;
  removeToast: (id: string) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  addToast: (toast) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
    const duration = toast.durationMs ?? 5000;
    if (duration > 0) {
      setTimeout(() => {
        set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
      }, duration);
    }
    return id;
  },
  removeToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

export function showError(message: string): void {
  useToastStore.getState().addToast({ type: "error", message });
}

export function showWarning(message: string): void {
  useToastStore.getState().addToast({ type: "warning", message });
}

export function showInfo(message: string, options?: Omit<ToastItem, "id" | "type" | "message">): void {
  useToastStore.getState().addToast({ type: "info", message, ...options });
}
