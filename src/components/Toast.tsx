import { useToastStore } from "../stores";
import type { ToastItem } from "../stores";

function ToastIcon({ type }: { type: ToastItem["type"] }) {
  if (type === "error") return <span aria-hidden>✕</span>;
  if (type === "warning") return <span aria-hidden>⚠</span>;
  if (type === "success") return <span aria-hidden>✓</span>;
  return <span aria-hidden>ℹ</span>;
}

function colorClass(type: ToastItem["type"]): string {
  switch (type) {
    case "error":
      return "bg-red-600 text-white";
    case "warning":
      return "bg-yellow-500 text-white";
    case "success":
      return "bg-green-600 text-white";
    default:
      return "bg-blue-600 text-white";
  }
}

export function Toast() {
  const toasts = useToastStore((s) => s.toasts);
  const removeToast = useToastStore((s) => s.removeToast);

  if (toasts.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none"
      role="region"
      aria-label="通知"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`flex items-start gap-2 px-4 py-3 rounded-lg shadow-lg max-w-sm pointer-events-auto text-sm ${colorClass(t.type)}`}
          style={{ animation: "slideInRight 0.2s ease-out" }}
        >
          <ToastIcon type={t.type} />
          <div className="flex-1 flex flex-col gap-2 min-w-0">
            <span className="break-words">{t.message}</span>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  void t.action?.onClick();
                }}
                className="self-start underline underline-offset-2 font-medium opacity-95 hover:opacity-100"
              >
                {t.action.label}
              </button>
            )}
          </div>
          <button
            onClick={() => removeToast(t.id)}
            className="ml-2 opacity-70 hover:opacity-100 leading-none"
            aria-label="閉じる"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
