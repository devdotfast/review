import {
  CreateReviewCommentInputSchema,
  type HostDocumentState,
  HostIdSchema,
  type HostReviewState,
  type HostReviewVersionHeader,
  type HostReviewVersionSummary,
  HostSourceRangeSchema,
  type JsonValue,
  type ReviewAgentTraceEvent,
  type ReviewAgentTraceSession,
  type ReviewCanvasBridge,
  type ReviewCanvasContent,
  type ReviewClient,
  type ReviewDisposable,
  type ReviewSurfaceEvent,
  isJsonObject,
  parseJsonText,
} from "@dev.fast/review-protocol";
import { z } from "zod";

import { buildCodeTarget } from "../target-fingerprint";
import type { createHostCommentStore } from "./host-comment-store";
import { resolveHostSoftwareMapData } from "./host-map-analysis";
import { reviewApiEndpoint, reviewFetchUrl } from "./review-client";
import { type ReviewSession, createReviewSession } from "./review-session";

export type HostCanvasContent = Extract<ReviewCanvasContent, { kind: "host" }>;
export interface HostReviewViewState {
  document: HostDocumentState;
  review: HostReviewState;
  snapshot: HostReviewVersionHeader;
  history: HostReviewVersionSummary[];
  selectedReviewVersion: number | null;
}
export interface HostReviewSession extends ReviewSession {
  dispose(): void;
}

/** Refresh the old views' read effects without replacing their transport. */
export function refreshHostReviewSession(
  core: HostReviewSession,
): ReviewSession {
  return { ...core, fetch: (...args) => core.fetch(...args) };
}
const submissionInput = z.strictObject({
  submissionId: HostIdSchema,
  decision: z.enum(["approve", "request-changes"]),
  comments: CreateReviewCommentInputSchema.array(),
});
const peekInput = z.object({
  root: z.strictObject({
    kind: z.literal("range"),
    file: HostSourceRangeSchema.shape.file,
    fromLine: HostSourceRangeSchema.shape.fromLine,
    toLine: HostSourceRangeSchema.shape.toLine,
  }),
  graph: z.enum(["base", "head"]).optional(),
});

/** View-model adapter for the existing UI. Every data operation uses the host API. */
export function createHostReviewSession(input: {
  client: ReviewClient;
  content: HostCanvasContent;
  comments: ReturnType<typeof createHostCommentStore>;
  getState(): HostReviewViewState;
  openRevision(reviewVersion: number | null): void;
  appSessionId?: string;
}): HostReviewSession {
  const { client, content, comments, getState } = input;
  const reviewId = getState().review.id;
  const listeners = new Set<(event: ReviewSurfaceEvent) => void>();
  const emit = (event: ReviewSurfaceEvent) => {
    for (const listener of listeners) listener(event);
  };
  let sourceSubscription: ReviewDisposable | undefined;
  let sourceGeneration = 0;
  const pendingSourceEvents: ReviewSurfaceEvent[] = [];
  let disposed = false;
  const deliverSource = (event: ReviewSurfaceEvent) => {
    if (listeners.size === 0) pendingSourceEvents.push(event);
    else emit(event);
  };
  const subscribeSource = () => {
    const generation = ++sourceGeneration;
    sourceSubscription = content.source?.onDidRequestComment?.((target) => {
      if (disposed || target.reviewId !== reviewId) return;
      void Promise.all([
        client.query("source.read", {
          reviewId,
          reviewVersion: target.reviewVersion,
          side: target.range.side,
          file: target.range.file,
          range: {
            fromLine: target.range.fromLine,
            toLine: target.range.toLine,
          },
          comparisonCommit: target.comparisonCommit,
        }),
        client.query("document.get", {
          reviewId,
          reviewVersion: target.reviewVersion,
        }),
      ])
        .then(([quote, document]) => {
          if (generation !== sourceGeneration || disposed) return;
          const pinnedTarget = buildCodeTarget({
            path: target.range.file,
            side: target.range.side,
            baseCommit:
              target.range.side === "base"
                ? quote.result.commit
                : document.result.binding.baseCommit,
            headCommit:
              target.comparisonCommit ?? document.result.binding.headCommit,
            span: {
              startLine: target.range.fromLine,
              endLine: target.range.toLine,
            },
          });
          deliverSource({
            event: "commentRequested",
            path: target.range.file,
            range: {
              fromLine: target.range.fromLine,
              toLine: target.range.toLine,
            },
            sideContext: target.range.side,
            target: {
              ...pinnedTarget,
              documentVersion: target.reviewVersion,
              commit: target.comparisonCommit,
            },
          });
        })
        .catch((error) => {
          if (generation === sourceGeneration)
            console.error("Could not open the pinned source comment", error);
        });
    });
  };
  const origin = content.connection.serverUrl;
  const unavailable = (message: string) => {
    throw new Error(message);
  };
  const sourceTarget = (
    file: string,
    side: "base" | "head",
    fromLine = 1,
    toLine = fromLine,
  ) => ({
    reviewId,
    reviewVersion: getState().document.reviewVersion,
    range: { file, side, fromLine, toLine },
  });
  const traceSession = (id: string): ReviewAgentTraceSession => ({
    sessionId: id,
    harness: "unknown",
    available: true,
    source: null,
    commits: [],
  });
  const request = async (
    rawUrl: string,
    init: RequestInit = {},
  ): Promise<Response> => {
    const url = new URL(rawUrl, origin);
    if (url.origin !== new URL(origin).origin)
      return Response.json(
        { ok: false, error: "Cross-host review requests are not allowed." },
        { status: 403 },
      );
    const endpoint = reviewApiEndpoint(url.pathname);
    const state = getState();
    const signal = init.signal ?? undefined;
    let body: JsonValue;
    try {
      body = parseJsonText(
        init.body ? await new Response(init.body).text() : "{}",
      );
    } catch {
      return Response.json(
        { ok: false, error: "Invalid JSON request." },
        { status: 400 },
      );
    }
    switch (endpoint) {
      case "/session":
        return Response.json({
          ok: true,
          session: {
            resolvedBaseRef: state.document.binding.baseCommit,
            headRef: state.document.binding.headCommit,
            historicalRevision:
              state.selectedReviewVersion === null
                ? null
                : String(state.selectedReviewVersion),
            reviewStatus:
              state.review.state === "closed" ? "closed" : "awaiting-review",
          },
        });
      case "/document-meta": {
        const selector = state.document.binding.selector;
        const metadata = {
          ok: true,
          updatedAtMs: Date.parse(state.document.createdAt),
          pullRequestNumber:
            selector.kind === "pull_request"
              ? Number(new URL(selector.url).pathname.split("/").at(-1))
              : undefined,
          pullRequestUrl:
            selector.kind === "pull_request" ? selector.url : undefined,
        };
        return Response.json(metadata);
      }
      case "/revisions":
        return Response.json({
          ok: true,
          versions: state.history.map((version) => ({
            revision: String(version.reviewVersion),
            sealedAt: Date.parse(version.createdAt),
            isCurrent: version.reviewVersion === state.document.reviewVersion,
          })),
        });
      case "/submissions": {
        if (init.method !== "POST") return new Response(null, { status: 405 });
        const parsed = submissionInput.safeParse(body);
        if (!parsed.success)
          return Response.json(
            { ok: false, error: "Invalid review submission." },
            { status: 400 },
          );
        await comments.submit(
          parsed.data.decision === "approve" ? "approve" : "request_changes",
          parsed.data.submissionId,
          parsed.data.comments,
        );
        return Response.json({ ok: true });
      }
      case "/dismiss":
        if (init.method !== "POST") return new Response(null, { status: 405 });
        await client.command("review.trash", {
          reviewId,
          expectedStateVersion: state.review.stateVersion,
        });
        content.showHome();
        return Response.json({ ok: true });
      case "/agent-traces": {
        const ids = new Set(
          Object.values(state.document.nodes).flatMap((node) =>
            node.type === "trace_quote" ? [node.traceId] : [],
          ),
        );
        return Response.json({
          ok: true,
          configured: true,
          sessions: [...ids].map(traceSession),
        });
      }
      case "/code-peek/resolve": {
        const parsed = peekInput.safeParse(body);
        if (!parsed.success)
          return Response.json(
            {
              ok: false,
              error: "Pinned code peeks require an exact source range.",
            },
            { status: 400 },
          );
        const target = sourceTarget(
          parsed.data.root.file,
          parsed.data.graph === "base" ? "base" : "head",
          parsed.data.root.fromLine,
          parsed.data.root.toLine,
        );
        const { result } = await client.query(
          "source.read",
          {
            reviewId,
            reviewVersion: target.reviewVersion,
            side: target.range.side,
            file: target.range.file,
            range: {
              fromLine: target.range.fromLine,
              toLine: target.range.toLine,
            },
          },
          signal,
        );
        const id = `${result.commit}:${result.file}:${target.range.fromLine}-${target.range.toLine}`;
        return Response.json({
          ok: true,
          snapshot: {
            roots: [{ kind: "source", sourceId: id }],
            resolved: {
              [id]: {
                source: {
                  id,
                  name: result.file,
                  kind: "source-range",
                  file: result.file,
                  line: target.range.fromLine,
                  endLine: target.range.toLine,
                },
                lines: result.text
                  .split("\n")
                  .map((line) => [{ t: line, k: "t" }]),
              },
            },
          },
        });
      }
      case "/software-map/resolved-data": {
        return Response.json(
          await resolveHostSoftwareMapData(client, state, body, signal),
        );
      }
      case "/telemetry/bug-report": {
        const headers = new Headers(init.headers);
        headers.set("content-type", "application/json");
        return reviewFetchUrl(
          content.connection,
          new URL(
            `/v1/workspaces/${client.connection.workspaceId}/reviews/${reviewId}/bug-report`,
            origin,
          ),
          {
            ...init,
            headers,
            body: JSON.stringify({
              reviewVersion: state.document.reviewVersion,
              report: body,
            }),
          },
        );
      }
      case "/telemetry/event": {
        return reviewFetchUrl(
          content.connection,
          new URL(endpoint, origin),
          init,
        );
      }
    }
    if (endpoint.startsWith("/agent-traces/")) {
      const traceId = decodeURIComponent(
        endpoint.slice("/agent-traces/".length),
      );
      const { result } = await client.query(
        "trace.get",
        { reviewId, traceId },
        signal,
      );
      const events: ReviewAgentTraceEvent[] = result.events.map((event) => {
        if (event.kind === "user")
          return { kind: "user", text: event.text, at: event.at ?? undefined };
        if (event.kind === "assistant")
          return {
            kind: "assistant",
            markdown: event.text,
            at: event.at ?? undefined,
          };
        if (event.kind === "system")
          return { kind: "separator", label: event.text || "System" };
        return {
          kind: "tool",
          tool: event.toolName ?? "tool",
          verb: event.kind === "tool_call" ? "call" : "result",
          title: event.toolName ?? "Tool",
          ...(event.kind === "tool_call"
            ? { input: event.text }
            : { output: event.text }),
          at: event.at ?? undefined,
        };
      });
      return Response.json({
        ok: true,
        parserVersion: "host-json-1",
        session: traceSession(traceId),
        trace: traceId,
        subagents: [],
        title: result.trace.label,
        startedAt: result.events[0]?.at ?? null,
        endedAt: result.events.at(-1)?.at ?? null,
        activeMs: null,
        userTurns: result.events.filter((event) => event.kind === "user")
          .length,
        toolCalls: result.events.filter((event) => event.kind === "tool_call")
          .length,
        events,
      });
    }
    return Response.json(
      { ok: false, error: `This review does not provide ${endpoint}.` },
      { status: 404 },
    );
  };
  const bridge: ReviewCanvasBridge = {
    appSessionId: input.appSessionId,
    config: {
      serverUrl: origin,
      sessionUrl: origin,
      routePath: `/reviews/${reviewId}`,
      sessionId: `host:${reviewId}:${getState().document.binding.id}`,
      token: content.connection.token,
      wasmUrl: content.wasmUrl ?? "",
      docRuntimeUrl: content.runtime?.docRuntimeUrl ?? "",
      appVersion: content.runtime?.appVersion ?? "development",
      theme: content.runtime?.theme ?? "dark",
      host: "desktop",
    },
    comments,
    inlineEditors: content.source?.inlineEditors ?? {
      create: () => unavailable("Native source editor is unavailable."),
      find: async () => unavailable("Native source search is unavailable."),
    },
    diffView: content.source?.diffView ?? {
      create: () => unavailable("Native diff view is unavailable."),
      files: async () => unavailable("Native diff view is unavailable."),
    },
    request,
    async post(command) {
      try {
        switch (command.name) {
          case "resumeAgentTerminal": {
            if (!content.openQuestion)
              throw new Error(
                "This question's terminal is not available. Start a new Ask to continue.",
              );
            const threadId = comments.hostThreadId(command.args.threadId);
            if (!threadId)
              throw new Error("The saved question thread is unavailable.");
            let cursor: string | undefined;
            let latest: { id: string; createdAt: string } | undefined;
            do {
              const { result } = await client.query("questions.list", {
                reviewId,
                threadId,
                cursor,
                limit: 200,
              });
              for (const run of result.items)
                if (
                  run.sessionId &&
                  (!latest || run.createdAt >= latest.createdAt)
                )
                  latest = run;
              cursor = result.nextCursor ?? undefined;
            } while (cursor);
            if (!latest)
              throw new Error(
                "This question has no saved local terminal. Start a new Ask to continue.",
              );
            await content.openQuestion(latest.id);
            return { ok: true };
          }
          case "showThreads":
            return { ok: true };
          case "showReviewView":
            emit({ event: "showReviewView", view: command.args.view });
            return { ok: true };
          case "openReviewRevision":
            input.openRevision(
              command.args.revision === undefined ||
                command.args.revision === null
                ? null
                : z.coerce
                    .number()
                    .int()
                    .nonnegative()
                    .parse(command.args.revision),
            );
            return { ok: true };
          case "openReview":
            content.openReview(command.args.reviewUuid);
            return { ok: true };
          case "openSourceTree":
            if (!content.source?.openTree)
              throw new Error("Native source tree is unavailable.");
            await content.source.openTree();
            return { ok: true };
          case "reveal":
            if (!content.source)
              throw new Error("Native source editor is unavailable.");
            await content.source.open(
              sourceTarget(
                command.args.path,
                command.args.side ?? "head",
                command.args.startLine,
                command.args.endLine,
              ),
            );
            return { ok: true };
          case "openFile":
            if (!content.source)
              throw new Error("Native source editor is unavailable.");
            await content.source.open(
              sourceTarget(
                command.args.path,
                "head",
                command.args.line ?? 1,
                command.args.endLine ?? command.args.line ?? 1,
              ),
            );
            return { ok: true };
          case "openDiff":
            emit({ event: "showReviewView", view: "diff" });
            return { ok: true };
        }
        return content.post
          ? await content.post(command)
          : { ok: false, error: "Desktop action is unavailable." };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    subscribe(listener) {
      if (disposed) return { dispose() {} };
      listeners.add(listener);
      if (!sourceSubscription) subscribeSource();
      // React can replace all old view listeners during a metadata refresh.
      // Wait for their replacement set before delivering a queued selection.
      if (pendingSourceEvents.length)
        queueMicrotask(() => {
          if (disposed || listeners.size === 0) return;
          for (const event of pendingSourceEvents.splice(0)) emit(event);
        });
      return {
        dispose() {
          listeners.delete(listener);
        },
      };
    },
    currentTheme: () => content.runtime?.theme ?? "dark",
    onDidChangeTheme: (listener) =>
      content.onDidChangeTheme?.(listener) ?? { dispose() {} },
    ready: () => content.ready?.(),
  };
  const session = createReviewSession(bridge);
  return {
    ...session,
    reviewVersion: () => getState().document.reviewVersion,
    supportReport: "snapshot",
    dispose() {
      disposed = true;
      ++sourceGeneration;
      sourceSubscription?.dispose();
      sourceSubscription = undefined;
      listeners.clear();
      pendingSourceEvents.length = 0;
    },
    importModule: async () =>
      unavailable("JSON reviews do not execute authored modules."),
  };
}
