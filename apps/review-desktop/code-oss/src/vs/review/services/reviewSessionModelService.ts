/*---------------------------------------------------------------------------------------------
 *  Copyright (c) dev.fast. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the repository root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from "../../base/common/event.js";
import {
	AsyncReferenceCollection,
	Disposable,
	type IReference,
	MutableDisposable,
	ReferenceCollection,
} from "../../base/common/lifecycle.js";
import {
	createDecorator,
	IInstantiationService,
} from "../../platform/instantiation/common/instantiation.js";
import { ReviewModuleCache } from "../common/reviewModuleCache.js";
import {
	ReviewDocumentResponseSchema,
	ReviewSoftwareMapResponseSchema,
	type ReviewCommentStoreBridge,
	type ReviewDescriptor,
	type ReviewDocumentLoad,
	type ReviewSessionDescriptor,
	type ReviewSessionWire,
	type ReviewSoftwareMapLoad,
	parseReviewSessionResponse,
} from "../common/reviewProtocol.js";
import {
	IReviewSessionService,
	type ReviewDataChangedEvent,
	type ReviewSessionConnection,
	type ReviewSessionClosedEvent,
	type ReviewThreadsCommittedEvent,
} from "./reviewSessionService.js";
import { ReviewCommentStore } from "./reviewCommentStore.js";

export interface ReviewDesktopSession {
	readonly serverUrl: string;
	readonly sessionUrl: string;
	readonly token: string;
	readonly descriptor: ReviewSessionDescriptor;
	readonly review: ReviewDescriptor;
	readonly session: ReviewSessionWire & {
		readonly sessionId: string;
		readonly storageDir: string;
	};
}

export type ReviewDocumentDataLoader = (
	session: ReviewDesktopSession,
	documentUrl: string,
	contentHash: string,
) => Promise<ReviewDocumentLoad>;

export type ReviewSoftwareMapLoader = (
	session: ReviewDesktopSession,
	headMapUrl: string,
	baseMapUrl: string,
	contentHash: string,
) => Promise<ReviewSoftwareMapLoad>;

type ReviewSessionResolver = (
	preferredSessionId?: string,
) => Promise<ReviewDesktopSession>;

type ReviewSessionRefreshPredicate = (session: ReviewDesktopSession) => boolean;

export type ReviewSessionModelState = "active" | "completed" | "unavailable";

class ReviewSessionUnavailableError extends Error {}

export class ReviewSessionModel extends Disposable {
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _session: ReviewDesktopSession;
	get session(): ReviewDesktopSession {
		return this._session;
	}

	private _state: ReviewSessionModelState = "active";
	get state(): ReviewSessionModelState {
		return this._state;
	}

	private _unavailableMessage: string | undefined;
	get unavailableMessage(): string | undefined {
		return this._unavailableMessage;
	}

	private documentRevision: string;
	private readonly modules = new ReviewModuleCache();
	private refreshPromise: Promise<void> | undefined;
	private _comments: ReviewCommentStore;
	get comments(): ReviewCommentStoreBridge {
		return this._comments;
	}
	constructor(
		readonly reviewUuid: string,
		session: ReviewDesktopSession,
		private readonly resolveSession: ReviewSessionResolver,
		onDidChangeLists: Event<void>,
		onDidChangeReviewData: Event<ReviewDataChangedEvent> = Event.None,
		onDidCloseSession: Event<ReviewSessionClosedEvent> = Event.None,
		private readonly shouldRefresh: ReviewSessionRefreshPredicate = () => true,
		onDidCommitReviewThreads: Event<ReviewThreadsCommittedEvent> = Event.None,
	) {
		super();
		this._session = session;
		this._comments = this.createCommentStore();
		this.documentRevision = reviewDocumentRevision(session);
		this._register(
			onDidChangeLists(() => {
				if (!this.shouldRefresh(this._session)) {
					return;
				}
				void this.refresh().catch((error) => {
					console.error(
						`[Review Desktop] failed to refresh model ${reviewUuid}`,
						error,
					);
				});
			}),
		);
		this._register(
			onDidChangeReviewData((event) => {
				if (event.uuid !== this.reviewUuid || this._state !== "active") {
					return;
				}
				this._onDidChange.fire();
			}),
		);
		this._register(
			onDidCommitReviewThreads((event) => {
				if (
					event.uuid !== this.reviewUuid ||
					event.sessionId !== this._session.session.sessionId ||
					this._state !== "active"
				) {
					return;
				}
				this._comments.applyCommit(event.commit);
				this._onDidChange.fire();
			}),
		);
		this._register(
			onDidCloseSession((event) => {
				if (event.session.sessionId !== this._session.session.sessionId) {
					return;
				}
				this._comments.dispose();
				if (event.review) {
					this._session = { ...this._session, review: event.review };
				}
				this._state = isCompletedReviewStatus(this._session.review.status)
					? "completed"
					: "unavailable";
				this._unavailableMessage =
					this._state === "unavailable"
						? `Review session closed (${event.reason}).`
						: undefined;
				this._onDidChange.fire();
			}),
		);
	}

	refresh(preferredSessionId?: string): Promise<void> {
		if (!preferredSessionId && this.refreshPromise) {
			return this.refreshPromise;
		}
		const refresh = this.resolveSession(preferredSessionId)
			.then((session) => {
				const previousState = this._state;
				const previousSessionId = this._session.session.sessionId;
				const previousModelRevision = reviewModelRevision(this._session);
				const previousRevision = this.documentRevision;
				this._session = session;
				this._state = "active";
				this._unavailableMessage = undefined;
				if (
					previousState !== "active" ||
					previousSessionId !== session.session.sessionId
				) {
					this._comments.dispose();
					this._comments = this.createCommentStore();
				}
				this.documentRevision = reviewDocumentRevision(session);
				if (
					previousState === "active" &&
					reviewModelRevision(session) === previousModelRevision
				) {
					return;
				}
				if (this.documentRevision !== previousRevision) {
					this.modules.clear();
				}
				this._onDidChange.fire();
			})
			.catch((error) => {
				if (error instanceof ReviewSessionUnavailableError) {
					this._state = "unavailable";
					this._unavailableMessage = error.message;
					this._onDidChange.fire();
				}
				throw error;
			});
		if (preferredSessionId) {
			return refresh;
		}
		const trackedRefresh = refresh.finally(() => {
			if (this.refreshPromise === trackedRefresh) {
				this.refreshPromise = undefined;
			}
		});
		this.refreshPromise = trackedRefresh;
		return this.refreshPromise;
	}

	resolveDocument(loader: ReviewDocumentDataLoader): Promise<ReviewDocumentLoad> {
		return this.modules.load("document", () => this.loadDocument(loader));
	}

	resolveSoftwareMap(
		loader: ReviewSoftwareMapLoader,
	): Promise<ReviewSoftwareMapLoad | null> {
		return this.modules.load("software-map", () =>
			this.loadSoftwareMap(loader),
		);
	}

	async request(url: string, init: RequestInit = {}): Promise<Response> {
		return fetch(url, init);
	}

	private loadDocument(
		loader: ReviewDocumentDataLoader,
	): Promise<ReviewDocumentLoad> {
		return loadReviewSessionDocument(this._session, loader);
	}

	private loadSoftwareMap(
		loader: ReviewSoftwareMapLoader,
	): Promise<ReviewSoftwareMapLoad | null> {
		return loadReviewSessionSoftwareMap(this._session, loader);
	}

	private createCommentStore(): ReviewCommentStore {
		return new ReviewCommentStore({
			request: (endpoint, init = {}) =>
				reviewSessionApiRequest(this._session, endpoint, init, (url, request) =>
					this.request(url, request),
				),
		});
	}

	override dispose(): void {
		this._comments.dispose();
		super.dispose();
	}
}

/**
 * Sends a Review API request scoped to `session`, adding the document route
 * and the session token. Callers that must not touch a model's request path
 * (the publish-gate validation mount) pass the session explicitly.
 */
export function reviewSessionApiRequest(
	session: ReviewDesktopSession,
	endpoint: string,
	init: RequestInit = {},
	fetchImpl: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<Response> {
	const url = new URL(`${session.sessionUrl}/__progressive-review${endpoint}`);
	const routePath = session.session.routePath ?? session.descriptor.routePath;
	if (routePath && routePath !== "/") {
		url.searchParams.set("document", routePath);
	}
	const headers = new Headers(init.headers);
	headers.set("x-review-token", session.token);
	return fetchImpl(url.href, { ...init, headers });
}

export async function loadReviewSessionDocument(
	session: ReviewDesktopSession,
	loader: ReviewDocumentDataLoader,
): Promise<ReviewDocumentLoad> {
	try {
		const url = new URL(`${session.sessionUrl}/__progressive-review/document`);
		const routePath = session.session.routePath ?? session.descriptor.routePath;
		if (routePath && routePath !== "/") {
			url.searchParams.set("document", routePath);
		}
		const response = await fetch(url, {
			headers: { "x-review-token": session.token },
			signal: AbortSignal.timeout(30_000),
		});
		const payload = ReviewDocumentResponseSchema.parse(await response.json());
		if (
			response.status === 409 &&
			!payload.ok &&
			payload.code === "needs_republish" &&
			payload.reviewUuid !== undefined &&
			payload.mapStale !== undefined
		) {
			return {
				state: "needs-republish",
				reviewUuid: payload.reviewUuid,
				mapStale: payload.mapStale,
			};
		}
		if (!response.ok || !payload.ok) {
			throw new Error(
				payload.ok
					? `Review document returned ${response.status}.`
					: payload.error,
			);
		}
		return await loader(
			session,
			payload.documentUrl,
			payload.contentHash,
		);
	} catch (error) {
		return { state: "unavailable", message: reviewLoadErrorMessage(error) };
	}
}

export async function loadReviewSessionSoftwareMap(
	session: ReviewDesktopSession,
	loader: ReviewSoftwareMapLoader,
): Promise<ReviewSoftwareMapLoad | null> {
	try {
		const url = new URL(
			`${session.sessionUrl}/__progressive-review/software-map`,
		);
		const response = await fetch(url, {
			headers: { "x-review-token": session.token },
			signal: AbortSignal.timeout(30_000),
		});
		if (response.status === 404) return null;
		const payload = ReviewSoftwareMapResponseSchema.parse(await response.json());
		if (
			response.status === 409 &&
			!payload.ok &&
			payload.code === "needs_republish" &&
			payload.reviewUuid !== undefined
		) {
			return { state: "needs-republish", reviewUuid: payload.reviewUuid };
		}
		if (!response.ok || !payload.ok) {
			throw new Error(
				payload.ok
					? `Software map returned ${response.status}.`
					: payload.error,
			);
		}
		return await loader(
			session,
			payload.headMapUrl,
			payload.baseMapUrl,
			payload.contentHash,
		);
	} catch (error) {
		return { state: "unavailable", message: reviewLoadErrorMessage(error) };
	}
}

function reviewLoadErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function reviewDocumentRevision(session: ReviewDesktopSession): string {
	return [
		session.session.sessionId,
		session.descriptor.routePath,
		session.review.presentedDocumentRevision ?? "",
		session.review.presentedSoftwareMapRevision ?? "",
		session.review.documentUpdatedAt ?? "",
	].join("\n");
}

function reviewModelRevision(session: ReviewDesktopSession): string {
	return JSON.stringify(session);
}

class ReviewSessionModelReferenceCollection extends ReferenceCollection<
	Promise<ReviewSessionModel>
> {
	constructor(
		private readonly createModel: (
			key: string,
			preferredSessionId?: string,
		) => Promise<ReviewSessionModel>,
		private readonly destroyModel: (model: ReviewSessionModel) => void,
	) {
		super();
	}

	protected createReferencedObject(
		key: string,
		preferredSessionId?: string,
	): Promise<ReviewSessionModel> {
		return this.createModel(key, preferredSessionId);
	}

	protected destroyReferencedObject(
		_reviewUuid: string,
		model: Promise<ReviewSessionModel>,
	): void {
		void model.then(this.destroyModel, () => undefined);
	}
}

export const IReviewSessionModelService =
	createDecorator<IReviewSessionModelService>("reviewSessionModelService");

export interface IReviewSessionModelService {
	readonly _serviceBrand: undefined;
	readonly onDidChangeActiveModel: Event<ReviewSessionModel | null>;
	readonly activeModel: ReviewSessionModel | null;
	/**
	 * A `background` acquisition opens the session for a non-document surface
	 * — the Source tab rooting its file tree. The server stamps the intent on
	 * its `session-registered` event, so the app never surfaces the review
	 * document tab for it.
	 */
	acquire(
		reviewUuid: string,
		preferredSessionId?: string,
		options?: { background?: boolean; revision?: string },
	): Promise<IReference<ReviewSessionModel>>;
	/**
	 * The review the workbench currently works against. Two meanings share
	 * this slot: the review the user is reading (a document tab activated it)
	 * and the review a Source tab acquired to root the workspace folder. Both
	 * legitimately drive the workspace root; consumers that care about "what
	 * the user is reading" must check the active editor, not this.
	 */
	setActiveModel(model: ReviewSessionModel | null): void;
}

export class ReviewSessionModelService
	extends Disposable
	implements IReviewSessionModelService
{
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeActiveModel = this._register(
		new Emitter<ReviewSessionModel | null>(),
	);
	readonly onDidChangeActiveModel = this._onDidChangeActiveModel.event;

	private _activeModel: ReviewSessionModel | null = null;
	get activeModel(): ReviewSessionModel | null {
		return this._activeModel;
	}

	private readonly modelReferences: AsyncReferenceCollection<ReviewSessionModel>;
	private readonly models = new Map<string, ReviewSessionModel>();
	/** Review uuid → in-flight background acquires; consulted by the open call. */
	private readonly backgroundOpenIntents = new Map<string, number>();
	private readonly activeModelSubscription = this._register(
		new MutableDisposable(),
	);

	constructor(
		@IInstantiationService
		private readonly instantiationService: IInstantiationService,
		@IReviewSessionService
		private readonly sessionService: IReviewSessionService,
	) {
		super();
		this.modelReferences = new AsyncReferenceCollection(
			new ReviewSessionModelReferenceCollection(
				(key, preferredSessionId) => {
					const [reviewUuid, revision] = key.split("@");
					return this.createModel(
						key,
						reviewUuid,
						revision,
						preferredSessionId,
					);
				},
				(model) => {
					if (this._activeModel === model) {
						this.setActiveModel(null);
					}
					const historical = model.session.session.historicalRevision;
					if (historical) {
						for (const [key, candidate] of this.models) {
							if (candidate === model) this.models.delete(key);
						}
						model.dispose();
						void this.sessionService.closeSession(
							model.session.session.sessionId,
						);
					}
				},
			),
		);
	}

	async acquire(
		reviewUuid: string,
		preferredSessionId?: string,
		options?: { background?: boolean; revision?: string },
	): Promise<IReference<ReviewSessionModel>> {
		const key = options?.revision
			? `${reviewUuid}@${options.revision}`
			: reviewUuid;
		if (!options?.background) {
			return this.modelReferences.acquire(key, preferredSessionId);
		}

		// The intent only has to reach the open request this acquisition may
		// trigger (`resolveSession` reads the map): suppression itself is data
		// on the server's session-registered event, so nothing must stay up for
		// later consumers.
		this.backgroundOpenIntents.set(
			reviewUuid,
			(this.backgroundOpenIntents.get(reviewUuid) ?? 0) + 1,
		);
		try {
			return await this.modelReferences.acquire(
				key,
				preferredSessionId,
			);
		} finally {
			const count = this.backgroundOpenIntents.get(reviewUuid) ?? 0;
			if (count <= 1) {
				this.backgroundOpenIntents.delete(reviewUuid);
			} else {
				this.backgroundOpenIntents.set(reviewUuid, count - 1);
			}
		}
	}

	setActiveModel(model: ReviewSessionModel | null): void {
		if (this._activeModel === model) {
			return;
		}
		this._activeModel = model;
		this.activeModelSubscription.value = model?.onDidChange(() => {
			if (this._activeModel === model) {
				this._onDidChangeActiveModel.fire(model);
			}
		});
		this._onDidChangeActiveModel.fire(model);
	}

	private async createModel(
		key: string,
		reviewUuid: string,
		revision?: string,
		preferredSessionId?: string,
	): Promise<ReviewSessionModel> {
		const existing = this.models.get(key);
		if (existing) {
			if (preferredSessionId) {
				await existing.refresh(preferredSessionId);
			}
			return existing;
		}
		const session = await this.resolveSession(
			reviewUuid,
			preferredSessionId,
			true,
			revision,
		);
		const resolveSession = (sessionId?: string) =>
			this.resolveSession(reviewUuid, sessionId, false, revision);
		const model = this.instantiationService.createInstance(
			ReviewSessionModel,
			reviewUuid,
			session,
			resolveSession,
			this.sessionService.onDidChangeLists,
			this.sessionService.onDidChangeReviewData,
			this.sessionService.onDidCloseSession,
			(current) => this.shouldRefreshModel(current),
			this.sessionService.onDidCommitReviewThreads ?? Event.None,
		);
		this.models.set(key, model);
		return model;
	}

	override dispose(): void {
		for (const model of this.models.values()) {
			model.dispose();
		}
		this.models.clear();
		super.dispose();
	}

	private shouldRefreshModel(current: ReviewDesktopSession): boolean {
		const descriptor = this.sessionService.sessions.find(
			(candidate) => candidate.sessionId === current.session.sessionId,
		);
		const review = this.findReviewDescriptor(current.review.uuid);
		if (!review) {
			return true;
		}
		if (!descriptor) {
			return this.sessionService.sessions.some(
				(candidate) => candidate.reviewUuid === current.review.uuid,
			);
		}
		return (
			JSON.stringify([descriptor, review]) !==
			JSON.stringify([current.descriptor, current.review])
		);
	}

	private async resolveSession(
		reviewUuid: string,
		preferredSessionId?: string,
		openIfMissing = false,
		revision?: string,
	): Promise<ReviewDesktopSession> {
		await this.sessionService.initialize();
		let descriptor = this.findSession(
			reviewUuid,
			preferredSessionId,
			revision,
		);
		if (!descriptor && openIfMissing) {
			descriptor = await this.sessionService.openReview(reviewUuid, {
				background: this.backgroundOpenIntents.has(reviewUuid),
				...(revision ? { revision } : {}),
			});
		}
		if (!descriptor) {
			throw new ReviewSessionUnavailableError(
				`Review session is unavailable: ${reviewUuid}`,
			);
		}
		let review = this.findReviewDescriptor(reviewUuid);
		if (!review) {
			await this.sessionService.refresh();
			review = this.findReviewDescriptor(reviewUuid);
		}
		if (!review) {
			throw new ReviewSessionUnavailableError(
				`Review is unavailable: ${reviewUuid}`,
			);
		}
		const connection = await this.sessionService.getConnection();
		return resolveDesktopSession(connection, descriptor, review);
	}

	/** The tutorial Review is not in the store-backed list; its descriptor
	    comes from the tutorial open response instead. */
	private findReviewDescriptor(
		reviewUuid: string,
	): ReviewDescriptor | undefined {
		const listed = this.sessionService.reviews.find(
			(candidate) => candidate.uuid === reviewUuid,
		);
		if (listed) {
			return listed;
		}
		const tutorial = this.sessionService.tutorialReview;
		return tutorial?.uuid === reviewUuid ? tutorial : undefined;
	}

	private findSession(
		reviewUuid: string,
		preferredSessionId?: string,
		revision?: string,
	): ReviewSessionDescriptor | undefined {
		if (preferredSessionId) {
			const preferred = this.sessionService.sessions.find(
				(candidate) => candidate.sessionId === preferredSessionId,
			);
			if (
				preferred?.reviewUuid === reviewUuid &&
				preferred.historicalRevision === revision
			) {
				return preferred;
			}
		}
		return this.sessionService.sessions.find(
			(candidate) =>
				candidate.reviewUuid === reviewUuid &&
				candidate.historicalRevision === revision,
		);
	}
}

function isCompletedReviewStatus(status: ReviewDescriptor["status"]): boolean {
	return (
		status === "accepted" ||
		status === "rejected" ||
		status === "awaiting-agent-updates"
	);
}

async function resolveDesktopSession(
	connection: ReviewSessionConnection,
	descriptor: ReviewSessionDescriptor,
	review: ReviewDescriptor,
): Promise<ReviewDesktopSession> {
	const response = await fetch(
		`${descriptor.sessionUrl}/__progressive-review/session`,
		{
			headers: { "x-review-token": connection.token },
			signal: AbortSignal.timeout(5_000),
		},
	);
	const payload = parseReviewSessionResponse(await response.json());
	if (!response.ok || !payload.ok) {
		throw new Error(
			payload.ok
				? `Review session returned ${response.status}.`
				: payload.error,
		);
	}
	if (!payload.session.sessionId || !payload.session.storageDir) {
		throw new Error("Review server session is missing desktop fields.");
	}
	return {
		serverUrl: connection.serverUrl,
		sessionUrl: descriptor.sessionUrl,
		token: connection.token,
		descriptor,
		review,
		session: payload.session as ReviewDesktopSession["session"],
	};
}
