import { randomUUID } from "node:crypto";
import { readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { writeFileAtomic } from "./atomic-write";
import { EMBEDDED_PROGRESSIVE_REVIEW_POSTHOG_KEY } from "./embedded-posthog-key";
import { DEV_REVIEW_HOME_ENV, devReviewHome } from "./review-storage";
import { withFileLock } from "./with-file-lock";

export type PostHogCaptureProperties = Record<
  string,
  boolean | number | string | null | undefined
>;

export interface PostHogCaptureInput {
  event: string;
  distinctId: string;
  properties?: PostHogCaptureProperties;
}

export interface PostHogCaptureClientOptions {
  apiKey?: string;
  host?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  timeoutSignal?: (timeoutMs: number) => AbortSignal;
  queueDir?: string;
  now?: () => number;
  idFactory?: () => string;
}

export const PROGRESSIVE_REVIEW_POSTHOG_KEY_ENV =
  "PROGRESSIVE_REVIEW_POSTHOG_KEY";
export const PROGRESSIVE_REVIEW_POSTHOG_HOST_ENV =
  "PROGRESSIVE_REVIEW_POSTHOG_HOST";

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";
const DEFAULT_CAPTURE_TIMEOUT_MS = 1_000;
const QUEUE_LIMIT = 1_000;
const BATCH_LIMIT = 50;
const QUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const FLUSH_DELAY_MS = 5_000;
const MAX_BACKOFF_MS = 60 * 60 * 1_000;
const DROPPED_FILE = "dropped.json";

type DropReason =
  | "queue_full"
  | "expired"
  | "corrupt"
  | "permanent_rejection"
  | "storage_failure";

interface QueuedPostHogEvent extends PostHogCaptureInput {
  createdAt: number;
  attempts: number;
  nextAttemptAt: number;
}

type SendResult = "success" | "transient" | "permanent";
type FlushBatchResult =
  | { state: "done"; nextRetryAt?: number }
  | { state: "more" }
  | { state: "retry"; nextRetryAt: number };

export class PostHogCaptureClient {
  private readonly apiKey: string | undefined;
  private readonly batchUrl: string;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly timeoutMs: number;
  private readonly timeoutSignal: (timeoutMs: number) => AbortSignal;
  private readonly queueDir: string | undefined;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly memoryDrops: Partial<Record<DropReason, number>> = {};
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private queuedSinceFlush = 0;

  constructor(options: PostHogCaptureClientOptions = {}) {
    this.apiKey = options.apiKey?.trim() || undefined;
    this.batchUrl = `${normalizeHost(options.host)}/batch/`;
    this.fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
    this.timeoutSignal =
      options.timeoutSignal ?? ((timeoutMs) => AbortSignal.timeout(timeoutMs));
    this.queueDir = options.queueDir;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;
  }

  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
    options: Omit<
      PostHogCaptureClientOptions,
      "apiKey" | "host" | "queueDir"
    > = {},
  ): PostHogCaptureClient {
    const reviewHome = env[DEV_REVIEW_HOME_ENV] ?? devReviewHome();
    return new PostHogCaptureClient({
      ...options,
      apiKey:
        nonEmpty(env[PROGRESSIVE_REVIEW_POSTHOG_KEY_ENV]) ??
        nonEmpty(env.DEV_FAST_POSTHOG_KEY) ??
        nonEmpty(env.POSTHOG_KEY) ??
        EMBEDDED_PROGRESSIVE_REVIEW_POSTHOG_KEY,
      host:
        nonEmpty(env[PROGRESSIVE_REVIEW_POSTHOG_HOST_ENV]) ??
        nonEmpty(env.DEV_FAST_POSTHOG_HOST) ??
        nonEmpty(env.POSTHOG_HOST),
      queueDir: path.join(reviewHome, "telemetry", "events"),
    });
  }

  get enabled(): boolean {
    return Boolean(this.apiKey && this.fetchImpl);
  }

  async capture(input: PostHogCaptureInput): Promise<void> {
    if (!this.enabled) return;
    const queued: QueuedPostHogEvent = {
      event: input.event,
      distinctId: input.distinctId,
      properties: compactProperties(input.properties ?? {}),
      createdAt: this.now(),
      attempts: 0,
      nextAttemptAt: 0,
    };
    if (!this.queueDir) {
      await this.sendBatch([queued]);
      return;
    }
    try {
      writeFileAtomic(
        path.join(
          this.queueDir,
          `${queued.createdAt}-${this.idFactory()}.json`,
        ),
        `${JSON.stringify(queued)}\n`,
        "utf8",
      );
      this.queuedSinceFlush += 1;
      this.scheduleFlush(
        this.queuedSinceFlush >= BATCH_LIMIT ? 0 : FLUSH_DELAY_MS,
      );
    } catch {
      this.incrementMemoryDrop("storage_failure");
      throw new Error("Could not store a telemetry event");
    }
  }

  async discard(): Promise<void> {
    this.clearFlushTimer();
    if (!this.queueDir) return;
    await withFileLock(
      path.join(this.queueDir, ".flush.lock"),
      {
        retryMs: 10,
        staleMs: 30_000,
        timeoutMs: 1_000,
        unownedGraceMs: 1_000,
        heartbeatMs: 5_000,
      },
      async () => {
        const files = await readdir(this.queueDir!).catch(() => []);
        await Promise.all(
          files
            .filter((file) => file.endsWith(".json"))
            .map((file) =>
              rm(path.join(this.queueDir!, file), { force: true }),
            ),
        );
        this.queuedSinceFlush = 0;
        for (const reason of Object.keys(this.memoryDrops) as DropReason[]) {
          delete this.memoryDrops[reason];
        }
      },
    );
  }

  async flush(deadlineMs = DEFAULT_CAPTURE_TIMEOUT_MS): Promise<void> {
    if (!this.enabled || !this.queueDir) return;
    this.clearFlushTimer();
    const startedAt = this.now();
    const lock = await withFileLock(
      path.join(this.queueDir, ".flush.lock"),
      {
        retryMs: 10,
        staleMs: 30_000,
        timeoutMs: Math.min(100, Math.max(0, deadlineMs)),
        unownedGraceMs: 1_000,
        heartbeatMs: 5_000,
      },
      async () => {
        let result: FlushBatchResult;
        do {
          result = await this.flushBatchLocked(deadlineMs, startedAt);
        } while (
          result.state === "more" &&
          this.now() - startedAt < deadlineMs
        );
        if (result.state === "more") this.scheduleFlush(0);
        if ("nextRetryAt" in result && result.nextRetryAt !== undefined) {
          this.scheduleFlush(Math.max(0, result.nextRetryAt - this.now()));
        }
      },
    ).catch(() => ({ acquired: false as const }));
    if (!lock.acquired) this.scheduleFlush(FLUSH_DELAY_MS);
  }

  async shutdown(deadlineMs = DEFAULT_CAPTURE_TIMEOUT_MS): Promise<void> {
    this.clearFlushTimer();
    await this.flush(deadlineMs);
  }

  private async flushBatchLocked(
    deadlineMs: number,
    startedAt: number,
  ): Promise<FlushBatchResult> {
    const queueDir = this.queueDir!;
    const now = this.now();
    const fileNames = (await readdir(queueDir).catch(() => []))
      .filter((name) => name.endsWith(".json") && name !== DROPPED_FILE)
      .sort();
    const drops = mergeDropCounts(
      await this.readDroppedCounts(),
      this.memoryDrops,
    );
    for (const reason of Object.keys(this.memoryDrops) as DropReason[]) {
      delete this.memoryDrops[reason];
    }

    const overflow = Math.max(0, fileNames.length - QUEUE_LIMIT);
    const retainedNames = fileNames.slice(overflow);
    for (const fileName of fileNames.slice(0, overflow)) {
      await rm(path.join(queueDir, fileName), { force: true });
    }
    addDrop(drops, "queue_full", overflow);

    const eligible: Array<{ fileName: string; event: QueuedPostHogEvent }> = [];
    let hasMoreEligible = false;
    let nextRetryAt: number | undefined;
    for (const fileName of retainedNames) {
      const filePath = path.join(queueDir, fileName);
      const event = await readQueuedEvent(filePath);
      if (!event) {
        await rm(filePath, { force: true });
        addDrop(drops, "corrupt", 1);
        continue;
      }
      if (now - event.createdAt > QUEUE_MAX_AGE_MS) {
        await rm(filePath, { force: true });
        addDrop(drops, "expired", 1);
        continue;
      }
      if (event.nextAttemptAt <= now) {
        if (eligible.length < BATCH_LIMIT) {
          eligible.push({ fileName, event });
        } else {
          hasMoreEligible = true;
        }
      } else {
        nextRetryAt = Math.min(nextRetryAt ?? Infinity, event.nextAttemptAt);
      }
    }

    await this.writeDroppedCounts(drops);
    if (eligible.length === 0) {
      this.queuedSinceFlush = 0;
      return { state: "done", ...(nextRetryAt ? { nextRetryAt } : {}) };
    }

    const diagnosticEvents = droppedEvents(
      drops,
      eligible[0]!.event.distinctId,
    );
    const sentEligible = eligible.slice(
      0,
      Math.max(0, BATCH_LIMIT - diagnosticEvents.length),
    );
    hasMoreEligible ||= sentEligible.length < eligible.length;
    const batch = [
      ...diagnosticEvents,
      ...sentEligible.map(({ event }) => event),
    ];
    const remainingMs = Math.max(1, deadlineMs - (this.now() - startedAt));
    const result = await this.sendBatch(batch, remainingMs);
    if (result === "success") {
      await Promise.all(
        sentEligible.map(({ fileName }) =>
          rm(path.join(queueDir, fileName), { force: true }),
        ),
      );
      if (diagnosticEvents.length > 0) {
        await rm(path.join(queueDir, DROPPED_FILE), { force: true });
      }
      this.queuedSinceFlush = 0;
      return hasMoreEligible
        ? { state: "more" }
        : { state: "done", ...(nextRetryAt ? { nextRetryAt } : {}) };
    }
    if (result === "permanent") {
      await Promise.all(
        sentEligible.map(({ fileName }) =>
          rm(path.join(queueDir, fileName), { force: true }),
        ),
      );
      addDrop(drops, "permanent_rejection", sentEligible.length);
      await this.writeDroppedCounts(drops);
      this.queuedSinceFlush = 0;
      return hasMoreEligible
        ? { state: "more" }
        : { state: "done", ...(nextRetryAt ? { nextRetryAt } : {}) };
    }

    let retryAt = Infinity;
    for (const { fileName, event } of sentEligible) {
      const attempts = event.attempts + 1;
      const eventRetryAt = now + retryDelay(attempts);
      retryAt = Math.min(retryAt, eventRetryAt);
      writeFileAtomic(
        path.join(queueDir, fileName),
        `${JSON.stringify({
          ...event,
          attempts,
          nextAttemptAt: eventRetryAt,
        })}\n`,
        "utf8",
      );
    }
    return { state: "retry", nextRetryAt: retryAt };
  }

  private async sendBatch(
    events: readonly QueuedPostHogEvent[],
    timeoutMs = this.timeoutMs,
  ): Promise<SendResult> {
    if (!this.apiKey || !this.fetchImpl || events.length === 0) {
      return "success";
    }
    try {
      const response = await this.fetchImpl(this.batchUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          api_key: this.apiKey,
          batch: events.map((event) => ({
            event: event.event,
            properties: {
              ...compactProperties(event.properties ?? {}),
              distinct_id: event.distinctId,
            },
            timestamp: new Date(event.createdAt).toISOString(),
          })),
        }),
        signal: this.timeoutSignal(Math.min(this.timeoutMs, timeoutMs)),
      });
      if (response.ok) return "success";
      if (
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500
      ) {
        return "transient";
      }
      return "permanent";
    } catch {
      return "transient";
    }
  }

  private scheduleFlush(delayMs: number): void {
    if (!this.queueDir || this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush();
    }, delayMs);
    this.flushTimer.unref?.();
  }

  private clearFlushTimer(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
  }

  private incrementMemoryDrop(reason: DropReason): void {
    this.memoryDrops[reason] = (this.memoryDrops[reason] ?? 0) + 1;
  }

  private async readDroppedCounts(): Promise<
    Partial<Record<DropReason, number>>
  > {
    if (!this.queueDir) return {};
    return readFile(path.join(this.queueDir, DROPPED_FILE), "utf8")
      .then((value) => JSON.parse(value) as Partial<Record<DropReason, number>>)
      .catch(() => ({}));
  }

  private async writeDroppedCounts(
    drops: Partial<Record<DropReason, number>>,
  ): Promise<void> {
    if (!this.queueDir) return;
    const compact = Object.fromEntries(
      Object.entries(drops).filter(([, count]) => Number(count) > 0),
    );
    if (Object.keys(compact).length === 0) return;
    writeFileAtomic(
      path.join(this.queueDir, DROPPED_FILE),
      `${JSON.stringify(compact)}\n`,
      "utf8",
    );
  }
}

function droppedEvents(
  drops: Partial<Record<DropReason, number>>,
  distinctId: string,
): QueuedPostHogEvent[] {
  return (Object.entries(drops) as Array<[DropReason, number]>)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => ({
      event: "review_telemetry_dropped",
      distinctId,
      properties: { reason, count },
      createdAt: Date.now(),
      attempts: 0,
      nextAttemptAt: 0,
    }));
}

async function readQueuedEvent(
  filePath: string,
): Promise<QueuedPostHogEvent | undefined> {
  try {
    const parsed = JSON.parse(
      await readFile(filePath, "utf8"),
    ) as QueuedPostHogEvent;
    if (
      typeof parsed.event !== "string" ||
      typeof parsed.distinctId !== "string" ||
      typeof parsed.createdAt !== "number" ||
      typeof parsed.attempts !== "number" ||
      typeof parsed.nextAttemptAt !== "number"
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function mergeDropCounts(
  left: Partial<Record<DropReason, number>>,
  right: Partial<Record<DropReason, number>>,
): Partial<Record<DropReason, number>> {
  const merged = { ...left };
  for (const [reason, count] of Object.entries(right) as Array<
    [DropReason, number]
  >) {
    addDrop(merged, reason, count);
  }
  return merged;
}

function addDrop(
  drops: Partial<Record<DropReason, number>>,
  reason: DropReason,
  count: number,
): void {
  if (count > 0) drops[reason] = (drops[reason] ?? 0) + count;
}

function retryDelay(attempts: number): number {
  const base = Math.min(
    MAX_BACKOFF_MS,
    1_000 * 2 ** Math.min(attempts - 1, 12),
  );
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

function normalizeHost(host: string | undefined): string {
  return (host?.trim() || DEFAULT_POSTHOG_HOST).replace(/\/+$/, "");
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function compactProperties(
  properties: PostHogCaptureProperties,
): Record<string, boolean | number | string | null> {
  return Object.fromEntries(
    Object.entries(properties).filter(
      (entry): entry is [string, boolean | number | string | null] =>
        entry[1] !== undefined,
    ),
  );
}
