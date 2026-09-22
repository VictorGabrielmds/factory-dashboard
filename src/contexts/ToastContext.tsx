// src/contexts/ToastContext.tsx
import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import "./Toast.css";

// ------------------------------------
// Types
// ------------------------------------

type ToastType = "success" | "error" | "info" | "warning";

interface Toast {
  id: string;
  message: string;
  type: ToastType;
}

interface ToastContextValue {
  addToast: (message: string, type?: ToastType, duration?: number) => void;
}

// ------------------------------------
// Context
// ------------------------------------

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast deve ser usado dentro de <ToastProvider>");
  return ctx;
}

// ------------------------------------
// Provider
// ------------------------------------

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback(
    (message: string, type: ToastType = "info", duration = 4000) => {
      // ✅ CORRIGIDO: Gerador de ID nativo, seguro e à prova de colisões
      const id = crypto.randomUUID(); 
      setToasts((prev) => [...prev, { id, message, type }]);
      setTimeout(() => removeToast(id), duration);
    },
    [removeToast]
  );

  const icons: Record<ToastType, string> = {
    success: "✓",
    error:   "✕",
    warning: "⚠",
    info:    "ℹ",
  };

  return (
    <ToastContext.Provider value={{ addToast }}>
      {children}
      {/* aria-live="polite" faz o navegador anunciar a mensagem automaticamente */}
      <div className="toast-container" aria-live="polite" aria-atomic="true">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.type}`} role="alert">
            <span className="toast-icon" aria-hidden="true">{icons[toast.type]}</span>
            <span className="toast-message">{toast.message}</span>
            <button 
              className="toast-close" 
              onClick={() => removeToast(toast.id)}
              aria-label="Fechar notificação"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}