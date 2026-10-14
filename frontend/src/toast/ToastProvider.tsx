import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ToastContext } from "./context";

const VISIBLE_MS = 1800;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<{ text: string; key: number } | null>(null);
  const timer = useRef<number>(undefined);

  const show = useCallback((text: string) => {
    window.clearTimeout(timer.current);
    setMessage({ text, key: Date.now() });
    timer.current = window.setTimeout(() => {
      setMessage(null);
    }, VISIBLE_MS);
  }, []);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    [],
  );

  return (
    <ToastContext.Provider value={show}>
      {children}
      {/* The live region stays mounted so screen readers announce each new message. */}
      <div role="status" aria-live="polite">
        {message && (
          <div key={message.key} className="toast">
            {message.text}
          </div>
        )}
      </div>
    </ToastContext.Provider>
  );
}
