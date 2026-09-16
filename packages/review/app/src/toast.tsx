import { useEffect, useState } from "react";

type ToastMessage = { kind: "success" | "error"; text: string };

/** Share the existing feedback UI and timer; render inside the canvas CSS scope. */
export function useToast(durationMs = 6_000) {
  const [message, showToast] = useState<ToastMessage | null>(null);

  useEffect(() => {
    if (!message) return;
    const timeout = window.setTimeout(() => showToast(null), durationMs);

    return () => window.clearTimeout(timeout);
  }, [message, durationMs]);

  return {
    showToast,
    toast: message ? <Toast message={message} /> : null,
  };
}

function Toast({ message }: { message: ToastMessage }) {
  return (
    <div className={`review-toast review-toast--${message.kind}`} role="status">
      {message.text}
    </div>
  );
}
