/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	CreateReviewCommentInputSchema,
	ReviewThreadsCommandResponseSchema,
	ReviewThreadsSnapshotResponseSchema,
	type CreateReviewCommentInput,
	type ReviewCommentAgentActivity,
	type ReviewCommentDraftThread,
	type ReviewCommentStoreChange,
	type ReviewCommentStoreBridge,
	type ReviewCommentStoreSnapshot,
	type ReviewCommentThreadRecord,
	type ReviewLocalCommentThread,
	type ReviewThreadsCommand,
	type ReviewThreadsCommit,
	type ReviewThreadsSnapshot,
	type ThreadTarget,
} from "../common/reviewProtocol.js";

type ReviewCommentRequest = (
	endpoint: `/${string}`,
	init?: RequestInit,
) => Promise<Response>;

interface ReviewCommentStoreOptions {
	readonly request: ReviewCommentRequest;
	readonly onError?: (error: unknown) => void;
}

interface PendingAgentActivity {
	readonly activity: ReviewCommentAgentActivity;
	readonly priorAgentMessageIds: ReadonlySet<string>;
	readonly started: Promise<void>;
	readonly resolveStarted: () => void;
}

/** Session-owned comment state shared by all Review surfaces. */
export class ReviewCommentStore implements ReviewCommentStoreBridge {
	private readonly listeners = new Set<
		(change: ReviewCommentStoreChange) => void
	>();
	private readonly requestReview: ReviewCommentRequest;
	private readonly onError: (error: unknown) => void;
	private persisted = new Map<string, ReviewCommentThreadRecord>();
	private overrides = new Map<string, ReviewCommentThreadRecord | null>();
	private local = new Map<string, ReviewLocalCommentThread>();
	private agentActivities = new Map<string, PendingAgentActivity>();
	private snapshot: ReviewCommentStoreSnapshot;
	private revision = -1;
	private pendingCommits: ReviewThreadsCommit[] = [];
	private refreshGeneration = 0;
	private started = false;
	private disposed = false;

	constructor(options: ReviewCommentStoreOptions) {
		this.requestReview = options.request;
		this.onError = options.onError ?? reportBackgroundReviewError;
		this.snapshot = this.buildSnapshot();
	}

	readonly subscribe = (
		listener: (change: ReviewCommentStoreChange) => void,
	): (() => void) => {
		if (this.disposed) return () => undefined;
		this.listeners.add(listener);
		this.start();
		return () => this.listeners.delete(listener);
	};

	readonly getSnapshot = (): ReviewCommentStoreSnapshot => this.snapshot;

	start(): void {
		if (this.started || this.disposed) return;
		this.started = true;
		void this.refreshPersistedComments();
	}

	async saveComment(input: CreateReviewCommentInput): Promise<void> {
		const parsed = CreateReviewCommentInputSchema.parse(input);
		const body = parsed.body.trim();
		if (!body) return;
		const normalized = { ...parsed, body };
		const existing =
			this.local.get(normalized.threadId)?.thread ??
			this.persisted.get(normalized.threadId);
		if (
			existing?.messages.some((message) => message.id === normalized.messageId)
		) {
			return;
		}
		if (existing && !targetsEqual(existing.target, normalized.target)) {
			throw new Error(
				`Comment thread ${normalized.threadId} already targets different content.`,
			);
		}
		const now = new Date().toISOString();
		const thread: ReviewCommentThreadRecord = existing
			? {
					...existing,
					status: "open",
						messages: [
							...existing.messages,
							{
								id: normalized.messageId,
								by: "You",
								at: now,
								body,
								agentInput: normalized.agentInput ?? false,
							},
						],
					}
			: {
					threadId: normalized.threadId,
					target: normalized.target,
					status: "open",
						messages: [
							{
								id: normalized.messageId,
								by: "You",
								at: now,
								body,
								agentInput: normalized.agentInput ?? false,
							},
						],
					};
		const previous = this.local.get(normalized.threadId);
		this.local.set(normalized.threadId, {
			clientStatus: "draft",
			thread,
			inputs: [
				...(previous?.inputs ?? []),
				normalized,
			],
		});
		this.publish();
		try {
			await this.dispatchCommand({
				command: "comment-draft.create",
				mutationId: normalized.messageId,
				input: normalized,
			});
		} catch (error) {
			if (previous) this.local.set(normalized.threadId, previous);
			else this.local.delete(normalized.threadId);
			this.publish();
			this.onError(error);
			throw error;
		}
	}

	async askAgent(input: CreateReviewCommentInput): Promise<void> {
		const parsed = CreateReviewCommentInputSchema.parse(input);
		const body = parsed.body.trim();
		if (!body) return;
		const normalized = { ...parsed, body, agentInput: true as const };
		const current =
			this.local.get(normalized.threadId)?.thread ??
			this.persisted.get(normalized.threadId);
		let resolveStarted: () => void = () => undefined;
		const started = new Promise<void>((resolve) => {
			resolveStarted = resolve;
		});
		const pending: PendingAgentActivity = {
			activity: {
				messageId: normalized.messageId,
				startedAt: new Date().toISOString(),
				status: "starting",
			},
			priorAgentMessageIds: new Set(
				current?.messages
					.filter((message) => message.role === "agent")
					.map((message) => message.id) ?? [],
			),
			started,
			resolveStarted,
		};
		this.agentActivities.set(normalized.threadId, pending);
		try {
			await this.saveComment(normalized);
			const response = await this.requestReview("/agent-runs", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(normalized),
			});
			if (!response.ok) {
				throw new Error(await reviewRequestError(response));
			}
			const active = this.agentActivities.get(normalized.threadId);
			if (active === pending && active.activity.status === "starting") {
				this.agentActivities.set(normalized.threadId, {
					...active,
					activity: { ...active.activity, status: "running" },
				});
				pending.resolveStarted();
				this.publish();
			}
			await pending.started;
		} catch (error) {
			if (
				this.local.has(normalized.threadId) ||
				this.persisted.has(normalized.threadId)
			) {
				this.agentActivities.set(normalized.threadId, {
					...pending,
					activity: {
						messageId: normalized.messageId,
						startedAt: pending.activity.startedAt,
						status: "failed",
						error: error instanceof Error ? error.message : String(error),
					},
				});
			} else {
				this.agentActivities.delete(normalized.threadId);
			}
			this.publish();
			throw error;
		}
	}

	async deleteLocalComment(threadId: string): Promise<void> {
		const previous = this.local.get(threadId);
		if (!previous) return;
		this.local.delete(threadId);
		this.publish();
		try {
			await this.dispatchCommand({
				command: "comment-draft.delete",
				mutationId: createMutationId(),
				threadId,
			});
		} catch (error) {
			this.local.set(threadId, previous);
			this.publish();
			this.onError(error);
		}
	}

	async updateComment(
		threadId: string,
		body: string,
		messageId?: string,
	): Promise<void> {
		const nextBody = body.trim();
		if (!nextBody) return;
		const local = this.local.get(threadId);
		const persisted = this.persisted.get(threadId);
		const current = local?.thread ?? persisted;
		if (!current) return;
		if (local) {
			this.local.set(threadId, {
				...local,
				thread: updateThreadMessageBody(local.thread, nextBody, messageId),
				inputs: updateLocalCommentInputs(local.inputs, nextBody, messageId),
			});
			this.publish();
			try {
				await this.dispatchCommand({
					command: "comment-draft.update",
					mutationId: createMutationId(),
					threadId,
					update: {
						body: nextBody,
						...(messageId !== undefined ? { messageId } : {}),
					},
				});
			} catch (error) {
				this.local.set(threadId, local);
				this.publish();
				this.onError(error);
			}
			return;
		}
		if (!persisted) return;
		this.overrides.set(
			threadId,
			updateThreadMessageBody(persisted, nextBody, messageId),
		);
		this.publish();
		try {
			await this.dispatchCommand({
				command: "comment.update",
				mutationId: createMutationId(),
				threadId,
				update: {
					body: nextBody,
					...(messageId !== undefined ? { messageId } : {}),
				},
			});
		} catch (error) {
			this.overrides.delete(threadId);
			if (local) this.local.set(threadId, local);
			this.publish();
			this.onError(error);
		}
	}

	async deleteComment(threadId: string): Promise<void> {
		if (this.local.has(threadId)) {
			await this.deleteLocalComment(threadId);
			return;
		}
		if (!this.persisted.has(threadId)) return;
		this.overrides.set(threadId, null);
		this.publish();
		try {
			await this.dispatchCommand({
				command: "comment.delete",
				mutationId: createMutationId(),
				threadId,
			});
		} catch (error) {
			this.overrides.delete(threadId);
			this.publish();
			this.onError(error);
		}
	}

	async deleteCommentMessage(
		threadId: string,
		messageId: string,
	): Promise<void> {
		const local = this.local.get(threadId);
		const persisted = this.persisted.get(threadId);
		if (local) {
			const next = deleteLocalCommentMessage(local, messageId);
			if (!next || (next.inputs.length === 0 && persisted)) {
				this.local.delete(threadId);
			} else {
				this.local.set(threadId, next);
			}
			this.publish();
			try {
				await this.dispatchCommand({
					command: "comment-draft-message.delete",
					mutationId: createMutationId(),
					threadId,
					messageId,
				});
			} catch (error) {
				this.local.set(threadId, local);
				this.publish();
				this.onError(error);
			}
			return;
		}
		if (!persisted) return;
		const updated = deleteThreadMessage(persisted, messageId);
		this.overrides.set(threadId, updated);
		this.publish();
		try {
			await this.dispatchCommand({
				command: "comment-message.delete",
				mutationId: createMutationId(),
				threadId,
				messageId,
			});
		} catch (error) {
			this.overrides.delete(threadId);
			if (local) this.local.set(threadId, local);
			this.publish();
			this.onError(error);
		}
	}

	async setCommentResolved(threadId: string, resolved: boolean): Promise<void> {
		const status = resolved ? "resolved" : "open";
		const local = this.local.get(threadId);
		if (local) {
			this.local.set(threadId, {
				...local,
				thread: { ...local.thread, status },
			});
			this.publish();
			try {
				await this.dispatchCommand({
					command: "comment-draft.update",
					mutationId: createMutationId(),
					threadId,
					update: { status },
				});
			} catch (error) {
				this.local.set(threadId, local);
				this.publish();
				this.onError(error);
			}
			return;
		}
		const persisted = this.persisted.get(threadId);
		if (!persisted) return;
		this.overrides.set(threadId, { ...persisted, status });
		this.publish();
		try {
			await this.dispatchCommand({
				command: "comment.update",
				mutationId: createMutationId(),
				threadId,
				update: { status },
			});
		} catch (error) {
			this.overrides.delete(threadId);
			this.publish();
			this.onError(error);
		}
	}

	async flushPendingComments(): Promise<CreateReviewCommentInput[]> {
		const pending = [...this.local.entries()].filter(
			([, local]) => local.clientStatus === "draft",
		);
		const submitted: CreateReviewCommentInput[] = [];
		for (const [threadId, local] of pending) {
			this.local.set(threadId, { ...local, clientStatus: "submitting" });
		}
		this.publish();
		for (const [, local] of pending) {
			for (const input of local.inputs) submitted.push(input);
		}
		return submitted;
	}

	async persistComment(input: CreateReviewCommentInput): Promise<void> {
		const parsed = CreateReviewCommentInputSchema.parse(input);
		await this.dispatchCommand({
			command: "comment.create",
			mutationId: parsed.messageId,
			input: parsed,
		});
	}

	applyCommit(commit: ReviewThreadsCommit): void {
		if (this.disposed) return;
		if (this.revision < 0) {
			this.pendingCommits.push(commit);
			this.refreshPersistedCommentsIfStarted();
			return;
		}
		this.applyCommitToProjection(commit);
	}

	completeHumanReviewRound(): void {
		for (const [threadId, local] of this.local) {
			this.persisted.set(threadId, local.thread);
		}
		this.local.clear();
		this.publish();
	}

	resetPendingComments(): void {
		for (const [threadId, local] of this.local) {
			if (local.clientStatus === "submitting") {
				this.local.set(threadId, { ...local, clientStatus: "draft" });
			}
		}
		this.publish();
	}

	async refreshPersistedComments(): Promise<void> {
		this.started = true;
		await this.loadPersistedComments();
	}

	refreshPersistedCommentsIfStarted(): void {
		if (!this.started || this.disposed) return;
		void this.loadPersistedComments();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.refreshGeneration += 1;
		this.listeners.clear();
		this.persisted.clear();
		this.overrides.clear();
		this.local.clear();
		this.agentActivities.clear();
		this.revision = -1;
		this.pendingCommits = [];
		this.snapshot = this.buildSnapshot();
	}

	private async loadPersistedComments(): Promise<void> {
		const generation = ++this.refreshGeneration;
		try {
			const response = await this.requestReview("/comments");
			const body = ReviewThreadsSnapshotResponseSchema.parse(
				await response.json(),
			);
			if (!response.ok || !body.ok) {
				throw new Error(
					body.ok
						? `Review request failed (${response.status}).`
						: body.error,
				);
			}
			if (this.disposed || generation !== this.refreshGeneration) return;
			this.applySnapshot(body.snapshot);
		} catch (error) {
			if (!this.disposed && generation === this.refreshGeneration) {
				this.onError(error);
			}
		}
	}

	private async dispatchCommand(command: ReviewThreadsCommand): Promise<void> {
		const response = await this.requestReview("/thread-commands", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(command),
		});
		const body = ReviewThreadsCommandResponseSchema.parse(await response.json());
		if (!response.ok || !body.ok) {
			throw new Error(
				body.ok ? `Review request failed (${response.status}).` : body.error,
			);
		}
		this.applyCommit(body.commit);
	}

	private applySnapshot(snapshot: ReviewThreadsSnapshot): void {
		if (snapshot.revision < this.revision) return;
		this.persisted = new Map(Object.entries(snapshot.comments));
		this.local = new Map(
			Object.entries(snapshot.drafts).map(([threadId, draft]) => [
				threadId,
				this.localCommentFromDraft(
					draft,
					this.local.get(threadId)?.clientStatus ?? "draft",
				),
			]),
		);
		this.overrides.clear();
		this.revision = snapshot.revision;
		const pending = this.pendingCommits.sort(
			(left, right) => left.revision - right.revision,
		);
		this.pendingCommits = [];
		for (const commit of pending) this.applyCommitToProjection(commit);
		this.publish();
	}

	private applyCommitToProjection(commit: ReviewThreadsCommit): void {
		if (commit.revision <= this.revision) return;
		if (commit.revision !== this.revision + 1) {
			this.refreshPersistedCommentsIfStarted();
			return;
		}
		for (const thread of commit.upsertedThreads) {
			this.persisted.set(thread.threadId, thread);
			this.overrides.delete(thread.threadId);
		}
		for (const threadId of commit.deletedThreadIds) {
			this.persisted.delete(threadId);
			this.overrides.delete(threadId);
		}
		for (const { threadId, draft } of commit.upsertedDrafts) {
			this.local.set(
				threadId,
				this.localCommentFromDraft(
					draft,
					this.local.get(threadId)?.clientStatus ?? "draft",
				),
			);
		}
		for (const threadId of commit.deletedDraftThreadIds) {
			this.local.delete(threadId);
		}
		this.revision = commit.revision;
		this.publish();
	}

	private localCommentFromDraft(
		draft: ReviewCommentDraftThread,
		clientStatus: ReviewLocalCommentThread["clientStatus"],
	): ReviewLocalCommentThread {
		return { clientStatus, thread: draft.thread, inputs: draft.inputs };
	}

	private publish(): void {
		if (this.disposed) return;
		const previous = this.snapshot;
		this.reconcileAgentActivities();
		const next = this.buildSnapshot();
		const threadIds = changedCommentThreadIds(previous, next);
		this.snapshot = next;
		if (threadIds.size === 0) return;
		for (const listener of this.listeners) listener({ threadIds });
	}

	private buildSnapshot(): ReviewCommentStoreSnapshot {
		const commentThreads = new Map(this.persisted);
		for (const [id, value] of this.overrides) {
			if (value) commentThreads.set(id, value);
			else commentThreads.delete(id);
		}
		for (const [id, value] of this.local) {
			commentThreads.set(id, value.thread);
		}
		return {
			commentThreads,
			localComments: new Map(this.local),
			agentActivities: new Map(
				[...this.agentActivities].map(([threadId, pending]) => [
					threadId,
					pending.activity,
				]),
			),
			pendingCommentCount: this.local.size,
		};
	}

	private reconcileAgentActivities(): void {
		for (const [threadId, pending] of this.agentActivities) {
			const thread =
				this.local.get(threadId)?.thread ?? this.persisted.get(threadId);
			if (!thread) {
				this.agentActivities.delete(threadId);
				continue;
			}
			const hasAgentReply = thread.messages.some(
				(message) =>
					message.role === "agent" &&
					!pending.priorAgentMessageIds.has(message.id),
			);
			if (hasAgentReply) {
				pending.resolveStarted();
				this.agentActivities.delete(threadId);
				continue;
			}
		}
	}
}

async function reviewRequestError(response: Response): Promise<string> {
	const fallback = `Failed to start Review agent (${response.status}).`;
	try {
		const body: unknown = await response.json();
		if (
			typeof body === 'object' &&
			body !== null &&
			'error' in body &&
			typeof body.error === 'string' &&
			body.error
		) {
			return body.error;
		}
	} catch {
		// Use the status-based fallback for malformed error responses.
	}
	return fallback;
}

function changedCommentThreadIds(
	previous: ReviewCommentStoreSnapshot,
	next: ReviewCommentStoreSnapshot,
): ReadonlySet<string> {
	const threadIds = new Set([
		...previous.commentThreads.keys(),
		...next.commentThreads.keys(),
		...previous.localComments.keys(),
		...next.localComments.keys(),
		...previous.agentActivities.keys(),
		...next.agentActivities.keys(),
	]);
	for (const threadId of [...threadIds]) {
		if (
			previous.commentThreads.get(threadId) ===
				next.commentThreads.get(threadId) &&
			previous.localComments.get(threadId) ===
				next.localComments.get(threadId) &&
			previous.agentActivities.get(threadId) ===
				next.agentActivities.get(threadId)
		) {
			threadIds.delete(threadId);
		}
	}
	return threadIds;
}

function targetsEqual(left: ThreadTarget, right: ThreadTarget): boolean {
	return stableSerialize(left) === stableSerialize(right);
}

function stableSerialize(value: unknown): string {
	if (value === null || typeof value !== "object") {
		const serialized = JSON.stringify(value);
		if (serialized === undefined) {
			throw new Error("Comment target is not serializable.");
		}
		return serialized;
	}
	if (Array.isArray(value)) {
		return `[${value.map(stableSerialize).join(",")}]`;
	}
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.filter((key) => record[key] !== undefined)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
		.join(",")}}`;
}

function updateThreadMessageBody(
	thread: ReviewCommentThreadRecord,
	body: string,
	messageId?: string,
): ReviewCommentThreadRecord {
	const index =
		messageId === undefined
			? thread.messages.length - 1
			: thread.messages.findIndex((message) => message.id === messageId);
	if (index < 0) {
		throw new Error(
			`Comment message ${messageId ?? "in thread"} does not exist in thread ${thread.threadId}.`,
		);
	}
	return {
		...thread,
		messages: thread.messages.map((message, messageIndex) =>
			messageIndex === index ? { ...message, body } : message,
		),
	};
}

function deleteThreadMessage(
	thread: ReviewCommentThreadRecord,
	messageId: string,
): ReviewCommentThreadRecord | null {
	const index = thread.messages.findIndex(
		(message) => message.id === messageId,
	);
	if (index < 0) {
		throw new Error(
			`Comment message ${messageId} does not exist in thread ${thread.threadId}.`,
		);
	}
	return thread.messages.length === 1
		? null
		: {
				...thread,
				messages: thread.messages.filter(
					(_message, messageIndex) => messageIndex !== index,
				),
			};
}

function deleteLocalCommentMessage(
	local: ReviewLocalCommentThread,
	messageId: string,
): ReviewLocalCommentThread | null {
	const thread = deleteThreadMessage(local.thread, messageId);
	return thread
		? {
				...local,
				thread,
				inputs: local.inputs.filter((input) => input.messageId !== messageId),
			}
		: null;
}

function updateLocalCommentInputs(
	inputs: CreateReviewCommentInput[],
	body: string,
	messageId?: string,
): CreateReviewCommentInput[] {
	const index =
		messageId === undefined
			? inputs.length - 1
			: inputs.findIndex((input) => input.messageId === messageId);
	return inputs.map((input, inputIndex) =>
		inputIndex === index ? { ...input, body } : input,
	);
}

function createMutationId(): string {
	return globalThis.crypto.randomUUID();
}

function reportBackgroundReviewError(error: unknown): void {
	console.error(error instanceof Error ? error : new Error(String(error)));
}
