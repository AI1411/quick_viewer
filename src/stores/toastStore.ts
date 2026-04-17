import { create } from "zustand";

export interface ToastItem {
  id: string;
  type: "error" | "warning" | "info" | "success";
  message: string;
}

interface ToastState {
  toasts: ToastItem[];
  addToast: (toast: Omit<ToastItem, "id">) => void;
  removeToast: (id: string) => void;
}

export const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  addToast: (toast) => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    set((state) => ({ toasts: [...state.toasts, { ...toast, id }] }));
    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
    }, 5000);
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

export function showInfo(message: string): void {
  useToastStore.getState().addToast({ type: "info", message });
}
