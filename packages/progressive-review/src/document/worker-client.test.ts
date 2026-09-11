import { EventEmitter } from "node:events";

import { type BirpcReturn, type ChannelOptions, createBirpc } from "birpc";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { ReviewPublishEvidenceTargets } from "../review-publication-audit";
import {
  runDocumentWorker,
  runDocumentWorkerWithTransport,
} from "./worker-client";
import type {
  DocumentWorkerApi,
  DocumentWorkerCallbacks,
  DocumentWorkerInput,
  DocumentWorkerResult,
} from "./worker-protocol";

// Exercise the client's real RPC and deadline lifecycle with a transport whose
// remote build can remain busy while fake time advances. Authored execution is
// covered separately by the real-worker document builder tests.
class TestWorker extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  completion = Promise.withResolvers<DocumentWorkerResult>();
  messages = new EventEmitter();
  remote: BirpcReturn<DocumentWorkerCallbacks, DocumentWorkerApi>;
  postMessage = vi.fn<ChannelOptions["post"]>((message) => {
    this.messages.emit("message", message);
  });
  terminate = vi.fn<() => Promise<number>>(async () => 0);

  constructor() {
    super();
    this.remote = createBirpc<DocumentWorkerCallbacks, DocumentWorkerApi>(
      { build: () => this.completion.promise },
      {
        post: (message) => {
          this.emit("message", message);
        },
        on: (listener) => {
          this.messages.on("message", listener);
        },
        off: (listener) => {
          this.messages.off("message", listener);
        },
        timeout: -1,
      },
    );
  }
}

const input: DocumentWorkerInput = {
  reviewPath: "/review/review.mdx",
  routePath: "/",
  ranges: "validate",
  hasEvidence: true,
  hasChangedLines: true,
  runtimeBindings: [],
  typeOnlyExports: {},
  syntax: {
    title: "Deadline",
    modules: [],
    expressions: [],
    bindings: [],
    body: [],
  },
};

const result: DocumentWorkerResult = {
  result: {
    document: null,
    peekCount: 0,
    rangePeeks: [],
    errors: [],
    warnings: [],
  },
  diagnostics: [],
};

const evidence: ReviewPublishEvidenceTargets = {
  head: { sourceRootPath: "/review/head" },
};

let worker: TestWorker;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  worker = new TestWorker();
});

afterEach(() => {
  worker.remote.$close();
  worker.completion.resolve(result);
  vi.useRealTimers();
});

it("allows cold evidence preparation beyond 30 seconds without resetting the execution budget", async () => {
  const pending = Promise.withResolvers<ReviewPublishEvidenceTargets>();

  const prepareEvidence = vi.fn<() => Promise<ReviewPublishEvidenceTargets>>(
    () => pending.promise,
  );

  const built = runDocumentWorkerWithTransport(worker, { prepareEvidence });
  void built.catch(() => undefined);
  expect(prepareEvidence).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(8_000);
  const requested = worker.remote.prepareEvidence();
  await vi.advanceTimersByTimeAsync(90_000);
  expect(prepareEvidence).toHaveBeenCalledOnce();
  expect(worker.terminate).not.toHaveBeenCalled();

  pending.resolve(evidence);
  await expect(requested).resolves.toEqual(evidence);
  await vi.advanceTimersByTimeAsync(21_999);
  expect(worker.terminate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(built).rejects.toThrow("Document build exceeded 30 seconds");
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(worker.listenerCount("message")).toBe(0);
});

it("waits for all overlapping parent callbacks before resuming the remaining deadline", async () => {
  const prepare = Promise.withResolvers<ReviewPublishEvidenceTargets>();
  const changed = Promise.withResolvers<null>();

  const built = runDocumentWorkerWithTransport(worker, {
    prepareEvidence: () => prepare.promise,
    resolveChangedLines: () => changed.promise,
  });

  void built.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(12_000);
  const preparation = worker.remote.prepareEvidence();
  await vi.advanceTimersByTimeAsync(20_000);
  const resolution = worker.remote.resolveChangedLines("source.ts", "head");
  await vi.advanceTimersByTimeAsync(20_000);
  prepare.resolve(evidence);
  await preparation;
  await vi.advanceTimersByTimeAsync(90_000);
  expect(worker.terminate).not.toHaveBeenCalled();

  changed.resolve(null);
  await resolution;
  await vi.advanceTimersByTimeAsync(17_999);
  expect(worker.terminate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(built).rejects.toThrow("Document build exceeded 30 seconds");
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it("resumes the execution budget after a callback rejection", async () => {
  const pending = Promise.withResolvers<ReviewPublishEvidenceTargets>();

  const built = runDocumentWorkerWithTransport(worker, {
    prepareEvidence: () => pending.promise,
  });

  void built.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(10_000);
  const requested = worker.remote.prepareEvidence();
  void requested.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(60_000);
  pending.reject(new Error("evidence unavailable", { cause: () => undefined }));
  await expect(requested).rejects.toThrow("evidence unavailable");
  await vi.advanceTimersByTimeAsync(19_999);
  expect(worker.terminate).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(built).rejects.toThrow("Document build exceeded 30 seconds");
});

it("cancels during a parent wait and suppresses its late response and deadline", async () => {
  const controller = new AbortController();
  const pending = Promise.withResolvers<ReviewPublishEvidenceTargets>();

  const built = runDocumentWorkerWithTransport(
    worker,
    { prepareEvidence: () => pending.promise },
    controller.signal,
  );

  void built.catch(() => undefined);
  const requested = worker.remote.prepareEvidence();
  void requested.catch(() => undefined);
  await vi.advanceTimersByTimeAsync(60_000);
  controller.abort(new Error("cancelled by test"));
  await expect(built).rejects.toThrow("cancelled by test");
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(worker.listenerCount("message")).toBe(0);
  const posted = worker.postMessage.mock.calls.length;

  pending.resolve(evidence);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(worker.postMessage).toHaveBeenCalledTimes(posted);
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects an already-aborted signal before starting the build", async () => {
  const controller = new AbortController();
  controller.abort(new Error("already cancelled"));
  await expect(runDocumentWorker(input, {}, controller.signal)).rejects.toThrow(
    "already cancelled",
  );
  expect(vi.getTimerCount()).toBe(0);
});

it("handles cancellation during worker construction before registering its listener", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled while starting"));
  await expect(
    runDocumentWorkerWithTransport(worker, {}, controller.signal),
  ).rejects.toThrow("cancelled while starting");
  expect(worker.postMessage).not.toHaveBeenCalled();
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("terminates a successful worker and clears its execution deadline", async () => {
  const built = runDocumentWorkerWithTransport(worker, {});
  worker.completion.resolve(result);
  await expect(built).resolves.toEqual(result);
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(worker.listenerCount("message")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
