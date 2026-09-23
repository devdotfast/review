import crypto from "node:crypto";

import {
  type JsonValue,
  type WhiteboardVerbRequest,
  type WhiteboardVerbResponse,
  parseWhiteboardDesktopVerbResult,
  parseWhiteboardVerbRequest,
} from "@dev.fast/whiteboard-protocol";

const DEFAULT_VERB_TIMEOUT_MS = 45_000;

interface PendingVerb {
  resolve(response: WhiteboardVerbResponse): void;
  timer: ReturnType<typeof setTimeout>;
}

export interface GlobalWhiteboardDesktopVerbWriter {
  readonly signal: AbortSignal;
  write(frame: string): void | Promise<void>;
  close(): void | Promise<void>;
}

/** The server's view of the desktop relay, so tests can supply their own. */
export interface WhiteboardDesktopVerbRelay {
  readonly attached: boolean;
  attach(writer: GlobalWhiteboardDesktopVerbWriter): boolean;
  dispatch(value: JsonValue): Promise<WhiteboardVerbResponse>;
  acceptResult(value: JsonValue): boolean;
  close(): void;
}

export class GlobalWhiteboardDesktopVerbRelay implements WhiteboardDesktopVerbRelay {
  private controlWriter: GlobalWhiteboardDesktopVerbWriter | null = null;
  private controlAbortListener: (() => void) | null = null;
  private readonly pending = new Map<string, PendingVerb>();

  constructor(private readonly timeoutMs = DEFAULT_VERB_TIMEOUT_MS) {}

  get attached(): boolean {
    return this.controlWriter !== null;
  }

  attach(writer: GlobalWhiteboardDesktopVerbWriter): boolean {
    if (this.controlWriter || writer.signal.aborted) return false;
    this.controlWriter = writer;
    const detach = () => this.detach(writer, "No Review Desktop is attached.");
    this.controlAbortListener = detach;
    writer.signal.addEventListener("abort", detach, { once: true });

    return true;
  }

  dispatch(value: JsonValue): Promise<WhiteboardVerbResponse> {
    const request: WhiteboardVerbRequest = parseWhiteboardVerbRequest(value);
    const control = this.controlWriter;

    if (!control) {
      return Promise.resolve({
        ok: false,
        error: "No Review Desktop is attached.",
      });
    }

    const id = crypto.randomUUID();

    return new Promise<WhiteboardVerbResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: "Review Desktop verb timed out." });
      }, this.timeoutMs);

      timer.unref?.();
      this.pending.set(id, { resolve, timer });
      const frame = `data: ${JSON.stringify({ event: "desktop-verb", id, request })}\n\n`;

      try {
        void Promise.resolve(control.write(frame)).catch(() => {
          this.detach(control, "No Review Desktop is attached.");
        });
      } catch {
        this.detach(control, "No Review Desktop is attached.");
      }
    });
  }

  acceptResult(value: JsonValue): boolean {
    const result = parseWhiteboardDesktopVerbResult(value);
    const pending = this.pending.get(result.id);

    if (!pending) return false;
    this.pending.delete(result.id);
    clearTimeout(pending.timer);
    pending.resolve(result.response);

    return true;
  }

  close(): void {
    const control = this.controlWriter;

    if (!control) {
      this.rejectPending("Review Desktop relay closed.");

      return;
    }

    this.detach(control, "Review Desktop relay closed.");
    void Promise.resolve(control.close()).catch(() => undefined);
  }

  private detach(
    writer: GlobalWhiteboardDesktopVerbWriter,
    error: string,
  ): void {
    if (this.controlWriter !== writer) return;

    if (this.controlAbortListener) {
      writer.signal.removeEventListener("abort", this.controlAbortListener);
    }

    this.controlAbortListener = null;
    this.controlWriter = null;
    this.rejectPending(error);
  }

  private rejectPending(error: string): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({ ok: false, error });
      this.pending.delete(id);
    }
  }
}
