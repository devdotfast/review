import type {
  ReviewCommentAgentActivity,
  ReviewCommentThreadRecord,
  ReviewDocumentVersionWire,
  ReviewLocalCommentThread,
} from "@dev.fast/review-protocol";
import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { AnchorRef } from "../../src/authoring";
import type { SourceLineComment } from "../../src/source-code-types";
import type { CreateReviewCommentInput, ThreadTarget } from "../../src/types";
import { useComments } from "./comments-context";
import { useReviewSession } from "./host/review-session";
import {
  buildAnchorTextTarget,
  buildCodeTarget,
  projectCodeTarget,
  resolvedCodeSurface,
} from "./target-fingerprint";
import {
  type ReviewSessionCommits,
  anchorTargetRecords,
  buildThreadTargetIndex,
  exactTargetRecords,
  targetAppearsInAnchor,
} from "./thread-target-index";
import { useResolvedBaseRef, useResolvedHeadRef } from "./thread-target-model";
import { useCompleteTutorialStep } from "./tutorial-context";
import { captureUiEvent, reviewAppTelemetryHeaders } from "./ui-telemetry";

export type LocalCommentThread = ReviewLocalCommentThread;
export interface CommentThreadView extends ReviewCommentThreadRecord {
  clientStatus: "persisted" | ReviewLocalCommentThread["clientStatus"];
  agentActivity?: ReviewCommentAgentActivity;
}

export type ReviewSubmissionOutcome =
  | "approved"
  | "changes-requested"
  | "dismissed";

export interface CommentDraftPlacement {
  x: number;
  y: number;
  side?: "below" | "right";
}

export type CommentDraftSurface = "document" | "panel";

export interface AstLineCommentRange {
  fromLine: number;
  toLine: number;
  side?: "additions" | "deletions";
}

export interface ResolvedCommentCodeSource {
  text: string;
  file: string;
  fromLine: number;
}

export type { ReviewSessionCommits } from "./thread-target-index";

export interface CommentDraftTarget extends CreateReviewCommentInput {
  draftSurface: CommentDraftSurface;
  title?: string;
  placement?: CommentDraftPlacement;
  intent?: "comment" | "ask-agent";
  panelRange?: AstLineCommentRange & { side?: "additions" | "deletions" };
  resolveTarget?: () => Promise<ThreadTarget>;
}

export type OpenCommentDraftTarget = Omit<
  CommentDraftTarget,
  "draftSurface" | "messageId" | "threadId"
> & { draftSurface?: CommentDraftSurface; threadId?: string };

export function commentDraftTargetForSurface(
  draftTarget: CommentDraftTarget | null,
  surface: CommentDraftSurface,
): CommentDraftTarget | null {
  return draftTarget?.draftSurface === surface ? draftTarget : null;
}

export function isGlobalCommentDraft(
  draftTarget: CommentDraftTarget | null,
): boolean {
  return (
    draftTarget?.draftSurface === "document" &&
    draftTarget.target.kind === "document"
  );
}

export function openThreadsWithDraftCleanup(input: {
  draftTarget: CommentDraftTarget | null;
  closeCommentDraft: () => void;
  openThreads: () => void;
}): void {
  if (isGlobalCommentDraft(input.draftTarget)) {
    input.closeCommentDraft();
  }
  input.openThreads();
}

export interface SoftwareMapFocusRequest {
  requestId: number;
  elementPath: string;
}

export interface ThreadFocusRequest {
  threadId: string;
  scroll: boolean;
  /** When false, the document scrolls to and highlights the anchor but the
   *  inline thread surface (expanded margin card / popover) stays closed —
   *  used when the thread detail is shown elsewhere (the Threads sidebar). */
  inline: boolean;
  nonce: number;
}

interface ReviewContextValue {
  softwareMapEnabled: boolean;
  historicalRevision: string | null;
  listVersions: () => Promise<ReviewDocumentVersionWire[] | null>;
  resolvedBaseRef: string | null;
  resolvedHeadRef: string | null;
  focusedThreadId: string | null;
  threadFocusRequest: ThreadFocusRequest | null;
  /** Focus a thread: sets focusedThreadId and enqueues a focus request.
   *  scroll and inline default to true. Always bumps nonce so repeated
   *  clicks re-trigger. */
  focusThread: (
    threadId: string,
    options?: { scroll?: boolean; inline?: boolean },
  ) => void;
  /** Clear focus (click-away / Escape). */
  blurThread: () => void;
  /** Consumer (the annotations layer) acknowledges the request after handling it. */
  clearThreadFocusRequest: () => void;
  commentThreads: ReadonlyMap<string, ReviewCommentThreadRecord>;
  allCommentThreads: () => CommentThreadView[];
  pendingCommentCount: number;
  submitPendingComments: (
    decision: "approve" | "request-changes",
    summary?: string,
  ) => Promise<void>;
  dismissReview: () => Promise<void>;
  openCommentDraft: (target: OpenCommentDraftTarget) => void;
  closeCommentDraft: () => void;
  draftTarget: CommentDraftTarget | null;
  askAgent: (input: CreateReviewCommentInput) => Promise<void>;
  softwareMapFocusRequest: SoftwareMapFocusRequest | null;
  openSoftwareMapElement: (elementPath: string) => void;
  saveComment: (input: CreateReviewCommentInput) => Promise<void>;
  updateComment: (
    threadId: string,
    body: string,
    messageId?: string,
  ) => Promise<void>;
  deleteComment: (threadId: string) => Promise<void>;
  deleteCommentMessage: (threadId: string, messageId: string) => Promise<void>;
  setCommentResolved: (threadId: string, resolved: boolean) => Promise<void>;
  /** Resolved comment threads, for the Threads sidebar's Resolved section. */
  resolvedCommentThreads: () => CommentThreadView[];
  submissionOutcome: ReviewSubmissionOutcome | null;
  deleteLocalComment: (threadId: string) => void;
  commentsForTarget: (target: ThreadTarget) => CommentThreadView[];
  commentsForAnchor: (anchor: AnchorRef) => CommentThreadView[];
  lineCommentsForAnchor: (anchor: AnchorRef) => SourceLineComment[];
  createAnchorCommentTarget: (anchor: AnchorRef) => OpenCommentDraftTarget;
  createAstLineCommentTarget: (
    anchor: AnchorRef,
    input: AstLineCommentRange,
  ) => OpenCommentDraftTarget;
}

const ReviewContext = createContext<ReviewContextValue | null>(null);
export function ReviewProvider({
  documentRoute,
  softwareMapEnabled = false,
  children,
}: {
  documentRoute?: string;
  softwareMapEnabled?: boolean;
  children: ReactNode;
}) {
  return (
    <ReviewCoordinator
      documentRoute={documentRoute}
      softwareMapEnabled={softwareMapEnabled}
    >
      {children}
    </ReviewCoordinator>
  );
}

function ReviewCoordinator({
  documentRoute,
  softwareMapEnabled,
  children,
}: {
  documentRoute?: string;
  softwareMapEnabled: boolean;
  children: ReactNode;
}) {
  const session = useReviewSession();
  const reviewFetch = session.fetch;
  const [commentStore, commentSnapshot] = useComments();
  const resolvedBaseRef = useResolvedBaseRef();
  const resolvedHeadRef = useResolvedHeadRef();
  const [draftTarget, setDraftTarget] = useState<CommentDraftTarget | null>(
    null,
  );
  const [focusedThreadId, setFocusedThreadId] = useState<string | null>(null);
  const [threadFocusRequest, setThreadFocusRequest] =
    useState<ThreadFocusRequest | null>(null);
  const [softwareMapFocusRequest, setSoftwareMapFocusRequest] =
    useState<SoftwareMapFocusRequest | null>(null);
  // Resolved threads are hidden from the canvas by default; this toggles them
  // back into view (greyed, with an unresolve action) so a reviewer can inspect
  // the context of already-addressed comments.
  // Set once the review has been submitted and the one-shot server has torn
  // itself down, so the canvas can show a terminal completed state instead of
  // a live-looking but dead document. The containing host owns its own window.
  const [submissionOutcome, setSubmissionOutcome] =
    useState<ReviewSubmissionOutcome | null>(null);
  const [historicalRevision, setHistoricalRevision] = useState<string | null>(
    null,
  );
  const pendingSubmissionRef = useRef<{
    key: string;
    submissionId: string;
    summaryComment?: CreateReviewCommentInput;
  } | null>(null);
  const threadFocusNonceRef = useRef(0);

  const commentThreads = commentSnapshot.commentThreads;
  const localComments = commentSnapshot.localComments;
  const agentActivities = commentSnapshot.agentActivities;
  const pendingCommentCount = commentSnapshot.pendingCommentCount;
  const commentTargetIndex = useMemo(
    () => buildThreadTargetIndex(commentThreads.values()),
    [commentThreads],
  );

  // The tutorial step for starting a thread. Both composer verbs create a
  // local comment. Watching the store also catches the code-oss comment widget,
  // which never calls this file's saveComment.
  const completeLeaveComment = useCompleteTutorialStep("leaveComment");
  useEffect(() => {
    if (commentThreads.size > 0 || localComments.size > 0) {
      completeLeaveComment?.();
    }
  }, [commentThreads, localComments, completeLeaveComment]);

  const focusThread = useCallback(
    (threadId: string, options?: { scroll?: boolean; inline?: boolean }) => {
      setFocusedThreadId(threadId);
      threadFocusNonceRef.current += 1;
      setThreadFocusRequest({
        threadId,
        scroll: options?.scroll ?? true,
        inline: options?.inline ?? true,
        nonce: threadFocusNonceRef.current,
      });
    },
    [],
  );

  const blurThread = useCallback(() => {
    setFocusedThreadId(null);
    setThreadFocusRequest(null);
  }, []);

  const clearThreadFocusRequest = useCallback(() => {
    setThreadFocusRequest(null);
  }, []);

  const commentsForTarget = useCallback(
    (target: ThreadTarget): CommentThreadView[] =>
      exactTargetRecords(commentTargetIndex, target).map((thread) =>
        commentThreadViewState(thread, localComments, agentActivities),
      ),
    [agentActivities, commentTargetIndex, localComments],
  );

  // Resolved threads are hidden from the document and the default lists;
  // they live in the Threads sidebar's Resolved section.
  const allCommentThreads = useCallback(
    (): CommentThreadView[] =>
      [...commentThreads.entries()]
        .filter(([, thread]) => thread.status !== "resolved")
        .map(([, thread]) =>
          commentThreadViewState(thread, localComments, agentActivities),
        )
        .sort(
          (left, right) => firstMessageTime(left) - firstMessageTime(right),
        ),
    [agentActivities, commentThreads, localComments],
  );

  const resolvedCommentThreads = useCallback(
    (): CommentThreadView[] =>
      [...commentThreads.entries()]
        .filter(([, thread]) => thread.status === "resolved")
        .map(([, thread]) =>
          commentThreadViewState(thread, localComments, agentActivities),
        )
        .sort(
          (left, right) => firstMessageTime(left) - firstMessageTime(right),
        ),
    [agentActivities, commentThreads, localComments],
  );

  const commentsForAnchor = useCallback(
    (anchor: AnchorRef): CommentThreadView[] =>
      selectCommentsForAnchor(
        anchorTargetRecords(commentTargetIndex, anchor, {
          baseRef: resolvedBaseRef,
          headRef: resolvedHeadRef,
        }),
        localComments,
        anchor,
        { baseRef: resolvedBaseRef, headRef: resolvedHeadRef },
        agentActivities,
      ),
    [
      agentActivities,
      commentTargetIndex,
      localComments,
      resolvedBaseRef,
      resolvedHeadRef,
    ],
  );

  const lineCommentsForAnchor = useCallback(
    (anchor: AnchorRef): SourceLineComment[] =>
      buildLineCommentsForAnchor(
        anchor,
        anchorTargetRecords(commentTargetIndex, anchor, {
          baseRef: resolvedBaseRef,
          headRef: resolvedHeadRef,
        }),
        { baseRef: resolvedBaseRef, headRef: resolvedHeadRef },
      ),
    [commentTargetIndex, resolvedBaseRef, resolvedHeadRef],
  );

  const createAstLineCommentTargetBound = useCallback(
    (anchor: AnchorRef, input: AstLineCommentRange): OpenCommentDraftTarget =>
      createAstLineCommentTarget(anchor, input, {
        baseRef: resolvedBaseRef,
        headRef: resolvedHeadRef,
      }),
    [resolvedBaseRef, resolvedHeadRef],
  );

  const saveComment = useCallback(
    async (input: CreateReviewCommentInput) => {
      const existing = commentSnapshot.commentThreads.get(input.threadId);
      await commentStore.saveComment(input);
      if (input.body.trim()) {
        captureUiEvent(session, "comment_created", {
          is_reply: Boolean(existing?.messages.length),
        });
      }
    },
    [commentSnapshot.commentThreads, commentStore, session],
  );
  const deleteLocalComment = useCallback(
    (threadId: string) => commentStore.deleteLocalComment(threadId),
    [commentStore],
  );
  const updateComment = useCallback(
    (threadId: string, body: string, messageId?: string) =>
      commentStore.updateComment(threadId, body, messageId),
    [commentStore],
  );
  const deleteComment = useCallback(
    (threadId: string) => commentStore.deleteComment(threadId),
    [commentStore],
  );
  const deleteCommentMessage = useCallback(
    (threadId: string, messageId: string) =>
      commentStore.deleteCommentMessage(threadId, messageId),
    [commentStore],
  );
  const setCommentResolved = useCallback(
    async (threadId: string, resolved: boolean) => {
      if (resolved)
        captureUiEvent(session, "thread_resolved", { kind: "comment" });
      await commentStore.setCommentResolved(threadId, resolved);
    },
    [commentStore, session],
  );

  const askAgent = useCallback(
    async (input: CreateReviewCommentInput) => {
      if (!input.body.trim()) return;
      captureUiEvent(session, "agent_run_started");
      await commentStore.askAgent(input);
    },
    [commentStore, session],
  );

  const submitPendingComments = useCallback(
    async (decision: "approve" | "request-changes", summary?: string) => {
      const summaryBody = summary?.trim();
      const key = `${decision}\u0000${summaryBody ?? ""}`;
      if (pendingSubmissionRef.current?.key !== key) {
        pendingSubmissionRef.current = {
          key,
          submissionId: createSubmissionId(),
          ...(summaryBody
            ? {
                summaryComment: {
                  threadId: createClientId(),
                  messageId: createClientId(),
                  target: { kind: "document" } as const,
                  body: summaryBody,
                },
              }
            : {}),
        };
      }
      const pendingSubmission = pendingSubmissionRef.current;
      try {
        if (pendingSubmission.summaryComment) {
          await commentStore.saveComment(pendingSubmission.summaryComment);
        }
        const submittedInputs = await commentStore.flushPendingComments();
        const response = await reviewFetch(
          "/submissions",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...reviewAppTelemetryHeaders(session),
            },
            body: JSON.stringify({
              submissionId: pendingSubmission.submissionId,
              decision,
              comments: submittedInputs,
            }),
          },
          { routePath: documentRoute },
        );
        if (!response.ok) {
          throw new Error(
            (await response.text()) ||
              `Failed to submit review (${response.status}).`,
          );
        }
        commentStore.completeHumanReviewRound();
        pendingSubmissionRef.current = null;
        setSubmissionOutcome(
          decision === "approve" ? "approved" : "changes-requested",
        );
      } catch (error) {
        commentStore.resetPendingComments();
        reportBackgroundReviewError(error);
        throw error;
      }
    },
    [commentStore, documentRoute, reviewFetch, session],
  );

  const createAnchorCommentTarget = useCallback(
    (anchor: AnchorRef): OpenCommentDraftTarget => ({
      target: anchorTextTarget(anchor),
      title: anchor.title,
      body: "",
    }),
    [],
  );

  const openSoftwareMapElement = useCallback(
    (elementPath: string) => {
      if (!softwareMapEnabled) return;
      setSoftwareMapFocusRequest((current) => ({
        requestId: (current?.requestId ?? 0) + 1,
        elementPath,
      }));
    },
    [softwareMapEnabled],
  );

  const dismissReview = useCallback(async () => {
    const response = await reviewFetch(
      "/dismiss",
      { method: "POST", headers: reviewAppTelemetryHeaders(session) },
      { routePath: documentRoute },
    );
    if (!response.ok) {
      throw new Error(`Review dismiss failed (${response.status}).`);
    }
    setSubmissionOutcome("dismissed");
  }, [documentRoute, reviewFetch, session]);

  const listVersions = useCallback(async () => {
    const response = await reviewFetch(
      "/revisions",
      {},
      { routePath: documentRoute },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as {
      ok: boolean;
      versions?: ReviewDocumentVersionWire[];
    };
    return body.ok ? (body.versions ?? []) : null;
  }, [documentRoute, reviewFetch]);

  // A review opened after a terminal decision must show its outcome banner
  // from the first render, not only in the session where the decision
  // happened. The session route reports the durable review status.
  useEffect(() => {
    let disposed = false;
    void reviewFetch("/session", {}, { routePath: documentRoute })
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json()) as {
          session?: { reviewStatus?: string; historicalRevision?: string };
        };
        if (disposed) return;
        setHistoricalRevision(body.session?.historicalRevision ?? null);
        if (body.session?.reviewStatus === "accepted") {
          setSubmissionOutcome("approved");
        } else if (body.session?.reviewStatus === "awaiting-agent-updates") {
          setSubmissionOutcome("changes-requested");
        }
      })
      .catch((error: unknown) => {
        console.error("Review status fetch failed", error);
      });
    return () => {
      disposed = true;
    };
  }, [documentRoute, reviewFetch, session]);

  const value = useMemo<ReviewContextValue>(
    () => ({
      softwareMapEnabled,
      historicalRevision,
      listVersions,
      resolvedBaseRef,
      resolvedHeadRef,
      focusedThreadId,
      threadFocusRequest,
      focusThread,
      blurThread,
      clearThreadFocusRequest,
      commentThreads,
      allCommentThreads,
      pendingCommentCount,
      submitPendingComments,
      dismissReview,
      openCommentDraft: (target) => {
        if (historicalRevision) return;
        captureUiEvent(session, "thread_draft_opened", {
          intent: target.intent ?? "comment",
        });
        setDraftTarget({
          ...target,
          draftSurface: target.draftSurface ?? "document",
          threadId: target.threadId ?? createClientId(),
          messageId: createClientId(),
          placement:
            target.placement ?? commentDraftPlacementFromActiveElement(),
        });
      },
      closeCommentDraft: () => setDraftTarget(null),
      draftTarget,
      askAgent,
      softwareMapFocusRequest,
      openSoftwareMapElement,
      saveComment,
      updateComment,
      deleteComment,
      deleteCommentMessage,
      setCommentResolved,
      resolvedCommentThreads,
      submissionOutcome,
      deleteLocalComment,
      commentsForTarget,
      commentsForAnchor,
      lineCommentsForAnchor,
      createAnchorCommentTarget,
      createAstLineCommentTarget: createAstLineCommentTargetBound,
    }),
    [
      blurThread,
      clearThreadFocusRequest,
      commentThreads,
      allCommentThreads,
      askAgent,
      commentsForAnchor,
      commentsForTarget,
      createAnchorCommentTarget,
      createAstLineCommentTargetBound,
      deleteComment,
      deleteCommentMessage,
      deleteLocalComment,
      draftTarget,
      focusedThreadId,
      focusThread,
      historicalRevision,
      lineCommentsForAnchor,
      listVersions,
      openSoftwareMapElement,
      pendingCommentCount,
      resolvedBaseRef,
      resolvedHeadRef,
      saveComment,
      session,
      softwareMapEnabled,
      setCommentResolved,
      resolvedCommentThreads,
      submissionOutcome,
      softwareMapFocusRequest,
      submitPendingComments,
      dismissReview,
      threadFocusRequest,
      updateComment,
    ],
  );

  return (
    <ReviewContext.Provider value={value}>{children}</ReviewContext.Provider>
  );
}

function commentDraftPlacementFromActiveElement(): CommentDraftPlacement {
  const activeElement =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const rect = activeElement?.getBoundingClientRect();
  if (rect && rect.width > 0 && rect.height > 0) {
    return {
      x: rect.left + rect.width / 2,
      y: rect.bottom + 8,
    };
  }
  return {
    x: window.innerWidth / 2,
    y: Math.min(window.innerHeight / 2, 280),
  };
}

function createSubmissionId(): string {
  return createClientId();
}

export function createClientId(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto?.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto?.getRandomValues !== "function") {
    throw new Error("Review thread creation requires browser cryptography.");
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10).join(""),
  ].join("-");
}

function firstMessageTime(thread: ReviewCommentThreadRecord): number {
  const time = Date.parse(thread.messages[0]?.at ?? "");
  return Number.isFinite(time) ? time : 0;
}

function anchorTextTarget(anchor: AnchorRef): ThreadTarget {
  return buildAnchorTextTarget({
    anchorId: anchor.id,
    field: "title",
    text: anchor.title,
  });
}

export function createAstLineCommentTarget(
  anchor: AnchorRef,
  input: AstLineCommentRange,
  commits: ReviewSessionCommits,
): OpenCommentDraftTarget {
  if (!anchor.peek?.resolution) {
    throw new Error("Code comments require a resolved anchor CodePeek.");
  }
  if (
    !Number.isInteger(input.fromLine) ||
    !Number.isInteger(input.toLine) ||
    input.toLine < input.fromLine
  ) {
    throw new Error("Code comments require a valid inclusive line range.");
  }
  return createAstLineCommentTargetFromSource(
    input,
    resolvedCodeSurface(anchor.peek.resolution),
    commits,
  );
}

export function createAstLineCommentTargetFromSource(
  input: AstLineCommentRange,
  source: ResolvedCommentCodeSource,
  commits: ReviewSessionCommits,
): OpenCommentDraftTarget {
  const side = input.side === "deletions" ? "base" : "head";
  const commit = side === "base" ? commits.baseRef : commits.headRef;
  if (!commit || !commits.baseRef || !commits.headRef) {
    throw new Error(
      "Code comments require the resolved base and head commits.",
    );
  }
  const lines = source.text.split("\n");
  const fromIndex = input.fromLine - source.fromLine;
  const toIndex = input.toLine - source.fromLine;
  const fromText = lines[fromIndex];
  const toText = lines[toIndex];
  if (fromText === undefined || toText === undefined) {
    throw new Error("Code comments require a range within resolved source.");
  }
  return {
    target: buildCodeTarget({
      path: source.file,
      side,
      baseCommit: commits.baseRef,
      headCommit: commits.headRef,
      span: { startLine: input.fromLine, endLine: input.toLine },
    }),
    title:
      input.fromLine === input.toLine
        ? `${source.file}:L${input.fromLine}`
        : `${source.file}:L${input.fromLine}-L${input.toLine}`,
    body: "",
  };
}

export function createBaseAstLineCommentDraftTarget(
  anchor: AnchorRef,
  input: AstLineCommentRange & { side: "deletions" },
  baseRef: string | null,
  headRef: string | null,
  resolveBaseSource: () => Promise<ResolvedCommentCodeSource>,
): OpenCommentDraftTarget {
  if (!baseRef || !headRef) {
    throw new Error(
      "Deleted-line comments require the resolved base and head commits.",
    );
  }
  const label =
    input.fromLine === input.toLine
      ? `L${input.fromLine}`
      : `L${input.fromLine}–${input.toLine}`;
  return {
    target: buildCodeTarget({
      path: anchor.peek?.resolution
        ? resolvedCodeSurface(anchor.peek.resolution).file
        : anchor.id,
      side: "base",
      baseCommit: baseRef,
      headCommit: headRef,
      span: { startLine: input.fromLine, endLine: input.toLine },
    }),
    title: label,
    body: "",
    panelRange: input,
    resolveTarget: async () => {
      const source = await resolveBaseSource();
      return createAstLineCommentTargetFromSource(input, source, {
        baseRef,
        headRef,
      }).target;
    },
  };
}

export function targetBelongsToAnchor(
  target: ThreadTarget,
  anchor: AnchorRef,
  commits: ReviewSessionCommits,
): boolean {
  return targetAppearsInAnchor(target, anchor, commits);
}

export function selectCommentsForAnchor(
  threads: Iterable<ReviewCommentThreadRecord>,
  localComments: ReadonlyMap<string, LocalCommentThread>,
  anchor: AnchorRef,
  commits: ReviewSessionCommits,
  agentActivities: ReadonlyMap<string, ReviewCommentAgentActivity> = new Map(),
): CommentThreadView[] {
  return [...threads]
    .filter((thread) => targetBelongsToAnchor(thread.target, anchor, commits))
    .map((thread) =>
      commentThreadViewState(thread, localComments, agentActivities),
    );
}

function commentThreadViewState(
  thread: ReviewCommentThreadRecord,
  localComments: ReadonlyMap<string, LocalCommentThread>,
  agentActivities: ReadonlyMap<string, ReviewCommentAgentActivity>,
): CommentThreadView {
  const agentActivity = agentActivities.get(thread.threadId);
  return {
    ...thread,
    clientStatus: commentClientStatus(thread.threadId, localComments),
    ...(agentActivity ? { agentActivity } : {}),
  };
}

function commentClientStatus(
  threadId: string,
  local: ReadonlyMap<string, LocalCommentThread>,
): CommentThreadView["clientStatus"] {
  return local.get(threadId)?.clientStatus ?? "persisted";
}

export function buildLineCommentsForAnchor(
  anchor: AnchorRef,
  threads: Iterable<ReviewCommentThreadRecord>,
  commits: ReviewSessionCommits,
): SourceLineComment[] {
  const source = anchor.peek?.resolution
    ? resolvedCodeSurface(anchor.peek.resolution)
    : undefined;
  return [...threads]
    .filter((thread) => thread.status !== "resolved")
    .flatMap((thread) => {
      const target = thread.target;
      const diffFile =
        target.kind === "code"
          ? anchor.peek?.resolution?.diff?.files.find(
              (file) =>
                file.path === target.position.new_path ||
                file.previousPath === target.position.old_path,
            )
          : undefined;
      const projection =
        target.kind === "code"
          ? projectCodeTarget(target, "head", diffFile?.patch)
          : null;
      if (
        target.kind !== "code" ||
        !projection ||
        !targetAppearsInAnchor(target, anchor, commits) ||
        !source ||
        projection.path !== source.file ||
        projection.span.endLine < source.fromLine ||
        projection.span.startLine > sourceEndLine(source)
      )
        return [];
      return [
        {
          rootIndex: 0,
          path: [],
          file: source.file,
          line: projection.span.startLine,
          count: thread.messages.length,
        },
      ];
    });
}

function sourceEndLine(source: ResolvedCommentCodeSource): number {
  return source.fromLine + source.text.split("\n").length - 1;
}

function reportBackgroundReviewError(error: unknown): void {
  console.error(error instanceof Error ? error : new Error(String(error)));
}

export function useReview(): ReviewContextValue {
  const value = useContext(ReviewContext);
  if (!value)
    throw new Error("Review components must render inside ReviewProvider");
  return value;
}
