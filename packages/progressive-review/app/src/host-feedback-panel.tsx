import {
  type HostCheckpoint,
  type HostDocumentState,
  type HostDraft,
  type HostFeedbackSubmission,
  HostFeedbackSubmissionSchema,
  type HostFeedbackTarget,
  type HostMessage,
  type HostQuestionRun,
  type HostThread,
  type HostThreadMapping,
  type ReviewClient,
  type ReviewHostSourceTarget,
} from "@dev.fast/review-protocol";
import { useCallback, useEffect, useRef, useState } from "react";

import "./host-feedback-panel.css";

type Harness = HostQuestionRun["harness"];
interface FeedbackSnapshot {
  drafts: HostDraft[];
  threads: HostThread[];
  runs: HostQuestionRun[];
  submissions: HostFeedbackSubmission[];
  revision: number;
}
interface TargetChoice {
  key: string;
  label: string;
  target: HostFeedbackTarget;
}

export function hostFeedbackTargets(
  document: HostDocumentState,
): TargetChoice[] {
  const documentVersion = document.version;
  const choices: TargetChoice[] = [
    {
      key: "document",
      label: "Whole review",
      target: { kind: "document", documentVersion },
    },
  ];
  for (const node of Object.values(document.nodes)) {
    choices.push({
      key: `node:${node.id}`,
      label: `${"title" in node && node.title ? node.title : node.id} (${node.type})`,
      target: { kind: "node", documentVersion, nodeId: node.id },
    });
    const items =
      node.type === "sequence"
        ? node.messages
        : node.type === "call_stack_diff"
          ? [...node.base, ...node.head]
          : node.type === "database_lens"
            ? node.useCases.flatMap((item) => [item, ...item.operations])
            : [];
    for (const item of new Map(items.map((item) => [item.id, item])).values()) {
      choices.push({
        key: `diagram:${node.id}:${item.id}`,
        label: `${node.id} → ${item.label ?? item.id}`,
        target: {
          kind: "diagram",
          documentVersion,
          nodeId: node.id,
          itemId: item.id,
        },
      });
    }
    if (node.type === "trace_quote")
      choices.push({
        key: `trace:${node.id}`,
        label: `${node.id} → quoted trace event`,
        target: {
          kind: "trace",
          documentVersion,
          nodeId: node.id,
          eventId: node.eventId,
        },
      });
  }
  for (const [id, definition] of Object.entries(document.definitions)) {
    if (definition.kind === "anchor")
      choices.push({
        key: `source:${id}`,
        label: `${definition.title} (${definition.source.file}:${definition.source.fromLine}–${definition.source.toLine})`,
        target: { kind: "source", documentVersion, range: definition.source },
      });
  }
  return choices;
}

async function allPages<T>(
  read: (cursor?: string) => Promise<{
    result: { items: T[]; nextCursor: string | null };
    eventCursor: string;
  }>,
) {
  const first = await read();
  const items = [...first.result.items];
  let cursor = first.result.nextCursor;
  while (cursor) {
    const page = await read(cursor);
    items.push(...page.result.items);
    cursor = page.result.nextCursor;
  }
  return { items, eventCursor: first.eventCursor };
}

function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "The review request failed.";
}

/** Posted messages are immutable. Only the current human's private drafts are editable. */
export function HostFeedbackPanel({
  client,
  document,
  checkpoint,
  requestedSource,
}: {
  client: ReviewClient;
  document: HostDocumentState;
  checkpoint?: HostCheckpoint;
  requestedSource?: ReviewHostSourceTarget;
}) {
  const reviewId = document.reviewId;
  const [snapshot, setSnapshot] = useState<FeedbackSnapshot>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [pending, setPending] = useState(false);
  const [body, setBody] = useState("");
  const [target, setTarget] = useState(() => hostFeedbackTargets(document)[0]);
  const composer = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!requestedSource || requestedSource.reviewId !== reviewId) return;
    setTarget({
      key: "selected-source",
      label: `${requestedSource.range.file}:${requestedSource.range.fromLine}–${requestedSource.range.toLine}`,
      target: {
        kind: "source",
        documentVersion: requestedSource.documentVersion,
        range: requestedSource.range,
      },
    });
    composer.current?.focus();
    composer.current?.scrollIntoView?.({ block: "center" });
  }, [requestedSource, reviewId]);
  const [harnesses, setHarnesses] = useState<Harness[]>([]);
  const [harness, setHarness] = useState<Harness>("codex");
  const [decision, setDecision] =
    useState<HostFeedbackSubmission["decision"]>("comment");
  const [summary, setSummary] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dirtyDrafts, setDirtyDrafts] = useState<Set<string>>(new Set());
  const draftDirtyChanged = useCallback(
    (id: string, dirty: boolean) =>
      setDirtyDrafts((prior) => {
        if (prior.has(id) === dirty) return prior;
        const next = new Set(prior);
        if (dirty) next.add(id);
        else next.delete(id);
        return next;
      }),
    [],
  );
  const selectedDraftIsDirty = [...selected].some((id) => dirtyDrafts.has(id));
  const generation = useRef(0);
  const lifetime = useRef<AbortSignal | undefined>(undefined);
  const choices = hostFeedbackTargets(document);
  const currentChoice = choices.find((choice) => choice.key === target.key);
  const refresh = useCallback(
    async (signal = lifetime.current) => {
      const ownGeneration = ++generation.current;
      // Subscribe from the first snapshot cursor, so changes during subsequent
      // reads are replayed instead of falling into a read/subscribe gap.
      const drafts = await allPages((cursor) =>
        client.query("drafts.list", { reviewId, cursor, limit: 200 }, signal),
      );
      const [threads, runs, submissions] = await Promise.all([
        allPages((cursor) =>
          client.query(
            "threads.list",
            { reviewId, cursor, limit: 200 },
            signal,
          ),
        ),
        allPages((cursor) =>
          client.query(
            "questions.list",
            { reviewId, cursor, limit: 200 },
            signal,
          ),
        ),
        allPages((cursor) =>
          client.query(
            "feedback.list",
            { reviewId, cursor, limit: 200 },
            signal,
          ),
        ),
      ]);
      if (!signal?.aborted && generation.current === ownGeneration) {
        setSnapshot({
          drafts: drafts.items,
          threads: threads.items,
          runs: runs.items,
          submissions: submissions.items,
          revision: ownGeneration,
        });
        setSelected(
          (prior) =>
            new Set(
              [...prior].filter((id) =>
                drafts.items.some((draft) => draft.id === id),
              ),
            ),
        );
      }
      return drafts.eventCursor;
    },
    [client, reviewId],
  );
  useEffect(() => {
    const abort = new AbortController();
    lifetime.current = abort.signal;
    void refresh(abort.signal)
      .then((after) =>
        client.subscribe({
          after,
          reviewId,
          signal: abort.signal,
          onReset: () => refresh(abort.signal),
          onEvent: async (event) => {
            if (/^(draft|thread|message|question|feedback)\./.test(event.type))
              await refresh(abort.signal);
          },
          onError: (failure) => setError(failure.message),
        }),
      )
      .catch((cause: unknown) => {
        if (!abort.signal.aborted) setError(failureMessage(cause));
      });
    void client
      .query("capabilities", {}, abort.signal)
      .then(({ result }) => {
        if (abort.signal.aborted) return;
        const available = result.ask.available
          ? result.ask.supportedHarnesses.filter(
              (item): item is Harness => item !== "opencode",
            )
          : [];
        setHarnesses(available);
        if (available[0]) setHarness(available[0]);
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted) setError(failureMessage(cause));
      });
    return () => abort.abort();
  }, [client, reviewId, refresh]);

  const runAction = async (action: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(failureMessage(cause));
    } finally {
      setPending(false);
    }
  };
  const clearComposer = () => {
    setBody("");
    setTarget(hostFeedbackTargets(document)[0]);
  };
  const saveDraft = () =>
    runAction(async () => {
      const { result } = await client.command("draft.save", {
        reviewId,
        draftId: crypto.randomUUID(),
        expectedVersion: null,
        target: target.target,
        body,
      });
      setSelected((prior) => new Set([...prior, result.id]));
      clearComposer();
      setNotice("Saved privately. Submit the review to share it.");
    });
  const post = () =>
    runAction(async () => {
      await client.command("thread.create", {
        reviewId,
        target: target.target,
        body,
      });
      clearComposer();
      setNotice("Comment posted.");
    });
  const ask = () =>
    runAction(async () => {
      await client.command("question.start", {
        reviewId,
        target: target.target,
        body,
        harness,
      });
      clearComposer();
      setNotice("Question saved. The agent opens beside this review.");
    });
  const submit = () =>
    runAction(async () => {
      if (!checkpoint) return;
      const input = {
        reviewId,
        checkpointId: checkpoint.id,
        decision,
        drafts: (snapshot?.drafts ?? [])
          .filter((draft) => selected.has(draft.id))
          .map((draft) => ({
            draftId: draft.id,
            expectedVersion: draft.version,
          })),
        body: summary.trim() || undefined,
      };
      await client.command("feedback.submit", input);
      setSummary("");
      setSelected(new Set());
      setNotice("Review submitted.");
    });

  return (
    <aside className="host-feedback" aria-label="Review discussion">
      <h2>Discussion</h2>
      {error && (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={() => void runAction(async () => {})}>
            Refresh
          </button>
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <label>
        Comment on{" "}
        <select
          aria-label="Comment target"
          disabled={pending}
          value={target.key}
          onChange={(event) => {
            const next = choices.find(
              (choice) => choice.key === event.target.value,
            );
            if (next) setTarget(next);
          }}
        >
          {!currentChoice && (
            <option value={target.key}>
              {target.label}{" "}
              {target.target.documentVersion === document.version
                ? "(selected range)"
                : "(earlier version)"}
            </option>
          )}
          {choices.map((choice) => (
            <option key={choice.key} value={choice.key}>
              {choice.label}
            </option>
          ))}
        </select>
      </label>
      <p className="host-feedback-context">
        Observed version {target.target.documentVersion}
        {target.target.documentVersion !== document.version && (
          <>
            {" "}
            · The review has changed.{" "}
            <button
              type="button"
              disabled={pending}
              onClick={() => setTarget(currentChoice ?? choices[0])}
            >
              Use displayed version {document.version}
            </button>
          </>
        )}
      </p>
      <textarea
        ref={composer}
        aria-label="New comment or question"
        disabled={pending}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Write a comment or ask a question…"
      />
      <div className="host-feedback-actions">
        <button
          type="button"
          disabled={pending || !body.trim()}
          onClick={() => void saveDraft()}
        >
          Add to review
        </button>
        <button
          type="button"
          disabled={pending || !body.trim()}
          onClick={() => void post()}
        >
          Post comment
        </button>
        <button
          type="button"
          disabled={pending || !body.trim() || !harnesses.length}
          onClick={() => void ask()}
        >
          Ask now
        </button>
        {harnesses.length > 0 && (
          <select
            aria-label="Question agent"
            disabled={pending}
            value={harness}
            onChange={(event) => {
              const next = harnesses.find(
                (value) => value === event.target.value,
              );
              if (next) setHarness(next);
            }}
          >
            {harnesses.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        )}
      </div>
      {!harnesses.length && (
        <p className="host-feedback-context">
          Ask is unavailable: no supported local agent is ready.
        </p>
      )}
      <h3>Private drafts</h3>
      {!snapshot && <p role="status">Loading discussion…</p>}
      {snapshot?.drafts.length === 0 && <p>No private drafts.</p>}
      {snapshot?.drafts.map((draft) => (
        <DraftEditor
          key={draft.id}
          draft={draft}
          selected={selected.has(draft.id)}
          pending={pending}
          onDirtyChange={draftDirtyChanged}
          onSelect={(checked) =>
            setSelected((prior) => {
              const next = new Set(prior);
              if (checked) next.add(draft.id);
              else next.delete(draft.id);
              return next;
            })
          }
          onSave={(nextBody, expectedVersion, target) =>
            runAction(async () => {
              await client.command("draft.save", {
                reviewId,
                draftId: draft.id,
                expectedVersion,
                target,
                body: nextBody,
              });
            })
          }
          onDelete={() =>
            runAction(async () => {
              await client.command("draft.delete", {
                reviewId,
                draftId: draft.id,
                expectedVersion: draft.version,
              });
            })
          }
        />
      ))}
      <fieldset disabled={pending || !checkpoint}>
        <legend>
          Submit review{checkpoint ? ` · checkpoint ${checkpoint.ordinal}` : ""}
        </legend>
        <label>
          Decision{" "}
          <select
            aria-label="Review decision"
            value={decision}
            onChange={(event) =>
              setDecision(
                HostFeedbackSubmissionSchema.shape.decision.parse(
                  event.target.value,
                ),
              )
            }
          >
            <option value="comment">Comment</option>
            <option value="request_changes">Request changes</option>
            <option value="approve">Approve</option>
          </select>
        </label>
        <textarea
          aria-label="Review summary"
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          placeholder="Optional review summary"
        />
        <button
          type="button"
          disabled={
            selectedDraftIsDirty ||
            (decision === "comment" && !summary.trim() && selected.size === 0)
          }
          onClick={() => void submit()}
        >
          Submit{" "}
          {selected.size
            ? `${selected.size} selected draft${selected.size === 1 ? "" : "s"}`
            : "review"}
        </button>
      </fieldset>
      {selectedDraftIsDirty && (
        <p>Save selected draft edits before submitting the review.</p>
      )}
      {!checkpoint && <p>Publish a checkpoint before submitting a review.</p>}
      <h3>Posted discussions</h3>
      {snapshot?.threads.length === 0 && <p>No posted comments yet.</p>}
      {snapshot?.threads.map((thread) => (
        <ThreadView
          key={thread.id}
          client={client}
          thread={thread}
          documentVersion={document.version}
          revision={snapshot.revision}
          runs={snapshot.runs.filter((run) => run.threadId === thread.id)}
          harness={harnesses.length ? harness : undefined}
          pending={pending}
          runAction={runAction}
        />
      ))}
      {(snapshot?.submissions.length ?? 0) > 0 && (
        <details>
          <summary>Submitted reviews ({snapshot!.submissions.length})</summary>
          <ul>
            {snapshot!.submissions.map((submission) => (
              <li key={submission.id}>
                {submission.decision.replaceAll("_", " ")} ·{" "}
                {new Date(submission.createdAt).toLocaleString()} ·{" "}
                {submission.messageIds.length} messages
              </li>
            ))}
          </ul>
        </details>
      )}
    </aside>
  );
}

function DraftEditor({
  draft,
  selected,
  pending,
  onSelect,
  onSave,
  onDelete,
  onDirtyChange,
}: {
  draft: HostDraft;
  selected: boolean;
  pending: boolean;
  onSelect(checked: boolean): void;
  onSave(
    body: string,
    expectedVersion: number,
    target: HostFeedbackTarget,
  ): Promise<void>;
  onDelete(): Promise<void>;
  onDirtyChange(id: string, dirty: boolean): void;
}) {
  const [buffer, setBuffer] = useState({ body: draft.body, base: draft });
  const { body, base } = buffer;
  useEffect(() => {
    onDirtyChange(draft.id, body !== draft.body);
    return () => onDirtyChange(draft.id, false);
  }, [draft.id, body, draft.body, onDirtyChange]);
  useEffect(
    () =>
      setBuffer((prior) =>
        prior.body === prior.base.body || prior.body === draft.body
          ? { body: draft.body, base: draft }
          : prior,
      ),
    [draft.version],
  );
  return (
    <section className="host-feedback-draft">
      <label>
        <input
          type="checkbox"
          checked={selected}
          onChange={(event) => onSelect(event.target.checked)}
        />{" "}
        Include in submission · version {draft.target.documentVersion}
      </label>
      <textarea
        aria-label="Private draft"
        value={body}
        onChange={(event) =>
          setBuffer((prior) => ({ ...prior, body: event.target.value }))
        }
      />
      <div className="host-feedback-actions">
        <button
          type="button"
          disabled={pending || !body.trim() || body === draft.body}
          onClick={() => void onSave(body, base.version, base.target)}
        >
          Save draft
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => void onDelete()}
        >
          Delete draft
        </button>
      </div>
      {base.version !== draft.version && (
        <p role="status">
          This draft changed elsewhere. Your unsaved text is preserved.{" "}
          <button
            type="button"
            onClick={() => setBuffer({ body: draft.body, base: draft })}
          >
            Discard local edits and reload
          </button>
        </p>
      )}
    </section>
  );
}

function ThreadView({
  client,
  thread,
  documentVersion,
  revision,
  runs,
  harness,
  pending,
  runAction,
}: {
  client: ReviewClient;
  thread: HostThread;
  documentVersion: number;
  revision: number;
  runs: HostQuestionRun[];
  harness?: Harness;
  pending: boolean;
  runAction(action: () => Promise<void>): Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<HostMessage[]>();
  const [mapping, setMapping] = useState<HostThreadMapping>();
  const [mappingError, setMappingError] = useState<string>();
  const [error, setError] = useState<string>();
  const [body, setBody] = useState("");
  const latestRuns = new Map<string, HostQuestionRun>();
  // questions.list returns newest attempts first, including timestamp ties.
  for (const run of runs) {
    if (!latestRuns.has(run.questionId)) latestRuns.set(run.questionId, run);
  }
  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    void allPages(async (cursor) => {
      const page = await client.query(
        "thread.get",
        {
          reviewId: thread.reviewId,
          threadId: thread.id,
          cursor,
          limit: 200,
        },
        abort.signal,
      );
      return {
        result: page.result.messages,
        eventCursor: page.eventCursor,
      };
    })
      .then((conversation) => {
        if (!abort.signal.aborted) {
          setMessages(conversation.items);
          setError(undefined);
        }
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted) setError(failureMessage(cause));
      });
    setMapping(undefined);
    setMappingError(undefined);
    void client
      .query(
        "thread.mapping",
        { reviewId: thread.reviewId, threadId: thread.id, documentVersion },
        abort.signal,
      )
      .then((location) => {
        if (!abort.signal.aborted) setMapping(location.result);
      })
      .catch((cause: unknown) => {
        if (!abort.signal.aborted) setMappingError(failureMessage(cause));
      });
    return () => abort.abort();
  }, [client, thread.id, thread.reviewId, documentVersion, revision, open]);
  const reply = (ask: boolean) =>
    runAction(async () => {
      if (ask && harness)
        await client.command("question.follow_up", {
          reviewId: thread.reviewId,
          threadId: thread.id,
          body,
          harness,
        });
      else
        await client.command("thread.reply", {
          reviewId: thread.reviewId,
          threadId: thread.id,
          messageId: crypto.randomUUID(),
          body,
        });
      setBody("");
    });
  return (
    <section className="host-feedback-thread">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "▾" : "▸"}{" "}
        {thread.target.kind === "document"
          ? "Whole review"
          : thread.target.kind === "source"
            ? `${thread.target.range.file}:${thread.target.range.fromLine}`
            : thread.target.nodeId}{" "}
        · {thread.status}
      </button>
      {[...latestRuns.values()].map((run) => (
        <p key={run.id} role="status">
          Question {run.state === "completed" ? "answered" : run.state}
          {run.error && `: ${run.error}`}{" "}
          {(run.state === "failed" || run.state === "interrupted") && (
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                void runAction(async () => {
                  await client.command("question.retry", {
                    reviewId: thread.reviewId,
                    runId: run.id,
                  });
                })
              }
            >
              Retry question
            </button>
          )}
        </p>
      ))}
      {open && (
        <>
          <p className="host-feedback-context">
            Originally observed version {thread.target.documentVersion}
            {mapping &&
              ` · ${mapping.status === "missing" ? "Target is no longer present; original context is retained" : mapping.status === "relocated" ? "Source relocated in the displayed version" : "Target found in the displayed version"}`}
          </p>
          {error && <p role="alert">{error}</p>}
          {mappingError && (
            <p role="status">
              Current source location unavailable: {mappingError} The saved
              conversation and original context remain available.
            </p>
          )}
          {thread.evidence && (
            <details>
              <summary>Original source excerpt</summary>
              <pre>{thread.evidence.text}</pre>
            </details>
          )}
          {!messages && <p role="status">Loading messages…</p>}
          {messages?.map((item) => (
            <article key={item.id} className="host-feedback-message">
              <header>
                {item.author.displayName} ·{" "}
                {new Date(item.createdAt).toLocaleString()}
              </header>
              <p>{item.body}</p>
            </article>
          ))}
          <textarea
            aria-label="Reply to discussion"
            disabled={pending}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            placeholder="Add a follow-up; posted messages cannot be edited."
          />
          <div className="host-feedback-actions">
            <button
              type="button"
              disabled={pending || !body.trim()}
              onClick={() => void reply(false)}
            >
              Reply
            </button>
            <button
              type="button"
              disabled={pending || !body.trim() || !harness}
              onClick={() => void reply(true)}
            >
              Ask follow-up
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() =>
                void runAction(async () => {
                  await client.command("thread.status", {
                    reviewId: thread.reviewId,
                    threadId: thread.id,
                    expectedVersion: thread.version,
                    status: thread.status === "open" ? "resolved" : "open",
                  });
                })
              }
            >
              {thread.status === "open" ? "Resolve" : "Reopen discussion"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
