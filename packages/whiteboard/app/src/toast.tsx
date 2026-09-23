import { useCallback, useEffect, useState } from "react";

import { useOptionalWhiteboardSession } from "./host/whiteboard-session";

type ToastMessage = { kind: "success" | "error"; text: string };

export function useToast(durationMs = 6_000) {
  const session = useOptionalWhiteboardSession();
  const [message, setMessage] = useState<ToastMessage | null>(null);

  const showToast = useCallback(
    (message: ToastMessage) => {
      if (session?.bridge.notify) session.bridge.notify(message);
      else setMessage(message);
    },
    [session],
  );

  useEffect(() => {
    if (!message) return;
    const timeout = window.setTimeout(() => setMessage(null), durationMs);

    return () => window.clearTimeout(timeout);
  }, [message, durationMs]);

  return {
    showToast,
    toast: message ? <Toast message={message} /> : null,
  };
}

function Toast({ message }: { message: ToastMessage }) {
  return (
    <div
      className={`whiteboard-toast whiteboard-toast--${message.kind}`}
      role="status"
    >
      {message.text}
    </div>
  );
}
