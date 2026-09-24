const OPEN_TIMEOUT_MS = 30_000;

export interface ReviewOpenContext {
  reviewUuid: string;
  presentationSessionId: string;
}

/**
 * "Opened but never presented" as an explicit event: one timer per
 * presentation from its session start, cleared when the canvas reports it
 * presented or the session ends. Keyed by presentation because a resume starts
 * a new session for the same review.
 */
export class ReviewOpenWatchdog {
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly options: {
      onTimeout: (context: ReviewOpenContext, elapsedMs: number) => void;
    },
  ) {}

  started(context: ReviewOpenContext): void {
    const id = context.presentationSessionId;
    this.presented(id);
    const startedAt = Date.now();

    const timer = setTimeout(() => {
      this.pending.delete(id);
      this.options.onTimeout(context, Date.now() - startedAt);
    }, OPEN_TIMEOUT_MS);

    timer.unref?.();
    this.pending.set(id, timer);
  }

  presented(presentationSessionId: string): void {
    clearTimeout(this.pending.get(presentationSessionId));
    this.pending.delete(presentationSessionId);
  }

  dispose(): void {
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
  }
}
